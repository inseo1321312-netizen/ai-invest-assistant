import { useEffect, useRef, useState, type FormEvent } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api';
import { aiReady, type AiReady } from '../aiReady';
import { formatDateTimeKst } from '../format';
import { streamSse } from '../sse';
import type { ChartSpec, ProviderId } from '../types';
import { Disclaimer, Dots, Icon, Segmented, Sheet, usd } from '../ui';
import { PROVIDER_LABEL } from './AnalysisPanel';
import { CandleChart } from './CandleChart';
import { Markdown } from '../markdown';

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
  /** ChatGPT가 답과 함께 알려 준 실제 5시간 사용률(없으면 모름) */
  gptWindow?: { usedPct: number; windowMinutes: number | null; resetAt: number | null; at: number } | null;
}
interface ChatItem { id: number; key: string | null; title: string; createdAt: number }
type Depth = 'light' | 'standard' | 'deep';

const SUGGESTIONS = ['오늘 시장 분위기 어때?', '이 종목 언제 사는 게 좋을까?', '삼성전자 18만원 넘으면 알려줘', '삼성전자 10주 있어'];
const DEPTHS: { value: Depth; label: string }[] = [{ value: 'light', label: '빠르게' }, { value: 'standard', label: '보통' }, { value: 'deep', label: '깊게' }];
let seq = 0;

interface Pref { provider: ProviderId; model: Record<ProviderId, string | null>; depth: Depth }

function readPref(): Pref | null {
  try {
    const v = JSON.parse(localStorage.getItem('chat.pref') ?? 'null');
    if (v && (v.provider === 'claude' || v.provider === 'gpt')) return { depth: 'standard', ...v };
  } catch { /* 기본값 */ }
  return null;
}
function savePref(p: Pref) {
  try { localStorage.setItem('chat.pref', JSON.stringify(p)); } catch { /* 무시 */ }
}

