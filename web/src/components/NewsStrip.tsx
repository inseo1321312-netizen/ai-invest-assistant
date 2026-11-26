import { useEffect, useState } from 'react';
import { api } from '../api';
import type { NewsItem } from '../types';
import { Sheet } from '../ui';

/** 몇 분 전·몇 시간 전·날짜 */
export function ago(sec: number, nowMs = Date.now()): string {
  const d = Math.max(0, Math.floor(nowMs / 1000) - sec);
  if (d < 3600) return `${Math.max(1, Math.floor(d / 60))}분 전`;
  if (d < 86400) return `${Math.floor(d / 3600)}시간 전`;
  if (d < 7 * 86400) return `${Math.floor(d / 86400)}일 전`;
  return new Date((sec + 9 * 3600) * 1000).toISOString().slice(5, 10).replace('-', '.');
}

export function NewsList({ items }: { items: NewsItem[] }) {
  return (
    <ul className="news-list">
      {items.map((n) => (
        <li key={n.url}>
          <a href={n.url} target="_blank" rel="noreferrer noopener">
            <span className="news-title">{n.title}</span>
            <span className="news-meta">{n.source ?? '뉴스'} · {ago(n.publishedAt)}</span>
          </a>
        </li>
      ))}
    </ul>
  );
}

/** 종목 화면 위쪽: 최신 기사 5개를 옆으로 넘기는 카드, "더 보기"는 전체 목록 */
export function NewsStrip({ keyId }: { keyId: string }) {
  const [items, setItems] = useState<NewsItem[] | null>(null);
  const [all, setAll] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ items: NewsItem[] }>(`/api/news?key=${encodeURIComponent(keyId)}`)
      .then((r) => { if (alive) setItems(Array.isArray(r.items) ? r.items : []); })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [keyId]);

  if (items && items.length === 0) return null;
  return (
    <section className="news-strip" aria-label="관련 뉴스">
      <div className="section-head">
        <h2 className="section-title">관련 뉴스</h2>
        {items && items.length > 5 && <button type="button" className="btn btn-ghost small" onClick={() => setAll(true)}>더 보기</button>}
      </div>
      <div className="news-row">
        {!items && Array.from({ length: 2 }, (_, i) => <span key={i} className="news-card skeleton" aria-hidden="true" />)}
        {items?.slice(0, 5).map((n) => (
          <a key={n.url} className="news-card" href={n.url} target="_blank" rel="noreferrer noopener">
            <span className="news-title">{n.title}</span>
            <span className="news-meta">{n.source ?? '뉴스'} · {ago(n.publishedAt)}</span>
          </a>
        ))}
      </div>
      {all && items && <Sheet title="관련 뉴스 전체" onClose={() => setAll(false)}><NewsList items={items} /></Sheet>}
    </section>
  );
}
