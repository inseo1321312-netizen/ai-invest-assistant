export type MarketId = 'coin' | 'kr' | 'us';
export type Currency = 'USDT' | 'KRW' | 'USD';
export type Horizon = 'scalp' | 'swing' | 'long';
export type Bar = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';
export type ProviderId = 'claude' | 'gpt';
export type Confidence = '낮음' | '중간' | '높음';

export interface Instrument { market: MarketId; symbol: string; kind: 'spot' | 'swap' | 'stock'; exchange: string | null; name: string | null }
export interface Quote { price: number; changePct24h: number; currency: Currency; time: number }
export interface Badge { opinion: string; confidence: Confidence; dataTime: number; provider: ProviderId }

export interface HoldingView {
  key: string;
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
  quote: Quote | null;
  krwValue: number | null;
  pnlPct: number | null;
  badge: Badge | null;
  manualId?: number;
}

export interface QuoteView { key: string; instrument: Instrument; quote: Quote | null; krwValue: number | null; badge: Badge | null }

export interface Overview { holdings: HoldingView[]; watchlist: QuoteView[]; usdKrw: number | null; connected: boolean; errors: string[] }

export interface FeedItem { id: number; createdAt: number; day: string; kind: 'briefing' | 'breaking' | 'spike' | 'liquidation'; market: MarketId; key: string | null; title: string; body: string; isBreaking: boolean }

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface Analysis {
  id: number; key: string; horizon: Horizon; provider: ProviderId; model: string; dataTime: number; createdAt: number;
  opinion: string; confidence: Confidence; summary: string; reasons: string[]; risks: string[];
  news: { title: string; url: string; date: string | null }[];
}

export interface HistoryItem { id: number; horizon: Horizon; provider: ProviderId; opinion: string; confidence: Confidence; dataTime: number; createdAt: number; tier: string; origin: string }

export interface ChartSpec { key: string; bar: Bar; from: number | null; to: number | null; markers: { time: number; text: string }[] }
