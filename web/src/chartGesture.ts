/**
 * 차트 손가락 동작:
 * - 한 손가락으로 옆으로 끌기 → 구간 고르기(놓으면 onPick)
 * - 위아래가 더 큰 움직임은 화면 스크롤로 보고 끝까지 무시(실수로 골라지지 않게)
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

/** 이만큼 움직이면 옆인지 위아래인지 정한다 */
const DECIDE_PX = 10;
/** 옆 움직임이 위아래의 이 배수 이상이어야 구간 고르기 */
const SIDEWAYS_RATIO = 1.5;

export function createGesture(h: {
  onPreview(sel: { x0: number; x1: number } | null): void;
  onPick(x0: number, x1: number): void;
  onPan(dx: number): void;
}) {
  const pts = new Map<number, number>();
  let start: { x: number; y: number } | null = null;
  let last: number | null = null;
  let mode: 'undecided' | 'pick' | 'ignore' = 'undecided';
  let mid: number | null = null;

  const middle = () => [...pts.values()].reduce((s, x) => s + x, 0) / pts.size;
  const reset = () => { start = null; last = null; mode = 'undecided'; mid = null; };

  return {
    down(id: number, x: number, y: number) {
      pts.set(id, x);
      if (pts.size === 1) { reset(); start = { x, y }; last = x; return; }
      // 두 번째 손가락: 고르던 것은 취소
      if (mode === 'pick') h.onPreview(null);
      mode = 'ignore';
      start = null;
      mid = middle();
    },
    move(id: number, x: number, y: number) {
      if (!pts.has(id)) return;
      pts.set(id, x);
      if (pts.size >= 2) {
        const m = middle();
        if (mid !== null && m !== mid) h.onPan(m - mid);
        mid = m;
        return;
      }
      if (start === null || mode === 'ignore') return;
      last = x;
      if (mode === 'undecided') {
        const dx = Math.abs(x - start.x);
        const dy = Math.abs(y - start.y);
        if (Math.max(dx, dy) < DECIDE_PX) return;
        mode = dx >= dy * SIDEWAYS_RATIO ? 'pick' : 'ignore';
        if (mode === 'ignore') return;
      }
      h.onPreview({ x0: start.x, x1: x });
    },
    /** 브라우저가 가져간 손가락(세로 스크롤 등): 모두 취소 */
    cancel() {
      if (mode === 'pick') h.onPreview(null);
      pts.clear();
      reset();
    },
    up(id: number) {
      pts.delete(id);
      if (pts.size >= 2) { mid = middle(); return; }
      if (pts.size === 1) { mid = null; start = null; mode = 'ignore'; return; } // 두 손가락 중 하나만 뗌
      if (mode === 'pick' && start !== null && last !== null) {
        h.onPreview(null);
        h.onPick(start.x, last);
      }
      reset();
    },
  };
}
