/**
 * 차트 손가락 동작:
 * - 한 손가락으로 끌기 → 구간 고르기(놓으면 onPick)
 * - 두 손가락 → 고르기 취소, 가운데가 움직인 만큼 옆으로 밀기(onPan). 벌리고 모으는 확대는 차트가 직접 한다
 */
export interface Candleish { time: number; open?: number; close: number }
export interface RangeInfo { from: number; to: number; pct: number | null; count: number }

/** 캔들 번호 a~b(순서 상관없음) 구간: 시작 직전 종가(맨 앞이면 첫 시가) 대비 끝 종가 등락 */
export function rangeOf(candles: Candleish[], a: number, b: number): RangeInfo | null {
  if (candles.length === 0) return null;
  const clamp = (i: number) => Math.min(candles.length - 1, Math.max(0, Math.round(i)));
  const i0 = clamp(Math.min(a, b));
  const i1 = clamp(Math.max(a, b));
  const base = i0 > 0 ? candles[i0 - 1]!.close : candles[i0]!.open ?? null;
  const end = candles[i1]!.close;
  return { from: candles[i0]!.time, to: candles[i1]!.time, pct: base ? (end / base - 1) * 100 : null, count: i1 - i0 + 1 };
}

const MIN_DRAG_PX = 8;

export function createGesture(h: {
  onPreview(sel: { x0: number; x1: number } | null): void;
  onPick(x0: number, x1: number): void;
  onPan(dx: number): void;
}) {
  const pts = new Map<number, number>();
  let start: number | null = null;
  let last: number | null = null;
  let picking = false;
  let mid: number | null = null;

  const middle = () => [...pts.values()].reduce((s, x) => s + x, 0) / pts.size;

  return {
    down(id: number, x: number) {
      pts.set(id, x);
      if (pts.size === 1) { start = x; last = x; picking = false; mid = null; return; }
      // 두 번째 손가락: 고르던 것은 취소
      if (picking) h.onPreview(null);
      picking = false;
      start = null;
      mid = middle();
    },
    move(id: number, x: number) {
      if (!pts.has(id)) return;
      pts.set(id, x);
      if (pts.size >= 2) {
        const m = middle();
        if (mid !== null && m !== mid) h.onPan(m - mid);
        mid = m;
        return;
      }
      if (start === null) return;
      last = x;
      if (!picking && Math.abs(x - start) >= MIN_DRAG_PX) picking = true;
      if (picking) h.onPreview({ x0: start, x1: x });
    },
    /** 브라우저가 가져간 손가락(세로 스크롤 등): 모두 취소 */
    cancel() {
      if (picking) h.onPreview(null);
      pts.clear();
      picking = false;
      start = null;
      last = null;
      mid = null;
    },
    up(id: number) {
      pts.delete(id);
      if (pts.size >= 2) { mid = middle(); return; }
      if (pts.size === 1) { mid = null; start = null; return; } // 두 손가락 중 하나만 뗌: 고르기 다시 안 함
      if (picking && start !== null && last !== null) {
        h.onPreview(null);
        h.onPick(start, last);
      }
      picking = false;
      start = null;
      last = null;
      mid = null;
    },
  };
}
