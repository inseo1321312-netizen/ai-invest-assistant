import { useEffect, useState } from 'react';
import { api } from '../api';
import { changeClass } from '../format';
import { marketStatus } from '../insights';
import type { OverviewId, OverviewItem } from '../types';

const SESSION: Partial<Record<OverviewId, 'kr' | 'us'>> = { kospi: 'kr', kosdaq: 'kr', spx: 'us', nasdaq: 'us' };

const signed = (n: number, digits = 2) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}%`;

function valueText(it: OverviewItem): string {
  if (it.value === null) return '—';
  if (it.id === 'usdkrw') return `${it.value.toLocaleString('ko-KR', { maximumFractionDigits: 1 })}원`;
  if (it.id === 'fng') return String(Math.round(it.value));
  if (it.id === 'kimchi') return signed(it.value);
  return it.value.toLocaleString('en-US', { maximumFractionDigits: 2 });
}

function Tile({ it, now }: { it: OverviewItem; now: Date }) {
  const session = SESSION[it.id];
  const open = session ? marketStatus(session, now).open : null;
  const sub = it.changePct !== null ? signed(it.changePct) : it.note;
  const tone = it.id === 'kimchi' ? changeClass(it.value) : changeClass(it.changePct);
  return (
    <div className="ov-tile" role="group" aria-label={it.label}>
      <span className="ov-label">
        {open !== null && <i className={`ov-led${open ? ' open' : ''}`} title={open ? '장중' : '휴장'} aria-hidden="true" />}
        {it.label}
      </span>
      <b className={`ov-value num${it.id === 'kimchi' ? ` ${tone}` : ''}`}>{valueText(it)}</b>
      {sub && it.id !== 'kimchi' && <span className={`ov-sub num ${it.changePct !== null ? tone : ''}`}>{sub}</span>}
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
      <p className="hero-label">오늘 시장 한눈에</p>
      {!items && <div className="ov-grid" aria-hidden="true">{Array.from({ length: 6 }, (_, i) => <span key={i} className="skeleton ov-sk" />)}</div>}
      {items && items.length === 0 && <p className="ov-empty">시장 정보를 불러오지 못했어요. 잠시 뒤 다시 열어 보세요.</p>}
      {items && items.length > 0 && <div className="ov-grid">{items.map((it) => <Tile key={it.id} it={it} now={now} />)}</div>}
    </section>
  );
}
