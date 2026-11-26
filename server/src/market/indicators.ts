import type { Candle } from './types.js';

type Series = (number | null)[];

export function sma(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length < period) return out;
  const k = 2 / (period + 1);
  let prev = values.slice(0, period).reduce((a, b) => a + b, 0) / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

/** 앞쪽에 null이 있는 시리즈에 EMA를 적용하고 원래 자리로 되돌린다. */
function emaOfSeries(series: Series, period: number): Series {
  const start = series.findIndex((v) => v !== null);
  const out: Series = new Array(series.length).fill(null);
  if (start < 0) return out;
  const tail = ema(series.slice(start) as number[], period);
  tail.forEach((v, j) => { out[start + j] = v; });
  return out;
}

function rsiValue(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  if (avgGain === 0) return 0;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

/** Wilder 평활 RSI. */
export function rsi(values: number[], period = 14): Series {
  const out: Series = new Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = values[i]! - values[i - 1]!;
    if (d > 0) gain += d; else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = rsiValue(avgGain, avgLoss);
  for (let i = period + 1; i < values.length; i++) {
    const d = values[i]! - values[i - 1]!;
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = rsiValue(avgGain, avgLoss);
  }
  return out;
}

export function macd(values: number[], fast = 12, slow = 26, signal = 9): { macd: Series; signal: Series; hist: Series } {
  const f = ema(values, fast);
  const s = ema(values, slow);
  const line: Series = values.map((_, i) => (f[i] !== null && s[i] !== null ? f[i]! - s[i]! : null));
  const sig = emaOfSeries(line, signal);
  const hist: Series = line.map((v, i) => (v !== null && sig[i] !== null ? v - sig[i]! : null));
  return { macd: line, signal: sig, hist };
}

/** 볼린저 밴드 (모집단 표준편차). */
export function bollinger(values: number[], period = 20, mult = 2): { mid: Series; upper: Series; lower: Series } {
  const mid = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i++) {
    const m = mid[i]!;
    let v = 0;
    for (let j = i - period + 1; j <= i; j++) v += (values[j]! - m) ** 2;
    const sd = Math.sqrt(v / period);
    upper[i] = m + mult * sd;
    lower[i] = m - mult * sd;
  }
  return { mid, upper, lower };
}

export interface IndicatorSummary {
  lastClose: number | null;
  sma20: number | null;
  sma60: number | null;
  ema20: number | null;
  rsi14: number | null;
  macd: number | null;
  macdSignal: number | null;
  macdHist: number | null;
  bbUpper: number | null;
  bbLower: number | null;
  volumeVsAvg20: number | null;
  lastCandleTime: number | null;
}

function lastValue(s: Series): number | null {
  const v = s.length ? s[s.length - 1]! : null;
  return v === null || !Number.isFinite(v) ? null : v;
}

export function summarizeIndicators(candles: Candle[]): IndicatorSummary {
  const closes = candles.map((c) => c.close);
  const vols = candles.map((c) => c.volume);
  const m = macd(closes);
  const bb = bollinger(closes);
  const avgVol = lastValue(sma(vols, 20));
  const lastVol = vols.length ? vols[vols.length - 1]! : null;
  return {
    lastClose: closes.length ? closes[closes.length - 1]! : null,
    sma20: lastValue(sma(closes, 20)),
    sma60: lastValue(sma(closes, 60)),
    ema20: lastValue(ema(closes, 20)),
    rsi14: lastValue(rsi(closes, 14)),
    macd: lastValue(m.macd),
    macdSignal: lastValue(m.signal),
    macdHist: lastValue(m.hist),
    bbUpper: lastValue(bb.upper),
    bbLower: lastValue(bb.lower),
    volumeVsAvg20: avgVol && lastVol !== null ? lastVol / avgVol : null,
    lastCandleTime: candles.length ? candles[candles.length - 1]!.time : null,
  };
}
