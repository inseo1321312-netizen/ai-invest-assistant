import { useEffect, useState } from 'react';
import { api } from '../api';
import { changeClass, formatTimeKst } from '../format';
import { marketStatus } from '../insights';
import type { OverviewId, OverviewItem } from '../types';
import { useTweened } from '../motion';

const SESSION: Partial<Record<OverviewId, 'kr' | 'us'>> = { kospi: 'kr', kosdaq: 'kr', spx: 'us', nasdaq: 'us' };

const signed = (n: number, digits = 2) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

function valueText(it: OverviewItem): string {
  if (it.value === null) return '—';
  if (it.id === 'usdkrw') return `${it.value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}원`;
  if (it.id === 'fng') return String(Math.round(it.value));
  if (it.id === 'kimchi') return signed(it.value);
  return it.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

/** 공포·탐욕 단계(서버 이름과 같은 경계): 공포는 내림색, 탐욕은 오름색 */
export function fngLevel(v: number): 'fear-x' | 'fear' | 'neutral' | 'greed' | 'greed-x' {
  if (v < 25) return 'fear-x';
  if (v < 45) return 'fear';
  if (v <= 55) return 'neutral';
  if (v <= 75) return 'greed';
  return 'greed-x';
}

function Tile({ it: raw, now }: { it: OverviewItem; now: Date }) {
  const tweened = useTweened(raw.value ?? 0);
  const it = raw.value === null ? raw : { ...raw, value: tweened };
  const session = SESSION[it.id];
  // 서버(네이버)가 알면 그대로(공휴일 포함), 모르면 시계로 짐작
  const open = session ? (typeof it.open === 'boolean' ? it.open : marketStatus(session, now).open) : null;
  const sub = it.changePct !== null ? signed(it.changePct) : it.note;
  const tone = it.id === 'kimchi' ? changeClass(it.value) : changeClass(it.changePct);
  const fng = it.id === 'fng' && raw.value !== null ? fngLevel(raw.value) : null;
  return (
    <div className={`ov-tile${it.id === 'fng' ? ' fng' : ''}${fng ? ` fng-${fng}` : ''}`} role="group" aria-label={it.label}>
      <span className="ov-label">
        {open !== null && <i className={`ov-led${open ? ' open' : ''}`} title={open ? '장중' : '휴장'} aria-hidden="true" />}
        {it.label}
      </span>
      <b className={`ov-value num${it.id === 'kimchi' ? ` ${tone}` : ''}`}>{valueText(it)}</b>
      {sub && it.id !== 'kimchi' && <span className={`ov-sub num ${it.changePct !== null ? tone : ''}`}>{sub}</span>}
      {fng && <i className="fng-bar" aria-hidden="true"><b style={{ left: `${Math.max(0, Math.min(100, Math.round(raw.value!)))}%` }} /></i>}
    </div>
  );
}

/** 홈 맨 위: 지수, 환율, 공포·탐욕, 김치 프리미엄. 1분마다 새로 고친다. */
export function MarketOverview() {
  const [items, setItems] = useState<OverviewItem[] | null>(null);
  const [now, setNow] = useState(() => new Date());

  useEffect(() => {
    let alive = true;
    const load = () => api<{ items: OverviewItem[] }>('/api/market-overview')
      .then((r) => { if (alive) { setItems(r.items); setNow(new Date()); } })
      .catch(() => { if (alive) setItems((v) => v ?? []); });
    void load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') void load(); }, 60_000);
    return () => { alive = false; clearInterval(t); };
  }, []);

  return (
    <section className="hero overview rise" aria-label="오늘 시장 한눈에">
      <p className="hero-label">오늘 시장 한눈에{items && items.length > 0 && <span className="ov-asof">{formatTimeKst(Math.floor(now.getTime() / 1000)).slice(6)} 기준</span>}</p>
      {!items && <div className="ov-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton ov-sk" />)}</div>}
      {items && items.length === 0 && <p className="ov-empty">시장 정보를 불러오지 못했어요. 잠시 뒤 다시 열어 보세요.</p>}
      {items && items.length > 0 && <div className="ov-grid">{[...items.filter((i) => i.id !== 'fng'), ...items.filter((i) => i.id === 'fng')].map((it) => <Tile key={it.id} it={it} now={now} />)}</div>}
    </section>
  );
}
