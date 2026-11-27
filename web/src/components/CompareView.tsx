import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { aiReady, type AiReady } from '../aiReady';
import { changeClass, formatPrice, parseKey } from '../format';
import { streamSse } from '../sse';
import type { Currency, Horizon, ProviderId } from '../types';
import { Dots, Icon, Segmented } from '../ui';
import { PROVIDER_LABEL } from './AnalysisPanel';
import { Avatar } from './rows';
import { SearchSheet } from './SearchSheet';

interface Pick { key: string; name: string | null }
interface Live { price: number; changePct24h: number; currency: Currency }
interface Facts { price: number | null; currency: Currency | null; dayPct: number | null; monthPct: number | null; yearPos: number | null; aboveMa20: boolean | null }
interface Rank { key: string; rank: number; opinion: string; reason: string; risk: string }
export interface CompareResult {
  id: number; keys: string[]; names: Record<string, string | null>; horizon: Horizon; provider: ProviderId; model: string;
  pick: string | null; confidence: string; summary: string; ranking: Rank[]; facts: Record<string, Facts | null>; createdAt: number;
}
interface Suggest { key: string; name: string | null; source: 'holding' | 'favorite' }
interface Past { id: number; keys: string[]; names: Record<string, string | null>; horizon: Horizon; provider: ProviderId; pick: string | null; createdAt: number }

const MAX = 4;
/** 단타·스윙·장기 대신 쉬운 말로 */
const HORIZONS: { value: Horizon; label: string }[] = [{ value: 'scalp', label: '하루 안' }, { value: 'swing', label: '몇 주' }, { value: 'long', label: '몇 달 이상' }];
const HORIZON_LABEL: Record<Horizon, string> = { scalp: '하루 안', swing: '몇 주', long: '몇 달 이상' };
const STORE = 'compare.pick';
const LAST = 'compare.last';

function readSaved(): { keys: Pick[]; horizon: Horizon } {
  try {
    const v = JSON.parse(localStorage.getItem(STORE) ?? 'null');
    if (v && Array.isArray(v.keys)) return { keys: v.keys.slice(0, MAX), horizon: ['scalp', 'swing', 'long'].includes(v.horizon) ? v.horizon : 'swing' };
  } catch { /* 처음 */ }
  return { keys: [], horizon: 'swing' };
}
function readLast(): CompareResult | null {
  try { return JSON.parse(sessionStorage.getItem(LAST) ?? 'null'); } catch { return null; }
}

