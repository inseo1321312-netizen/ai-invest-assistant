import type { Db } from '../db.js';

const KEY = 'fx.usdkrw';
const TTL_MS = 6 * 3600 * 1000;
const URL_USDKRW = 'https://api.frankfurter.dev/v1/latest?from=USD&to=KRW';

/** 은행 기준(ECB 고시) 원/달러 환율. 6시간 캐시, 실패하면 마지막 값, 없으면 null. */
export async function getUsdKrw(opts: { db: Db; fetchImpl?: typeof fetch; now: () => number }): Promise<number | null> {
  const cached = opts.db.kvGet<{ rate: number; fetchedAt: number }>(KEY);
  if (cached && opts.now() - cached.fetchedAt < TTL_MS) return cached.rate;
  try {
    const res = await (opts.fetchImpl ?? fetch)(URL_USDKRW);
    if (!res.ok) throw new Error(String(res.status));
    const json = (await res.json()) as { rates?: { KRW?: number } };
    const rate = json.rates?.KRW;
    if (typeof rate !== 'number' || !Number.isFinite(rate)) throw new Error('no rate');
    opts.db.kvSet(KEY, { rate, fetchedAt: opts.now() });
    return rate;
  } catch {
    return cached?.rate ?? null;
  }
}
