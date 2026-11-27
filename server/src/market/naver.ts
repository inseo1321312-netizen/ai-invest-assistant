/**
 * 네이버 증권(키 없음, 공식 API 아님): 한국·미국 주식 시세·차트·순위·지수·기본 지표.
 * 미국 분봉은 네이버에 없어서 야후 파이낸스 차트를 쓴다.
 * 확인: 2026-11-26 실제 응답(polling.finance.naver.com, api.stock.naver.com, m.stock.naver.com, ac.stock.naver.com).
 * 형식이 바뀌면 이 파일만 고치면 된다. 한투 앱키가 있으면 한투를 먼저 쓰고, 실패할 때 여기로 넘어온다.
 */
import { aggregate, type IndexQuote, type KisClient, type RankRow, type StockInfo } from './kis.js';
import type { Bar, Candle, Instrument, Quote, UsExchange } from './types.js';
import { BAR_SECONDS } from './types.js';

export type StockSource = Pick<KisClient, 'getQuote' | 'getCandles' | 'getRanking' | 'getIndex' | 'getUsIndex' | 'getBasicInfo'>;
/** 네이버 클라이언트: 시세 출처 + 미국 기호의 네이버 코드(로고 주소에 쓴다) */
/** 금·은·구리 선물(네이버 시장지표 코드) */
export type MetalCode = 'GCcv1' | 'SIcv1' | 'HGcv1';
export type NaverClient = StockSource & { usCode(inst: Instrument): Promise<string>; getMetal(code: MetalCode): Promise<IndexQuote> };

const UA = { 'user-agent': 'Mozilla/5.0', accept: 'application/json' };
const RANK_LIMIT = 20;
/** 미국 급등 순위에서 시가총액이 이보다 작은 회사는 뺀다(네이버 marketValue 단위: 천 달러 → 5억 달러) */
const MIN_US_MARKET_VALUE = 500_000;
const EXCHANGE_OF: Record<string, UsExchange> = { NSQ: 'NAS', NAS: 'NAS', NASDAQ: 'NAS', NYS: 'NYS', NYSE: 'NYS', AMX: 'AMS', AMS: 'AMS', AMEX: 'AMS' };
const US_INDEX: Record<'SPX' | 'COMP', string> = { SPX: '.INX', COMP: '.IXIC' };
const KR_INDEX: Record<'0001' | '1001', string> = { '0001': 'KOSPI', '1001': 'KOSDAQ' };

/** "1,002조 6,368억", "5.39배", "192억 USD", "31,809원" → 숫자. 모르면 null */
export function parseKoNumber(s: unknown): number | null {
  if (typeof s === 'number') return Number.isFinite(s) ? s : null;
  if (typeof s !== 'string') return null;
  const units: Record<string, number> = { 조: 1e12, 억: 1e8, 만: 1e4 };
  let total = 0;
  let found = false;
  for (const m of s.replace(/,/g, '').matchAll(/(-?\d+(?:\.\d+)?)\s*(조|억|만)?/g)) {
    total += Number(m[1]) * (m[2] ? units[m[2]]! : 1);
    found = true;
  }
  return found && Number.isFinite(total) ? Math.round(total * 1e6) / 1e6 : null;
}

const num = (s: unknown): number => parseKoNumber(s) ?? 0;
/** 하락(4: 하한, 5: 하락)인데 부호가 없으면 붙인다 */
interface Realtime {
  closePrice?: string;
  fluctuationsRatio?: string;
  compareToPreviousPrice?: { code?: string };
  marketStatus?: string;
  localTradedAt?: string;
  overMarketPriceInfo?: { tradingSessionType?: string; overMarketStatus?: string; overPrice?: string; localTradedAt?: string } | null;
}

const unixOf = (s: unknown): number | null => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN;
  return Number.isFinite(t) ? Math.floor(t / 1000) : null;
};

/** 네이버 장 상태: 알면 { open }, 모르면 {} */
const openOf = (d: Realtime): { open?: boolean } => (d.marketStatus === 'OPEN' ? { open: true } : d.marketStatus === 'CLOSE' ? { open: false } : {});
/** 마지막 체결 시각(알 때만): 밤사이에 장이 있었는지 가리는 데 쓴다 */
const tradedOf = (d: Realtime): { tradedAt?: number } => { const t = unixOf(d.localTradedAt); return t === null ? {} : { tradedAt: t }; };

