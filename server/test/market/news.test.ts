import { expect, test } from 'vitest';
import { createNews, newsQueryFor, parseRss } from '../../src/market/news.js';
import { parseInstrumentKey } from '../../src/market/types.js';
import { fakeFetch } from '../fakeFetch.js';
import { makeClock } from '../helpers.js';

const RSS = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>"삼성전자" - Google 뉴스</title>
<item><title>삼성전자, 신제품 공개 &amp; 주가 상승 - 한국경제</title><link>https://news.google.com/rss/articles/A1?oc=5</link><pubDate>Thu, 26 Nov 2026 03:00:00 GMT</pubDate><source url="https://www.hankyung.com">한국경제</source></item>
<item><title><![CDATA[반도체 업황 <회복> 기대]]></title><link>https://news.google.com/rss/articles/B2?oc=5</link><pubDate>Wed, 25 Nov 2026 01:00:00 GMT</pubDate><source url="https://www.mk.co.kr">매일경제</source></item>
<item><title>나쁜 링크</title><link>javascript:alert(1)</link><pubDate>Wed, 25 Nov 2026 00:00:00 GMT</pubDate></item>
</channel></rss>`;

test('parses Google News RSS: titles without the outlet suffix, entities and CDATA decoded, unsafe links dropped', () => {
  expect(parseRss(RSS)).toEqual([
    { title: '삼성전자, 신제품 공개 & 주가 상승', url: 'https://news.google.com/rss/articles/A1?oc=5', source: '한국경제', publishedAt: Date.parse('2026-11-26T03:00:00Z') / 1000 },
    { title: '반도체 업황 <회복> 기대', url: 'https://news.google.com/rss/articles/B2?oc=5', source: '매일경제', publishedAt: Date.parse('2026-11-25T01:00:00Z') / 1000 },
  ]);
});

test('search asks Google News in Korean and remembers results for 10 minutes', async () => {
  const f = fakeFetch({ '/rss/search': () => new Response(RSS) });
  const clock = makeClock();
  const news = createNews({ fetch: f, now: clock.now });
  expect(await news.search('삼성전자')).toHaveLength(2);
  await news.search('삼성전자');
  expect(f.count('/rss/search')).toBe(1);
  expect(f.calls[0]!.url.searchParams.get('hl')).toBe('ko');
  expect(f.calls[0]!.url.searchParams.get('q')).toBe('삼성전자');
  clock.advance(11 * 60_000);
  await news.search('삼성전자');
  expect(f.count('/rss/search')).toBe(2);
});

test('a date range adds after/before (KST) and keeps only nearby articles', async () => {
  const f = fakeFetch({ '/rss/search': () => new Response(RSS) });
  const news = createNews({ fetch: f, now: makeClock().now });
  const t = Date.parse('2026-11-26T09:00:00+09:00') / 1000;
  const items = await news.search('삼성전자', { from: t, to: t });
  expect(f.calls[0]!.url.searchParams.get('q')).toBe('삼성전자 after:2026-11-25 before:2026-11-27');
  expect(items.map((i) => i.source)).toEqual(['한국경제', '매일경제']);
});

test('failures give an empty list', async () => {
  const news = createNews({ fetch: (async () => { throw new Error('down'); }) as typeof fetch, now: makeClock().now });
  expect(await news.search('x')).toEqual([]);
});

test('query words per market', () => {
  expect(newsQueryFor(parseInstrumentKey('kr:005930'), '삼성전자')).toBe('삼성전자 (주가 OR 주식 OR 실적 OR 증시)');
  expect(newsQueryFor(parseInstrumentKey('us:NAS:AAPL'), null)).toBe('AAPL (주가 OR 주식 OR 실적 OR 증시)');
  expect(newsQueryFor(parseInstrumentKey('coin:BTC-USDT-SWAP'), '비트코인')).toBe('비트코인');
  expect(newsQueryFor(parseInstrumentKey('coin:PEPE-USDT'), null)).toBe('PEPE 코인');
});

test('broken or hex character codes do not break the feed', () => {
  const xml = '<rss><channel><item><title>A&#99999999;B &#x41;&#66; - 한경</title><link>https://n.example/1</link><pubDate>Thu, 26 Nov 2026 03:00:00 GMT</pubDate><source url="https://h">한경</source></item></channel></rss>';
  expect(parseRss(xml).map((i) => i.title)).toEqual(['AB AB']);
});
