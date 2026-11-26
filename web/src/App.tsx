import { useEffect, useState, type CSSProperties } from 'react';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { ChatView } from './components/ChatView';
import { FeedBanner } from './components/FeedBanner';
import { InstrumentView } from './components/InstrumentView';
import { LoginView } from './components/LoginView';
import { MarketOverview } from './components/MarketOverview';
import { MarketTabs, readSavedTab, saveTab } from './components/MarketTabs';
import { SearchSheet } from './components/SearchSheet';
import { Trending } from './components/Trending';
import { WatchList } from './components/WatchList';
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

function greeting(): string {
  const h = Number(new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hourCycle: 'h23' }).format(new Date()));
  if (h < 5) return '늦은 밤이에요';
  if (h < 11) return '좋은 아침이에요';
  if (h < 17) return '오늘의 시장';
  return '오늘 하루 정리';
}

function Home({ onOpen }: { onOpen: (key: string) => void }) {
  const [tab, setTab] = useState<MarketId>(readSavedTab);
  const [refresh, setRefresh] = useState(0);
  const [spin, setSpin] = useState(false);
  const [searching, setSearching] = useState(false);

  function changeTab(m: MarketId) {
    setTab(m);
    saveTab(m);
  }

  return (
    <div className="fade-in">
      <header className="topbar">
        <div>
          <p className="topbar-sub">{todayLabel()}</p>
          <h1>{greeting()}</h1>
        </div>
        <button type="button" className={`icon-btn${spin ? ' spin' : ''}`} aria-label="새로고침" onAnimationEnd={() => setSpin(false)}
          onClick={() => { setSpin(true); setRefresh((n) => n + 1); }}><Icon.refresh /></button>
      </header>
      <button type="button" className="search-pill" aria-label="종목 검색" onClick={() => setSearching(true)}>
        <Icon.search /><span>종목 검색</span><small>삼성, 애플, 비트…</small>
      </button>
      <MarketOverview key={`ov-${refresh}`} />
      <FeedBanner refreshKey={refresh} onOpenKey={onOpen} />
      <MarketTabs value={tab} onChange={changeTab} />
      <Trending key={`tr-${tab}-${refresh}`} market={tab} onOpen={onOpen} />
      <WatchList key={`wl-${tab}-${refresh}`} market={tab} onOpen={onOpen} />
      {searching && <SearchSheet onOpen={onOpen} onClose={() => setSearching(false)} />}
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [instrument, setInstrument] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string | null>(null);

  useEffect(() => {
    document.scrollingElement?.scrollTo?.({ top: 0 });
  }, [tab, instrument]);

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
      <nav className="bottom-nav" aria-label="메뉴" style={{ '--i': ['home', 'chat', 'settings'].indexOf(tab) } as CSSProperties}>
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
