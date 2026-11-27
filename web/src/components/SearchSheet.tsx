import { useEffect, useRef, useState } from 'react';
import { api, post } from '../api';
import type { SearchHit } from '../types';
import { Dots, Sheet } from '../ui';
import { Avatar, MARKET_SHORT } from './rows';

/** 이름 일부나 기호로 세 시장을 한 번에 찾는다. ★로 즐겨찾기에 넣고 뺀다. */
export function SearchSheet({ onOpen, onClose }: { onOpen: (key: string, name?: string) => void; onClose: () => void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [starred, setStarred] = useState<Set<string>>(new Set());
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
    api<{ keys: string[] }>('/api/watchlist').then((r) => { if (Array.isArray(r.keys)) setStarred(new Set(r.keys)); }).catch(() => undefined);
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (!term) { setHits(null); setLoading(false); return; }
    let alive = true;
    setLoading(true);
    const t = setTimeout(() => {
      api<{ hits: SearchHit[] }>(`/api/search?q=${encodeURIComponent(term)}`)
        .then((r) => { if (alive) setHits(r.hits); })
        .catch(() => { if (alive) setHits([]); })
        .finally(() => { if (alive) setLoading(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  async function toggleStar(key: string) {
    const on = starred.has(key);
    setStarred((s) => { const n = new Set(s); if (on) n.delete(key); else n.add(key); return n; });
    if (on) await api(`/api/watchlist?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
    else await post('/api/watchlist', { key }).catch(() => undefined);
  }

  return (
    <Sheet title="종목 검색" onClose={onClose} full>
      <div className="search-box">
        <input ref={input} className="input" aria-label="종목 이름" placeholder="예: 삼성, 애플, 비트, NVDA" value={q}
          onChange={(e) => setQ(e.target.value)} autoComplete="off" autoCorrect="off" spellCheck={false} enterKeyHint="search" />
      </div>
      {loading && !hits && <p className="status"><Dots /> 찾는 중…</p>}
      {hits && hits.length === 0 && <p className="empty">찾는 종목이 없어요. 이름 일부나 종목 기호로 찾아보세요.</p>}
      {hits && hits.length > 0 && (
        <ul className="search-list" aria-label="검색 결과">
          {hits.map((h) => (
            <li key={h.key}>
              <button type="button" className="search-row" aria-label={`${h.name} ${h.symbol} ${MARKET_SHORT[h.market]}`} onClick={() => { onOpen(h.key, h.name); onClose(); }}>
                <Avatar inst={{ market: h.market, symbol: h.symbol, name: h.name }} logoKey={h.key} />
                <span className="search-name">{h.name}<small>{h.symbol}</small></span>
                <span className={`market-badge ${h.market}`}>{MARKET_SHORT[h.market]}</span>
              </button>
              <button type="button" className="star-btn" aria-label={`${h.name} 즐겨찾기`} aria-pressed={starred.has(h.key)} onClick={() => toggleStar(h.key)}>
                {starred.has(h.key) ? '★' : '☆'}
              </button>
            </li>
          ))}
        </ul>
      )}
      {!q.trim() && <p className="hint" style={{ textAlign: 'center' }}>한국 주식은 이름으로, 미국 주식은 이름이나 기호로, 코인은 한글 이름이나 기호로 찾을 수 있어요.</p>}
    </Sheet>
  );
}