/** 네이버가 알려 주는 장 상태(공휴일 포함)와 프리·애프터마켓 가격을 붙인다 */
function withSession(quote: Quote, d: Realtime): Quote {
  if (d.marketStatus !== 'OPEN' && d.marketStatus !== 'CLOSE' && d.marketStatus !== 'PREOPEN') return quote;
  const o = d.overMarketPriceInfo;
  const over = o ? parseKoNumber(o.overPrice) : null;
  const kind = o?.tradingSessionType === 'PRE_MARKET' ? 'pre' : o?.tradingSessionType === 'AFTER_MARKET' ? 'after' : null;
  const extended = o && kind && over !== null && over > 0 && quote.price > 0
    ? { kind, open: o.overMarketStatus === 'OPEN', price: over, changePct: ((over - quote.price) / quote.price) * 100, tradedAt: unixOf(o.localTradedAt) } as const
    : null;
  // 네이버는 시간외(NXT 애프터마켓 등)가 열려 있으면 OPEN이라고 한다: 그때 정규장은 닫힌 것으로 본다
  return { ...quote, session: { open: d.marketStatus === 'OPEN' && !extended?.open, ...(d.marketStatus === 'PREOPEN' ? { beforeOpen: true } : {}), tradedAt: unixOf(d.localTradedAt), extended } };
}

function signedPct(ratio: unknown, code: unknown): number {
  const v = num(ratio);
  return (code === '4' || code === '5') && v > 0 ? -v : v;
}

function ymd(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10).replace(/-/g, '');
}
function kstUnix(ymdStr: string, hms = '000000'): number {
  return Math.floor(Date.parse(`${ymdStr.slice(0, 4)}-${ymdStr.slice(4, 6)}-${ymdStr.slice(6, 8)}T${hms.slice(0, 2)}:${hms.slice(2, 4)}:${hms.slice(4, 6)}+09:00`) / 1000);
}

