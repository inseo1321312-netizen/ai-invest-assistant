/** 차트에 표시할 "크게 움직인 캔들": 직전 종가 대비 종가 등락률로 상승 상위 n, 하락 상위 n. 0.5% 미만은 뺀다. */
export function bigMoves(candles: { time: number; close: number }[], n = 3): { time: number; pct: number }[] {
  const moves: { time: number; pct: number }[] = [];
  for (let i = 1; i < candles.length; i++) {
    const prev = candles[i - 1]!.close;
    if (!(prev > 0)) continue;
    moves.push({ time: candles[i]!.time, pct: (candles[i]!.close / prev - 1) * 100 });
  }
  const ups = moves.filter((m) => m.pct >= 0.5).sort((a, b) => b.pct - a.pct).slice(0, n);
  const downs = moves.filter((m) => m.pct <= -0.5).sort((a, b) => a.pct - b.pct).slice(0, n);
  return [...ups, ...downs].sort((a, b) => a.time - b.time);
}
