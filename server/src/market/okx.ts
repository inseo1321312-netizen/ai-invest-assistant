import crypto from 'node:crypto';
import type { Config } from '../config.js';
import type { Bar, Candle, Holding, Quote } from './types.js';
import { parseInstrumentKey } from './types.js';

const BASE = 'https://www.okx.com';
const MAX_CANDLES = 300;
const MAX_HISTORY = 100;

export class OkxError extends Error {
  constructor(public code: string, msg: string) {
    super(`OKX 오류 ${code}: ${msg}`);
  }
}

export interface OkxClient {
  getCandles(instId: string, bar: Bar, limit: number): Promise<Candle[]>;
  getQuote(instId: string): Promise<Quote>;
  getHoldings(): Promise<Holding[]>;
  getFundingRate(instId: string): Promise<number | null>;
  /** 마지막 보유 조회에서 지원하지 않아 뺀 상품 ID */
  unsupported(): string[];
}

export function okxSign(secret: string, timestamp: string, method: string, requestPath: string, body: string): string {
  return crypto.createHmac('sha256', secret).update(timestamp + method + requestPath + body).digest('base64');
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

export function createOkxClient(opts: { creds: Config['okx']; fetchImpl?: typeof fetch; now?: () => Date }): OkxClient {
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => new Date());
  const ctValCache = new Map<string, number>();
  let skipped: string[] = [];
  const tryKey = (instId: string) => { try { return parseInstrumentKey(`coin:${instId}`); } catch { skipped.push(instId); return null; } };

  async function call<T>(path: string, query: Record<string, string>, signed: boolean): Promise<T> {
    const qs = new URLSearchParams(query).toString();
    const requestPath = qs ? `${path}?${qs}` : path;
    const headers: Record<string, string> = { accept: 'application/json' };
    if (signed) {
      if (!opts.creds) throw new OkxError('auth', 'API 키가 없습니다');
      const ts = now().toISOString();
      headers['OK-ACCESS-KEY'] = opts.creds.key;
      headers['OK-ACCESS-SIGN'] = okxSign(opts.creds.secret, ts, 'GET', requestPath, '');
      headers['OK-ACCESS-TIMESTAMP'] = ts;
      headers['OK-ACCESS-PASSPHRASE'] = opts.creds.passphrase;
    }
    const res = await doFetch(BASE + requestPath, { method: 'GET', headers });
    const json = (await res.json().catch(() => null)) as { code?: string; msg?: string; data?: T } | null;
    if (!json || json.code !== '0') throw new OkxError(json?.code ?? String(res.status), json?.msg ?? res.statusText);
    return json.data as T;
  }

  async function getFundingRate(instId: string): Promise<number | null> {
    const data = await call<{ fundingRate: string }[]>('/api/v5/public/funding-rate', { instId }, false);
    return numOrNull(data[0]?.fundingRate);
  }

  async function contractValue(instId: string): Promise<number> {
    const cached = ctValCache.get(instId);
    if (cached !== undefined) return cached;
    const data = await call<{ ctVal: string }[]>('/api/v5/public/instruments', { instType: 'SWAP', instId }, false);
    const v = num(data[0]?.ctVal) || 1;
    ctValCache.set(instId, v);
    return v;
  }

  return {
    async getCandles(instId, bar, limit) {
      const rows: string[][] = [];
      const first = await call<string[][]>('/api/v5/market/candles', { instId, bar: OKX_BAR[bar], limit: String(Math.min(limit, MAX_CANDLES)) }, false);
      rows.push(...first);
      while (rows.length < limit && rows.length > 0) {
        const oldest = rows[rows.length - 1]![0]!;
        const page = await call<string[][]>('/api/v5/market/history-candles', {
          instId, bar: OKX_BAR[bar], after: oldest, limit: String(Math.min(limit - rows.length, MAX_HISTORY)),
        }, false);
        if (page.length === 0) break;
        rows.push(...page);
      }
      return rows.slice(0, limit).map(toCandle).reverse();
    },

    async getQuote(instId) {
      const [t] = await call<{ last: string; open24h: string; ts: string }[]>('/api/v5/market/ticker', { instId }, false);
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
    unsupported: () => [...skipped],

    async getHoldings() {
      if (!opts.creds) return [];
      const [balance, positions] = await Promise.all([
        call<{ details: { ccy: string; eq: string; eqUsd: string; accAvgPx?: string; openAvgPx?: string }[] }[]>('/api/v5/account/balance', {}, true),
        call<{ instId: string; posSide: string; pos: string; avgPx: string; lever: string; liqPx: string; markPx: string; upl: string }[]>('/api/v5/account/positions', {}, true),
      ]);
      const out: Holding[] = [];
      skipped = [];
      for (const p of positions) {
        const pos = num(p.pos);
        if (pos === 0) continue;
        const posInst = tryKey(p.instId);
        if (!posInst) continue;
        const side: 'long' | 'short' = p.posSide === 'long' ? 'long' : p.posSide === 'short' ? 'short' : pos > 0 ? 'long' : 'short';
        const [ctVal, fundingRate] = await Promise.all([
          p.instId.endsWith('-SWAP') ? contractValue(p.instId) : Promise.resolve(1),
          p.instId.endsWith('-SWAP') ? getFundingRate(p.instId).catch(() => null) : Promise.resolve(null),
        ]);
        out.push({
          instrument: posInst,
          quantity: Math.round(Math.abs(pos) * ctVal * 1e10) / 1e10,
          avgPrice: num(p.avgPx),
          currency: 'USDT',
          source: 'okx',
          side,
          leverage: numOrNull(p.lever),
          liqPrice: numOrNull(p.liqPx),
          markPrice: numOrNull(p.markPx),
          unrealizedPnl: numOrNull(p.upl),
          fundingRate,
        });
      }
      for (const d of balance[0]?.details ?? []) {
        if (d.ccy === 'USDT' || num(d.eqUsd) < 1) continue;
        const spotInst = tryKey(`${d.ccy}-USDT`);
        if (!spotInst) continue;
        const avg = numOrNull(d.accAvgPx) ?? numOrNull(d.openAvgPx) ?? 0;
        out.push({
          instrument: spotInst,
          quantity: num(d.eq),
          avgPrice: avg,
          currency: 'USDT',
          source: 'okx',
          side: null,
          leverage: null,
          liqPrice: null,
          markPrice: null,
          unrealizedPnl: null,
          fundingRate: null,
        });
      }
      return out;
    },
  };
}
