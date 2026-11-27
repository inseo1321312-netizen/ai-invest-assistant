import { useEffect, useState } from 'react';
import { api } from '../api';

interface MyNews { key: string; name: string; title: string; url: string; source: string | null; publishedAt: number }

/** 홈 '오늘 소식': 즐겨찾기·보유 종목 뉴스가 옆으로 계속 흐르고, 누르면 기사로 간다 */
export function NewsTicker({ refreshKey = 0 }: { refreshKey?: number }) {
  const [items, setItems] = useState<MyNews[] | null>(null);

  useEffect(() => {
    let alive = true;
    api<{ items: MyNews[] }>('/api/news/mine')
      .then((r) => { if (alive) setItems(r.items); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [refreshKey]);

  const moving = (items?.length ?? 0) > 1;
  const renderItems = (hidden: boolean) => (items ?? []).map((n) => (
    <li key={`${hidden ? 'd' : 'o'}-${n.url}`}>
      <a className="ticker-item" href={n.url} target="_blank" rel="noopener noreferrer" tabIndex={hidden ? -1 : 0}>
        <span className="tag">{n.name}</span>{n.title}
      </a>
    </li>
  ));

  return (
    <section className="ticker" aria-label="오늘 소식">
      <div className="ticker-row">
        <span className="ticker-badge calm">소식</span>
        <div className={`ticker-track${moving ? '' : ' still'}`}>
          {items === null && <span className="ticker-empty">뉴스를 불러오는 중…</span>}
          {items && items.length === 0 && <span className="ticker-empty">즐겨찾기나 보유 종목을 넣으면 관련 뉴스가 여기 흘러요</span>}
          {items && items.length > 0 && (
            <div style={{ display: 'flex', gap: 28, width: 'max-content' }} className={moving ? 'ticker-list marquee' : 'ticker-list'}>
              <ul className="ticker-list">{renderItems(false)}</ul>
              {moving && <ul className="ticker-list" aria-hidden="true">{renderItems(true)}</ul>}
            </div>
          )}
        </div>
      </div>
    </section>
  );
}
