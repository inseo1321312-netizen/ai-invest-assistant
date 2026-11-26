/** 지금 뜨는 종목: 코인은 OKX 전체 시세에서 계산, 주식은 KIS 순위. 60초 동안 기억한다. */
import type { KisClient } from './kis.js';
import type { OkxTicker } from './okx.js';
import type { Currency, MarketId } from './types.js';

export type TrendKind = 'gainers' | 'value';
export interface TrendItem { key: string; name: string; symbol: string; price: number; changePct: number; value: number | null; currency: Currency }

const TTL_MS = 60_000;
const LIMIT = 10;
/** 거래대금이 이보다 작은 코인은 급등 목록에서 뺀다(잡코인 걸러내기) */
const MIN_COIN_VALUE_USDT = 1_000_000;

export function rankCoins(tickers: OkxTicker[], kind: TrendKind, koName: (base: string) => string | null, limit = LIMIT): TrendItem[] {
  const items: TrendItem[] = [];
  for (const t of tickers) {
    const m = /^([A-Z0-9]+)-USDT$/.exec(t.instId);
    if (!m || !(t.last > 0) || !(t.open24h > 0)) continue;
    if (kind === 'gainers' && t.volCcy24h < MIN_COIN_VALUE_USDT) continue;
    const base = m[1]!;
    items.push({ key: `coin:${base}-USDT`, name: koName(base) ?? base, symbol: base, price: t.last, changePct: (t.last / t.open24h - 1) * 100, value: t.volCcy24h, currency: 'USDT' });
  }
  items.sort((a, b) => (kind === 'gainers' ? b.changePct - a.changePct : (b.value ?? 0) - (a.value ?? 0)));
  return items.slice(0, limit);
}

export interface Trending { get(market: MarketId, kind: TrendKind): Promise<TrendItem[]> }

export function createTrending(deps: {
  okx: { getTickers(instType: 'SPOT'): Promise<OkxTicker[]> };
  kis: Pick<KisClient, 'getRanking'> | null;
  instruments: { koreanCoinName(base: string): string | null; findKrCode(name: string): string | null };
  now: () => number;
}): Trending {
  const cache = new Map<string, { at: number; items: Promise<TrendItem[]> }>();
  let tickers: { at: number; rows: Promise<OkxTicker[]> } | null = null;

  async function load(market: MarketId, kind: TrendKind): Promise<TrendItem[]> {
    if (market === 'coin') {
      if (!tickers || deps.now() - tickers.at >= TTL_MS) tickers = { at: deps.now(), rows: deps.okx.getTickers('SPOT') };
      const rows = await tickers.rows.catch((err) => { tickers = null; throw err; });
      return rankCoins(rows, kind, (b) => deps.instruments.koreanCoinName(b));
    }
    if (!deps.kis) return [];
    const rows = await deps.kis.getRanking(market, kind);
    const out: TrendItem[] = [];
    for (const r of rows) {
      if (market === 'kr') {
        const code = r.code ?? deps.instruments.findKrCode(r.name);
        if (!code || !/^[0-9A-Z]{6}$/.test(code)) continue;
        out.push({ key: `kr:${code}`, name: r.name, symbol: code, price: r.price, changePct: r.changePct, value: r.value, currency: 'KRW' });
      } else if (r.symbol && r.exchange) {
        out.push({ key: `us:${r.exchange}:${r.symbol}`, name: r.name, symbol: r.symbol, price: r.price, changePct: r.changePct, value: r.value, currency: 'USD' });
      }
      if (out.length >= LIMIT) break;
    }
    return out;
  }

  return {
    get(market, kind) {
      const k = `${market}:${kind}`;
      const hit = cache.get(k);
      if (hit && deps.now() - hit.at < TTL_MS) return hit.items;
      const items = load(market, kind);
      cache.set(k, { at: deps.now(), items });
      items.catch(() => cache.delete(k));
      return items;
    },
  };
}
