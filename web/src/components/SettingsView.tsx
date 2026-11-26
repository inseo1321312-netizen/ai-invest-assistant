import { useEffect, useState } from 'react';
import { api, ApiError, post } from '../api';
import { formatDateTimeKst } from '../format';
import { useToast, usd } from '../ui';
import { AlertSettings } from './AlertSettings';
import { ChatgptConnect } from './ChatgptConnect';
import { AboutSettings, DataSettings, DisplaySettings } from './MoreSettings';

const MENU: [string, string][] = [['set-display', '화면'], ['set-ai', 'AI'], ['set-alerts', '알림'], ['set-check', '연결 점검'], ['set-data', '데이터'], ['set-about', '앱 정보']];

interface Settings {
  models: Record<'claude' | 'gpt', Record<'light' | 'standard' | 'deep', string>>;
  gptMode: 'siwc' | 'apikey';
  budget: { scheduledDailyUsd: number; interactiveDailyUsd: number; monthlyUsd: number; gptMonthlyUsd: number };
  keys: { claude: boolean; openai: boolean; kis: boolean; push: boolean };
}
interface Usage { today: { interactive: number; scheduled: number }; month: number; gptMonth: number; requests?: { gpt5h: number; gptToday: number } }
type BudgetKey = keyof Settings['budget'];

const TIER_LABEL = { light: '가벼운', standard: '기본', deep: '심층' } as const;
const BUDGET_FIELDS: [BudgetKey, string][] = [
  ['interactiveDailyUsd', '하루 직접 사용'], ['scheduledDailyUsd', '하루 예약 작업'], ['monthlyUsd', '한 달 전체'], ['gptMonthlyUsd', '한 달 GPT 종량제'],
];

function isStandalone(): boolean {
  try {
    return window.matchMedia?.('(display-mode: standalone)').matches === true || (navigator as { standalone?: boolean }).standalone === true;
  } catch {
    return false;
  }
}

