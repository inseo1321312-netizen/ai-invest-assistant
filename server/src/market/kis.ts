import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { assertReadPath } from './kisPaths.js';
import type { Bar, Candle, Holding, Instrument, Quote, UsExchange } from './types.js';
import { BAR_SECONDS, parseInstrumentKey } from './types.js';

export { assertReadPath, KIS_READ_PATHS, KisBlockedError } from './kisPaths.js';

const BASE = 'https://openapi.koreainvestment.com:9443';
const TOKEN_KEY = 'kis.token';
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export class KisError extends Error {}

export interface KisClient {
  getCandles(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]>;
  getQuote(inst: Instrument): Promise<Quote>;
  getHoldings(): Promise<Holding[]>;
}

interface StoredToken { token: string; expiresAt: number }
type Row = Record<string, string>;
interface KisBody { rt_cd?: string; msg1?: string; output?: Row; output1?: Row[] | Row; output2?: Row[] | Row; ctx_area_fk100?: string; ctx_area_nk100?: string; ctx_area_fk200?: string; ctx_area_nk200?: string }

const num = (s: unknown): number => {
  const n = Number(typeof s === 'string' ? s.trim() : s);
  return Number.isFinite(n) ? n : 0;
};

/** 'YYYYMMDD' + 'HHMMSS'(한국 시간) → unix 초 */
function kstToUnix(ymd: string, hms = '000000'): number {
  const iso = `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}+09:00`;
  return Math.floor(Date.parse(iso) / 1000);
}