export function createNaverClient(deps: { fetch: typeof fetch; now?: () => number }): NaverClient {
  const now = deps.now ?? Date.now;
  /** 미국 기호 → 네이버 코드(AAPL → AAPL.O, KO → KO, DELL → DELL.K) */
  const reuters = new Map<string, string>();

  async function get<T>(url: string): Promise<T> {
    const res = await deps.fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`네이버 증권 오류 (${res.status})`);
    return (await res.json()) as T;
  }

  async function usCode(inst: Instrument): Promise<string> {
    const hit = reuters.get(inst.symbol);
    if (hit) return hit;
    try {
      const r = await get<{ items?: { code: string; reutersCode: string; nationCode: string }[] }>(`https://ac.stock.naver.com/ac?${new URLSearchParams({ q: inst.symbol, target: 'stock' })}`);
      const item = r.items?.find((i) => i.nationCode === 'USA' && i.code.toUpperCase() === inst.symbol.toUpperCase());
      if (item?.reutersCode) {
        reuters.set(inst.symbol, item.reutersCode);
        return item.reutersCode;
      }
    } catch { /* 아래 규칙으로 */ }
    return inst.exchange === 'NAS' ? `${inst.symbol}.O` : inst.symbol;
  }

  async function realtime(path: string): Promise<Realtime> {
    const r = await get<{ datas?: Realtime[] }>(`https://polling.finance.naver.com/api/realtime/${path}`);
    const d = r.datas?.[0];
    if (!d || !(num(d.closePrice) > 0)) throw new Error('네이버 증권 시세가 비어 있습니다');
    return d;
  }

  type DayRow = { localDate: string; openPrice: number; highPrice: number; lowPrice: number; closePrice: number; accumulatedTradingVolume: number };

  async function chart(kind: 'domestic' | 'foreign', code: string, period: 'day' | 'week', limit: number): Promise<Candle[]> {
    const spanDays = period === 'day' ? Math.ceil(limit * 1.6) + 10 : limit * 7 + 14;
    const url = `https://api.stock.naver.com/chart/${kind}/item/${encodeURIComponent(code)}/${period}?startDateTime=${ymd(now() - spanDays * 86400_000)}0000&endDateTime=${ymd(now())}2359`;
    const rows = await get<DayRow[]>(url);
    return (Array.isArray(rows) ? rows : [])
      .filter((r) => r.localDate && r.closePrice > 0)
      .map((r) => ({ time: kstUnix(r.localDate), open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.closePrice, volume: r.accumulatedTradingVolume ?? 0 }))
      .sort((a, b) => a.time - b.time)
      .slice(-limit);
  }

  async function krMinutes(code: string, bar: Bar, limit: number): Promise<Candle[]> {
    const url = `https://api.stock.naver.com/chart/domestic/item/${code}/minute?startDateTime=${ymd(now() - 4 * 86400_000)}0900&endDateTime=${ymd(now())}1530`;
    const rows = await get<{ localDateTime: string; openPrice: number; highPrice: number; lowPrice: number; currentPrice: number; accumulatedTradingVolume: number }[]>(url);
    const ones = (Array.isArray(rows) ? rows : [])
      .filter((r) => r.localDateTime && r.currentPrice > 0)
      .map((r) => ({ time: kstUnix(r.localDateTime.slice(0, 8), r.localDateTime.slice(8, 14)), open: r.openPrice, high: r.highPrice, low: r.lowPrice, close: r.currentPrice, volume: r.accumulatedTradingVolume ?? 0 }))
      .sort((a, b) => a.time - b.time);
    return aggregate(ones, BAR_SECONDS[bar]).slice(-limit);
  }

  async function usMinutes(inst: Instrument, bar: Bar, limit: number): Promise<Candle[]> {
    const interval = bar === '1m' ? '1m' : bar === '15m' ? '15m' : bar === '1H' || bar === '4H' ? '60m' : '5m';
    const sym = inst.symbol.replace(/\./g, '-');
    const r = await get<{ chart?: { result?: { timestamp?: number[]; indicators?: { quote?: { open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }[] } }[] } }>(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?${new URLSearchParams({ range: '5d', interval })}`,
    );
    const res = r.chart?.result?.[0];
    const q = res?.indicators?.quote?.[0];
    const ts = res?.timestamp ?? [];
    const out: Candle[] = [];
    ts.forEach((t, i) => {
      const o = q?.open[i]; const h = q?.high[i]; const l = q?.low[i]; const c = q?.close[i];
      if (o == null || h == null || l == null || c == null) return;
      out.push({ time: t, open: o, high: h, low: l, close: c, volume: q?.volume[i] ?? 0 });
    });
    return bar === '4H' ? aggregate(out, BAR_SECONDS['4H']).slice(-limit) : out.slice(-limit);
  }

  type KrRankItem = { itemCode: string; stockName: string; closePrice: string; fluctuationsRatio: string; accumulatedTradingValue?: string; stockEndType?: string; compareToPreviousPrice?: { code?: string } };
  type UsRankItem = { symbolCode: string; reutersCode: string; stockName: string; closePrice: string; fluctuationsRatio: string; accumulatedTradingValue?: string; marketValue?: string; stockEndType?: string; stockExchangeType?: { code?: string }; compareToPreviousPrice?: { code?: string } };

  async function krRanking(kind: 'gainers' | 'value'): Promise<RankRow[]> {
    const lists = kind === 'gainers'
      ? ['up/KOSPI', 'up/KOSDAQ']
      : ['quantTop/KOSPI', 'quantTop/KOSDAQ', 'marketValue/KOSPI'];
    const settled = await Promise.allSettled(lists.map((p) => get<{ stocks?: KrRankItem[] }>(`https://m.stock.naver.com/api/stocks/${p}?page=1&pageSize=50`)));
    const seen = new Set<string>();
    const rows: RankRow[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const it of s.value.stocks ?? []) {
        if (it.stockEndType !== 'stock' || seen.has(it.itemCode) || !/^[0-9A-Z]{6}$/.test(it.itemCode)) continue;
        seen.add(it.itemCode);
        // 거래대금 단위: 백만 원
        rows.push({ code: it.itemCode, symbol: null, exchange: null, name: it.stockName, price: num(it.closePrice), changePct: signedPct(it.fluctuationsRatio, it.compareToPreviousPrice?.code), value: it.accumulatedTradingValue ? num(it.accumulatedTradingValue) * 1e6 : null });
      }
    }
    if (rows.length === 0 && settled.every((s) => s.status === 'rejected')) throw new Error('네이버 증권 순위를 가져오지 못했습니다');
    rows.sort((a, b) => (kind === 'gainers' ? b.changePct - a.changePct : (b.value ?? 0) - (a.value ?? 0)));
    return rows.slice(0, RANK_LIMIT);
  }

  async function usRanking(kind: 'gainers' | 'value'): Promise<RankRow[]> {
    const sort = kind === 'gainers' ? 'up' : 'marketValue';
    const settled = await Promise.allSettled(['NASDAQ', 'NYSE', 'AMEX'].map((ex) => get<{ stocks?: UsRankItem[] }>(`https://api.stock.naver.com/stock/exchange/${ex}/${sort}?page=1&pageSize=50`)));
    const rows: RankRow[] = [];
    for (const s of settled) {
      if (s.status !== 'fulfilled') continue;
      for (const it of s.value.stocks ?? []) {
        const exchange = EXCHANGE_OF[it.stockExchangeType?.code ?? ''];
        if (it.stockEndType !== 'stock' || !exchange || !/^[A-Z0-9.-]{1,10}$/.test(it.symbolCode ?? '')) continue;
        if (kind === 'gainers' && num(it.marketValue) < MIN_US_MARKET_VALUE) continue;
        if (it.reutersCode) reuters.set(it.symbolCode, it.reutersCode);
        rows.push({ code: null, symbol: it.symbolCode, exchange, name: it.stockName, price: num(it.closePrice), changePct: signedPct(it.fluctuationsRatio, it.compareToPreviousPrice?.code), value: it.accumulatedTradingValue ? num(it.accumulatedTradingValue) : null });
      }
    }
    if (rows.length === 0 && settled.every((s) => s.status === 'rejected')) throw new Error('네이버 증권 순위를 가져오지 못했습니다');
    rows.sort((a, b) => (kind === 'gainers' ? b.changePct - a.changePct : (b.value ?? 0) - (a.value ?? 0)));
    return rows.slice(0, RANK_LIMIT);
  }

  function infoFrom(list: { code: string; value: string }[] | undefined, currency: 'KRW' | 'USD'): StockInfo {
    const v = (code: string) => {
      const n = parseKoNumber(list?.find((x) => x.code === code)?.value);
      return n === null || n === 0 ? null : n;
    };
    return { marketCap: v('marketValue'), per: v('per'), pbr: v('pbr'), eps: v('eps'), high52: v('highPriceOf52Weeks'), low52: v('lowPriceOf52Weeks'), currency };
  }

  return {
    usCode,

    async getQuote(inst) {
      if (inst.market === 'kr') {
        const d = await realtime(`domestic/stock/${inst.symbol}`);
        return withSession({ instrument: inst, price: num(d.closePrice), changePct24h: signedPct(d.fluctuationsRatio, d.compareToPreviousPrice?.code), currency: 'KRW', time: Math.floor(now() / 1000) }, d);
      }
      if (inst.market === 'us') {
        const d = await realtime(`worldstock/stock/${encodeURIComponent(await usCode(inst))}`);
        return withSession({ instrument: inst, price: num(d.closePrice), changePct24h: signedPct(d.fluctuationsRatio, d.compareToPreviousPrice?.code), currency: 'USD', time: Math.floor(now() / 1000) }, d);
      }
      throw new Error('주식 종목만 조회할 수 있습니다');
    },

    async getCandles(inst, bar, limit) {
      if (inst.market === 'kr') {
        if (bar === '1D') return chart('domestic', inst.symbol, 'day', limit);
        if (bar === '1W') return chart('domestic', inst.symbol, 'week', limit);
        return krMinutes(inst.symbol, bar, limit);
      }
      if (inst.market === 'us') {
        if (bar === '1D') return chart('foreign', await usCode(inst), 'day', limit);
        if (bar === '1W') return chart('foreign', await usCode(inst), 'week', limit);
        return usMinutes(inst, bar, limit);
      }
      throw new Error('주식 종목만 조회할 수 있습니다');
    },

    getRanking: (market, kind) => (market === 'kr' ? krRanking(kind) : usRanking(kind)),

    async getIndex(code) {
      const d = await realtime(`domestic/index/${KR_INDEX[code]}`);
      return { value: num(d.closePrice), changePct: signedPct(d.fluctuationsRatio, d.compareToPreviousPrice?.code), ...openOf(d), ...tradedOf(d) } satisfies IndexQuote;
    },

    async getMetal(code) {
      const d = await get<Realtime & { fluctuationsType?: { code?: string } }>(`https://api.stock.naver.com/marketindex/metals/${code}`);
      if (!d.closePrice) throw new Error('시세 없음');
      return { value: num(d.closePrice), changePct: signedPct(d.fluctuationsRatio, d.fluctuationsType?.code), ...openOf(d), ...tradedOf(d) };
    },

    async getUsIndex(symbol) {
      const d = await realtime(`worldstock/index/${US_INDEX[symbol]}`);
      return { value: num(d.closePrice), changePct: signedPct(d.fluctuationsRatio, d.compareToPreviousPrice?.code), ...openOf(d), ...tradedOf(d) };
    },

    async getBasicInfo(inst) {
      if (inst.market === 'kr') {
        const r = await get<{ totalInfos?: { code: string; value: string }[] }>(`https://m.stock.naver.com/api/stock/${inst.symbol}/integration`);
        return infoFrom(r.totalInfos, 'KRW');
      }
      if (inst.market === 'us') {
        const r = await get<{ stockItemTotalInfos?: { code: string; value: string }[] }>(`https://api.stock.naver.com/stock/${encodeURIComponent(await usCode(inst))}/basic`);
        return infoFrom(r.stockItemTotalInfos, 'USD');
      }
      throw new Error('주식 종목만 조회할 수 있습니다');
    },
  };
}

/** 앞 출처(한투)를 먼저 쓰고, 실패하면 뒤 출처(네이버)로 */
export function withFallback<T extends object>(primary: T, secondary: T, methods: (keyof T)[]): T {
  const out = {} as T;
  for (const m of methods) {
    (out as Record<keyof T, unknown>)[m] = async (...args: unknown[]) => {
      try {
        return await (primary[m] as (...a: unknown[]) => Promise<unknown>).apply(primary, args);
      } catch {
        return (secondary[m] as (...a: unknown[]) => Promise<unknown>).apply(secondary, args);
      }
    };
  }
  return out;
}
