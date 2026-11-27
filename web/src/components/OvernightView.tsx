import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { axisPrice, changeClass, formatPrice, parseKey } from '../format';
import type { Currency, MarketId } from '../types';
import { Dots, Icon, Sheet } from '../ui';
import { Avatar } from './rows';

interface Settings { sleep: string; wake: string; notify: boolean }
interface ItemFacts { key: string; name: string | null; market: MarketId; price: number | null; fromPrice: number | null; currency: Currency | null; pct: number | null; kind: 'night' | 'session' | 'today' | 'closed'; extended: { price: number; changePct: number } | null }
interface Facts {
  market: {
    spx: { value: number; changePct: number | null; traded?: boolean | null } | null;
    nasdaq: { value: number; changePct: number | null; traded?: boolean | null } | null;
    btc: { from: number; to: number; pct: number; high: number; low: number } | null;
    usdkrw: number | null;
    kimchi: number | null;
    metals?: Record<'gold' | 'silver' | 'copper', { value: number; changePct: number | null } | null>;
  };
  items: ItemFacts[];
  news: { n: number; title: string; url: string; source: string | null; publishedAt: number; key: string | null }[];
}
export interface Recap {
  id: number; day: string; from: number; to: number; origin: 'scheduled' | 'manual'; createdAt: number;
  headline: string; points: string[]; items: { key: string; note: string }[]; news: { n: number; why: string }[]; today: string[]; facts: Facts;
}
interface View { recap: Recap | null; settings: Settings; making: boolean; error: string | null; sleepTimes: string[]; wakeTimes: string[] }
interface Past { id: number; day: string; from: number; to: number; origin: string; headline: string }

/** '07:00' → '7:00' */
const hm = (t: string) => t.replace(/^0(\d)/, '$1');
const kstParts = (ms: number) => {
  const d = new Date(ms + 9 * 3600_000);
  return { day: d.toISOString().slice(0, 10), m: d.getUTCMonth() + 1, d: d.getUTCDate(), time: `${d.getUTCHours()}:${String(d.getUTCMinutes()).padStart(2, '0')}` };
};

/** "어젯밤 11:00 ~ 오늘 7:00", 지난 정리는 "11/26 23:00 ~ 11/27 7:00" */
function rangeText(from: number, to: number): string {
  const today = kstParts(Date.now()).day;
  const f = kstParts(from);
  const t = kstParts(to);
  if (t.day !== today) return `${f.m}/${f.d} ${f.time} ~ ${t.m}/${t.d} ${t.time}`;
  // 밤 시각은 12시간제로(어젯밤 11:00), 자정 넘으면 새벽
  const night = (time: string) => { const [h, mm] = time.split(':').map(Number); return `${h! > 12 ? h! - 12 : h}:${String(mm).padStart(2, '0')}`; };
  return `${f.day === t.day ? '새벽' : '어젯밤'} ${night(f.time)} ~ 오늘 ${t.time}`;
}

const signed = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? '—' : `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`);

function ago(sec: number): string {
  const min = Math.max(0, Math.round((Date.now() / 1000 - sec) / 60));
  if (min < 60) return min < 1 ? '방금' : `${min}분 전`;
  const h = Math.round(min / 60);
  return h < 24 ? `${h}시간 전` : `${Math.round(h / 24)}일 전`;
}

/** 시작 가격은 짧게(달러는 그대로), 끝 가격은 단위까지 */
function fromTo(from: number, to: number, currency: Currency): string {
  return `${currency === 'USD' ? formatPrice(from, currency) : axisPrice(from, currency)} → ${formatPrice(to, currency)}`;
}

