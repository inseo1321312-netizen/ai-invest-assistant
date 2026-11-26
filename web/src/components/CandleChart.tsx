import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import { api, ApiError } from '../api';
import { bollinger, macd, rsi, sma } from '../indicators';
import type { Bar, Candle } from '../types';

/** 차트 라이브러리는 UTC로 그리므로 한국 시간으로 보이게 9시간 밀어서 넣고, 클릭하면 되돌린다. */
const KST = 9 * 3600;
const INTRADAY: Bar[] = ['1m', '5m', '15m', '1H', '4H'];

export interface Indicators { ma: boolean; bb: boolean; rsi: boolean; macd: boolean }
export const DEFAULT_INDICATORS: Indicators = { ma: true, bb: false, rsi: false, macd: false };

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function CandleChart({ keyId, bar, onPointClick, markers = [], height = 300, indicators = DEFAULT_INDICATORS, from = null, to = null }: {
  keyId: string;
  bar: Bar;
  onPointClick?: (time: number) => void;
  markers?: { time: number; text: string }[];
  height?: number;
  indicators?: Indicators;
  from?: number | null;
  to?: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const clickRef = useRef(onPointClick);
  clickRef.current = onPointClick;
  const extraPanes = Number(indicators.rsi) + Number(indicators.macd);
  const totalHeight = height + extraPanes * 90;

  useEffect(() => {
    let alive = true;
    let cleanup = () => {};
    setError(null);
    setLoading(true);
    api<{ candles: Candle[] }>(`/api/market/candles?key=${encodeURIComponent(keyId)}&bar=${bar}&limit=300`)
      .then(({ candles }) => {
        if (!alive || !box.current) return;
        setLoading(false);
        const up = cssVar('--up', '#e5322d');
        const down = cssVar('--down', '#1d63e0');
        const muted = cssVar('--muted', '#6b7280');
        const line = cssVar('--line', '#e5e8ec');
        const ai = cssVar('--ai', '#0f8b72');
        const chart = createChart(box.current, {
          height: totalHeight,
          autoSize: true,
          layout: { background: { color: 'transparent' }, textColor: muted, fontFamily: 'Pretendard Variable, system-ui, sans-serif', attributionLogo: false },
          grid: { vertLines: { visible: false }, horzLines: { color: line } },
          rightPriceScale: { borderVisible: false },
          timeScale: { timeVisible: INTRADAY.includes(bar), secondsVisible: false, borderVisible: false },
          crosshair: { mode: 1 },
          localization: { locale: 'ko-KR' },
        });
        const t = (s: number) => (s + KST) as UTCTimestamp;
        const closes = candles.map((c) => c.close);
        const toLine = (vals: (number | null)[]) => vals.flatMap((v, i) => (v === null ? [] : [{ time: t(candles[i]!.time), value: v }]));

        const candleSeries = chart.addSeries(CandlestickSeries, { upColor: up, downColor: down, borderUpColor: up, borderDownColor: down, wickUpColor: up, wickDownColor: down });
        candleSeries.setData(candles.map((c) => ({ time: t(c.time), open: c.open, high: c.high, low: c.low, close: c.close })));
        const vol = chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
        chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });
        vol.setData(candles.map((c) => ({ time: t(c.time), value: c.volume, color: c.close >= c.open ? `${up}55` : `${down}55` })));

        const lineOpts = (color: string) => ({ color, lineWidth: 1 as const, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false });
        if (indicators.ma) {
          chart.addSeries(LineSeries, lineOpts(ai)).setData(toLine(sma(closes, 20)));
          chart.addSeries(LineSeries, lineOpts(muted)).setData(toLine(sma(closes, 60)));
        }
        if (indicators.bb) {
          const b = bollinger(closes);
          chart.addSeries(LineSeries, { ...lineOpts(muted), lineStyle: 2 }).setData(toLine(b.upper));
          chart.addSeries(LineSeries, { ...lineOpts(muted), lineStyle: 2 }).setData(toLine(b.lower));
        }
        let pane = 1;
        if (indicators.rsi) {
          chart.addSeries(LineSeries, { ...lineOpts(ai), lastValueVisible: true }, pane++).setData(toLine(rsi(closes)));
        }
        if (indicators.macd) {
          const m = macd(closes);
          const p = pane++;
          chart.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false }, p)
            .setData(m.hist.flatMap((v, i) => (v === null ? [] : [{ time: t(candles[i]!.time), value: v, color: v >= 0 ? `${up}99` : `${down}99` }])));
          chart.addSeries(LineSeries, lineOpts(ai), p).setData(toLine(m.line));
          chart.addSeries(LineSeries, lineOpts(muted), p).setData(toLine(m.signal));
        }

        if (markers.length) {
          createSeriesMarkers(candleSeries, markers.map((m) => ({ time: t(m.time), position: 'aboveBar' as const, color: ai, shape: 'arrowDown' as const, text: m.text })));
        }
        if (from !== null && to !== null) chart.timeScale().setVisibleRange({ from: t(from), to: t(to) });
        else chart.timeScale().fitContent();
        const onClick = (p: { time?: unknown }) => {
          if (typeof p.time === 'number') clickRef.current?.(p.time - KST);
        };
        chart.subscribeClick(onClick as never);
        cleanup = () => { chart.unsubscribeClick(onClick as never); chart.remove(); };
      })
      .catch((e) => { if (alive) { setLoading(false); setError(e instanceof ApiError ? e.message : '차트를 불러오지 못했어요'); } });
    return () => { alive = false; cleanup(); };
    // markers·범위는 처음 그릴 때만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId, bar, totalHeight, indicators.ma, indicators.bb, indicators.rsi, indicators.macd]);

  return (
    <div style={{ position: 'relative' }}>
      <div ref={box} role="img" aria-label={`${keyId} ${bar} 차트`} style={{ height: totalHeight, width: '100%' }} />
      {loading && !error && <div className="skeleton" style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />}
      {error && <p className="notice" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
