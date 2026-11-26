export type MarketId = 'coin' | 'kr' | 'us';
export type Currency = 'USDT' | 'KRW' | 'USD';
export type Horizon = 'scalp' | 'swing' | 'long';
export type Bar = '1m' | '5m' | '15m' | '1H' | '4H' | '1D' | '1W';
export type ProviderId = 'claude' | 'gpt';
export type Confidence = '낮음' | '중간' | '높음';

export interface Instrument { market: MarketId; symbol: string; kind: 'spot' | 'swap' | 'stock'; exchange: string | null; name: string | null }
/** 주식 장 상태(네이버 기준, 공휴일 포함). tradedAt은 unix 초, extended는 프리·애프터마켓(종가 대비 %) */
export interface MarketSession {
  open: boolean;
  tradedAt: number | null;
  extended: { kind: 'pre' | 'after'; open: boolean; price: number; changePct: number; tradedAt: number | null } | null;
}

export interface Quote { price: number; changePct24h: number; currency: Currency; time: number; session?: MarketSession }
export interface Badge { opinion: string; confidence: Confidence; dataTime: number; provider: ProviderId }

export interface QuoteView { key: string; instrument: Instrument; quote: Quote | null; krwValue: number | null; badge: Badge | null }

/** 홈 "자주 보는 종목": 즐겨찾기와 최근 본 종목(즐겨찾기 제외) */
export interface Overview { favorites: QuoteView[]; recent: QuoteView[]; usdKrw: number | null; errors: string[] }

export interface SearchHit { key: string; market: MarketId; name: string; symbol: string }
export interface TrendItem { key: string; name: string; symbol: string; price: number; changePct: number; value: number | null; currency: Currency }
export type OverviewId = 'kospi' | 'kosdaq' | 'spx' | 'nasdaq' | 'usdkrw' | 'fng' | 'kimchi';
export interface OverviewItem { id: OverviewId; label: string; value: number | null; changePct: number | null; note: string | null; open?: boolean | null }
export interface NewsItem { title: string; url: string; source: string | null; publishedAt: number }
export interface StockInfo { marketCap: number | null; per: number | null; pbr: number | null; eps: number | null; high52: number | null; low52: number | null; currency: 'KRW' | 'USD' }
export interface CoinInfo { fundingRate: number | null; openInterestUsd: number | null; longShortRatio: number | null; liq1h: { longUsd: number; shortUsd: number } | null; kimchiPct: number | null; upbitWarning: boolean; upbitCautions: string[] }

export interface FeedItem { id: number; createdAt: number; day: string; kind: 'briefing' | 'breaking' | 'spike' | 'liquidation' | 'alert'; market: MarketId; key: string | null; title: string; body: string; isBreaking: boolean }

export interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }

export interface Analysis {
  id: number; key: string; horizon: Horizon; provider: ProviderId; model: string; dataTime: number; createdAt: number;
  opinion: string; confidence: Confidence; summary: string; reasons: string[]; risks: string[];
  news: { title: string; url: string; date: string | null }[];
}

export interface HistoryItem { id: number; horizon: Horizon; provider: ProviderId; opinion: string; confidence: Confidence; dataTime: number; createdAt: number; tier: string; origin: string }

export interface ChartSpec { key: string; bar: Bar; from: number | null; to: number | null; markers: { time: number; text: string }[] }
