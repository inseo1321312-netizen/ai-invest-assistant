import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { formatDateTimeKst } from '../format';
import { streamSse } from '../sse';
import type { ChartSpec, ProviderId } from '../types';
import { Dots, Icon, Segmented, Sheet, usd } from '../ui';
import { PROVIDER_LABEL } from './AnalysisPanel';
import { CandleChart } from './CandleChart';

interface Msg {
  id: number;
  role: 'user' | 'assistant';
  text: string;
  provider?: ProviderId;
  model?: string;
  costUsd?: number;
  question?: string;
  charts: ChartSpec[];
  status?: string | null;
  error?: string | null;
  running?: boolean;
}

interface ModelOption { id: string; label: string }
interface ModelsResponse { lists: Record<ProviderId, ModelOption[]>; defaults: Record<ProviderId, Record<'light' | 'standard' | 'deep', string>> }
interface Usage {
  today: { interactive: number; scheduled: number };
  month: number;
  limits: { interactiveDailyUsd: number; monthlyUsd: number; scheduledDailyUsd: number };
  requests?: { gpt5h: number; gptToday: number; claudeToday: number };
  gptLimitHitAt?: number | null;
}

const SUGGESTIONS = ['지금 내 포지션 위험해?', '오늘 시장 분위기 어때?', '이 종목 언제 사는 게 좋을까?', '최근 뉴스 요약해 줘'];
let seq = 0;

function readPref(): { provider: ProviderId; model: Record<ProviderId, string | null> } {
  try {
    const v = JSON.parse(localStorage.getItem('chat.pref') ?? 'null');
    if (v && (v.provider === 'claude' || v.provider === 'gpt')) return v;
  } catch { /* 기본값 */ }
  return { provider: 'claude', model: { claude: null, gpt: null } };
}
function savePref(p: ReturnType<typeof readPref>) {
  try { localStorage.setItem('chat.pref', JSON.stringify(p)); } catch { /* 무시 */ }
}

function ModelSheet({ models, provider, model, onPick, onClose }: {
  models: ModelsResponse | null; provider: ProviderId; model: Record<ProviderId, string | null>;
  onPick: (p: ProviderId, m: string) => void; onClose: () => void;
}) {
  const [tab, setTab] = useState<ProviderId>(provider);
  const list = models?.lists[tab] ?? [];
  const current = model[tab] ?? models?.defaults[tab].standard ?? null;
  return (
    <Sheet title="모델 선택" onClose={onClose}>
      <Segmented kind="tab" label="AI" value={tab} onChange={setTab} options={[{ value: 'claude', label: 'Claude' }, { value: 'gpt', label: 'GPT' }]} />
      <p className="small muted">{tab === 'gpt' ? 'ChatGPT 로그인으로 쓸 수 있는 모델이에요.' : 'Claude 구독 크레딧으로 쓰는 모델이에요. 비싼 모델일수록 크레딧이 빨리 줄어요.'}</p>
      {!models && <p className="status"><Dots /> 모델 목록을 불러오는 중…</p>}
      <ul className="option-list" role="radiogroup" aria-label={`${PROVIDER_LABEL[tab]} 모델`}>
        {list.map((m) => (
          <li key={m.id}>
            <button type="button" className="option" role="radio" aria-checked={current === m.id} onClick={() => { onPick(tab, m.id); onClose(); }}>
              <span>{m.label}</span>
              <small>{m.id === models?.defaults[tab].standard ? '기본' : m.id}</small>
            </button>
          </li>
        ))}
      </ul>
    </Sheet>
  );
}

function UsageSheet({ usage, onClose }: { usage: Usage | null; onClose: () => void }) {
  const pct = (a: number, b: number) => (b > 0 ? Math.min(100, (a / b) * 100) : 0);
  return (
    <Sheet title="사용량" onClose={onClose}>
      {!usage && <p className="status"><Dots /> 불러오는 중…</p>}
      {usage && (
        <>
          <h3 style={{ margin: '4px 0' }}>Claude (구독 크레딧)</h3>
          <div className="kv"><span>오늘 직접 사용</span><span className="num">{usd(usage.today.interactive)} / {usd(usage.limits.interactiveDailyUsd)}</span></div>
          <div className={`bar${pct(usage.today.interactive, usage.limits.interactiveDailyUsd) > 80 ? ' hot' : ''}`}><i style={{ width: `${pct(usage.today.interactive, usage.limits.interactiveDailyUsd)}%` }} /></div>
          <div className="kv"><span>이번 달</span><span className="num">{usd(usage.month)} / {usd(usage.limits.monthlyUsd)}</span></div>
          <div className={`bar${pct(usage.month, usage.limits.monthlyUsd) > 80 ? ' hot' : ''}`}><i style={{ width: `${pct(usage.month, usage.limits.monthlyUsd)}%` }} /></div>
          <h3 style={{ margin: '16px 0 4px' }}>ChatGPT Plus</h3>
          <div className="kv"><span>최근 5시간 요청</span><span className="num">{usage.requests?.gpt5h ?? 0}회</span></div>
          <div className="kv"><span>오늘 요청</span><span className="num">{usage.requests?.gptToday ?? 0}회</span></div>
          {usage.gptLimitHitAt && <p className="notice" style={{ margin: '8px 0 0' }}>마지막으로 한도에 걸린 시각: {formatDateTimeKst(Math.floor(usage.gptLimitHitAt / 1000))}</p>}
          <p className="small muted">ChatGPT Plus는 5시간마다 쓸 수 있는 양이 정해져 있어요. 남은 정확한 양은 OpenAI가 앱에 알려주지 않아서, ChatGPT 설정에서 확인하세요.</p>
          <a className="btn btn-block" href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">ChatGPT 사용량 열기</a>
        </>
      )}
    </Sheet>
  );
}

