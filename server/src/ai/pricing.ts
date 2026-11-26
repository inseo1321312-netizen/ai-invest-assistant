/** 달러 / 100만 토큰 (2026-11-26 공식 가격표 기준) */
export const PRICES: Record<string, { in: number; out: number; cacheRead: number; cacheWrite: number }> = {
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-fable-5-2': { in: 8, out: 40, cacheRead: 0.2, cacheWrite: 10 },
  'gpt-6-luna': { in: 0.1, out: 0.5, cacheRead: 0.01, cacheWrite: 0 },
  'gpt-6.1-terra': { in: 1, out: 5, cacheRead: 0.05, cacheWrite: 0 },
  'gpt-6.2-sol': { in: 2, out: 10, cacheRead: 0.1, cacheWrite: 0 },
};

export const WEB_SEARCH_USD = 0.01;

const MAX_PRICE = Object.values(PRICES).reduce(
  (m, p) => ({ in: Math.max(m.in, p.in), out: Math.max(m.out, p.out), cacheRead: Math.max(m.cacheRead, p.cacheRead), cacheWrite: Math.max(m.cacheWrite, p.cacheWrite) }),
  { in: 0, out: 0, cacheRead: 0, cacheWrite: 0 },
);

export interface UsageCounts { input: number; output: number; cacheRead: number; cacheWrite: number; webSearches: number }

export function costUsd(model: string, u: UsageCounts): number {
  const p = PRICES[model] ?? MAX_PRICE;
  return (u.input * p.in + u.output * p.out + u.cacheRead * p.cacheRead + u.cacheWrite * p.cacheWrite) / 1_000_000 + u.webSearches * WEB_SEARCH_USD;
}