/** 밤사이: 잠든 시각부터 정리 시각까지 시장·내 종목·뉴스를 AI가 정리해 둔 것 */
export function OvernightView({ onOpen, embedded = false, onSeen }: { onOpen: (key: string) => void; embedded?: boolean; onSeen?: (id: number) => void }) {
  const [view, setView] = useState<View | null>(null);
  const [shown, setShown] = useState<Recap | null>(null);
  const [past, setPast] = useState<Past[]>([]);
  const [editing, setEditing] = useState(false);
  const [loadError, setLoadError] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const [tries, setTries] = useState(0);
  const load = () => api<View>('/api/overnight')
    .then((v) => { setView(v); setLoadError(false); if (v.recap) onSeen?.(v.recap.id); if (!v.making) void api<{ items: Past[] }>('/api/overnight/history').then((r) => setPast(r.items)).catch(() => undefined); })
    // 한 번 못 읽어도 만드는 중이면 계속 다시 묻는다(화면이 '정리하는 중'에 멈추지 않게)
    .catch(() => { setLoadError(true); setTries((n) => n + 1); });

  useEffect(() => { void load(); }, []);

  // 앱으로 돌아오면 다시 읽는다(그사이 정리 시각이 지났으면 오늘 정리가 만들어진다)
  useEffect(() => {
    const back = () => { if (document.visibilityState === 'visible') void load(); };
    document.addEventListener('visibilitychange', back);
    return () => document.removeEventListener('visibilitychange', back);
  }, []);

  // 만드는 중이면 5초마다 다시 읽는다
  useEffect(() => {
    if (!view?.making) return;
    const t = setTimeout(() => void load(), 5000);
    return () => clearTimeout(t);
  }, [view, tries]);

  async function rerun() {
    setShown(null);
    await api('/api/overnight/run', { method: 'POST' }).catch(() => undefined);
    setView((v) => (v ? { ...v, making: true, error: null } : v));
  }

  async function openPast(id: number) {
    const r = await api<{ recap: Recap }>(`/api/overnight/${id}`).catch(() => null);
    if (!r) return;
    setShown(r.recap);
    // 창 안에서는 창이 스크롤된다(뒤 화면은 묶여 있다)
    const sheet = rootRef.current?.closest('.sheet') as HTMLElement | null;
    if (sheet) sheet.scrollTop = 0; else window.scrollTo?.({ top: 0 });
  }

  const recap = shown ?? view?.recap ?? null;
  const settings = view?.settings;

  return (
    <div ref={rootRef} className="screen overnight" role="region" aria-label="밤사이">
      <header className={embedded ? 'on-head' : 'topbar'}>
        <div>
          <p className="topbar-sub">{recap ? rangeText(recap.from, recap.to) : '자는 동안 있었던 일'}</p>
          {!embedded && <h1>밤사이</h1>}
        </div>
        {settings && (
          <button type="button" className="on-chip" aria-label="정리 설정" onClick={() => setEditing(true)}>
            <Icon.moon />{hm(settings.wake)} 정리
          </button>
        )}
      </header>

      {!view && !loadError && <div className="on-sk" aria-hidden="true"><span className="skeleton" /><span className="skeleton" /><span className="skeleton" /></div>}
      {loadError && !view?.making && <p className="error on-pad" role="alert">불러오지 못했어요. 잠시 뒤 다시 열어 주세요.</p>}

      {view?.making && <p className="status on-pad" aria-live="polite"><Dots /> 정리하는 중… 30초쯤 걸려요</p>}
      {view && !view.making && view.error && !shown && (
        <div className="on-pad on-err">
          <p className="error" role="alert">{view.error}</p>
          <button type="button" className="btn btn-primary" onClick={() => void rerun()}><Icon.refresh /> 다시 정리</button>
        </div>
      )}
      {view && !view.making && !view.error && !recap && settings && (
        <div className="on-empty">
          <div className="on-moon" aria-hidden="true"><Icon.moon /></div>
          <p className="on-empty-title">{hm(settings.wake)}에 정리돼요</p>
          <button type="button" className="btn btn-primary" onClick={() => void rerun()}>지금 정리</button>
        </div>
      )}

      {recap && <RecapBody r={recap} onOpen={onOpen} />}

      {recap && view && !view.making && !(view.error && !shown) && (
        <div className="on-pad on-again">
          <button type="button" className="btn btn-block" onClick={() => void rerun()}><Icon.refresh /> 다시 정리</button>
          <p className="hint">{shown ? '지난 정리를 보고 있어요' : '마지막으로 잠든 시각부터 지금까지 새로 정리해요'}</p>
        </div>
      )}

      {past.length > 0 && (
        <section className="on-past">
          <h2 className="section-title">지난 정리</h2>
          <ul className="list" aria-label="지난 정리">
            {past.map((p) => {
              const t = kstParts(p.to);
              return (
                <li key={p.id}>
                  <button type="button" className="on-past-row" aria-current={recap?.id === p.id ? 'true' : undefined} onClick={() => void openPast(p.id)}>
                    <span className="on-past-day">{t.m}/{t.d}</span>
                    <span className="on-past-head">{p.headline}</span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      )}

      {editing && view && settings && (
        <SettingsSheet settings={settings} sleepTimes={view.sleepTimes} wakeTimes={view.wakeTimes} onClose={() => setEditing(false)}
          onSaved={(s) => { setView((v) => (v ? { ...v, settings: s } : v)); setEditing(false); }} />
      )}
    </div>
  );
}

function RecapBody({ r, onOpen }: { r: Recap; onOpen: (key: string) => void }) {
  const m = r.facts.market;
  const note = (key: string) => r.items.find((i) => i.key === key)?.note ?? null;
  const picked = r.news.map((x) => ({ ...x, item: r.facts.news.find((n) => n.n === x.n) })).filter((x) => x.item);
  return (
    <>
      <section className="on-summary rise" role="region" aria-label="AI 정리">
        <p className="on-label"><Icon.spark /> AI 정리</p>
        <h2 className="on-headline">{r.headline}</h2>
        <ul className="on-points">{r.points.map((p, i) => <li key={i}>{p}</li>)}</ul>
      </section>

      <section className="on-block" role="region" aria-label="시장">
        <h2 className="section-title">시장</h2>
        <div className="on-market">
          <div className="on-cell"><span>S&amp;P500</span><b className="num">{m.spx ? m.spx.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</b><em className={`num ${changeClass(m.spx?.changePct)}`}>{signed(m.spx?.changePct, 2)}</em></div>
          <div className="on-cell"><span>나스닥</span><b className="num">{m.nasdaq ? m.nasdaq.value.toLocaleString('en-US', { maximumFractionDigits: 2 }) : '—'}</b><em className={`num ${changeClass(m.nasdaq?.changePct)}`}>{signed(m.nasdaq?.changePct, 2)}</em></div>
          {m.spx?.traded === false && <p className="on-closed">미국장 휴장 · 마지막 거래 기준이에요</p>}
          <div className="on-cell wide">
            <span>비트코인 밤사이</span>
            {m.btc ? <>
              <b className="num">{fromTo(m.btc.from, m.btc.to, 'USDT')} <em className={changeClass(m.btc.pct)}>{signed(m.btc.pct)}</em></b>
              <small className="num">최고 {axisPrice(m.btc.high, 'USDT')} · 최저 {axisPrice(m.btc.low, 'USDT')}</small>
            </> : <b>—</b>}
          </div>
          <div className="on-cell"><span>원/달러</span><b className="num">{m.usdkrw === null ? '—' : `${m.usdkrw.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}원`}</b></div>
          <div className="on-cell"><span>김치 프리미엄</span><b className={`num ${changeClass(m.kimchi)}`}>{signed(m.kimchi, 2)}</b></div>
        </div>
        {m.metals && (
          <div className="on-metals">
            {(['gold', 'silver', 'copper'] as const).map((k) => {
              const v = m.metals![k];
              const label = { gold: '금', silver: '은', copper: '구리' }[k];
              return (
                <div key={k} className="on-cell" role="group" aria-label={label}>
                  <span>{label}</span>
                  <b className="num">{v ? `$${v.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}` : '—'}</b>
                  <em className={`num ${changeClass(v?.changePct)}`}>{signed(v?.changePct, 2)}</em>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {r.facts.items.length > 0 && (
        <section className="on-block" role="region" aria-label="내 종목 밤사이">
          <h2 className="section-title">내 종목 밤사이</h2>
          <ul className="list on-items">
            {r.facts.items.map((it) => (
              <li key={it.key}>
                <button type="button" className="on-item" aria-label={`${it.name ?? it.key} 열기`} onClick={() => onOpen(it.key)}>
                  <Avatar inst={parseKey(it.key, it.name)} logoKey={it.key} />
                  <span className="on-item-main">
                    <span className="on-item-name">{it.name ?? it.key.split(':').at(-1)}</span>
                    {note(it.key) && <span className="on-item-note">{note(it.key)}</span>}
                  </span>
                  <span className="on-item-move">
                    {it.kind === 'closed' || it.price === null || !it.currency
                      ? <small>{it.kind === 'closed' ? (it.market === 'us' ? '미국장 휴장' : '밤엔 거래 없음') : '—'}</small>
                      : <>
                        <span className="num">{it.fromPrice !== null ? fromTo(it.fromPrice, it.price, it.currency) : formatPrice(it.price, it.currency)}</span>
                        <b className={`num ${changeClass(it.pct)}`}>{it.kind === 'today' && <small className="on-live">장중 </small>}{signed(it.pct)}</b>
                        {it.extended && <small className="num">시간외 {formatPrice(it.extended.price, it.currency)} {signed(it.extended.changePct)}</small>}
                      </>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {picked.length > 0 && (
        <section className="on-block" role="region" aria-label="밤사이 주요 뉴스">
          <h2 className="section-title">밤사이 주요 뉴스</h2>
          <ul className="list on-news">
            {picked.map((x) => (
              <li key={x.n}>
                <a href={x.item!.url} target="_blank" rel="noreferrer noopener">
                  <span className="on-news-title">{x.item!.title}</span>
                  <small>{x.item!.source ? `${x.item!.source} · ` : ''}{ago(x.item!.publishedAt)}</small>
                </a>
                <p className="on-why">{x.why}</p>
              </li>
            ))}
          </ul>
        </section>
      )}

      {r.today.length > 0 && (
        <section className="on-block" role="region" aria-label="오늘 볼 것">
          <h2 className="section-title">오늘 볼 것</h2>
          <ul className="on-today">{r.today.map((t, i) => <li key={i}>{t}</li>)}</ul>
        </section>
      )}
    </>
  );
}

function SettingsSheet({ settings, sleepTimes, wakeTimes, onClose, onSaved }: {
  settings: Settings; sleepTimes: string[]; wakeTimes: string[]; onClose: () => void; onSaved: (s: Settings) => void;
}) {
  const [s, setS] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ settings: Settings }>('/api/overnight/settings', { method: 'PUT', body: JSON.stringify(s) });
      onSaved(r.settings);
    } catch (e) {
      setError(e instanceof Error ? e.message : '저장하지 못했어요');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Sheet title="밤사이 설정" onClose={onClose}>
      <label className="field">잠드는 시간
        <select value={s.sleep} onChange={(e) => setS({ ...s, sleep: e.target.value })}>
          {sleepTimes.map((t) => <option key={t} value={t}>{hm(t)}</option>)}
        </select>
      </label>
      <label className="field">정리 시각
        <select value={s.wake} onChange={(e) => setS({ ...s, wake: e.target.value })}>
          {wakeTimes.map((t) => <option key={t} value={t}>{hm(t)}</option>)}
        </select>
      </label>
      <label className="on-switch">
        <input type="checkbox" checked={s.notify} onChange={(e) => setS({ ...s, notify: e.target.checked })} aria-label="알림 받기" />
        <span>정리되면 알림 받기</span>
      </label>
      <p className="hint">{hm(s.sleep)}부터 {hm(s.wake)}까지를 {hm(s.wake)}에 정리해요</p>
      {error && <p className="error" role="alert">{error}</p>}
      <button type="button" className="btn btn-primary btn-block" disabled={busy} onClick={() => void save()}>저장</button>
    </Sheet>
  );
}