function HistorySheet({ keyId, onPick, onNew, onClose }: { keyId: string | null; onPick: (id: number) => void; onNew: () => void; onClose: () => void }) {
  const [chats, setChats] = useState<{ id: number; title: string; createdAt: number }[] | null>(null);
  useEffect(() => {
    api<{ chats: { id: number; title: string; createdAt: number }[] }>(`/api/chats${keyId ? `?key=${encodeURIComponent(keyId)}` : ''}`)
      .then((r) => setChats(r.chats)).catch(() => setChats([]));
  }, [keyId]);
  return (
    <Sheet title="이전 대화" onClose={onClose}>
      <button type="button" className="btn btn-block" onClick={() => { onNew(); onClose(); }}><Icon.plus /> 새 대화</button>
      {chats && chats.length === 0 && <p className="small muted">아직 대화가 없어요.</p>}
      <ul className="option-list" style={{ marginTop: 10 }}>
        {chats?.map((c) => (
          <li key={c.id}><button type="button" className="option" onClick={() => { onPick(c.id); onClose(); }}><span>{c.title}</span><small>{formatDateTimeKst(Math.floor(c.createdAt / 1000))}</small></button></li>
        ))}
      </ul>
    </Sheet>
  );
}

export function ChatView({ keyId, onClose }: { keyId: string | null; onClose?: () => void }) {
  const [pref, setPref] = useState(readPref);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sheet, setSheet] = useState<null | 'model' | 'usage' | 'history'>(null);
  const chatId = useRef<number | null>(null);
  const aborts = useRef<AbortController[]>([]);
  const endRef = useRef<HTMLDivElement>(null);

  const loadUsage = () => api<Usage>('/api/usage').then(setUsage).catch(() => undefined);

  useEffect(() => {
    api<ModelsResponse>('/api/ai/models').then(setModels).catch(() => undefined);
    void loadUsage();
    return () => aborts.current.forEach((a) => a.abort());
  }, []);

  async function openChat(id: number) {
    chatId.current = id;
    const r = await api<{ messages: { id: number; role: 'user' | 'assistant'; text: string; provider: ProviderId | null }[] }>(`/api/chats/${id}/messages`).catch(() => null);
    if (!r) return;
    let lastQ = '';
    setMessages(r.messages.map((m) => {
      if (m.role === 'user') lastQ = m.text;
      return { id: ++seq, role: m.role, text: m.text, provider: m.provider ?? undefined, question: m.role === 'assistant' ? lastQ : undefined, charts: [] };
    }));
  }

  // 같은 종목의 최근 대화(24시간 안)를 이어서 연다
  useEffect(() => {
    let alive = true;
    api<{ chats: { id: number; createdAt: number }[] }>(`/api/chats${keyId ? `?key=${encodeURIComponent(keyId)}` : ''}`)
      .then((r) => {
        const last = r.chats[0];
        if (alive && last && Date.now() - last.createdAt < 24 * 3600_000 && chatId.current === null) void openChat(last.id);
      })
      .catch(() => undefined);
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [keyId]);

  useEffect(() => { endRef.current?.scrollIntoView?.({ block: 'end', behavior: 'smooth' }); }, [messages]);

  const update = (id: number, f: (m: Msg) => Msg) => setMessages((prev) => prev.map((m) => (m.id === id ? f(m) : m)));
  const modelOf = (p: ProviderId) => pref.model[p] ?? null;
  const labelOf = (p: ProviderId, id: string | null | undefined) => {
    const real = id ?? models?.defaults[p].standard;
    return models?.lists[p].find((m) => m.id === real)?.label ?? real ?? PROVIDER_LABEL[p];
  };

  function ask(text: string, who: ProviderId, addUser: boolean) {
    const answerId = ++seq;
    setMessages((prev) => [
      ...prev,
      ...(addUser ? [{ id: ++seq, role: 'user' as const, text, charts: [] }] : []),
      { id: answerId, role: 'assistant', text: '', provider: who, question: text, charts: [], running: true, status: null },
    ]);
    const ctrl = new AbortController();
    aborts.current.push(ctrl);
    void streamSse('/api/chat', { chatId: chatId.current, key: keyId, provider: who, model: modelOf(who), text }, (type, d) => {
      if (type === 'chat') chatId.current = d.chatId;
      if (type === 'status') update(answerId, (m) => ({ ...m, status: d.message }));
      if (type === 'text') update(answerId, (m) => ({ ...m, text: m.text + d.delta, status: null }));
      if (type === 'chart') update(answerId, (m) => ({ ...m, charts: [...m.charts, d.spec] }));
      if (type === 'done') update(answerId, (m) => ({ ...m, model: d.model, costUsd: d.costUsd }));
      if (type === 'error') update(answerId, (m) => ({ ...m, error: d.message }));
    }, ctrl.signal).finally(() => { update(answerId, (m) => ({ ...m, running: false, status: null })); void loadUsage(); });
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    ask(text, pref.provider, true);
  }

  function pick(p: ProviderId, m: string) {
    const next = { provider: p, model: { ...pref.model, [p]: m } };
    setPref(next);
    savePref(next);
  }

  const busy = messages.some((m) => m.running);
  const claudePct = usage ? Math.min(100, (usage.today.interactive / Math.max(usage.limits.interactiveDailyUsd, 0.01)) * 100) : 0;
  const title = keyId ? `${keyId.split(':').slice(1).join(':')} 상담` : 'AI 상담';

  return (
    <div className="screen chat" role="region" aria-label="AI 채팅">
      <header className="topbar">
        {onClose ? <button type="button" className="icon-btn" aria-label="뒤로" onClick={onClose}><Icon.back /></button> : <h1>{title}</h1>}
        {onClose && <p className="title-sm">{title}</p>}
        <div className="chat-head-tools">
          <button type="button" className="icon-btn" aria-label="이전 대화" onClick={() => setSheet('history')}><Icon.history /></button>
        </div>
      </header>
      <div className="chat-head-tools" style={{ padding: '0 16px 6px', justifyContent: 'space-between' }}>
        <button type="button" className="model-btn" aria-label="AI 모델 선택" onClick={() => setSheet('model')}>
          <span className={`dot ${pref.provider}`} />{labelOf(pref.provider, modelOf(pref.provider))}<Icon.chevron />
        </button>
        <button type="button" className="usage-pill" aria-label="사용량" onClick={() => setSheet('usage')}>
          {usage ? (
            pref.provider === 'claude'
              ? <><span className={`meter${claudePct > 80 ? ' hot' : ''}`}><i style={{ width: `${claudePct}%` }} /></span><span className="num">오늘 {usd(usage.today.interactive)}</span></>
              : <span className="num">5시간 {usage.requests?.gpt5h ?? 0}회</span>
          ) : <span>사용량</span>}
        </button>
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="empty" style={{ margin: 0 }}>
            <p style={{ margin: 0 }}>사도 될지, 언제 팔지 고민을 적어 보세요. AI가 시세와 뉴스를 확인하고 같이 따져 봐요.</p>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => ask(s, pref.provider, true)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' && <p className="msg-who">{labelOf(m.provider!, m.model)}</p>}
            {m.charts.map((c, i) => (
              <div key={i} className="chart-card"><CandleChart keyId={c.key} bar={c.bar} markers={c.markers} from={c.from} to={c.to} height={200} /></div>
            ))}
            {m.text && <p className="msg-text">{m.text}</p>}
            {m.running && <p className="status" aria-live="polite"><Dots /> {m.status ?? '생각 중…'}</p>}
            {m.error && <p className="error" role="alert">{m.error}</p>}
            {m.role === 'assistant' && !m.running && m.question && (
              <div className="msg-foot">
                <span className="num">{m.costUsd !== undefined && m.costUsd > 0 ? `${usd(m.costUsd)} 사용` : ''}</span>
                <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => ask(m.question!, m.provider === 'claude' ? 'gpt' : 'claude', false)}>
                  {PROVIDER_LABEL[m.provider === 'claude' ? 'gpt' : 'claude']} 의견 듣기
                </button>
              </div>
            )}
          </div>
        ))}
        <div ref={endRef} />
      </div>

      <form className="composer" onSubmit={submit}>
        <textarea aria-label="메시지" rows={1} value={input} onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
          placeholder={`${PROVIDER_LABEL[pref.provider]}에게 물어보기`} />
        <button className="send-btn" type="submit" aria-label="보내기" disabled={busy || !input.trim()}><Icon.send /></button>
      </form>

      {sheet === 'model' && <ModelSheet models={models} provider={pref.provider} model={pref.model} onPick={pick} onClose={() => setSheet(null)} />}
      {sheet === 'usage' && <UsageSheet usage={usage} onClose={() => setSheet(null)} />}
      {sheet === 'history' && <HistorySheet keyId={keyId} onPick={(id) => void openChat(id)} onNew={() => { chatId.current = null; setMessages([]); }} onClose={() => setSheet(null)} />}
    </div>
  );
}
