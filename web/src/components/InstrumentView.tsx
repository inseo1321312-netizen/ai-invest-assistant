import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { changeClass, formatDateTimeKst, formatPct, formatPrice } from '../format';
import { streamSse } from '../sse';
import type { Analysis, Bar, Horizon, ProviderId, Quote } from '../types';
import { Dots, Icon, Segmented, Sheet, useFlash } from '../ui';
import { AnalysisPanel, emptyRun, PROVIDER_LABEL, type RunState } from './AnalysisPanel';
import { CandleChart, DEFAULT_INDICATORS, type Indicators } from './CandleChart';

const COIN_BARS: { value: Bar; label: string }[] = [
  { value: '5m', label: '5분' }, { value: '1H', label: '1시간' }, { value: '4H', label: '4시간' }, { value: '1D', label: '일' }, { value: '1W', label: '주' },
];
const STOCK_BARS: { value: Bar; label: string }[] = [{ value: '5m', label: '5분' }, { value: '1D', label: '일' }, { value: '1W', label: '주' }];
const HORIZON_OPTIONS: { value: Horizon; label: string; hint: string }[] = [
  { value: 'scalp', label: '단타', hint: '하루 안' }, { value: 'swing', label: '스윙', hint: '며칠~몇 주' }, { value: 'long', label: '장기', hint: '몇 달 이상' },
];
/** 분석 기간을 고르면 차트도 그 기간에 맞는 캔들로 바꾼다(서버 분석 기준과 같음). */
const HORIZON_BAR: Record<'coin' | 'stock', Record<Horizon, Bar>> = {
  coin: { scalp: '5m', swing: '4H', long: '1D' },
  stock: { scalp: '5m', swing: '1D', long: '1D' },
};
const IND_LABEL: { key: keyof Indicators; label: string }[] = [
  { key: 'ma', label: '이동평균' }, { key: 'bb', label: '볼린저' }, { key: 'rsi', label: 'RSI' }, { key: 'macd', label: 'MACD' },
];

