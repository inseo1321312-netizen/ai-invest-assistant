import type { Config } from '../config.js';
import type { Db } from '../db.js';
import { assertReadPath } from './kisPaths.js';
import type { Bar, Candle, Instrument, Quote, UsExchange } from './types.js';
import { BAR_SECONDS, parseInstrumentKey } from './types.js';

export { assertReadPath, KIS_READ_PATHS, KisBlockedError } from './kisPaths.js';

const BASE = 'https://openapi.koreainvestment.com:9443';
const TOKEN_KEY = 'kis.token';
const REFRESH_MARGIN_MS = 10 * 60 * 1000;

export class KisError extends Error {}

export interface RankRow { code: string | null; symbol: string | null; exchange: UsExchange | null; name: string; price: number; changePct: number; value: number | null }
export interface IndexQuote { value: number; changePct: number }

export interface KisClient {
  getCandles(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]>;
  getQuote(inst: Instrument): Promise<Quote>;
  /** 지금 뜨는 종목: 상승률(gainers) 또는 거래대금(value) 순위. 미국은 세 거래소를 합친다. */
  getRanking(market: 'kr' | 'us', kind: 'gainers' | 'value'): Promise<RankRow[]>;
  /** 코스피 0001, 코스닥 1001 */
  getIndex(code: '0001' | '1001'): Promise<IndexQuote>;
  /** S&P500 SPX, 나스닥 종합 COMP */
  getUsIndex(symbol: 'SPX' | 'COMP'): Promise<IndexQuote>;
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

const US_EXCHANGES: UsExchange[] = ['NAS', 'NYS', 'AMS'];
const RANK_LIMIT = 20;
const text = (s: unknown): string | null => (typeof s === 'string' && s.trim() ? s.trim() : null);

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

  async function domesticRanking(kind: 'gainers' | 'value'): Promise<RankRow[]> {
    if (kind === 'value') {
      const { body } = await request('/uapi/domestic-stock/v1/quotations/volume-rank', 'FHPST01710000', {
        FID_COND_MRKT_DIV_CODE: 'J', FID_COND_SCR_DIV_CODE: '20171', FID_INPUT_ISCD: '0000', FID_DIV_CLS_CODE: '0', FID_BLNG_CLS_CODE: '3',
        FID_TRGT_CLS_CODE: '111111111', FID_TRGT_EXLS_CLS_CODE: '000000', FID_INPUT_PRICE_1: '', FID_INPUT_PRICE_2: '', FID_VOL_CNT: '', FID_INPUT_DATE_1: '',
      });
      return rows(body.output as unknown as Row[]).map((r) => ({
        code: text(r.mksc_shrn_iscd), symbol: null, exchange: null, name: text(r.hts_kor_isnm) ?? '', price: num(r.stck_prpr), changePct: num(r.prdy_ctrt), value: num(r.acml_tr_pbmn) || null,
      })).filter((r) => r.name).slice(0, RANK_LIMIT);
    }
    const { body } = await request('/uapi/domestic-stock/v1/ranking/fluctuation', 'FHPST01700000', {
      fid_cond_mrkt_div_code: 'J', fid_cond_scr_div_code: '20170', fid_input_iscd: '0000', fid_rank_sort_cls_code: '0', fid_input_cnt_1: '0', fid_prc_cls_code: '1',
      fid_input_price_1: '', fid_input_price_2: '', fid_vol_cnt: '', fid_trgt_cls_code: '0', fid_trgt_exls_cls_code: '0', fid_div_cls_code: '0', fid_rsfl_rate1: '', fid_rsfl_rate2: '',
    });
    // 공식 문서에는 종목코드 필드가 없다. 있으면 쓰고, 없으면 이름으로 찾는다(trending.ts).
    return rows(body.output as unknown as Row[]).map((r) => ({
      code: text(r.stck_shrn_iscd) ?? text(r.mksc_shrn_iscd), symbol: null, exchange: null, name: text(r.hts_kor_isnm) ?? '', price: num(r.stck_prpr), changePct: num(r.prdy_ctrt), value: null,
    })).filter((r) => r.name).slice(0, RANK_LIMIT);
  }

  async function overseasRanking(kind: 'gainers' | 'value'): Promise<RankRow[]> {
    const settled = await Promise.allSettled(US_EXCHANGES.map(async (ex) => {
      const { body } = kind === 'gainers'
        ? await request('/uapi/overseas-stock/v1/ranking/updown-rate', 'HHDFS76290000', { AUTH: '', EXCD: ex, NDAY: '0', GUBN: '1', VOL_RANG: '0', KEYB: '' })
        : await request('/uapi/overseas-stock/v1/ranking/trade-pbmn', 'HHDFS76320010', { AUTH: '', EXCD: ex, NDAY: '0', VOL_RANG: '0', PRC1: '', PRC2: '', KEYB: '' });
      return rows(body.output2).map((r): RankRow => ({
        code: null, symbol: text(r.symb), exchange: ex, name: text(r.name) ?? text(r.ename) ?? text(r.symb) ?? '', price: num(r.last), changePct: num(r.rate), value: num(r.tamt) || null,
      })).filter((r) => r.symbol && /^[A-Z0-9.-]{1,10}$/.test(r.symbol));
    }));
    const ok = settled.filter((s): s is PromiseFulfilledResult<RankRow[]> => s.status === 'fulfilled');
    if (ok.length === 0) throw new KisError('미국 순위를 가져오지 못했습니다');
    const all = ok.flatMap((s) => s.value);
    all.sort((a, b) => (kind === 'gainers' ? b.changePct - a.changePct : (b.value ?? 0) - (a.value ?? 0)));
    return all.slice(0, RANK_LIMIT);
  }

  return {
    async getRanking(market, kind) {
      return market === 'kr' ? domesticRanking(kind) : overseasRanking(kind);
    },

    async getIndex(code) {
      const { body } = await request('/uapi/domestic-stock/v1/quotations/inquire-index-price', 'FHPUP02100000', { FID_COND_MRKT_DIV_CODE: 'U', FID_INPUT_ISCD: code });
      const o = body.output ?? {};
      return { value: num(o.bstp_nmix_prpr), changePct: num(o.bstp_nmix_prdy_ctrt) };
    },

    async getUsIndex(symbol) {
      const t = now();
      const { body } = await request('/uapi/overseas-price/v1/quotations/inquire-daily-chartprice', 'FHKST03030100', {
        FID_COND_MRKT_DIV_CODE: 'N', FID_INPUT_ISCD: symbol, FID_INPUT_DATE_1: ymdKst(t - 10 * 86400_000), FID_INPUT_DATE_2: ymdKst(t), FID_PERIOD_DIV_CODE: 'D',
      });
      const o = (Array.isArray(body.output1) ? body.output1[0] : body.output1) ?? {};
      return { value: num(o.ovrs_nmix_prpr), changePct: num(o.prdy_ctrt) };
    },

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

  };
}

function dedupeSort(candles: Candle[]): Candle[] {
  const map = new Map<number, Candle>();
  for (const c of candles) map.set(c.time, c);
  return [...map.values()].sort((a, b) => a.time - b.time);
}
