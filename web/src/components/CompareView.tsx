import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { aiReady } from '../aiReady';
import { changeClass, formatPrice, parseKey } from '../format';
import { streamSse } from '../sse';
import type { Currency, Horizon, ProviderId } from '../types';
import { Dots, Icon, Segmented } from '../ui';
import { PROVIDER_LABEL } from './AnalysisPanel';
import { Avatar } from './rows';
import { SearchSheet } from './SearchSheet';

interface Pick { key: string; name: string | null }
interface Facts { price: number | null; currency: Currency | null; dayPct: number | null; monthPct: number | null; yearPos: number | null; aboveMa20: boolean | null }
interface Rank { key: string; rank: number; opinion: string; reason: string; risk: string }
export interface CompareResult {
  id: number; keys: string[]; names: Record<string, string | null>; horizon: Horizon; provider: ProviderId; model: string;
  pick: string | null; confidence: string; summary: string; ranking: Rank[]; facts: Record<string, Facts | null>; createdAt: number;
}
interface Suggest { key: string; name: string | null; source: 'holding' | 'favorite' }
interface Past { id: number; keys: string[]; names: Record<string, string | null>; horizon: Horizon; provider: ProviderId; pick: string | null; createdAt: number }

const MAX = 4;
const HORIZONS: { value: Horizon; label: string }[] = [{ value: 'scalp', label: '단타' }, { value: 'swing', label: '스윙' }, { value: 'long', label: '장기' }];
const HORIZON_LABEL: Record<Horizon, string> = { scalp: '단타', swing: '스윙', long: '장기' };
const STORE = 'compare.pick';

function readSaved(): { keys: Pick[]; horizon: Horizon } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (v && Array.isArray(v.keys)) return { keys: v.keys.slice(0, MAX), horizon: ['scalp', 'swing', 'long'].includes(v.horizon) ? v.horizon : 'swing' };
  } catch { /* 처음 */ }
  return { keys: [], horizon: 'swing' };
}

const short = (key: string) => key.split(':').at(-1)!;
/** 받침이 있으면 '이', 없으면 '가' */
function subj(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '이' : '가';
}
const signed = (n: number | null) => (n === null ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);

