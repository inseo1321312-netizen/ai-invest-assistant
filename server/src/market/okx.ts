import type { Bar, Candle, Quote } from './types.js';
import { parseInstrumentKey } from './types.js';

const BASE = 'https://www.okx.com';
const MAX_CANDLES = 300;
const MAX_HISTORY = 100;

export class OkxError extends Error {
  constructor(public code: string, msg: string) {
    super(`OKX 오류 ${code}: ${msg}`);
  }
}

export interface OkxTicker { instId: string; last: number; open24h: number; volCcy24h: number }

export interface OkxLiquidation { side: 'long' | 'short'; usd: number; ts: number }
export interface OkxAnnouncement { type: string; title: string; url: string; ts: number }

export interface OkxClient {
  getOpenInterest(instId: string): Promise<{ oiUsd: number }>;
  /** 롱·숏 계정 비율(최근 1시간 단위 값) */
  getLongShortRatio(ccy: string): Promise<number | null>;
  /** 최근 청산 내역. uly 예: BTC-USDT */
  getLiquidations(uly: string): Promise<OkxLiquidation[]>;
  getAnnouncements(): Promise<OkxAnnouncement[]>;
  /** 전체 시세. SPOT의 volCcy24h는 호가 화폐(USDT 등) 기준 24시간 거래대금 */
  getTickers(instType: 'SPOT' | 'SWAP'): Promise<OkxTicker[]>;
  getCandles(instId: string, bar: Bar, limit: number): Promise<Candle[]>;
  getQuote(instId: string): Promise<Quote>;
  getFundingRate(instId: string): Promise<number | null>;
}

const OKX_BAR: Record<Bar, string> = { '1m': '1m', '5m': '5m', '15m': '15m', '1H': '1H', '4H': '4H', '1D': '1Dutc', '1W': '1Wutc' };

const num = (s: unknown): number => {
  const n = typeof s === 'string' ? Number(s) : typeof s === 'number' ? s : NaN;
  return Number.isFinite(n) ? n : 0;
};
const numOrNull = (s: unknown): number | null => (s === '' || s === undefined || s === null ? null : Number.isFinite(Number(s)) ? Number(s) : null);

function toCandle(row: string[]): Candle {
  return { time: Math.floor(num(row[0]) / 1000), open: num(row[1]), high: num(row[2]), low: num(row[3]), close: num(row[4]), volume: num(row[5]) };
}

/** OKX 공개 API만 쓴다(키 없음). */
export function createOkxClient(opts: { fetchImpl?: typeof fetch } = {}): OkxClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const ctValCache = new Map<string, number>();

  async function call<T>(path: string, query: Record<string, string>): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const headers: Record<string, string> = { accept: 'application/json' };
    const res = await doFetch(BASE + requestPath, { method: 'GET', headers });
    const json = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
    if (!json || json.code !== '0') throw new OkxError(json?.code ?? String(res.status), json?.msg ?? res.statusText);
    return json.data as T;
  }

  async function getFundingRate(instId: string): Promise<number | null> {
    const data = await call<{ fundingRate: string }[]>('/api/v5/public/funding-rate', { instId });
    return numOrNull(data[0]?.fundingRate);
  }

  async function contractValue(instId: string): Promise<number> {
    const cached = ctValCache.get(instId);
    if (cached !== undefined) return cached;
    const data = await call<{ ctVal: string }[]>('/api/v5/public/instruments', { instType: 'SWAP', instId });
    const v = num(data[0]?.ctVal) || 1;
    ctValCache.set(instId, v);
    return v;
  }

  return {
    async getCandles(instId, bar, limit) {
      const rows: string[][] = [];
      const first = await call<string[][]>('/api/v5/market/candles', { instId, bar: OKX_BAR[bar], limit: String(Math.min(limit, MAX_CANDLES)) });
      rows.push(...first);
      while (rows.length < limit && rows.length > 0) {
        const oldest = rows[rows.length - 1]![0]!;
        const page = await call<string[][]>('/api/v5/market/history-candles', {
          instId, bar: OKX_BAR[bar], after: oldest, limit: String(Math.min(limit - rows.length, MAX_HISTORY)),
        });
        if (page.length === 0) break;
        rows.push(...page);
      }
      return rows.slice(0, limit).map(toCandle).reverse();
    },

    async getQuote(instId) {
      const [t] = await call<{ last: string; open24h: string; ts: string }[]>('/api/v5/market/ticker', { instId });
      if (!t) throw new OkxError('empty', `${instId} 시세 없음`);
      const last = num(t.last);
      const open = num(t.open24h);
      return {
        instrument: parseInstrumentKey(`coin:${instId}`),
        price: last,
        changePct24h: open ? ((last - open) / open) * 100 : 0,
        currency: 'USDT',
        time: Math.floor(num(t.ts) / 1000),
      };
    },

    getFundingRate,

    async getOpenInterest(instId) {
      const data = await call<{ oiUsd: string }[]>('/api/v5/public/open-interest', { instType: 'SWAP', instId });
      return { oiUsd: num(data[0]?.oiUsd) };
    },

    async getLongShortRatio(ccy) {
      const data = await call<string[][]>('/api/v5/rubik/stat/contracts/long-short-account-ratio', { ccy, period: '1H' });
      return numOrNull(data[0]?.[1]);
    },

    async getLiquidations(uly) {
      const data = await call<{ details?: { bkPx: string; posSide: string; sz: string; ts: string }[] }[]>('/api/v5/public/liquidation-orders', { instType: 'SWAP', uly, state: 'filled' });
      const ctVal = await contractValue(`${uly}-SWAP`).catch(() => 1);
      return (data[0]?.details ?? []).map((d) => ({ side: d.posSide === 'long' ? 'long' as const : 'short' as const, usd: num(d.sz) * num(d.bkPx) * ctVal, ts: num(d.ts) }));
    },

    async getAnnouncements() {
      const data = await call<{ details?: { annType: string; title: string; url: string; pTime: string }[] }[]>('/api/v5/support/announcements', {});
      return (data[0]?.details ?? []).map((d) => ({ type: d.annType, title: d.title, url: d.url, ts: num(d.pTime) }));
    },

    async getTickers(instType) {
      const rows = await call<{ instId: string; last: string; open24h: string; volCcy24h: string }[]>('/api/v5/market/tickers', { instType });
      return rows.map((r) => ({ instId: r.instId, last: num(r.last), open24h: num(r.open24h), volCcy24h: num(r.volCcy24h) }));
    },
  };
}
