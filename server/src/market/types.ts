export type MarketId = 'coin' | 'kr' | 'us';
export type Bar = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';
export type Horizon = 'scalp' | 'swing' | 'long';
export type Currency = 'USDT' | 'KRW' | 'USD';
export type UsExchange = 'NAS' | 'NYS' | 'AMS';

export const MARKETS: readonly MarketId[] = ['coin', 'kr', 'us'];
export const BARS: readonly Bar[] = ['1m', '5m', '15m', '1H', '4H', '1D', '1W'];
export const HORIZONS: readonly Horizon[] = ['scalp', 'swing', 'long'];
export const HORIZON_LABEL: Record<Horizon, string> = { scalp: '단타', swing: '스윙', long: '장기' };
export const BAR_SECONDS: Record<Bar, number> = {
  '1m': 60, '5m': 300, '15m': 900, '1H': 3600, '4H': 14400, '1D': 86400, '1W': 604800,
};

export interface Instrument {
  market: MarketId;
  symbol: string;
  kind: 'spot' | 'swap' | 'stock';
  exchange: UsExchange | null;
  name: string | null;
}

/** 캔들 배열은 항상 오래된 것 → 최신 순. time은 캔들 시작 시각(unix 초). */
export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface Quote { instrument: Instrument; price: number; changePct24h: number; currency: Currency; time: number }

export interface Holding {
  instrument: Instrument;
  quantity: number;
  avgPrice: number;
  currency: Currency;
  source: 'okx' | 'kis' | 'manual';
  side: 'long' | 'short' | null;
  leverage: number | null;
  liqPrice: number | null;
  markPrice: number | null;
  unrealizedPnl: number | null;
  fundingRate: number | null;
}

export const HORIZON_BARS: Record<Horizon, { primary: Bar; primaryLimit: number; secondary: Bar; secondaryLimit: number }> = {
  scalp: { primary: '5m', primaryLimit: 288, secondary: '1H', secondaryLimit: 48 },
  swing: { primary: '4H', primaryLimit: 180, secondary: '1D', secondaryLimit: 120 },
  long: { primary: '1D', primaryLimit: 365, secondary: '1W', secondaryLimit: 104 },
};

/** 주식은 KIS 분봉이 당일(미국은 최근) 것만 나와서 스윙도 일봉으로 본다. */
const STOCK_HORIZON_BARS: typeof HORIZON_BARS = {
  scalp: { primary: '5m', primaryLimit: 78, secondary: '1D', secondaryLimit: 20 },
  swing: { primary: '1D', primaryLimit: 120, secondary: '1W', secondaryLimit: 52 },
  long: HORIZON_BARS.long,
};

export function horizonBars(market: MarketId, horizon: Horizon) {
  return market === 'coin' ? HORIZON_BARS[horizon] : STOCK_HORIZON_BARS[horizon];
}

export const MARKET_CURRENCY: Record<MarketId, Currency> = { coin: 'USDT', kr: 'KRW', us: 'USD' };

const US_EXCHANGES: readonly UsExchange[] = ['NAS', 'NYS', 'AMS'];

export function instrumentKey(i: Instrument): string {
  if (i.market === 'us') return `us:${i.exchange}:${i.symbol}`;
  return `${i.market}:${i.symbol}`;
}

export function parseInstrumentKey(key: string): Instrument {
  const parts = key.split(':');
  const market = parts[0];
  if (market === 'coin' && parts.length === 2 && /^[A-Z0-9]+-[A-Z0-9]+(-SWAP)?$/.test(parts[1]!)) {
    const symbol = parts[1]!;
    return { market: 'coin', symbol, kind: symbol.endsWith('-SWAP') ? 'swap' : 'spot', exchange: null, name: null };
  }
  if (market === 'kr' && parts.length === 2 && /^[0-9A-Z]{6}$/.test(parts[1]!)) {
    return { market: 'kr', symbol: parts[1]!, kind: 'stock', exchange: null, name: null };
  }
  if (market === 'us' && parts.length === 3 && US_EXCHANGES.includes(parts[1] as UsExchange) && /^[A-Z0-9.-]{1,10}$/.test(parts[2]!)) {
    return { market: 'us', symbol: parts[2]!, kind: 'stock', exchange: parts[1] as UsExchange, name: null };
  }
  throw new Error(`잘못된 종목 키: ${key}`);
}
