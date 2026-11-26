import { useEffect, useState } from 'react';
import { api } from '../api';
import type { FeedItem } from '../types';
import { Sheet } from '../ui';

/** 맨 위 [속보] 띠. 소식이 여러 개면 천천히 흘러가고, 누르면 자세히 보여준다. */
export function FeedBanner({ refreshKey = 0, onOpenKey }: { refreshKey?: number; onOpenKey?: (key: string) => void }) {
  const [items, setItems] = useState<FeedItem[] | null>(null);
  const [open, setOpen] = useState<FeedItem | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ items: FeedItem[] }>('/api/feed')
      .then((r) => { if (alive) setItems([...r.items].sort((a, b) => Number(b.isBreaking) - Number(a.isBreaking) || b.createdAt - a.createdAt)); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [refreshKey]);

  const breaking = items?.some((i) => i.isBreaking) ?? false;
  const moving = (items?.length ?? 0) > 1;
  const renderItems = (list: FeedItem[], hidden: boolean) => list.map((it) => (
    <li key={`${hidden ? 'd' : 'o'}-${it.id}`}>
      <button type="button" className="ticker-item" tabIndex={hidden ? -1 : 0} onClick={() => setOpen(it)}>
        {it.isBreaking && <span className="tag">[속보]</span>}
        {it.title}
      </button>
    </li>
  ));

  return (
    <section className="ticker" aria-label="오늘의 소식">
      <div className="ticker-row">
        <span className={`ticker-badge${breaking ? '' : ' calm'}`}>{breaking ? '속보' : '소식'}</span>
        <div className={`ticker-track${moving ? '' : ' still'}`}>
          {items === null && <span className="ticker-empty">소식을 불러오는 중…</span>}
          {items && items.length === 0 && <span className="ticker-empty">오늘 소식이 아직 없어요. 매일 아침 8시에 정리해요.</span>}
          {items && items.length > 0 && (
            <div style={{ display: 'flex', gap: 28, width: 'max-content' }} className={moving ? 'ticker-list marquee' : 'ticker-list'}>
              <ul className="ticker-list">{renderItems(items, false)}</ul>
              {moving && <ul className="ticker-list" aria-hidden="true">{renderItems(items, true)}</ul>}
            </div>
          )}
        </div>
      </div>
      {open && (
        <Sheet title={open.isBreaking ? '[속보]' : '오늘의 소식'} onClose={() => setOpen(null)}>
          <h3 style={{ margin: '0 0 8px', fontSize: 18 }}>{open.title}</h3>
          <p style={{ whiteSpace: 'pre-line', color: 'var(--ink-2)', margin: 0 }}>{open.body}</p>
          {open.key && onOpenKey && (
            <button type="button" className="btn btn-ai btn-block" style={{ marginTop: 16 }} onClick={() => { const k = open.key!; setOpen(null); onOpenKey(k); }}>
              차트와 AI 분석 보기
            </button>
          )}
        </Sheet>
      )}
    </section>
  );
}