function urlBase64ToUint8Array(base64: string): Uint8Array {
  const pad = '='.repeat((4 - (base64.length % 4)) % 4);
  const raw = atob((base64 + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

function UsageBar({ label, used, limit }: { label: string; used: number; limit: number }) {
  const pct = limit > 0 ? Math.min(100, (used / limit) * 100) : 0;
  return (
    <>
      <div className="kv num"><span>{label}</span><span>{usd(used)} / {usd(limit)}</span></div>
      <div className={`bar${pct > 80 ? ' hot' : ''}`}><i style={{ width: `${pct}%` }} /></div>
    </>
  );
}

export function SettingsView({ onClose }: { onClose?: () => void }) {
  const [s, setS] = useState<Settings | null>(null);
  const [budgetText, setBudgetText] = useState<Record<BudgetKey, string> | null>(null);
  const [usage, setUsage] = useState<Usage | null>(null);
  const [siwc, setSiwc] = useState<{ connected: boolean; expiresAt: number | null } | null>(null);
  const [toast, showToast] = useToast();
  const [diag, setDiag] = useState<{ id: string; label: string; state: string; detail: string }[] | null>(null);
  const [diagBusy, setDiagBusy] = useState(false);

  async function runDiagnose() {
    setDiagBusy(true);
    try {
      setDiag((await api<{ checks: { id: string; label: string; state: string; detail: string }[] }>('/api/admin/diagnose')).checks);
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '점검하지 못했어요');
    } finally {
      setDiagBusy(false);
    }
  }

  useEffect(() => {
    api<Settings>('/api/settings').then((v) => {
      setS(v);
      setBudgetText(Object.fromEntries(BUDGET_FIELDS.map(([k]) => [k, String(v.budget[k])])) as Record<BudgetKey, string>);
    }).catch(() => showToast('설정을 불러오지 못했어요'));
    api<Usage>('/api/usage').then(setUsage).catch(() => undefined);
    loadSiwc();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function loadSiwc() {
    api<{ connected: boolean; expiresAt: number | null }>('/api/admin/siwc-status').then(setSiwc).catch(() => undefined);
  }

  async function save() {
    if (!s || !budgetText) return;
    const budget = {} as Settings['budget'];
    for (const [k, label] of BUDGET_FIELDS) {
      const raw = budgetText[k].trim();
      const n = Number(raw);
      if (raw === '' || !Number.isFinite(n) || n < 0) return showToast(`${label} 한도를 숫자로 입력하세요`);
      budget[k] = n;
    }
    try {
      setS(await api<Settings>('/api/settings', { method: 'PUT', body: JSON.stringify({ models: s.models, gptMode: s.gptMode, budget }) }));
      showToast('설정을 저장했어요');
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '저장하지 못했어요');
    }
  }

  async function enablePush() {
    try {
      const { publicKey } = await api<{ publicKey: string | null }>('/api/push/public-key');
      if (!publicKey) return showToast('서버에 알림 키가 아직 없어요. 잠시 뒤 다시 눌러 주세요');
      if (!('serviceWorker' in navigator) || !('PushManager' in window)) return showToast('이 브라우저에서는 알림을 받을 수 없어요');
      if ((await Notification.requestPermission()) !== 'granted') return showToast('알림 권한을 허용해야 받을 수 있어요');
      const reg = await navigator.serviceWorker.ready;
      const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource });
      await post('/api/push/subscribe', sub.toJSON());
      showToast('알림을 켰어요');
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '알림을 켜지 못했어요');
    }
  }

  async function runBriefing() {
    try {
      await post('/api/admin/run-briefing', {});
      showToast('브리핑을 만들고 있어요. 1분 정도 뒤에 맨 위 소식에 나타나요');
    } catch (e) {
      showToast(e instanceof ApiError ? e.message : '브리핑을 시작하지 못했어요');
    }
  }

  async function disconnectChatgpt() {
    await api('/api/admin/siwc-tokens', { method: 'DELETE' }).catch(() => undefined);
    setSiwc({ connected: false, expiresAt: null });
    showToast('ChatGPT 연결을 끊었어요');
  }

  async function logout() {
    await post('/api/logout', {}).catch(() => undefined);
    location.reload();
  }

  const setModel = (p: 'claude' | 'gpt', t: 'light' | 'standard' | 'deep', v: string) => s && setS({ ...s, models: { ...s.models, [p]: { ...s.models[p], [t]: v } } });
  const loginCmd = `npm run siwc:login -w server -- --server ${typeof location !== 'undefined' ? location.origin : ''}`;

  return (
    <div className="screen settings" role="region" aria-label="설정">
      <header className="topbar">
        {onClose && <button type="button" className="icon-btn" aria-label="뒤로" onClick={onClose}>‹</button>}
        <h1>설정</h1>
        <span />
      </header>
      <nav className="set-menu" aria-label="설정 메뉴">
        {MENU.map(([id, label]) => (
          <button key={id} type="button" aria-label={`${label} 항목으로 이동`} onClick={() => document.getElementById(id)?.scrollIntoView?.({ behavior: 'smooth', block: 'start' })}>{label}</button>
        ))}
      </nav>

      <DisplaySettings />

      {usage && s && (
        <section className="panel" id="set-ai">
          <h2>AI 사용액</h2>
          <UsageBar label="오늘 직접 사용" used={usage.today.interactive} limit={s.budget.interactiveDailyUsd} />
          <UsageBar label="오늘 예약 작업" used={usage.today.scheduled} limit={s.budget.scheduledDailyUsd} />
          <UsageBar label="이번 달" used={usage.month} limit={s.budget.monthlyUsd} />
          <p className="small muted">ChatGPT 최근 5시간 {usage.requests?.gpt5h ?? 0}회, 오늘 {usage.requests?.gptToday ?? 0}회. Claude는 구독에 포함된 API 크레딧에서 나가요.</p>
        </section>
      )}

      {s && (
        <section className="panel">
          <h2>AI 연결</h2>
          <p><span className={`status-dot${s.keys.claude ? ' on' : ''}`} />Claude {s.keys.claude ? '연결됨' : '— 서버에 Claude 키가 없어요'}</p>
          <label className="field">
            GPT 연결 방식
            <select aria-label="GPT 연결 방식" value={s.gptMode} onChange={(e) => setS({ ...s, gptMode: e.target.value as Settings['gptMode'] })}>
              <option value="siwc">ChatGPT Plus 구독</option>
              <option value="apikey">OpenAI 종량제(비상용)</option>
            </select>
          </label>
          {s.gptMode === 'siwc' && (
            <div className="small">
              <p><span className={`status-dot${siwc?.connected ? ' on' : ''}`} />ChatGPT {siwc?.connected ? `연결됨${siwc.expiresAt ? ` (토큰 갱신 예정 ${formatDateTimeKst(Math.floor(siwc.expiresAt / 1000))})` : ''}` : '연결 안 됨'}</p>
              {!siwc?.connected && <ChatgptConnect onConnected={loadSiwc} />}
              {siwc?.connected && <button type="button" className="btn" onClick={disconnectChatgpt}>ChatGPT 연결 끊기</button>}
              <details style={{ marginTop: 10 }}>
                <summary className="muted" style={{ cursor: 'pointer' }}>PC로 연결하기</summary>
                <p className="muted">PC에서 이 앱 코드 폴더를 열고 아래 명령을 실행해도 돼요.</p>
                <pre className="cmd">{loginCmd}</pre>
              </details>
            </div>
          )}
          {s.gptMode === 'apikey' && !s.keys.openai && <p className="notice" style={{ margin: '8px 0 0' }}>서버에 OpenAI 키가 없어 종량제 방식을 쓸 수 없어요</p>}
        </section>
      )}

      {s && budgetText && (
        <section className="panel">
          <h2>사용 한도(달러)</h2>
          {BUDGET_FIELDS.map(([k, label]) => (
            <label key={k} className="field">
              {label}
              <input type="number" min={0} step={0.5} inputMode="decimal" value={budgetText[k]} onChange={(e) => setBudgetText({ ...budgetText, [k]: e.target.value })} />
            </label>
          ))}
          <details>
            <summary className="small muted" style={{ cursor: 'pointer', margin: '6px 0' }}>기본 모델 바꾸기</summary>
            {(['claude', 'gpt'] as const).map((p) => (['standard', 'deep', 'light'] as const).map((t) => (
              <label key={`${p}-${t}`} className="field">
                {p === 'claude' ? 'Claude' : 'GPT'} {TIER_LABEL[t]} 모델
                <input value={s.models[p][t]} onChange={(e) => setModel(p, t, e.target.value)} />
              </label>
            )))}
          </details>
          <button type="button" className="btn btn-primary btn-block" style={{ marginTop: 8 }} onClick={save}>설정 저장</button>
        </section>
      )}

      <section className="panel" id="set-check">
        <h2>연결 점검</h2>
        <p className="small muted" style={{ marginTop: 0 }}>거래소·증권사·AI·데이터 저장이 제대로 연결됐는지 확인해요.</p>
        <button type="button" className="btn btn-block" disabled={diagBusy} onClick={runDiagnose}>{diagBusy ? '점검 중…' : '연결 점검'}</button>
        {diag && (
          <ul className="diag" aria-label="연결 점검 결과">
            {diag.map((c) => (
              <li key={c.id} className={c.state}><i className="dot" aria-hidden="true" /><b>{c.label}</b><span>{c.detail}</span></li>
            ))}
          </ul>
        )}
      </section>

      <div id="set-alerts"><AlertSettings /></div>

      <section className="panel">
        <h2>알림과 브리핑</h2>
        {!isStandalone() && <p className="small muted">아이폰은 Safari 공유 버튼에서 홈 화면에 추가한 뒤에만 알림을 받을 수 있어요.</p>}
        <div className="actions">
          <button type="button" className="btn" onClick={enablePush}>알림 켜기</button>
          <button type="button" className="btn" onClick={runBriefing}>지금 브리핑 만들기</button>
        </div>
        {s && (
          <div style={{ marginTop: 10 }} className="small">
            <p><span className="status-dot on" />코인 시세(OKX·업비트) 키 없이 연결</p>
            <p><span className="status-dot on" />주식 시세 {s.keys.kis ? '한국투자증권(안 되면 네이버 증권)' : '네이버 증권(키 없이 연결)'}</p>
            <p><span className={`status-dot${s.keys.push ? ' on' : ''}`} />알림 키 {s.keys.push ? '있음' : '없음'}</p>
          </div>
        )}
      </section>

      <DataSettings />
      <AboutSettings />

      <section className="panel">
        <button type="button" className="btn btn-block" onClick={logout}>로그아웃</button>
      </section>
      {toast}
    </div>
  );
}
