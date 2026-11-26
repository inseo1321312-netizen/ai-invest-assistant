/** 업비트 공개 API(키 없음): 코인 한글명, 유의·주의 표시, 원화 가격 */
export interface UpbitMarket { market: string; koreanName: string; englishName: string; warning: boolean; cautions: string[] }

export interface UpbitClient {
  markets(): Promise<UpbitMarket[]>;
  /** 원화 시장 가격. 키는 기초 기호(BTC 등) */
  krwPrices(): Promise<Map<string, number>>;
}

const BASE = 'https://api.upbit.com/v1';

export function createUpbitClient(deps: { fetch: typeof fetch }): UpbitClient {
  async function get<T>(path: string): Promise<T> {
    const res = await deps.fetch(`${BASE}${path}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (!res.ok) throw new Error(`업비트 오류 (${res.status})`);
    return (await res.json()) as T;
  }
  return {
    async markets() {
      const rows = await get<{ market: string; korean_name: string; english_name: string; market_event?: { warning?: boolean; caution?: Record<string, boolean> } }[]>('/market/all?isDetails=true');
      return rows.map((r) => ({
        market: r.market,
        koreanName: r.korean_name,
        englishName: r.english_name,
        warning: r.market_event?.warning === true,
        cautions: Object.entries(r.market_event?.caution ?? {}).filter(([, on]) => on === true).map(([k]) => k),
      }));
    },
    async krwPrices() {
      const rows = await get<{ market: string; trade_price: number }[]>('/ticker/all?quote_currencies=KRW');
      const out = new Map<string, number>();
      for (const r of rows) if (r.market.startsWith('KRW-') && Number.isFinite(r.trade_price)) out.set(r.market.slice(4), r.trade_price);
      return out;
    },
  };
}
