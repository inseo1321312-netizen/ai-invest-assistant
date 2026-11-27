import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError, post } from '../api';
import { changeClass, formatDateTimeKst, formatPct, formatPrice, formatTimeKst, HORIZON_LABEL } from '../format';
import { yearStats } from '../insights';
import { streamSse } from '../sse';
import type { Analysis, Bar, Candle, HistoryItem, Horizon, NewsItem, ProviderId, Quote } from '../types';
import { Dots, Icon, Segmented, Sheet, useFlash, useToast } from '../ui';
import { useTweened } from '../motion';
import { InstrumentInfo } from './InstrumentInfo';
import { NewsList, NewsStrip } from './NewsStrip';
import { Avatar } from './rows';
import { SessionLine } from './SessionLine';
import { parseKey } from '../format';
import { AnalysisPanel, emptyRun, PROVIDER_LABEL, type RunState } from './AnalysisPanel';
import { CandleChart, DEFAULT_INDICATORS, type Indicators } from './CandleChart';
import { aiReady, usePreferredProvider } from '../aiReady';
import { PriceAlertSheet } from './PriceAlertSheet';

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

/** 차트에서 끌어 고른 구간(to가 있으면)이나 한 캔들이 왜 움직였는지. Claude 키가 없으면 GPT가 설명한다 */
export function ExplainSheet({ keyId, bar, time, to = null, pct, onClose }: { keyId: string; bar: Bar; time: number; to?: number | null; pct: number | null; onClose: () => void }) {
  const [text, setText] = useState('');
  const [news, setNews] = useState<NewsItem[] | null>(null);
  const [status, setStatus] = useState<string | null>('그 무렵 소식을 찾는 중…');
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const ctrl = new AbortController();
    let streamed = '';
    void aiReady().then(({ preferred }) => streamSse('/api/explain-point', { key: keyId, bar, time, to, provider: preferred }, (type, d) => {
      if (type === 'status') setStatus(d.message);
      if (type === 'text') { streamed += d.delta; setText(streamed); }
      if (type === 'explanation') { setText(d.text); setStatus(null); }
      if (type === 'error') { setError(d.message); setStatus(null); }
      if (type === 'done') setStatus(null);
    }, ctrl.signal)).finally(() => setStatus(null));
    return () => ctrl.abort();
  }, [keyId, bar, time, to]);
  // 그 날짜 앞뒤 하루의 관련 뉴스
  useEffect(() => {
    let alive = true;
    api<{ items: NewsItem[] }>(`/api/news?key=${encodeURIComponent(keyId)}&from=${time}&to=${to ?? time}`)
      .then((r) => { if (alive) setNews(Array.isArray(r.items) ? r.items.slice(0, 5) : []); })
      .catch(() => { if (alive) setNews([]); });
    return () => { alive = false; };
  }, [keyId, time, to]);
  return (
    <Sheet title="왜 움직였을까?" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>
        {to ? `${formatTimeKst(time).replace('-', '/')} ~ ${formatTimeKst(to).replace('-', '/')}` : `${formatDateTimeKst(time)} 캔들`}
        {pct !== null && <b className={`change num ${changeClass(pct)}`} style={{ marginLeft: 8 }}>{formatPct(pct)}</b>}
      </p>
      {status && <p className="status" aria-live="polite"><Dots /> {status}</p>}
      {error && <p className="error" role="alert">{error}</p>}
      {text && <p style={{ whiteSpace: 'pre-wrap', margin: '8px 0 0', lineHeight: 1.65 }}>{text}</p>}
      {news && news.length > 0 && (
        <>
          <h3 className="sheet-sub">그 무렵 뉴스</h3>
          <NewsList items={news} />
        </>
      )}
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
  const [explainAt, setExplainAt] = useState<{ time: number; to: number | null; pct: number | null } | null>(null);
  const preferred = usePreferredProvider();
  const [targetOpen, setTargetOpen] = useState(false);
  const [hint, setHint] = useState(() => { try { return localStorage.getItem('hint.chartDrag') !== '1'; } catch { return false; } });
  const [name, setName] = useState<string | null>(null);
  const [fav, setFav] = useState(false);
  const [bell, setBell] = useState(false);
  const [toast, showToast] = useToast();
  const [daily, setDaily] = useState<Candle[] | null>(null);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const runningNow = Object.values(runs).some((r) => r?.running);

  // 지난 AI 의견. 분석이 끝날 때마다 다시 불러온다.
  useEffect(() => {
    if (runningNow) return;
    let alive = true;
    api<{ items: HistoryItem[] }>(`/api/analysis/history?key=${encodeURIComponent(keyId)}`)
      .then((r) => { if (alive && Array.isArray(r.items)) setHistory(r.items); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [keyId, runningNow]);
  const aborts = useRef<AbortController[]>([]);
  const flash = useFlash(quote?.price);
  const shownPrice = useTweened(quote?.price ?? 0);

  useEffect(() => () => aborts.current.forEach((a) => a.abort()), []);

  useEffect(() => {
    let alive = true;
    const load = () => api<{ quote: Quote; name?: string | null }>(`/api/market/quote?key=${encodeURIComponent(keyId)}`).then((r) => {
      if (!alive) return;
      setQuote(r.quote);
      if (r.name) setName(r.name);
    }).catch(() => undefined);
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 15_000);
    return () => { alive = false; clearInterval(t); };
  }, [keyId]);

  // 최근 본 종목으로 기록하고, ★·🔔 상태를 불러온다
  useEffect(() => {
    let alive = true;
    void post('/api/recent', { key: keyId }).catch(() => undefined);
    api<{ keys: string[] }>('/api/watchlist').then((r) => { if (alive && Array.isArray(r.keys)) setFav(r.keys.includes(keyId)); }).catch(() => undefined);
    if (isCoin) api<{ coins: string[] }>('/api/alerts').then((r) => { if (alive && Array.isArray(r.coins)) setBell(r.coins.includes(keyId)); }).catch(() => undefined);
    return () => { alive = false; };
  }, [keyId, isCoin]);

  async function toggleFav() {
    const next = !fav;
    setFav(next);
    try {
      if (next) await post('/api/watchlist', { key: keyId });
      else await api(`/api/watchlist?key=${encodeURIComponent(keyId)}`, { method: 'DELETE' });
      showToast(next ? '즐겨찾기에 넣었어요' : '즐겨찾기에서 뺐어요');
    } catch (e) {
      setFav(!next);
      showToast(e instanceof ApiError ? e.message : '바꾸지 못했어요');
    }
  }

  async function toggleBell() {
    const next = !bell;
    setBell(next);
    try {
      if (next) await post('/api/alerts/coins', { key: keyId });
      else await api(`/api/alerts/coins?key=${encodeURIComponent(keyId)}`, { method: 'DELETE' });
      showToast(next ? '급변·사건이 생기면 알려 드릴게요' : '알림을 껐어요');
    } catch (e) {
      setBell(!next);
      showToast(e instanceof ApiError ? e.message : '바꾸지 못했어요');
    }
  }

  // 1년 범위·변동폭 계산용 일봉
  useEffect(() => {
    let alive = true;
    api<{ candles: Candle[] }>(`/api/market/candles?key=${encodeURIComponent(keyId)}&bar=1D&limit=365`)
      .then((r) => { if (alive && Array.isArray(r.candles)) setDaily(r.candles); })
      .catch(() => undefined);
    return () => { alive = false; };
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
  const second: ProviderId = preferred === 'claude' ? 'gpt' : 'claude';
  const other: ProviderId = runs.claude?.analysis && !runs.gpt?.analysis ? 'gpt' : runs.gpt?.analysis && !runs.claude?.analysis ? 'claude' : second;
  const title = keyId.split(':').slice(1).join(':');
  const stats = quote && daily && daily.length > 1 ? yearStats(daily, quote.price, Math.floor(Date.now() / 1000)) : null;
  const compact = (n: number) => new Intl.NumberFormat('ko-KR', { notation: 'compact', maximumFractionDigits: 1 }).format(n);

  return (
    <div className="screen" role="region" aria-label={`${keyId} 상세`}>
      <header className="topbar">
        <button type="button" className="icon-btn" aria-label="뒤로" onClick={onClose}><Icon.back /></button>
        <div className="title-wrap">
          <Avatar inst={parseKey(keyId, name)} logoKey={keyId} />
          <h1 className="title-sm">{name ?? title}{name && <small>{title}</small>}</h1>
        </div>
        <div className="head-actions">
          <button type="button" className={`icon-btn toggle-icon${fav ? ' on star' : ''}`} aria-label="즐겨찾기" aria-pressed={fav} onClick={toggleFav}><Icon.star /></button>
          {isCoin && <button type="button" className={`icon-btn toggle-icon${bell ? ' on' : ''}`} aria-label="알림 코인" aria-pressed={bell} onClick={toggleBell}><Icon.bell /></button>}
          <button type="button" className="icon-btn" aria-label="채팅" onClick={() => onChat(keyId)}><Icon.chat /></button>
        </div>
      </header>

      <div className="price-hero">
        <p className={`price num ${flash}`}>{quote ? formatPrice(shownPrice || quote.price, quote.currency) : <span className="skeleton" style={{ display: 'inline-block', width: 160, height: 30 }} />}</p>
        {quote && (
          <div className="sub">
            <span className={`change num ${changeClass(quote.changePct24h)}`}>{formatPct(quote.changePct24h)}</span>
            <span className="small muted">{isCoin ? '24시간' : '전일 대비'}</span>
            <span className="chip-row">
              <button type="button" className="target-chip" onClick={() => setTargetOpen(true)}><Icon.bell /> 목표가 알림</button>
            </span>
          </div>
        )}
        {quote?.session && <SessionLine session={quote.session} currency={quote.currency} />}
        {stats && quote && (
          <div className="range rise" role="img" aria-label={`1년 가격 범위에서 ${Math.round(stats.position * 100)}% 위치`}>
            <div className="range-bar"><i style={{ left: `${stats.position * 100}%` }} /></div>
            <div className="range-ends num"><span>1년 최저 {formatPrice(stats.low, quote.currency)}</span><span>최고 {formatPrice(stats.high, quote.currency)}</span></div>
          </div>
        )}
      </div>

      <NewsStrip keyId={keyId} />

      <section className="card" aria-label="차트">
        <Segmented small kind="pressed" label="캔들 단위" options={bars} value={bar} onChange={setBar} />
        <CandleChart keyId={keyId} bar={bar} indicators={indicators} autoMarkers onRangePick={(from, to, pct) => {
          setExplainAt({ time: from, to: to > from ? to : null, pct });
          if (hint) { setHint(false); try { localStorage.setItem('hint.chartDrag', '1'); } catch { /* 무시 */ } }
        }} />
        {hint && <p className="chart-hint">끌어서 구간 설명 · 두 손가락으로 확대</p>}
        <div className="chart-tools" role="group" aria-label="지표">
          {IND_LABEL.map((i) => (
            <button key={i.key} type="button" className="toggle" aria-pressed={indicators[i.key]} onClick={() => setIndicators((s) => ({ ...s, [i.key]: !s[i.key] }))}>{i.label}</button>
          ))}
        </div>
      </section>
      {stats && (
        <dl className="stats rise" aria-label="주요 지표">
          <div><dt>1년 최고가 대비</dt><dd className={`num ${changeClass(stats.fromHighPct)}`}>{formatPct(stats.fromHighPct)}</dd></div>
          <div><dt>30일 하루 변동폭</dt><dd className="num">±{stats.volatility30.toFixed(1)}%</dd></div>
          <div><dt>30일 평균 거래량</dt><dd className="num">{compact(stats.avgVolume30)}</dd></div>
          <div><dt>1년 범위 위치</dt><dd className="num">{Math.round(stats.position * 100)}%</dd></div>
        </dl>
      )}
      <InstrumentInfo keyId={keyId} />
      {targetOpen && quote && <PriceAlertSheet keyId={keyId} name={name} price={quote.price} currency={quote.currency} onClose={() => setTargetOpen(false)} />}
      {explainAt !== null && <ExplainSheet keyId={keyId} bar={bar} time={explainAt.time} to={explainAt.to} pct={explainAt.pct} onClose={() => setExplainAt(null)} />}

      <div className="section-head"><h2 className="section-title">AI 타이밍 분석</h2></div>
      <Segmented kind="radio" label="분석 기간" options={HORIZON_OPTIONS} value={horizon} onChange={changeHorizon} />
      <AnalysisPanel runs={runs} isSwap={isSwap} />

      {history.length > 1 && (
        <>
          <div className="section-head"><h2 className="section-title">AI 의견 기록</h2></div>
          <ul className="history" aria-label="AI 의견 기록">
            {history.map((h) => (
              <li key={h.id}>
                <b>{h.opinion}</b>
                <span>{PROVIDER_LABEL[h.provider]} {HORIZON_LABEL[h.horizon]}{h.tier === 'deep' ? ' 심층' : ''}, {formatTimeKst(h.dataTime)} 기준</span>
              </li>
            ))}
          </ul>
        </>
      )}

      <div className="sticky-actions">
        <button type="button" className="btn btn-ai" disabled={anyRunning} onClick={() => run(preferred, false)}>AI 타이밍 분석</button>
        <button type="button" className="btn" disabled={anyRunning} onClick={() => run(preferred, true)}>심층 분석</button>
        <button type="button" className="btn" disabled={anyRunning} onClick={() => run(other, false)} title={`${PROVIDER_LABEL[other]}에게 묻기`}>두 번째 의견</button>
      </div>
      {toast}
    </div>
  );
}
