import { useCallback, useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { formatKrwApprox } from '../format';
import type { MarketId, Overview, QuoteView } from '../types';
import { Icon, SkeletonList, Sparkline } from '../ui';
import { Avatar, BadgeChip, DisplayName, PriceCell } from './rows';

const REFRESH_MS = 30_000;

function Row({ w, recent, spark, onOpen }: { w: QuoteView; recent: boolean; spark?: number[]; onOpen: (key: string) => void }) {
  return (
    <button type="button" className="row" onClick={() => onOpen(w.key)}>
      <Avatar inst={w.instrument} />
      <span className="row-name"><DisplayName inst={w.instrument} /></span>
      <PriceCell price={w.quote?.price ?? null} currency={w.quote?.currency ?? 'USDT'} change={w.quote?.changePct24h ?? null} />
      <span className="row-sub num">
        {recent ? <span className="recent-tag"><Icon.history />최근 본 종목</span> : <span className="fav-tag" aria-label="즐겨찾기">★</span>}
        {w.krwValue !== null && w.quote?.currency !== 'KRW' ? ` ${formatKrwApprox(w.krwValue)}` : ''}
      </span>
      <span style={{ justifySelf: 'end' }}>{spark && <Sparkline values={spark} />}</span>
      {w.badge && <span className="row-meta"><BadgeChip badge={w.badge} /></span>}
    </button>
  );
}

/** 홈 "자주 보는 종목": ★ 즐겨찾기 먼저, 그다음 최근 본 종목 */
export function WatchList({ market, onOpen }: { market: MarketId; onOpen: (key: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spark, setSpark] = useState<Record<string, number[]>>({});
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api<Overview>(`/api/market/${market}/overview`)
      .then((o) => { setData(o); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '목록을 불러오지 못했어요'));
  }, [market]);

  useEffect(() => {
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const keysSig = data ? [...data.favorites, ...data.recent].map((w) => w.key).join(',') : '';
  useEffect(() => {
    if (!keysSig) return;
    let alive = true;
    api<{ sparklines: Record<string, number[]> }>(`/api/market/sparklines?keys=${encodeURIComponent(keysSig)}`)
      .then((r) => { if (alive) setSpark(r.sparklines); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [keysSig]);

  async function unfavorite(key: string) {
    await api(`/api/watchlist?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
    load();
  }

  const rows = data ? [...data.favorites.map((w) => ({ w, recent: false })), ...data.recent.map((w) => ({ w, recent: true }))] : [];

  return (
    <section aria-label="자주 보는 종목 영역">
      <div className="section-head">
        <h2 className="section-title">자주 보는 종목</h2>
        {data && data.favorites.length > 0 && (
          <button type="button" className="btn btn-ghost small" onClick={() => setEditing((v) => !v)}>{editing ? '완료' : '편집'}</button>
        )}
      </div>
      {error && <p className="notice" role="alert">{error}</p>}
      {data?.errors.map((m) => <p key={m} className="notice">{m}</p>)}
      {!data && !error && <SkeletonList />}
      {data && rows.length === 0 && (
        <p className="empty">검색해서 ★을 누르면 여기에 모여요. 종목 화면을 열면 최근 본 종목도 여기에 쌓여요.</p>
      )}
      {rows.length > 0 && (
        <ul className="list" aria-label="자주 보는 종목">
          {rows.map(({ w, recent }) => (
            <li key={`${recent ? 'r' : 'f'}-${w.key}`} className={editing && !recent ? 'editing' : undefined}>
              <Row w={w} recent={recent} spark={spark[w.key]} onOpen={onOpen} />
              {editing && !recent && (
                <button type="button" className="remove-btn" aria-label={`${w.instrument.name ?? w.instrument.symbol} 즐겨찾기에서 빼기`} onClick={() => unfavorite(w.key)}>빼기</button>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
