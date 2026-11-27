/** Google 뉴스 RSS(한국어). 개인·비상업 용도. 10분 동안 기억한다. */
import type { Instrument } from './types.js';

export interface NewsItem { title: string; url: string; source: string | null; publishedAt: number }

const TTL_MS = 10 * 60_000;
const LIMIT = 10;
const DAY = 86400;

function decode(s: string): string {
  return s
    .replace(/^<!\[CDATA\[([\s\S]*)\]\]>$/, '$1')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'")
    .replace(/&#(x[0-9a-f]+|\d+);/gi, (_, n: string) => {
      const cp = n[0] === 'x' || n[0] === 'X' ? parseInt(n.slice(1), 16) : Number(n);
      return Number.isInteger(cp) && cp >= 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    .replace(/&amp;/g, '&')
    .trim();
}

function tag(block: string, name: string): string | null {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`).exec(block);
  return m ? decode(m[1]!) : null;
}

export function parseRss(xml: string): NewsItem[] {
  const out: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const block = m[1]!;
    const url = tag(block, 'link') ?? '';
    if (!/^https?:\/\//i.test(url)) continue;
    const source = tag(block, 'source');
    let title = tag(block, 'title') ?? '';
    if (source && title.endsWith(` - ${source}`)) title = title.slice(0, -(source.length + 3)).trim();
    const t = Date.parse(tag(block, 'pubDate') ?? '');
    if (!title) continue;
    out.push({ title, url, source, publishedAt: Number.isFinite(t) ? Math.floor(t / 1000) : 0 });
  }
  return out;
}

function ymdKst(sec: number): string {
  return new Date((sec + 9 * 3600) * 1000).toISOString().slice(0, 10);
}

/** 검색어: 이름(없으면 기호)에 시장 단어를 붙인다. 이름에 이미 '코인'이 있으면 그대로 */
export function newsQueryFor(inst: Instrument, name: string | null): string {
  if (inst.market === 'coin') {
    const n = name ?? inst.symbol.split('-')[0]!;
    if (/코인$/.test(n)) return n;
    return name ? `${n} (코인 OR 가상자산 OR 시세)` : `${n} 코인`;
  }
  return `${name ?? inst.symbol} (주가 OR 주식 OR 실적 OR 증시)`;
}

export interface News { search(query: string, range?: { from: number; to: number }): Promise<NewsItem[]> }

export function createNews(deps: { fetch: typeof fetch; now: () => number }): News {
  const cache = new Map<string, { at: number; items: NewsItem[] }>();
  return {
    async search(query, range) {
      const q = range ? `${query} after:${ymdKst(range.from - DAY)} before:${ymdKst(range.to + DAY)}` : query;
      const hit = cache.get(q);
      if (hit && deps.now() - hit.at < TTL_MS) return hit.items;
      try {
        const url = `https://news.google.com/rss/search?${new URLSearchParams({ q, hl: 'ko', gl: 'KR', ceid: 'KR:ko' }).toString()}`;
        const res = await deps.fetch(url, { signal: AbortSignal.timeout(10_000) });
        if (!res.ok) throw new Error(String(res.status));
        let items = parseRss(await res.text());
        if (range) items = items.filter((i) => i.publishedAt >= range.from - DAY && i.publishedAt <= range.to + DAY);
        items = items.sort((a, b) => b.publishedAt - a.publishedAt).slice(0, LIMIT);
        cache.set(q, { at: deps.now(), items });
        if (cache.size > 200) cache.delete(cache.keys().next().value!);
        return items;
      } catch {
        return hit?.items ?? [];
      }
    },
  };
}
