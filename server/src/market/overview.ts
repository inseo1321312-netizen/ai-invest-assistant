/** 홈 맨 위 "오늘 시장 한눈에". 항목마다 따로 가져오고, 실패한 항목은 비워 둔다. 60초 기억. */
import type { KisClient } from './kis.js';
import type { Sentiment } from './sentiment.js';

export type OverviewId = 'kospi' | 'kosdaq' | 'spx' | 'nasdaq' | 'usdkrw' | 'fng' | 'kimchi';
/** open: 지수 시장이 열려 있는지(모르면 null) */
export interface OverviewItem { id: OverviewId; label: string; value: number | null; changePct: number | null; note: string | null; open: boolean | null }

const TTL_MS = 60_000;

export interface MarketOverview { get(): Promise<OverviewItem[]> }

export function createMarketOverview(deps: {
  kis: Pick<KisClient, 'getIndex' | 'getUsIndex'> | null;
  fx: () => Promise<number | null>;
  sentiment: () => Promise<Sentiment | null>;
  upbit: { krwPrices(): Promise<Map<string, number>> };
  okx: { getQuote(instId: string): Promise<{ price: number }> };
  now: () => number;
}): MarketOverview {
  let cached: { at: number; items: Promise<OverviewItem[]> } | null = null;
  const safe = <T>(p: Promise<T>): Promise<T | null> => p.catch(() => null);

  async function load(): Promise<OverviewItem[]> {
    const k = deps.kis;
    const [kospi, kosdaq, spx, nasdaq, fx, fng, upbit, okxBtc] = await Promise.all([
      k ? safe(k.getIndex('0001')) : null,
      k ? safe(k.getIndex('1001')) : null,
      k ? safe(k.getUsIndex('SPX')) : null,
      k ? safe(k.getUsIndex('COMP')) : null,
      safe(deps.fx()),
      safe(deps.sentiment()),
      safe(deps.upbit.krwPrices()),
      safe(deps.okx.getQuote('BTC-USDT')),
    ]);
    const idx = (id: OverviewId, label: string, q: { value: number; changePct: number; open?: boolean } | null): OverviewItem => ({
      id, label, value: q && q.value > 0 ? q.value : null, changePct: q && q.value > 0 ? q.changePct : null, note: null, open: q?.open ?? null,
    });
    const upbitBtc = upbit?.get('BTC') ?? null;
    const kimchi = fx && upbitBtc && okxBtc?.price ? (upbitBtc / (okxBtc.price * fx) - 1) * 100 : null;
    return [
      idx('kospi', '코스피', kospi),
      idx('kosdaq', '코스닥', kosdaq),
      idx('spx', 'S&P500', spx),
      idx('nasdaq', '나스닥', nasdaq),
      { id: 'usdkrw', label: '원/달러', value: fx, changePct: null, note: null, open: null },
      { id: 'fng', label: '공포·탐욕', value: fng?.value ?? null, changePct: null, note: fng?.label ?? null, open: null },
      { id: 'kimchi', label: '김치 프리미엄', value: kimchi, changePct: null, note: null, open: null },
    ];
  }

  return {
    get() {
      if (cached && deps.now() - cached.at < TTL_MS) return cached.items;
      const items = load();
      cached = { at: deps.now(), items };
      return items;
    },
  };
}
