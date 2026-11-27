import { useEffect, useRef, useState } from 'react';
import { CandlestickSeries, HistogramSeries, LineSeries, createChart, createSeriesMarkers, type UTCTimestamp } from 'lightweight-charts';
import { api, ApiError } from '../api';
import { bollinger, macd, rsi, sma } from '../indicators';
import { bigMoves } from '../bigMoves';
import type { Bar, Candle } from '../types';
import { formatPrice, wonMode } from '../format';

/** 차트 라이브러리는 UTC로 그리므로 한국 시간으로 보이게 9시간 밀어서 넣고, 클릭하면 되돌린다. */
const KST = 9 * 3600;
const INTRADAY: Bar[] = ['1m', '5m', '15m', '1H', '4H'];

export interface Indicators { ma: boolean; bb: boolean; rsi: boolean; macd: boolean }
export const DEFAULT_INDICATORS: Indicators = { ma: true, bb: false, rsi: false, macd: false };

function fmt(n: number): string {
  const abs = Math.abs(n);
  return n.toLocaleString('en-US', abs >= 100 ? { maximumFractionDigits: 2 } : abs >= 1 ? { maximumFractionDigits: 4 } : { maximumSignificantDigits: 4 });
}

function cssVar(name: string, fallback: string): string {
  if (typeof window === 'undefined') return fallback;
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}

export function CandleChart({ keyId, bar, onPointClick, markers = [], height = 300, indicators = DEFAULT_INDICATORS, from = null, to = null, autoMarkers = false }: {
  keyId: string;
  bar: Bar;
  /** 누른 캔들의 시작 시각(UTC 초)과 직전 종가 대비 등락률(%) */
  onPointClick?: (time: number, pct: number | null) => void;
  /** 크게 오르내린 캔들에 ▲▼ 표시 */
  autoMarkers?: boolean;
  markers?: { time: number; text: string }[];
  height?: number;
  indicators?: Indicators;
  from?: number | null;
  to?: number | null;
}) {
  const box = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [ohlc, setOhlc] = useState<{ open: number; high: number; low: number; close: number } | null>(null);
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
          timeScale: { timeVisible: INTRADAY.includes(bar), secondsVisible: false, borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
          crosshair: { mode: 1 },
          handleScroll: { vertTouchDrag: false, mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true },
          handleScale: { mouseWheel: false, pinch: true, axisPressedMouseMove: true },
          // 원화 단위면 가격 눈금도 원으로
          localization: { locale: 'ko-KR', ...(wonMode() && !keyId.startsWith('kr:') ? { priceFormatter: (p: number) => formatPrice(p, keyId.startsWith('us:') ? 'USD' : 'USDT') } : {}) },
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

        // 손가락(마우스)이 있는 캔들의 시가·고가·저가·종가, 없으면 마지막 캔들
        const last = candles[candles.length - 1];
        const lastOhlc = last ? { open: last.open, high: last.high, low: last.low, close: last.close } : null;
        setOhlc(lastOhlc);
        const onMove = (p: { seriesData?: Map<unknown, unknown> }) => {
          const d = p.seriesData?.get(candleSeries) as { open: number; high: number; low: number; close: number } | undefined;
          setOhlc(d && typeof d.open === 'number' ? d : lastOhlc);
        };
        chart.subscribeCrosshairMove?.(onMove as never);

        const allMarkers = [
          ...markers.map((m) => ({ time: t(m.time), position: 'aboveBar' as const, color: ai, shape: 'arrowDown' as const, text: m.text })),
          ...(autoMarkers ? bigMoves(candles).map((m) => (m.pct > 0
            ? { time: t(m.time), position: 'belowBar' as const, color: up, shape: 'arrowUp' as const, text: `+${m.pct.toFixed(1)}%` }
            : { time: t(m.time), position: 'aboveBar' as const, color: down, shape: 'arrowDown' as const, text: `${m.pct.toFixed(1)}%` })) : []),
        ].sort((a, b) => a.time - b.time);
        if (allMarkers.length) createSeriesMarkers(candleSeries, allMarkers);
        if (from !== null && to !== null) chart.timeScale().setVisibleRange({ from: t(from), to: t(to) });
        else chart.timeScale().fitContent();
        const onClick = (p: { time?: unknown }) => {
          if (typeof p.time !== 'number') return;
          const at = p.time - KST;
          const i = candles.findIndex((c) => c.time === at);
          const prev = i > 0 ? candles[i - 1]!.close : 0;
          clickRef.current?.(at, i > 0 && prev > 0 ? (candles[i]!.close / prev - 1) * 100 : null);
        };
        chart.subscribeClick(onClick as never);
        cleanup = () => { chart.unsubscribeClick(onClick as never); chart.unsubscribeCrosshairMove?.(onMove as never); chart.remove(); };
      })
      .catch((e) => { if (alive) { setLoading(false); setError(e instanceof ApiError ? e.message : '차트를 불러오지 못했어요'); } });
    return () => { alive = false; cleanup(); };
    // markers·범위는 처음 그릴 때만 쓴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId, bar, totalHeight, indicators.ma, indicators.bb, indicators.rsi, indicators.macd, autoMarkers]);

  return (
    <div style={{ position: 'relative' }}>
      {ohlc && !loading && !error && (
        <div className="ohlc num" aria-hidden="true">
          <span>시 <b>{fmt(ohlc.open)}</b></span><span>고 <b>{fmt(ohlc.high)}</b></span><span>저 <b>{fmt(ohlc.low)}</b></span><span>종 <b>{fmt(ohlc.close)}</b></span>
          <span className={ohlc.close >= ohlc.open ? 'up' : 'down'}>{ohlc.open ? `${ohlc.close >= ohlc.open ? '+' : ''}${(((ohlc.close - ohlc.open) / ohlc.open) * 100).toFixed(2)}%` : ''}</span>
        </div>
      )}
      <div ref={box} role="img" aria-label={`${keyId} ${bar} 차트`} style={{ height: totalHeight, width: '100%' }} />
      {loading && !error && <div className="skeleton" style={{ position: 'absolute', inset: 0 }} aria-hidden="true" />}
      {error && <p className="notice" style={{ margin: 0 }}>{error}</p>}
    </div>
  );
}
