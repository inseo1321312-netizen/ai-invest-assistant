/** 코인 시장 공포·탐욕 지수(alternative.me, 키 없이 무료). 30분 동안 기억해 둔다. */
export interface Sentiment { value: number; label: string; updatedAt: number }

const URL = 'https://api.alternative.me/fng/?limit=1';
const TTL_MS = 30 * 60_000;

function labelFor(v: number): string {
  if (v < 25) return '극도의 공포';
  if (v < 45) return '공포';
  if (v <= 55) return '중립';
  if (v <= 75) return '탐욕';
  return '극도의 탐욕';
}

export function createSentiment(deps: { fetch: typeof fetch; now: () => number }): () => Promise<Sentiment | null> {
  let cached: { at: number; value: Sentiment } | null = null;
  return async () => {
    if (cached && deps.now() - cached.at < TTL_MS) return cached.value;
    try {
      const res = await deps.fetch(URL, { signal: AbortSignal.timeout(8000) });
      const body = (await res.json()) as { data?: { value?: string; timestamp?: string }[] };
      const row = body.data?.[0];
      const value = Number(row?.value);
      if (!row || !Number.isFinite(value) || value < 0 || value > 100) return cached?.value ?? null;
      const out = { value, label: labelFor(value), updatedAt: Number(row.timestamp) || 0 };
      cached = { at: deps.now(), value: out };
      return out;
    } catch {
      return cached?.value ?? null;
    }
  };
}
