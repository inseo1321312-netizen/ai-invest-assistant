/** 홈 '오늘 소식' 띠: 보유 종목과 즐겨찾기 종목의 최근 뉴스(새것부터, 같은 기사는 한 번) */
import type { Db } from '../db.js';
import type { News } from '../market/news.js';
import { newsQueryFor } from '../market/news.js';
import { parseInstrumentKey } from '../market/types.js';

export interface MyNewsItem { key: string; name: string; title: string; url: string; source: string | null; publishedAt: number }

const MAX_KEYS = 12;
const PER_KEY = 4;
const MAX_ITEMS = 30;
const MAX_AGE_SEC = 3 * 86400;

export async function myNews(deps: { db: Db; news: Pick<News, 'search'>; instruments?: { nameOf(key: string): string | null } | null; now: () => number }): Promise<MyNewsItem[]> {
  // 보유 종목 먼저, 그다음 즐겨찾기(최근에 넣은 것부터)
  const keys = (deps.db.sql.prepare(`SELECT key FROM (SELECT key, added_at, 0 AS kind FROM holdings UNION ALL SELECT key, added_at, 1 AS kind FROM watchlist)
    GROUP BY key ORDER BY MIN(kind), MAX(added_at) DESC LIMIT ?`).all(MAX_KEYS) as { key: string }[]).map((r) => r.key);
  const since = deps.now() / 1000 - MAX_AGE_SEC;
  const lists = await Promise.all(keys.map(async (key) => {
    const known = deps.instruments?.nameOf(key) ?? null;
    const name = known ?? key.split(':').at(-1)!;
    const items = await deps.news.search(newsQueryFor(parseInstrumentKey(key), known)).catch(() => []);
    return items.filter((n) => n.publishedAt >= since).slice(0, PER_KEY).map((n) => ({ key, name, title: n.title, url: n.url, source: n.source, publishedAt: n.publishedAt }));
  }));
  const seen = new Set<string>();
  return lists.flat()
    .sort((a, b) => b.publishedAt - a.publishedAt)
    .filter((n) => { const id = n.url || n.title; if (seen.has(id)) return false; seen.add(id); return true; })
    .slice(0, MAX_ITEMS);
}
