/** 차트에 그릴 지표(서버와 같은 공식). 계산할 수 없는 자리는 null. */
type S = (number | null)[];

export function sma(v: number[], p: number): S {
  let sum = 0;
  return v.map((x, i) => {
    sum += x;
    if (i >= p) sum -= v[i - p]!;
    return i >= p - 1 ? sum / p : null;
  });
}

export function ema(v: number[], p: number): S {
  const out: S = new Array(v.length).fill(null);
  if (v.length < p) return out;
  const k = 2 / (p + 1);
  let prev = v.slice(0, p).reduce((a, b) => a + b, 0) / p;
  out[p - 1] = prev;
  for (let i = p; i < v.length; i++) { prev = v[i]! * k + prev * (1 - k); out[i] = prev; }
  return out;
}

export function rsi(v: number[], p = 14): S {
  const out: S = new Array(v.length).fill(null);
  if (v.length <= p) return out;
  let g = 0;
  let l = 0;
  for (let i = 1; i <= p; i++) { const d = v[i]! - v[i - 1]!; if (d > 0) g += d; else l -= d; }
  let ag = g / p;
  let al = l / p;
  const val = () => (ag === 0 && al === 0 ? 50 : al === 0 ? 100 : 100 - 100 / (1 + ag / al));
  out[p] = val();
  for (let i = p + 1; i < v.length; i++) {
    const d = v[i]! - v[i - 1]!;
    ag = (ag * (p - 1) + Math.max(d, 0)) / p;
    al = (al * (p - 1) + Math.max(-d, 0)) / p;
    out[i] = val();
  }
  return out;
}

export function macd(v: number[]): { line: S; signal: S; hist: S } {
  const f = ema(v, 12);
  const s = ema(v, 26);
  const line: S = v.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const start = line.findIndex((x) => x !== null);
  const signal: S = new Array(v.length).fill(null);
  if (start >= 0) ema(line.slice(start) as number[], 9).forEach((x, j) => { signal[start + j] = x; });
  const hist: S = line.map((x, i) => (x !== null && signal[i] !== null ? x - signal[i]! : null));
  return { line, signal, hist };
}

export function bollinger(v: number[], p = 20, m = 2): { upper: S; lower: S } {
  const mid = sma(v, p);
  const upper: S = new Array(v.length).fill(null);
  const lower: S = new Array(v.length).fill(null);
  for (let i = p - 1; i < v.length; i++) {
    let s = 0;
    for (let j = i - p + 1; j <= i; j++) s += (v[j]! - mid[i]!) ** 2;
    const sd = Math.sqrt(s / p);
    upper[i] = mid[i]! + m * sd;
    lower[i] = mid[i]! - m * sd;
  }
  return { upper, lower };
}