function ago(ms: number): string {
  const min = Math.max(0, Math.round((Date.now() - ms) / 60_000));
  if (min < 1) return '방금';
  if (min < 60) return `${min}분 전`;
  const h = Math.round(min / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.round(h / 24)}일 전`;
}

/** 얼마나 썼는지 원 그래프 */
function Ring({ pct }: { pct: number }) {
  const r = 9;
  const c = 2 * Math.PI * r;
  return (
    <svg viewBox="0 0 24 24" className="ring" aria-hidden="true">
      <circle className="ring-bg" cx="12" cy="12" r={r} />
      <circle className="ring-fill" cx="12" cy="12" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - Math.min(100, pct) / 100)} />
    </svg>
  );
}

/** ChatGPT 구독의 실제 5시간 사용률(창이 지났으면 모름) */
function gptWindowPct(u: Usage): number | null {
  const w = u.gptWindow;
  if (!w) return null;
  const end = w.resetAt ?? w.at + (w.windowMinutes ?? 300) * 60_000;
  return end > Date.now() ? w.usedPct : null;
}

/**
 * 지금 고른 AI 기준 사용량. API는 오늘 한도 대비 금액(%).
 * ChatGPT 구독은 ChatGPT가 알려 준 실제 %만 쓰고, 모르면 숫자를 지어내지 않고 여유/한도만 보여준다.
 */
function usageNow(u: Usage, provider: ProviderId, gptMode: 'siwc' | 'apikey'): { pct: number | null; label: string } {
  if (provider === 'gpt' && gptMode === 'siwc') {
    const real = gptWindowPct(u);
    if (real !== null) return { pct: real, label: '5시간' };
    const hit = u.gptLimitHitAt && Date.now() - u.gptLimitHitAt < 5 * 3600_000;
    return hit ? { pct: 100, label: '한도' } : { pct: null, label: '여유' };
  }
  return { pct: (u.today.interactive / Math.max(u.limits.interactiveDailyUsd, 0.01)) * 100, label: '오늘' };
}

function Bar({ label, value, pct }: { label: string; value: string; pct: number }) {
  return (
    <>
      <div className="kv"><span>{label}</span><span className="num">{value}</span></div>
      <div className={`bar${pct > 80 ? ' hot' : ''}`}><i style={{ width: `${Math.min(100, pct)}%` }} /></div>
    </>
  );
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
  const pct = (a: number, b: number) => (b > 0 ? (a / b) * 100 : 0);
  const real = usage ? gptWindowPct(usage) : null;
  return (
    <Sheet title="사용량" onClose={onClose}>
      {!usage && <p className="status"><Dots /> 불러오는 중…</p>}
      {usage && (
        <>
          <h3 className="sheet-sub" style={{ marginTop: 4 }}>API</h3>
          <Bar label="오늘" value={`${usd(usage.today.interactive)} / ${usd(usage.limits.interactiveDailyUsd)}`} pct={pct(usage.today.interactive, usage.limits.interactiveDailyUsd)} />
          <Bar label="이번 달" value={`${usd(usage.month)} / ${usd(usage.limits.monthlyUsd)}`} pct={pct(usage.month, usage.limits.monthlyUsd)} />
          <h3 className="sheet-sub">ChatGPT 구독</h3>
          {real !== null && <Bar label="5시간 사용" value={`${Math.round(real)}%`} pct={real} />}
          <div className="kv"><span>최근 5시간 요청</span><span className="num">{usage.requests?.gpt5h ?? 0}회</span></div>
          <div className="kv"><span>오늘 요청</span><span className="num">{usage.requests?.gptToday ?? 0}회</span></div>
          {usage.gptLimitHitAt && <p className="notice" style={{ margin: '8px 0 0' }}>마지막으로 한도에 걸린 시각: {formatDateTimeKst(Math.floor(usage.gptLimitHitAt / 1000))}</p>}
          <a className="btn btn-block" style={{ marginTop: 12 }} href="https://chatgpt.com/settings/usage" target="_blank" rel="noreferrer noopener">ChatGPT 사용량 열기</a>
        </>
      )}
    </Sheet>
  );
}

/** 왼쪽에서 밀려 나오는 대화 목록 */
function ChatDrawer({ currentId, onPick, onNew, onDeleted, onClose }: {
  currentId: number | null; onPick: (id: number) => void; onNew: () => void; onDeleted: (id: number) => void; onClose: () => void;
}) {
  const [chats, setChats] = useState<ChatItem[] | null>(null);
  const [closing, setClosing] = useState(false);
  useEffect(() => {
    api<{ chats: ChatItem[] }>('/api/chats').then((r) => setChats(r.chats)).catch(() => setChats([]));
  }, []);
  const close = () => { setClosing(true); window.setTimeout(onClose, 200); };
  async function remove(id: number) {
    setChats((list) => (list ?? []).filter((c) => c.id !== id));
    await api(`/api/chats/${id}`, { method: 'DELETE' }).catch(() => undefined);
    onDeleted(id);
  }
  return createPortal(
    <div className={`drawer-wrap${closing ? ' closing' : ''}`}>
      <button type="button" className="drawer-backdrop" aria-label="대화 목록 닫기" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-label="대화 목록">
        <div className="drawer-head">
          <h2>대화</h2>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={close}><Icon.close /></button>
        </div>
        <button type="button" className="btn btn-primary btn-block" onClick={() => { onNew(); close(); }}><Icon.compose /> 새 대화</button>
        {chats === null && <p className="status"><Dots /></p>}
        {chats && chats.length === 0 && <p className="small muted">아직 대화가 없어요.</p>}
        <ul className="drawer-list">
          {chats?.map((c) => (
            <li key={c.id} className={c.id === currentId ? 'on' : undefined}>
              <button type="button" className="drawer-item" onClick={() => { onPick(c.id); close(); }}>
                <span>{c.title}</span>
                <small>{ago(c.createdAt)}</small>
              </button>
              <button type="button" className="icon-btn drawer-del" aria-label={`${c.title} 지우기`} onClick={() => remove(c.id)}><Icon.trash /></button>
            </li>
          ))}
        </ul>
      </aside>
    </div>,
    document.body,
  );
}

export function ChatView({ keyId, onClose }: { keyId: string | null; onClose?: () => void }) {
  const saved = useRef(readPref());
  const [pref, setPref] = useState<Pref>(() => saved.current ?? { provider: 'claude', model: { claude: null, gpt: null }, depth: 'standard' });
  const [ready, setReady] = useState<AiReady | null>(null);
  const [models, setModels] = useState<ModelsResponse | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [sheet, setSheet] = useState<null | 'model' | 'usage' | 'drawer'>(null);
  const [currentChat, setCurrentChat] = useState<number | null>(null);
  const chatId = useRef<number | null>(null);
  const aborts = useRef<AbortController[]>([]);
  const endRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // 입력칸은 글 길이만큼 늘린다
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    el.style.height = 'auto';
    if (el.scrollHeight > 0) el.style.height = `${Math.min(el.scrollHeight + 2, 140)}px`;
  }, [input]);

  const loadUsage = () => api<Usage>('/api/usage').then(setUsage).catch(() => undefined);

  useEffect(() => {
    api<ModelsResponse>('/api/ai/models').then(setModels).catch(() => undefined);
    void loadUsage();
    // Claude 키가 없으면 GPT로 시작(저장한 선택도 답할 수 없는 쪽이면 바꾼다)
    void aiReady().then((r) => {
      setReady(r);
      setPref((p) => {
        if (!saved.current) return { ...p, provider: r.preferred };
        const usable = p.provider === 'claude' ? r.claude : r.gpt;
        const other = p.provider === 'claude' ? r.gpt : r.claude;
        return !usable && other ? { ...p, provider: p.provider === 'claude' ? 'gpt' : 'claude' } : p;
      });
    });
    return () => aborts.current.forEach((a) => a.abort());
  }, []);

  async function openChat(id: number) {
    chatId.current = id;
    setCurrentChat(id);
    const r = await api<{ messages: { id: number; role: 'user' | 'assistant'; text: string; provider: ProviderId | null }[] }>(`/api/chats/${id}/messages`).catch(() => null);
    if (!r) return;
    let lastQ = '';
    setMessages(r.messages.map((m) => {
      if (m.role === 'user') lastQ = m.text;
      return { id: ++seq, role: m.role, text: m.text, provider: m.provider ?? undefined, question: m.role === 'assistant' ? lastQ : undefined, charts: [] };
    }));
  }

  function newChat() {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
    chatId.current = null;
    setCurrentChat(null);
    setMessages([]);
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
      // 생각하는 동안에도 고른 모델 이름을 보여준다(끝나면 실제로 답한 모델로 바뀜)
      { id: answerId, role: 'assistant', text: '', provider: who, model: modelOf(who) ?? undefined, question: text, charts: [], running: true, status: null },
    ]);
    const ctrl = new AbortController();
    aborts.current.push(ctrl);
    void streamSse('/api/chat', { chatId: chatId.current, key: keyId, provider: who, model: modelOf(who), text, depth: pref.depth }, (type, d) => {
      if (type === 'chat') { chatId.current = d.chatId; setCurrentChat(d.chatId); }
      if (type === 'status') update(answerId, (m) => ({ ...m, status: d.message }));
      if (type === 'text') update(answerId, (m) => ({ ...m, text: m.text + d.delta, status: null }));
      if (type === 'chart') update(answerId, (m) => ({ ...m, charts: [...m.charts, d.spec] }));
      if (type === 'done') update(answerId, (m) => ({ ...m, model: d.model, costUsd: d.costUsd }));
      if (type === 'error') update(answerId, (m) => ({ ...m, error: d.message }));
    }, ctrl.signal).finally(() => { update(answerId, (m) => ({ ...m, running: false, status: null })); void loadUsage(); });
  }

  function stop() {
    aborts.current.forEach((a) => a.abort());
    aborts.current = [];
  }

  function submit(e?: FormEvent) {
    e?.preventDefault();
    const text = input.trim();
    if (!text) return;
    setInput('');
    ask(text, pref.provider, true);
  }

  function setAndSave(next: Pref) {
    saved.current = next;
    setPref(next);
    savePref(next);
  }

  const busy = messages.some((m) => m.running);
  const now = usage ? usageNow(usage, pref.provider, ready?.gptMode ?? 'siwc') : null;
  const title = keyId ? `${keyId.split(':').slice(1).join(':')} 상담` : 'AI 상담';

  return (
    <div className="screen chat" role="region" aria-label="AI 채팅">
      <header className="topbar">
        {onClose
          ? <button type="button" className="icon-btn" aria-label="뒤로" onClick={onClose}><Icon.back /></button>
          : <button type="button" className="icon-btn" aria-label="대화 목록" onClick={() => setSheet('drawer')}><Icon.menu /></button>}
        <p className="title-sm">{title}</p>
        <div className="chat-head-tools">
          {onClose && <button type="button" className="icon-btn" aria-label="대화 목록" onClick={() => setSheet('drawer')}><Icon.menu /></button>}
          <button type="button" className="icon-btn" aria-label="새 대화" onClick={newChat}><Icon.compose /></button>
        </div>
      </header>
      <div className="chat-head-tools" style={{ padding: '0 16px 6px', justifyContent: 'space-between' }}>
        <button type="button" className="model-btn" aria-label="AI 모델 선택" onClick={() => setSheet('model')}>
          <span className={`dot ${pref.provider}`} />{labelOf(pref.provider, modelOf(pref.provider))}<Icon.chevron />
        </button>
        <button type="button" className={`usage-pill${now && now.pct !== null && now.pct > 80 ? ' hot' : ''}`} aria-label={now ? `사용량 ${now.label}${now.pct !== null ? ` ${Math.round(now.pct)}%` : ''}` : '사용량'} onClick={() => setSheet('usage')}>
          {now ? <><Ring pct={now.pct ?? 0} /><span className="num">{now.label}{now.pct !== null ? ` ${Math.round(Math.min(100, now.pct))}%` : ''}</span></> : <span>사용량</span>}
        </button>
      </div>

      <div className="messages">
        {messages.length === 0 && (
          <div className="chat-empty rise">
            <div className="orb" aria-hidden="true"><Icon.spark /></div>
            <h2>무엇이든 물어보세요</h2>
            <div className="suggestions">
              {SUGGESTIONS.map((s) => <button key={s} type="button" onClick={() => ask(s, pref.provider, true)}>{s}</button>)}
            </div>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={`msg msg-${m.role}`}>
            {m.role === 'assistant' && <p className="msg-who"><span className={`provider-dot ${m.provider}`} aria-hidden="true" />{labelOf(m.provider!, m.model)}</p>}
            {m.charts.map((c, i) => (
              <div key={i} className="chart-card"><CandleChart keyId={c.key} bar={c.bar} markers={c.markers} from={c.from} to={c.to} height={200} /></div>
            ))}
            {m.text && (m.role === 'assistant' ? <Markdown text={m.text} /> : <p className="msg-text">{m.text}</p>)}
            {m.running && <p className="status" aria-live="polite"><Dots /> {m.status ?? '생각 중…'}</p>}
            {!m.running && m.status && <p className="agent-done">{m.status}</p>}
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
        <Disclaimer />
        <div ref={endRef} />
      </div>

      <div className="composer-wrap">
        <Segmented small kind="radio" label="생각 깊이" value={pref.depth} onChange={(depth: Depth) => setAndSave({ ...pref, depth })} options={DEPTHS} />
        <form className="composer" onSubmit={submit}>
          <textarea ref={boxRef} aria-label="메시지" rows={1} value={input} onChange={(e) => setInput(e.target.value)}
            onFocus={() => setTimeout(() => endRef.current?.scrollIntoView?.({ block: 'end' }), 350)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); submit(); } }}
            placeholder={`${PROVIDER_LABEL[pref.provider]}에게 물어보기`} />
          {busy
            ? <button className="send-btn stop" type="button" aria-label="멈추기" onClick={stop}><Icon.stop /></button>
            : <button className="send-btn" type="submit" aria-label="보내기" disabled={!input.trim()}><Icon.send /></button>}
        </form>
      </div>

      {sheet === 'model' && <ModelSheet models={models} provider={pref.provider} model={pref.model} onPick={(p, m) => setAndSave({ ...pref, provider: p, model: { ...pref.model, [p]: m } })} onClose={() => setSheet(null)} />}
      {sheet === 'usage' && <UsageSheet usage={usage} onClose={() => setSheet(null)} />}
      {sheet === 'drawer' && (
        <ChatDrawer currentId={currentChat} onPick={(id) => void openChat(id)} onNew={newChat}
          onDeleted={(id) => { if (id === chatId.current) newChat(); }} onClose={() => setSheet(null)} />
      )}
    </div>
  );
}
