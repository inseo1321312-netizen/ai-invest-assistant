import { useEffect, useLayoutEffect, useState, type CSSProperties } from 'react';
import { motionOk, navigate } from './motion';
import { PULL_TRIGGER, useNetwork, usePullToRefresh } from './gestures';
import { api, ApiError, setUnauthorizedHandler } from './api';
import { ChatView } from './components/ChatView';
import { CompareView } from './components/CompareView';
import { NewsTicker } from './components/NewsTicker';
import { Holdings } from './components/Holdings';
import { InstrumentView } from './components/InstrumentView';
import { LoginView } from './components/LoginView';
import { MarketOverview } from './components/MarketOverview';
import { MarketTabs, readSavedTab, saveTab } from './components/MarketTabs';
import { SearchSheet } from './components/SearchSheet';
import { Trending } from './components/Trending';
import { WatchList } from './components/WatchList';
import { SettingsView } from './components/SettingsView';
import type { MarketId, OverviewItem } from './types';
import { setUsdKrw } from './format';
import { Disclaimer, Icon } from './ui';
import { greeting } from './greeting';
import { watchViewport } from './viewport';

export { Disclaimer };

type Tab = 'home' | 'compare' | 'chat' | 'settings';

function todayLabel(): string {
  return new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'long', day: 'numeric', weekday: 'long' }).format(new Date());
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

  function reload() {
    setSpin(true);
    setRefresh((n) => n + 1);
  }

  const pull = usePullToRefresh(reload);

  // 인터넷이 다시 연결되면 홈을 새로 고친다
  useEffect(() => {
    const on = () => reload();
    window.addEventListener('online', on);
    return () => window.removeEventListener('online', on);
  }, []);

  return (
    <div className="fade-in">
      <div className={`ptr${pull >= PULL_TRIGGER ? ' armed' : ''}`} style={{ '--pull': pull } as CSSProperties} aria-hidden="true"><Icon.refresh /></div>
      <header className="topbar">
        <div>
          <p className="topbar-sub">{todayLabel()}</p>
          <h1 className="greet">{greeting(tab)}</h1>
        </div>
        <button type="button" className={`icon-btn${spin ? ' spin' : ''}`} aria-label="새로고침" onAnimationEnd={() => setSpin(false)}
          onClick={reload}><Icon.refresh /></button>
      </header>
      <button type="button" className="search-pill" aria-label="종목 검색" onClick={() => setSearching(true)}>
        <Icon.search /><span>종목 검색</span><small>삼성, 애플, 비트…</small>
      </button>
      <MarketOverview key={`ov-${refresh}`} />
      <NewsTicker refreshKey={refresh} />
      <MarketTabs value={tab} onChange={changeTab} />
      <Trending key={`tr-${tab}-${refresh}`} market={tab} onOpen={onOpen} />
      <Holdings key={`hd-${refresh}`} market={tab} onOpen={onOpen} />
      <WatchList key={`wl-${tab}-${refresh}`} market={tab} onOpen={onOpen} />
      {searching && <SearchSheet onOpen={onOpen} onClose={() => setSearching(false)} />}
    </div>
  );
}

function NetworkBar() {
  const net = useNetwork();
  if (net === 'online') return null;
  return (
    <div className={`net-bar ${net}`} role="status">
      {net === 'offline' ? '인터넷 연결이 끊겼어요 · 다시 연결되면 자동으로 새로 고쳐요' : '다시 연결됐어요'}
    </div>
  );
}

function Shell() {
  const [tab, setTab] = useState<Tab>('home');
  const [, setFxTick] = useState(0);

  // 원화 단위로 보여 줄 때 쓸 환율(10분마다)
  useEffect(() => {
    let alive = true;
    const load = () => api<{ items: OverviewItem[] }>('/api/market-overview').then((r) => {
      const rate = r.items.find((i) => i.id === 'usdkrw')?.value ?? null;
      if (alive && rate) { setUsdKrw(rate); setFxTick((n) => n + 1); }
    }).catch(() => undefined);
    void load();
    const t = setInterval(load, 10 * 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  const [instrument, setInstrument] = useState<string | null>(null);
  const [chatKey, setChatKey] = useState<string | null>(null);
  const [compareSeed, setCompareSeed] = useState<string | null>(null);
  const [chatDraft, setChatDraft] = useState<{ id: number; text: string } | null>(null);

  // 키보드가 가린 만큼을 CSS에 알린다(입력창·시트가 키보드 위에 붙게)
  useEffect(() => watchViewport(), []);

  // 화면이 바뀌면 맨 위부터(전환 효과가 새 화면을 찍기 전에 올린다)
  useLayoutEffect(() => {
    document.scrollingElement?.scrollTo?.({ top: 0 });
  }, [tab, instrument]);

  const open = (key: string) => navigate('forward', () => setInstrument(key));

  function go(t: Tab) {
    // 지금 보고 있는 탭을 한 번 더 누르면 맨 위로
    if (t === tab && !instrument) { window.scrollTo({ top: 0, behavior: motionOk() ? 'smooth' : 'auto' }); return; }
    navigate(instrument && t === 'home' ? 'back' : 'tab', () => {
      setInstrument(null);
      if (t === 'chat') { setChatKey(null); setChatDraft(null); }
      if (t === 'compare') setCompareSeed(null);
      setTab(t);
    });
  }

  let body;
  if (tab === 'home' && instrument) {
    body = <InstrumentView key={instrument} keyId={instrument} onClose={() => navigate('back', () => setInstrument(null))} onChat={(k) => navigate('forward', () => { setChatDraft(null); setChatKey(k); setTab('chat'); })}
      onCompare={(k) => navigate('tab', () => { setInstrument(null); setCompareSeed(k); setTab('compare'); })} />;
  } else if (tab === 'home') {
    body = <Home onOpen={open} />;
  } else if (tab === 'compare') {
    body = <CompareView key={compareSeed ?? 'none'} seed={compareSeed} onOpen={(k) => navigate('forward', () => { setTab('home'); setInstrument(k); })}
      onAsk={(text) => navigate('tab', () => { setChatKey(null); setChatDraft({ id: Date.now(), text }); setTab('chat'); })} />;
  } else if (tab === 'chat') {
    body = <ChatView key={chatKey ?? (chatDraft ? `draft-${chatDraft.id}` : 'all')} keyId={chatKey} draft={chatDraft?.text} onClose={chatKey ? () => navigate('back', () => { setTab('home'); setInstrument(chatKey); }) : undefined} />;
  } else {
    body = <SettingsView />;
  }

  return (
    <div className="app">
      <NetworkBar />
      {body}
      {tab !== 'chat' && <Disclaimer />}
      <nav className="bottom-nav" aria-label="메뉴" style={{ '--i': ['home', 'compare', 'chat', 'settings'].indexOf(tab) } as CSSProperties}>
        <button type="button" aria-current={tab === 'home' ? 'page' : undefined} onClick={() => go('home')}><Icon.home />홈</button>
        <button type="button" aria-current={tab === 'compare' ? 'page' : undefined} onClick={() => go('compare')}><Icon.compare />비교</button>
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
