/** 종목 화면의 추가 정보: 주식은 기본 지표(KIS), 코인은 선물 지표(OKX)와 김치 프리미엄(업비트). */
import type { KisClient, StockInfo } from './kis.js';
import type { OkxClient } from './okx.js';
import { parseInstrumentKey } from './types.js';
import type { UpbitClient } from './upbit.js';

export interface CoinInfo {
  fundingRate: number | null;
  openInterestUsd: number | null;
  longShortRatio: number | null;
  liq1h: { longUsd: number; shortUsd: number } | null;
  kimchiPct: number | null;
  upbitWarning: boolean;
  upbitCautions: string[];
}

export interface InstrumentInfo { get(key: string): Promise<{ stock: StockInfo | null; coin: CoinInfo | null }> }

const COIN_TTL_MS = 60_000;
const STOCK_TTL_MS = 10 * 60_000;

export function createInstrumentInfo(deps: {
  kis: Pick<KisClient, 'getBasicInfo'> | null;
  okx: Pick<OkxClient, 'getFundingRate' | 'getOpenInterest' | 'getLongShortRatio' | 'getLiquidations' | 'getQuote'>;
  upbit: Pick<UpbitClient, 'krwPrices' | 'markets'>;
  fx: () => Promise<number | null>;
  now: () => number;
}): InstrumentInfo {
  const cache = new Map<string, { at: number; ttl: number; value: Promise<{ stock: StockInfo | null; coin: CoinInfo | null }> }>();
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  async function coinInfo(base: string): Promise<CoinInfo> {
    const swap = `${base}-USDT-SWAP`;
    const [fundingRate, oi, ratio, liqs, prices, markets, spot, fx] = await Promise.all([
      safe(deps.okx.getFundingRate(swap)),
      safe(deps.okx.getOpenInterest(swap)),
      safe(deps.okx.getLongShortRatio(base)),
      safe(deps.okx.getLiquidations(`${base}-USDT`)),
      safe(deps.upbit.krwPrices()),
      safe(deps.upbit.markets()),
      safe(deps.okx.getQuote(`${base}-USDT`)),
      safe(deps.fx()),
    ]);
    const since = deps.now() - 3600_000;
    const recent = liqs?.filter((l) => l.ts >= since) ?? null;
    const upbitPrice = prices?.get(base) ?? null;
    const market = markets?.find((m) => m.market === `KRW-${base}`) ?? null;
    return {
      fundingRate,
      openInterestUsd: oi?.oiUsd ?? null,
      longShortRatio: ratio,
      liq1h: recent ? {
        longUsd: recent.filter((l) => l.side === 'long').reduce((s, l) => s + l.usd, 0),
        shortUsd: recent.filter((l) => l.side === 'short').reduce((s, l) => s + l.usd, 0),
      } : null,
      kimchiPct: upbitPrice && spot?.price && fx ? (upbitPrice / (spot.price * fx) - 1) * 100 : null,
      upbitWarning: market?.warning ?? false,
      upbitCautions: market?.cautions ?? [],
    };
  }

  return {
    get(key) {
      const inst = parseInstrumentKey(key);
      const hit = cache.get(key);
      if (hit && deps.now() - hit.at < hit.ttl) return hit.value;
      const value = inst.market === 'coin'
        ? coinInfo(inst.symbol.split('-')[0]!).then((coin) => ({ stock: null, coin }))
        : (deps.kis ? safe(deps.kis.getBasicInfo(inst)) : Promise.resolve(null)).then((stock) => ({ stock, coin: null }));
      cache.set(key, { at: deps.now(), ttl: inst.market === 'coin' ? COIN_TTL_MS : STOCK_TTL_MS, value });
      if (cache.size > 300) cache.delete(cache.keys().next().value!);
      return value;
    },
  };
}