function ago(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return min < 1 ? '방금' : `${min}분 전`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

/** 비교 탭: 2~4개를 골라 지금 사기에 뭐가 나은지 AI 판정을 받는다 */
export function CompareView({ seed, onOpen, onAsk }: { seed: string | null; onOpen: (key: string) => void; onAsk: (text: string) => void }) {
  const [picks, setPicks] = useState<Pick[]>(() => {
    const saved = readSaved().keys;
    return seed && !saved.some((p) => p.key === seed) && saved.length < MAX ? [...saved, { key: seed, name: null }] : saved;
  });
  const [horizon, setHorizon] = useState<Horizon>(() => readSaved().horizon);
  const [suggest, setSuggest] = useState<Suggest[]>([]);
  const [past, setPast] = useState<Past[]>([]);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareResult | null>(null);
  const abort = useRef<AbortController | null>(null);

  const loadPast = () => api<{ items: Past[] }>('/api/compare/history').then((r) => setPast(r.items)).catch(() => undefined);

  useEffect(() => {
    api<{ items: Suggest[] }>('/api/compare/suggest').then((r) => setSuggest(r.items)).catch(() => undefined);
    void loadPast();
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ keys: picks, horizon })); } catch { /* 저장 못 해도 괜찮다 */ }
  }, [picks, horizon]);

  // 이름을 모르는 종목(종목 화면에서 담은 것)은 이름을 물어 온다
  useEffect(() => {
    for (const p of picks.filter((x) => x.name === null)) {
      api<{ name?: string | null }>(`/api/market/quote?key=${encodeURIComponent(p.key)}`)
        .then((r) => { if (r.name) setPicks((list) => list.map((x) => (x.key === p.key ? { ...x, name: r.name! } : x))); })
        .catch(() => undefined);
    }
  }, [picks]);

  const nameOf = (key: string, names?: Record<string, string | null>) => names?.[key] ?? picks.find((p) => p.key === key)?.name ?? short(key);

  function add(key: string, name: string | null = null) {
    setPicks((list) => (list.some((p) => p.key === key) || list.length >= MAX ? list : [...list, { key, name }]));
  }
  const remove = (key: string) => setPicks((list) => list.filter((p) => p.key !== key));

  async function run(provider?: ProviderId) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    setStatus('준비하는 중…');
    const who = provider ?? (await aiReady()).preferred;
    await streamSse('/api/compare', { keys: picks.map((p) => p.key), horizon, provider: who }, (type, d) => {
      if (type === 'status') setStatus(d.message);
      if (type === 'compare') { setResult(d.result); void loadPast(); }
      if (type === 'error') setError(d.message);
    }, ctrl.signal);
    if (!ctrl.signal.aborted) setStatus(null);
  }

  async function openPast(id: number) {
    const r = await api<{ result: CompareResult }>(`/api/compare/${id}`).catch(() => null);
    if (r) { setResult(r.result); setError(null); }
  }

  function askMore(r: CompareResult) {
    const names = r.keys.map((k) => nameOf(k, r.names));
    const verdict = r.pick ? `${nameOf(r.pick, r.names)}${subj(nameOf(r.pick, r.names))} 낫다고` : '지금은 기다리는 게 낫다고';
    onAsk(`${names.join('·')} ${HORIZON_LABEL[r.horizon]} 비교에서 ${verdict} 나왔는데, `);
  }

  const busy = status !== null;
  const quick = picks.length < MAX ? suggest.filter((s) => !picks.some((p) => p.key === s.key)) : [];
  const other: ProviderId | null = result ? (result.provider === 'claude' ? 'gpt' : 'claude') : null;

  return (
    <div className="screen compare" role="region" aria-label="비교">
      <header className="topbar">
        <div>
          <p className="topbar-sub">지금 사기에 뭐가 나을까</p>
          <h1>비교</h1>
        </div>
      </header>

      <section className="cmp-pick">
        <div className="cmp-chips">
          {picks.map((p) => (
            <span key={p.key} className="cmp-chip">
              <Avatar inst={parseKey(p.key, p.name)} logoKey={p.key} />
              <span className="cmp-chip-name">{p.name ?? short(p.key)}</span>
              <button type="button" className="cmp-x" aria-label={`${p.name ?? short(p.key)} 빼기`} onClick={() => remove(p.key)}><Icon.close /></button>
            </span>
          ))}
          {picks.length < MAX && (
            <button type="button" className="cmp-add" aria-label="종목 추가" onClick={() => setSearching(true)}><Icon.plus />{picks.length === 0 ? '종목 담기' : '추가'}</button>
          )}
        </div>
        {quick.length > 0 && (
          <div className="cmp-quick" aria-label="보유·즐겨찾기에서 담기">
            {quick.map((s) => (
              <button key={s.key} type="button" aria-label={`${s.name ?? short(s.key)} 담기`} onClick={() => add(s.key, s.name)}>
                <span className={`cmp-src ${s.source}`} aria-hidden="true" />{s.name ?? short(s.key)}
              </button>
            ))}
          </div>
        )}
        <Segmented small kind="radio" label="기간" value={horizon} onChange={setHorizon} options={HORIZONS} />
        <button type="button" className="btn btn-ai btn-block cmp-go" disabled={picks.length < 2 || busy} onClick={() => void run()}>
          {busy ? <><Dots /> {status}</> : '비교하기'}
        </button>
        {picks.length < 2 && !busy && <p className="cmp-hint">두 개 이상 담으면 비교할 수 있어요</p>}
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {result && <ResultCard r={result} nameOf={(k) => nameOf(k, result.names)} onOpen={onOpen} busy={busy}
        onOther={other ? () => void run(other) : undefined} otherLabel={other ? `${PROVIDER_LABEL[other]} 의견` : ''} onAsk={() => askMore(result)} />}

      {past.length > 0 && (
        <section className="cmp-past">
          <h2 className="section-title">지난 비교</h2>
          <ul className="list" aria-label="지난 비교">
            {past.map((p) => (
              <li key={p.id}>
                <button type="button" className="cmp-past-row" onClick={() => void openPast(p.id)}>
                  <span className="cmp-past-names">{p.keys.map((k) => p.names[k] ?? short(k)).join(' · ')}</span>
                  <small>{HORIZON_LABEL[p.horizon]} · {p.pick ? `${p.names[p.pick] ?? short(p.pick)}` : '기다리기'} · {PROVIDER_LABEL[p.provider]} · {ago(p.createdAt)}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {searching && <SearchSheet onOpen={(key, name) => add(key, name ?? null)} onClose={() => setSearching(false)} />}
    </div>
  );
}

function ResultCard({ r, nameOf, onOpen, onOther, otherLabel, onAsk, busy }: {
  r: CompareResult; nameOf: (k: string) => string; onOpen: (k: string) => void; onOther?: () => void; otherLabel: string; onAsk: () => void; busy: boolean;
}) {
  const order = r.ranking.map((x) => x.key);
  return (
    <section className="cmp-result rise" role="region" aria-label="비교 결과">
      <div className="cmp-verdict">
        <p className="cmp-verdict-main">{r.pick ? <>지금은 <b>{nameOf(r.pick)}</b></> : <>지금은 <b>기다리기</b></>}</p>
        <span className="cmp-conf">확신 {r.confidence}</span>
      </div>
      <p className="cmp-summary">{r.summary}</p>
      <ol className="cmp-rank" aria-label="순위">
        {r.ranking.map((x) => (
          <li key={x.key} className={x.key === r.pick ? 'top' : undefined}>
            <span className="cmp-n num">{x.rank}</span>
            <div className="cmp-rank-body">
              <button type="button" className="cmp-rank-name" onClick={() => onOpen(x.key)}>
                <Avatar inst={parseKey(x.key, nameOf(x.key))} logoKey={x.key} />{nameOf(x.key)}
                <span className={`cmp-op op-${x.opinion}`}>{x.opinion}</span>
              </button>
              <p className="cmp-why">{x.reason}</p>
              <p className="cmp-risk">{x.risk}</p>
            </div>
          </li>
        ))}
      </ol>
      <div className="cmp-table-wrap">
        <table className="cmp-table" aria-label="나란히 보기">
          <thead><tr><th />{order.map((k) => <th key={k} scope="col">{nameOf(k)}</th>)}</tr></thead>
          <tbody>
            <tr><th scope="row">가격</th>{order.map((k) => { const f = r.facts[k]; return <td key={k} className="num">{f?.price != null && f.currency ? formatPrice(f.price, f.currency) : '—'}</td>; })}</tr>
            <tr><th scope="row">오늘</th>{order.map((k) => <td key={k} className={`num ${changeClass(r.facts[k]?.dayPct)}`}>{signed(r.facts[k]?.dayPct ?? null)}</td>)}</tr>
            <tr><th scope="row">한 달</th>{order.map((k) => <td key={k} className={`num ${changeClass(r.facts[k]?.monthPct)}`}>{signed(r.facts[k]?.monthPct ?? null)}</td>)}</tr>
            <tr><th scope="row">52주 위치</th>{order.map((k) => {
              const y = r.facts[k]?.yearPos ?? null;
              return <td key={k}>{y === null ? '—' : <span className="cmp-year"><i><b style={{ left: `${Math.round(y)}%` }} /></i><span className="num">{Math.round(y)}%</span></span>}</td>;
            })}</tr>
            <tr><th scope="row">추세</th>{order.map((k) => { const a = r.facts[k]?.aboveMa20; return <td key={k} className={a === true ? 'up' : a === false ? 'down' : ''}>{a === null || a === undefined ? '—' : a ? '20일선 위' : '20일선 아래'}</td>; })}</tr>
          </tbody>
        </table>
      </div>
      <p className="cmp-who">{PROVIDER_LABEL[r.provider]} · {HORIZON_LABEL[r.horizon]} 기준</p>
      <div className="cmp-actions">
        {onOther && <button type="button" className="btn" disabled={busy} onClick={onOther}>{otherLabel}</button>}
        <button type="button" className="btn btn-primary" onClick={onAsk}><Icon.chat /> 이어서 묻기</button>
      </div>
    </section>
  );
}