const short = (key: string) => key.split(':').at(-1)!;
/** 받침이 있으면 '이', 없으면 '가' */
function subj(word: string): string {
  const c = word.charCodeAt(word.length - 1);
  return c >= 0xac00 && c <= 0xd7a3 && (c - 0xac00) % 28 !== 0 ? '이' : '가';
}
const signed = (n: number | null | undefined) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(1)}%`);
const opClass = (op: string) => (op === '매수' || op === '롱 진입' ? 'buy' : op === '매도' || op === '숏 진입' ? 'sell' : 'hold');

function ago(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 60) return min < 1 ? '방금' : `${min}분 전`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

/** 비교 탭: VS 칸에 2~4개를 담고, 얼마나 들고 갈지 고르면 AI가 지금 사기에 뭐가 나은지 판정한다 */
export function CompareView({ seed, onOpen, onAsk }: { seed: string | null; onOpen: (key: string) => void; onAsk: (text: string) => void }) {
  const [picks, setPicks] = useState<Pick[]>(() => {
    const saved = readSaved().keys;
    return seed && !saved.some((p) => p.key === seed) && saved.length < MAX ? [...saved, { key: seed, name: null }] : saved;
  });
  // 4개가 다 찼을 때 종목 화면에서 담은 것: 하나를 빼면 그 자리에 들어간다
  const [pending, setPending] = useState<Pick | null>(() => {
    const saved = readSaved().keys;
    return seed && !saved.some((p) => p.key === seed) && saved.length >= MAX ? { key: seed, name: null } : null;
  });
  const [horizon, setHorizon] = useState<Horizon>(() => readSaved().horizon);
  // 담은 종목 시세: null = 불러오는 중, false = 못 불러옴
  const [live, setLive] = useState<Record<string, Live | null | false>>({});
  const [ready, setReady] = useState<AiReady | null>(null);
  const [suggest, setSuggest] = useState<Suggest[]>([]);
  const [past, setPast] = useState<Past[]>([]);
  const [searching, setSearching] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResultState] = useState<CompareResult | null>(readLast);
  const abort = useRef<AbortController | null>(null);

  const setResult = (r: CompareResult) => {
    setResultState(r);
    try { sessionStorage.setItem(LAST, JSON.stringify(r)); } catch { /* 못 남겨도 괜찮다 */ }
  };
  const loadPast = () => api<{ items: Past[] }>('/api/compare/history').then((r) => setPast(r.items)).catch(() => undefined);

  useEffect(() => {
    api<{ items: Suggest[] }>('/api/compare/suggest').then((r) => setSuggest(r.items)).catch(() => undefined);
    void loadPast();
    void aiReady().then(setReady);
    return () => abort.current?.abort();
  }, []);

  useEffect(() => {
    try { localStorage.setItem(STORE, JSON.stringify({ keys: picks, horizon })); } catch { /* 저장 못 해도 괜찮다 */ }
  }, [picks, horizon]);

  // 담은 종목: 지금 가격·오늘 등락(이름을 모르면 이름도)
  useEffect(() => {
    for (const p of picks.filter((x) => !(x.key in live))) {
      setLive((m) => ({ ...m, [p.key]: null }));
      api<{ quote: Live; name?: string | null }>(`/api/market/quote?key=${encodeURIComponent(p.key)}`)
        .then((r) => {
          setLive((m) => ({ ...m, [p.key]: r.quote && typeof r.quote.price === 'number' ? r.quote : false }));
          if (!p.name && r.name) setPicks((list) => list.map((x) => (x.key === p.key ? { ...x, name: r.name! } : x)));
        })
        .catch(() => setLive((m) => ({ ...m, [p.key]: false })));
    }
  }, [picks]);

  const nameOf = (key: string, names?: Record<string, string | null>) => names?.[key] ?? picks.find((p) => p.key === key)?.name ?? short(key);

  function add(key: string, name: string | null = null) {
    setPicks((list) => (list.some((p) => p.key === key) || list.length >= MAX ? list : [...list, { key, name }]));
  }
  function remove(key: string) {
    setPicks((list) => {
      const next = list.filter((p) => p.key !== key);
      return pending && !next.some((p) => p.key === pending.key) ? [...next, pending] : next;
    });
    setPending(null);
  }

  async function run(provider?: ProviderId, keys: string[] = picks.map((p) => p.key), h: Horizon = horizon) {
    abort.current?.abort();
    const ctrl = new AbortController();
    abort.current = ctrl;
    setError(null);
    setStatus('준비하는 중…');
    const who = provider ?? (await aiReady()).preferred;
    await streamSse('/api/compare', { keys, horizon: h, provider: who }, (type, d) => {
      if (type === 'status') setStatus(d.message);
      if (type === 'compare') { setResult(d.result); void loadPast(); }
      if (type === 'error') setError(d.message);
    }, ctrl.signal);
    if (!ctrl.signal.aborted) setStatus(null);
  }

  async function openPast(id: number) {
    abort.current?.abort();
    setStatus(null);
    const r = await api<{ result: CompareResult }>(`/api/compare/${id}`).catch(() => null);
    if (r) { setResult(r.result); setError(null); }
  }

  function askMore(r: CompareResult) {
    const names = r.keys.map((k) => nameOf(k, r.names));
    const verdict = r.pick ? `${nameOf(r.pick, r.names)}${subj(nameOf(r.pick, r.names))} 낫다고` : '지금은 기다리는 게 낫다고';
    onAsk(`${names.join('·')} 비교(${HORIZON_LABEL[r.horizon]} 기준)에서 ${verdict} 나왔는데, `);
  }

  const busy = status !== null;
  const quick = picks.length < MAX ? suggest.filter((s) => !picks.some((p) => p.key === s.key)) : [];
  const empties = Math.max(0, 2 - picks.length);
  // 다른 AI는 연결돼 있을 때만
  const otherId: ProviderId | null = result ? (result.provider === 'claude' ? 'gpt' : 'claude') : null;
  const other = otherId && ready && ready[otherId] ? otherId : null;

  return (
    <div className="screen compare" role="region" aria-label="비교">
      <header className="topbar">
        <div>
          <p className="topbar-sub">지금 사기에 뭐가 나을까?</p>
          <h1>비교</h1>
        </div>
      </header>

      <div className={`vs${picks.length + empties > 2 ? ' grid' : ''}`} role="group" aria-label="비교할 종목">
        {/* 두 칸일 때 그 사이 한가운데 */}
        {picks.length + empties === 2 && <span className="vs-badge" aria-hidden="true">VS</span>}
        {picks.map((p, i) => {
          const q = live[p.key];
          const name = p.name ?? short(p.key);
          return (
            <div key={p.key} className="vs-slot" role="group" aria-label={name}>
              <button type="button" className="vs-x" aria-label={`${name} 빼기`} onClick={() => remove(p.key)}><Icon.close /></button>
              <Avatar inst={parseKey(p.key, p.name)} logoKey={p.key} />
              <span className="vs-name">{name}</span>
              <span className="vs-price num">{q ? formatPrice(q.price, q.currency) : q === false ? '—' : <span className="skeleton vs-sk" />}</span>
              <span className={`vs-chg num ${changeClass(q ? q.changePct24h : null)}`}>{q ? signed(q.changePct24h) : ''}</span>
            </div>
          );
        })}
        {Array.from({ length: empties }, (_, i) => (
          <button key={`e${i}`} type="button" className="vs-slot empty" aria-label="종목 담기" onClick={() => setSearching(true)}>
            <span className="vs-plus" aria-hidden="true"><Icon.plus /></span>
            <span>종목 담기</span>
          </button>
        ))}
      </div>
      {picks.length >= 2 && picks.length < MAX && (
        <button type="button" className="vs-more" aria-label="종목 추가" onClick={() => setSearching(true)}><Icon.plus /> 하나 더 <small>(최대 4개)</small></button>
      )}
      {pending && <p className="cmp-hint" role="status">{pending.name ?? short(pending.key)} — 4개까지 담을 수 있어요. 하나를 빼면 바로 담을게요</p>}

      {quick.length > 0 && (
        <div className="cmp-quick" aria-label="보유·즐겨찾기에서 담기">
          <span className="cmp-quick-label">보유·즐겨찾기</span>
          {quick.map((s) => (
            <button key={s.key} type="button" aria-label={`${s.name ?? short(s.key)} 담기`} onClick={() => add(s.key, s.name)}>{s.name ?? short(s.key)}</button>
          ))}
        </div>
      )}

      <section className="vs-ask">
        <p className="vs-q" id="vs-q">얼마나 들고 갈 건가요?</p>
        <Segmented kind="radio" label="얼마나 들고 갈 건가요?" value={horizon} onChange={setHorizon} options={HORIZONS} />
        <button type="button" className="btn btn-ai btn-block vs-go" disabled={picks.length < 2 || busy} onClick={() => void run()}>
          {busy ? <><Dots /> {status}</> : 'AI에게 뭐가 나은지 묻기'}
        </button>
        {error && <p className="error" role="alert">{error}</p>}
      </section>

      {result && (
        <ResultCard r={result} nameOf={(k) => nameOf(k, result.names)} onOpen={onOpen} busy={busy}
          onOther={other ? () => void run(other, result.keys, result.horizon) : undefined} onAsk={() => askMore(result)} />
      )}

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

function ResultCard({ r, nameOf, onOpen, onOther, onAsk, busy }: {
  r: CompareResult; nameOf: (k: string) => string; onOpen: (k: string) => void; onOther?: () => void; onAsk: () => void; busy: boolean;
}) {
  const order = r.ranking.map((x) => x.key);
  const rank = (k: string) => r.ranking.find((x) => x.key === k)!;
  const maxMonth = Math.max(1, ...order.map((k) => Math.abs(r.facts[k]?.monthPct ?? 0)));
  const win = (k: string) => (k === r.pick ? 'win' : undefined);
  return (
    <section className="cmp-result rise" role="region" aria-label="비교 결과">
      <div className="cmp-verdict">
        <p className="cmp-verdict-main">{r.pick ? <>1위 <b>{nameOf(r.pick)}</b></> : <>지금은 <b>기다리기</b></>}</p>
        <span className="cmp-conf">확신 {r.confidence}</span>
      </div>
      <p className="vs-quote">“{r.summary}”</p>
      <div className="cmp-table-wrap">
        <table className={`vs-table n${order.length}`} aria-label="나란히 보기">
          <thead>
            <tr>
              <th />
              {order.map((k) => (
                <th key={k} scope="col" className={win(k)}>
                  <button type="button" className="vs-col" onClick={() => onOpen(k)}><span className="cmp-th">{nameOf(k)}</span>{k === r.pick && ' ✓'}</button>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr><th scope="row">AI 의견</th>{order.map((k) => <td key={k} className={win(k)}><span className={`cmp-op op-${opClass(rank(k).opinion)}`}>{rank(k).opinion}</span></td>)}</tr>
            <tr><th scope="row">오늘</th>{order.map((k) => <td key={k} className={`num ${changeClass(r.facts[k]?.dayPct)} ${win(k) ?? ''}`}>{signed(r.facts[k]?.dayPct)}</td>)}</tr>
            <tr><th scope="row">한 달</th>{order.map((k) => {
              const m = r.facts[k]?.monthPct ?? null;
              return (
                <td key={k} className={win(k)}>
                  <span className={`num ${changeClass(m)}`}>{signed(m)}</span>
                  {m !== null && <i className={`vs-bar ${m >= 0 ? 'up' : 'down'}`} style={{ width: `${Math.max(6, (Math.abs(m) / maxMonth) * 100)}%` }} aria-hidden="true" />}
                </td>
              );
            })}</tr>
            <tr><th scope="row">52주 위치</th>{order.map((k) => {
              const y = r.facts[k]?.yearPos ?? null;
              return <td key={k} className={win(k)}>{y === null ? '—' : <span className="cmp-year"><i><b style={{ left: `${Math.round(y)}%` }} /></i><span className="num">{Math.round(y)}%</span></span>}</td>;
            })}</tr>
            <tr><th scope="row">20일선</th>{order.map((k) => { const a = r.facts[k]?.aboveMa20; return <td key={k} className={`${a === true ? 'up' : a === false ? 'down' : ''} ${win(k) ?? ''}`}>{a === null || a === undefined ? '—' : a ? '위' : '아래'}</td>; })}</tr>
            <tr className="vs-text"><th scope="row">이유</th>{order.map((k) => <td key={k} className={win(k)}>{rank(k).reason}</td>)}</tr>
            <tr className="vs-text"><th scope="row">위험</th>{order.map((k) => <td key={k} className={`muted ${win(k) ?? ''}`}>{rank(k).risk}</td>)}</tr>
          </tbody>
        </table>
      </div>
      <p className="cmp-who">{PROVIDER_LABEL[r.provider]} · {HORIZON_LABEL[r.horizon]} 기준</p>
      <div className="cmp-actions">
        {onOther && <button type="button" className="btn" disabled={busy} onClick={onOther}>다른 AI에게도 묻기</button>}
        <button type="button" className="btn btn-primary" onClick={onAsk}><Icon.chat /> 이어서 묻기</button>
      </div>
    </section>
  );
}
