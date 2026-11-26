import { useEffect, useState } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { ChatView } from './components/ChatView';
import { FeedBanner } from './components/FeedBanner';
import { HoldingsList } from './components/HoldingsList';
import { InstrumentView } from './components/InstrumentView';
import { LoginView } from './components/LoginView';
import { MarketTabs, readSavedTab, saveTab } from './components/MarketTabs';
import { SettingsView } from './components/SettingsView';
import type { MarketId } from './types';
import { Icon } from './ui';

export function Disclaimer() {
  return <p className="disclaimer">투자 판단과 책임은 본인에게 있음</p>;
}

type Tab = 'home' | 'chat' | 'settings';

function todayLabel(): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
}

function Home({ onOpen }: { onOpen: (key: string) => void }) {
  const [tab, setTab] = useState<MarketId>(readSavedTab);
  const [refresh, setRefresh] = useState(0);

  function changeTab(m: MarketId) {
    setTab(m);
    saveTab(m);
  }

  return (
    <div className="fade-in">
      <header className="topbar">
        <div>
          <p className="topbar-sub">{todayLabel()}</p>
          <h1>투자 비서</h1>
        </div>
        <button type="button" className="icon-btn" aria-label="새로고침" onClick={() => setRefresh((n) => n + 1)}><Icon.refresh /></button>
      </header>
      <FeedBanner refreshKey={refresh} onOpenKey={onOpen} />
      <MarketTabs value={tab} onChange={changeTab} />
      <HoldingsList key={`${tab}-${refresh}`} market={tab} onOpen={onOpen} />
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [instrument, setInstrument] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string | null>(null);

  function go(t: Tab) {
    setInstrument(null);
    if (t === 'chat') setChatKey(null);
    setTab(t);
  }

  let body;
  if (tab === 'home' && instrument) {
    body = <InstrumentView key={instrument} keyId={instrument} onClose={() => setInstrument(null)} onChat={(k) => { setChatKey(k); setTab('chat'); }} />;
  } else if (tab === 'home') {
    body = <Home onOpen={setInstrument} />;
  } else if (tab === 'chat') {
    body = <ChatView key={chatKey ?? 'all'} keyId={chatKey} onClose={chatKey ? () => { setTab('home'); setInstrument(chatKey); } : undefined} />;
  } else {
    body = <SettingsView />;
  }

  return (
    <div className="app">
      {body}
      <Disclaimer />
      <nav className="bottom-nav" aria-label="메뉴">
        <button type="button" aria-current={tab === 'home' ? 'page' : undefined} onClick={() => go('home')}><Icon.home />홈</button>
        <button type="button" aria-current={tab === 'chat' ? 'page' : undefined} onClick={() => go('chat')}><Icon.chat />AI 상담</button>
        <button type="button" aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><Icon.settings />설정</button>
      </nav>
    </div>
  );
}

/** 무료 서버는 한동안 안 쓰면 잠든다. 깨어나는 동안 보여주는 화면 */
function WakeScreen() {
  return (
    <main className="login fade-in" aria-busy="true">
      <img className="logo" src="/icons/icon-192.png" alt="" />
      <h1 style={{ fontSize: 22 }}>서버를 깨우는 중이에요</h1>
      <p className="muted" style={{ margin: '4px 0 16px' }}>한동안 쓰지 않으면 서버가 잠들어요. 처음 열 때 30초~1분 정도 걸려요.</p>
      <div className="wake-bar"><i /></div>
    </main>
  );
}

export default function App() {
  const [auth, setAuth] = useState<'loading' | 'in' | 'out'>('loading');
  const [slow, setSlow] = useState(false);

  useEffect(() => {
    if (auth !== 'loading') return;
    const t = setTimeout(() => setSlow(true), 800);
    return () => clearTimeout(t);
  }, [auth]);

  useEffect(() => {
    setUnauthorizedHandler(() => setAuth('out'));
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    // 서버가 깨어나는 동안에는 502/503/연결 실패가 올 수 있다: 잠시 뒤 다시 묻는다(최대 약 1분)
    const check = (attempt: number) => {
      api<{ loggedIn: boolean }>('/api/me')
        .then((r) => { if (alive) setAuth(r.loggedIn ? 'in' : 'out'); })
        .catch((e) => {
          if (!alive) return;
          const waking = e instanceof ApiError && [0, 502, 503, 504].includes(e.status);
          if (waking && attempt < 20) timer = setTimeout(() => check(attempt + 1), 3000);
          else setAuth('out');
        });
    };
    check(0);
    return () => { alive = false; clearTimeout(timer); setUnauthorizedHandler(null); };
  }, []);

  if (auth === 'loading') return slow ? <WakeScreen /> : null;
  if (auth === 'out') return <LoginView onLoggedIn={() => setAuth('in')} />;
  return <Shell />;
}