function ymdKst(ms: number): string {
  const d = new Date(ms + 9 * 3600 * 1000);
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

const BALANCE_EXCHANGE: Record<string, UsExchange> = { NASD: 'NAS', NAS: 'NAS', NYSE: 'NYS', NYS: 'NYS', AMEX: 'AMS', AMS: 'AMS' };

/** 1분봉 → 더 큰 분봉으로 묶는다(시작 시각 기준). */
function aggregate(candles: Candle[], seconds: number): Candle[] {
  const out: Candle[] = [];
  for (const c of candles) {
    const t = Math.floor(c.time / seconds) * seconds;
    const cur = out[out.length - 1];
    if (cur && cur.time === t) {
      cur.high = Math.max(cur.high, c.high);
      cur.low = Math.min(cur.low, c.low);
      cur.close = c.close;
      cur.volume += c.volume;
    } else {
      out.push({ ...c, time: t });
    }
  }
  return out;
}

export function createKisClient(opts: {
  creds: Config['kis'];
  db: Db;
  fetchImpl?: typeof fetch;
  now?: () => number;
  minIntervalMs?: number;
}): KisClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  const minInterval = opts.minIntervalMs ?? Math.ceil(1000 / 15);
  let tokenPromise: Promise<string> | null = null;
  let queue: Promise<void> = Promise.resolve();

  function requireCreds(): NonNullable<Config['kis']> {
    if (!opts.creds) throw new KisError('한국투자증권 API 키가 설정되지 않았습니다');
    return opts.creds;
  }

  async function issueToken(): Promise<string> {
    const creds = requireCreds();
    const res = await doFetch(`${BASE}/oauth2/tokenP`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ grant_type: 'client_credentials', appkey: creds.appKey, appsecret: creds.appSecret }),
    });
    const json = (await res.json().catch(() => null)) as { access_token?: string; access_token_token_expired?: string; error_description?: string } | null;
    if (!json?.access_token || !json.access_token_token_expired) {
      throw new KisError(`한국투자증권 토큰 발급 실패: ${json?.error_description ?? res.status}`);
    }
    const expiresAt = Date.parse(`${json.access_token_token_expired.replace(' ', 'T')}+09:00`);
    opts.db.kvSet(TOKEN_KEY, { token: json.access_token, expiresAt } satisfies StoredToken);
    return json.access_token;
  }

  function getToken(): Promise<string> {
    const stored = opts.db.kvGet<StoredToken>(TOKEN_KEY);
    if (stored && stored.expiresAt - REFRESH_MARGIN_MS > now()) return Promise.resolve(stored.token);
    if (!tokenPromise) {
      tokenPromise = issueToken().finally(() => { tokenPromise = null; });
    }
    return tokenPromise;
  }

  function throttle(): Promise<void> {
    if (minInterval <= 0) return Promise.resolve();
    const next = queue.then(() => new Promise<void>((r) => setTimeout(r, minInterval)));
    const mine = queue;
    queue = next;
    return mine;
  }

  async function request(path: string, trId: string, query: Record<string, string>, trCont = ''): Promise<{ body: KisBody; trCont: string }> {
    assertReadPath(path);
    const creds = requireCreds();
    const token = await getToken();
    await throttle();
    const url = `${BASE}${path}?${new URLSearchParams(query).toString()}`;
    const res = await doFetch(url, {
      method: 'GET',
      headers: {
        'content-type': 'application/json; charset=utf-8',
        authorization: `Bearer ${token}`,
        appkey: creds.appKey,
        appsecret: creds.appSecret,
        tr_id: trId,
        tr_cont: trCont,
        custtype: 'P',
      },
    });
    const body = (await res.json().catch(() => null)) as KisBody | null;
    if (!body || body.rt_cd !== '0') throw new KisError(`한국투자증권 오류: ${body?.msg1 ?? res.status}`);
    return { body, trCont: res.headers.get('tr_cont') ?? '' };
  }

  const rows = (v: Row[] | Row | undefined): Row[] => (Array.isArray(v) ? v : []);

  async function domesticDaily(code: string, period: 'D' | 'W', limit: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let end = now();
    const spanDays = period === 'D' ? 140 : 980; // 한 번에 최대 100개
    for (let page = 0; page < 10 && out.length < limit; page++) {
      const start = end - spanDays * 86400_000;
      const { body } = await request('/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', 'FHKST03010100', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_DATE_1: ymdKst(start), FID_INPUT_DATE_2: ymdKst(end),
        FID_PERIOD_DIV_CODE: period, FID_ORG_ADJ_PRC: '0',
      });
      const list = rows(body.output2).filter((r) => r.stck_bsop_date);
      if (list.length === 0) break;
      for (const r of list) {
        out.push({ time: kstToUnix(r.stck_bsop_date!), open: num(r.stck_oprc), high: num(r.stck_hgpr), low: num(r.stck_lwpr), close: num(r.stck_clpr), volume: num(r.acml_vol) });
      }
      end = (kstToUnix(list[list.length - 1]!.stck_bsop_date!) - 86400) * 1000;
    }
    return dedupeSort(out).slice(-limit);
  }

  async function domesticMinutes(code: string, bar: Bar, limit: number): Promise<Candle[]> {
    // 당일 1분봉만 제공된다(한 번에 30개). 시간을 거슬러 가며 모은 뒤 묶는다.
    const out: Candle[] = [];
    const need = Math.min(limit * (BAR_SECONDS[bar] / 60), 400);
    let hour = new Date(now() + 9 * 3600_000).toISOString().slice(11, 19).replace(/:/g, '');
    if (hour > '153000') hour = '153000';
    for (let page = 0; page < 14 && out.length < need; page++) {
      const { body } = await request('/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', 'FHKST03010200', {
        FID_ETC_CLS_CODE: '', FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: code, FID_INPUT_HOUR_1: hour, FID_PW_DATA_INCU_YN: 'Y',
      });
      const list = rows(body.output2).filter((r) => r.stck_cntg_hour);
      if (list.length === 0) break;
      for (const r of list) {
        out.push({ time: kstToUnix(r.stck_bsop_date!, r.stck_cntg_hour!), open: num(r.stck_oprc), high: num(r.stck_hgpr), low: num(r.stck_lwpr), close: num(r.stck_prpr), volume: num(r.cntg_vol) });
      }
      const oldest = list[list.length - 1]!.stck_cntg_hour!;
      if (oldest <= '090000') break;
      const t = kstToUnix('20000101', oldest) - 60;
      hour = new Date(t * 1000 + 9 * 3600_000).toISOString().slice(11, 19).replace(/:/g, '');
    }
    return aggregate(dedupeSort(out), BAR_SECONDS[bar]).slice(-limit);
  }

  async function overseasDaily(inst: Instrument, gubn: '0' | '1', limit: number): Promise<Candle[]> {
    const out: Candle[] = [];
    let bymd = '';
    for (let page = 0; page < 10 && out.length < limit; page++) {
      const { body } = await request('/uapi/overseas-price/v1/quotations/dailyprice', 'HHDFS76240000', {
        AUTH: '', EXCD: inst.exchange!, SYMB: inst.symbol, GUBN: gubn, BYMD: bymd, MODP: '1',
      });
      const list = rows(body.output2).filter((r) => r.xymd);
      if (list.length === 0) break;
      for (const r of list) {
        out.push({ time: kstToUnix(r.xymd!), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.clos), volume: num(r.tvol) });
      }
      const oldest = kstToUnix(list[list.length - 1]!.xymd!) - 86400;
      bymd = ymdKst(oldest * 1000);
    }
    return dedupeSort(out).slice(-limit);
  }

  async function overseasMinutes(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]> {
    const nmin = Math.max(1, Math.round(BAR_SECONDS[bar] / 60));
    const out: Candle[] = [];
    let keyb = '';
    for (let page = 0; page < 5 && out.length < limit; page++) {
      const { body } = await request('/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice', 'HHDFS76950200', {
        AUTH: '', EXCD: inst.exchange!, SYMB: inst.symbol, NMIN: String(nmin), PINC: '1', NEXT: page === 0 ? '' : '1', NREC: '120', FILL: '', KEYB: keyb,
      });
      const list = rows(body.output2).filter((r) => r.kymd && r.khms);
      if (list.length === 0) break;
      for (const r of list) {
        out.push({ time: kstToUnix(r.kymd!, r.khms!), open: num(r.open), high: num(r.high), low: num(r.low), close: num(r.last), volume: num(r.evol) });
      }
      const last = list[list.length - 1]!;
      keyb = `${last.xymd ?? last.kymd}${last.xhms ?? last.khms}`;
    }
    return dedupeSort(out).slice(-limit);
  }

  return {
    async getCandles(inst, bar, limit) {
      if (inst.market === 'kr') {
        if (bar === '1D') return domesticDaily(inst.symbol, 'D', limit);
        if (bar === '1W') return domesticDaily(inst.symbol, 'W', limit);
        return domesticMinutes(inst.symbol, bar, limit);
      }
      if (inst.market === 'us') {
        if (bar === '1D') return overseasDaily(inst, '0', limit);
        if (bar === '1W') return overseasDaily(inst, '1', limit);
        return overseasMinutes(inst, bar, limit);
      }
      throw new KisError('주식 종목만 조회할 수 있습니다');
    },

    async getQuote(inst) {
      if (inst.market === 'kr') {
        const { body } = await request('/uapi/domestic-stock/v1/quotations/inquire-price', 'FHKST01010100', { FID_COND_MRKT_DIV_CODE: 'J', FID_INPUT_ISCD: inst.symbol });
        const o = body.output ?? {};
        return { instrument: inst, price: num(o.stck_prpr), changePct24h: num(o.prdy_ctrt), currency: 'KRW', time: Math.floor(now() / 1000) };
      }
      if (inst.market === 'us') {
        const { body } = await request('/uapi/overseas-price/v1/quotations/price', 'HHDFS00000300', { AUTH: '', EXCD: inst.exchange!, SYMB: inst.symbol });
        const o = body.output ?? {};
        return { instrument: inst, price: num(o.last), changePct24h: num(o.rate), currency: 'USD', time: Math.floor(now() / 1000) };
      }
      throw new KisError('주식 종목만 조회할 수 있습니다');
    },

    async getHoldings() {
      if (!opts.creds) return [];
      const { accountNo, productCode } = opts.creds;
      const out: Holding[] = [];
      const base = { source: 'kis' as const, side: null, leverage: null, liqPrice: null, markPrice: null, unrealizedPnl: null, fundingRate: null };

      let fk = '';
      let nk = '';
      let cont = '';
      for (let page = 0; page < 5; page++) {
        const { body, trCont } = await request('/uapi/domestic-stock/v1/trading/inquire-balance', 'TTTC8434R', {
          CANO: accountNo, ACNT_PRDT_CD: productCode, AFHR_FLPR_YN: 'N', OFL_YN: '', INQR_DVSN: '02', UNPR_DVSN: '01',
          FUND_STTL_ICLD_YN: 'N', FNCG_AMT_AUTO_RDPT_YN: 'N', PRCS_DVSN: '00', CTX_AREA_FK100: fk, CTX_AREA_NK100: nk,
        }, cont);
        for (const r of rows(body.output1)) {
          if (num(r.hldg_qty) <= 0 || !r.pdno) continue;
          const inst = { ...parseInstrumentKey(`kr:${r.pdno}`), name: r.prdt_name ?? null };
          out.push({ instrument: inst, quantity: num(r.hldg_qty), avgPrice: num(r.pchs_avg_pric), currency: 'KRW', ...base });
        }
        if (trCont !== 'M' && trCont !== 'F') break;
        fk = body.ctx_area_fk100 ?? '';
        nk = body.ctx_area_nk100 ?? '';
        cont = 'N';
      }

      fk = ''; nk = ''; cont = '';
      for (let page = 0; page < 5; page++) {
        const { body, trCont } = await request('/uapi/overseas-stock/v1/trading/inquire-balance', 'TTTS3012R', {
          CANO: accountNo, ACNT_PRDT_CD: productCode, OVRS_EXCG_CD: 'NASD', TR_CRCY_CD: 'USD', CTX_AREA_FK200: fk, CTX_AREA_NK200: nk,
        }, cont);
        for (const r of rows(body.output1)) {
          const ex = BALANCE_EXCHANGE[r.ovrs_excg_cd ?? ''];
          if (!ex || !r.ovrs_pdno || num(r.ovrs_cblc_qty) <= 0) continue;
          const inst = { ...parseInstrumentKey(`us:${ex}:${r.ovrs_pdno}`), name: r.ovrs_item_name ?? null };
          out.push({ instrument: inst, quantity: num(r.ovrs_cblc_qty), avgPrice: num(r.pchs_avg_pric), currency: 'USD', ...base });
        }
        if (trCont !== 'M' && trCont !== 'F') break;
        fk = body.ctx_area_fk200 ?? '';
        nk = body.ctx_area_nk200 ?? '';
        cont = 'N';
      }
      return out;
    },
  };
}

function dedupeSort(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}