function ExplainSheet({ keyId, bar, time, onClose }: { keyId: string; bar: Bar; time: number; onClose: () => void }) {
  const [text, setText] = useState('');
  const [status, setStatus] = useState<string | null>('그 무렵 소식을 찾는 중…');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    let streamed = '';
    void streamSse('/api/explain-point', { key: keyId, bar, time, provider: 'claude' }, (type, d) => {
      if (type === 'status') setStatus(d.message);
      if (type === 'text') { streamed += d.delta; setText(streamed); }
      if (type === 'explanation') { setText(d.text); setStatus(null); }
      if (type === 'error') { setError(d.message); setStatus(null); }
      if (type === 'done') setStatus(null);
    }, ctrl.signal).finally(() => setStatus(null));
    return () => ctrl.abort();
  }, [keyId, bar, time]);
  return (
    <Sheet title="이 지점 왜?" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>{formatDateTimeKst(time)} 캔들</p>
      {status && <p className="status" aria-live="polite"><Dots /> {status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {text && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', lineHeight: 1.65 }}>{text}</p>}
    </Sheet>
  );
}

export function InstrumentView({ keyId, onClose, onChat }: { keyId: string; onClose: () => void; onChat: (key: string) => void }) {
  const isCoin = keyId.startsWith('coin:');
  const isSwap = keyId.endsWith('-SWAP');
  const bars = isCoin ? COIN_BARS : STOCK_BARS;
  const [bar, setBar] = useState<Bar>(HORIZON_BAR[isCoin ? 'coin' : 'stock'].swing);
  const [horizon, setHorizon] = useState<Horizon>('swing');
  const [indicators, setIndicators] = useState<Indicators>(DEFAULT_INDICATORS);
  const [quote, setQuote] = useState<Quote | null>(null);
  const [runs, setRuns] = useState<Partial<Record<ProviderId, RunState>>>({});
  const [explainAt, setExplainAt] = useState<number | null>(null);
  const aborts = useRef<AbortController[]>([]);
  const flash = useFlash(quote?.price);

  useEffect(() => () => aborts.current.forEach((a) => a.abort()), []);

  useEffect(() => {
    let alive = true;
    const load = () => api<{ quote: Quote }>(`/api/market/quote?key=${encodeURIComponent(keyId)}`).then((r) => { if (alive) setQuote(r.quote); }).catch(() => undefined);
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [keyId]);

  useEffect(() => {
    let alive = true;
    setRuns({});
    api<{ analyses: Analysis[] }>(`/api/analysis/latest?key=${encodeURIComponent(keyId)}&horizon=${horizon}`)
      .then((r) => {
        if (!alive) return;
        const next: Partial<Record<ProviderId, RunState>> = {};
        for (const a of r.analyses) next[a.provider] = { ...emptyRun(), analysis: a };
        setRuns(next);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [keyId, horizon]);

  function changeHorizon(h: Horizon) {
    setHorizon(h);
    setBar(HORIZON_BAR[isCoin ? 'coin' : 'stock'][h]);
  }

  const patch = useCallback((p: ProviderId, f: (r: RunState) => RunState) => {
    setRuns((prev) => ({ ...prev, [p]: f(prev[p] ?? emptyRun()) }));
  }, []);

  function run(provider: ProviderId, deep: boolean) {
    const ctrl = new AbortController();
    aborts.current.push(ctrl);
    patch(provider, (r) => ({ ...r, running: true, status: null, text: '', error: null }));
    void streamSse('/api/analysis', { key: keyId, horizon, provider, deep }, (type, d) => {
      if (type === 'status') patch(provider, (r) => ({ ...r, status: d.message }));
      if (type === 'text') patch(provider, (r) => ({ ...r, text: r.text + d.delta }));
      if (type === 'analysis') patch(provider, (r) => ({ ...r, analysis: d.analysis }));
      if (type === 'error') patch(provider, (r) => ({ ...r, error: d.message }));
    }, ctrl.signal).finally(() => patch(provider, (r) => ({ ...r, running: false, status: null })));
  }

  const anyRunning = Object.values(runs).some((r) => r?.running);
  const other: ProviderId = runs.claude?.analysis && !runs.gpt?.analysis ? 'gpt' : runs.gpt?.analysis && !runs.claude?.analysis ? 'claude' : 'gpt';
  const title = keyId.split(':').slice(1).join(':');

  return (
    <div className="screen" role="region" aria-label={`${keyId} 상세`}>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="뒤로" onClick={onClose}><Icon.back /></button>
        <p className="title-sm">{title}</p>
        <button type="button" className="icon-btn" onClick={() => onChat(keyId)}><Icon.chat /> 채팅</button>
      </header>

      <div className="price-hero">
        <p className={`price num ${flash}`}>{quote ? formatPrice(quote.price, quote.currency) : <span className="skeleton" style={{ display: 'inline-block', width: 160, height: 30 }} />}</p>
        {quote && <div className="sub"><span className={`change num ${changeClass(quote.changePct24h)}`}>{formatPct(quote.changePct24h)}</span><span className="small muted">{isCoin ? '24시간' : '전일 대비'}</span></div>}
      </div>

      <section className="card" aria-label="차트">
        <Segmented small kind="pressed" label="캔들 단위" options={bars} value={bar} onChange={setBar} />
        <CandleChart keyId={keyId} bar={bar} onPointClick={setExplainAt} indicators={indicators} />
        <div className="chart-tools" role="group" aria-label="지표">
          {IND_LABEL.map((i) => (
            <button key={i.key} type="button" className="toggle" aria-pressed={indicators[i.key]} onClick={() => setIndicators((s) => ({ ...s, [i.key]: !s[i.key] }))}>{i.label}</button>
          ))}
        </div>
        <p className="hint">캔들을 누르면 그때 왜 움직였는지 AI가 찾아봐요.</p>
      </section>
      {explainAt !== null && <ExplainSheet keyId={keyId} bar={bar} time={explainAt} onClose={() => setExplainAt(null)} />}

      <div className="section-head"><h2 className="section-title">AI 타이밍 분석</h2></div>
      <Segmented kind="radio" label="분석 기간" options={HORIZON_OPTIONS} value={horizon} onChange={changeHorizon} />
      <AnalysisPanel runs={runs} isSwap={isSwap} />

      <div className="sticky-actions">
        <button type="button" className="btn btn-ai" disabled={anyRunning} onClick={() => run('claude', false)}>AI 타이밍 분석</button>
        <button type="button" className="btn" disabled={anyRunning} onClick={() => run('claude', true)}>심층 분석</button>
        <button type="button" className="btn" disabled={anyRunning} onClick={() => run(other, false)} title={`${PROVIDER_LABEL[other]}에게 묻기`}>두 번째 의견</button>
      </div>
    </div>
  );
}
