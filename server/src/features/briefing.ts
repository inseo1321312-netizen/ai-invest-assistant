import { z } from 'zod';
import type { Db } from '../db.js';
import { kstDay } from '../ai/budget.js';
import * as prompts from '../ai/prompts.js';
import type { AiTool } from '../ai/types.js';
import { summarizeIndicators } from '../market/indicators.js';
import type { Holding, MarketId } from '../market/types.js';
import { BAR_SECONDS, horizonBars, instrumentKey, MARKETS } from '../market/types.js';
import type { Push } from '../push.js';
import { holdingContext, lastClosedTime, saveAnalysis } from './analysis.js';
import { type FeatureDeps, fmtNum } from './deps.js';
import { CONFIDENCE, opinionChoices, type Confidence } from './tools.js';

export interface BriefingDeps extends FeatureDeps { push: Push }

export type FeedKind = 'briefing' | 'breaking' | 'spike' | 'liquidation';
export interface FeedItem { id: number; createdAt: number; day: string; kind: FeedKind; market: MarketId; key: string | null; title: string; body: string; isBreaking: boolean }

const MARKET_NAME: Record<MarketId, string> = { coin: '코인', kr: '한국주식', us: '미국주식' };
const LIQ_ALERT_MS = 6 * 3600_000;

export function addFeedItem(db: Db, now: () => number, item: Omit<FeedItem, 'id' | 'createdAt' | 'day'>): void {
  const t = now();
  db.sql.prepare('INSERT INTO feed_items (created_at, day, kind, market, key, title, body, is_breaking) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .run(t, kstDay(t), item.kind, item.market, item.key, item.title, item.body, item.isBreaking ? 1 : 0);
}

export function listFeed(db: Db, day: string): FeedItem[] {
  const rows = db.sql.prepare('SELECT * FROM feed_items WHERE day = ? ORDER BY is_breaking DESC, created_at DESC, id DESC').all(day) as {
    id: number; created_at: number; day: string; kind: FeedKind; market: MarketId; key: string | null; title: string; body: string; is_breaking: number;
  }[];
  return rows.map((r) => ({ id: r.id, createdAt: r.created_at, day: r.day, kind: r.kind, market: r.market, key: r.key, title: r.title, body: r.body, isBreaking: r.is_breaking === 1 }));
}

function zonedParts(ms: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: get('weekday'), minutes: Number(get('hour')) * 60 + Number(get('minute')) };
}

/** 휴장일은 따로 보지 않는다(주말·시간만). */
export function isMarketOpen(market: MarketId, ms: number): boolean {
  if (market === 'coin') return true;
  const { weekday, minutes } = zonedParts(ms, market === 'kr' ? 'Asia/Seoul' : 'America/New_York');
  if (weekday === 'Sat' || weekday === 'Sun') return false;
  return market === 'kr' ? minutes >= 9 * 60 && minutes <= 15 * 60 + 30 : minutes >= 9 * 60 + 30 && minutes <= 16 * 60;
}

interface BriefingItem { key: string; headline: string; detail: string; isBreaking: boolean; opinion: string; confidence: Confidence; reasons: string[]; risks: string[] }

async function briefTab(deps: BriefingDeps, market: MarketId, holdings: Holding[]): Promise<BriefingItem[]> {
  const blocks: string[] = [];
  const choices = new Map<string, string[]>();
  const dataTimes = new Map<string, number>();
  const nowSec = Math.floor(deps.now() / 1000);
  for (const h of holdings) {
    const key = instrumentKey(h.instrument);
    if (choices.has(key)) continue;
    choices.set(key, opinionChoices(h, h.instrument));
    const bars = horizonBars(market, 'swing');
    const quote = await deps.market.getQuote(h.instrument).catch(() => null);
    const candles = await deps.market.getCandles(h.instrument, bars.primary, bars.primaryLimit).catch(() => []);
    const dt = lastClosedTime(candles, BAR_SECONDS[bars.primary], nowSec);
    if (dt !== null) dataTimes.set(key, dt);
    blocks.push([
      `## ${key}${h.instrument.name ? ` (${h.instrument.name})` : ''}`,
      `현재가: ${quote ? `${fmtNum(quote.price)} ${quote.currency}, 24시간 ${quote.changePct24h.toFixed(2)}%` : '알 수 없음'}`,
      holdingContext(h, quote?.price ?? null),
      `스윙 지표(${bars.primary}): ${JSON.stringify(summarizeIndicators(candles))}`,
      `고를 수 있는 의견: ${choices.get(key)!.join(' / ')}`,
    ].join('\n'));
  }
  const keys = [...choices.keys()] as [string, ...string[]];
  let submitted: { summary: string; items: BriefingItem[] } | null = null;
  const submit: AiTool<{ summary: string; items: BriefingItem[] }> = {
    name: 'submit_briefing',
    description: '브리핑 결과를 제출한다. 반드시 마지막에 한 번 호출한다.',
    schema: z.strictObject({
      summary: z.string(),
      items: z.array(z.strictObject({
        key: z.enum(keys), headline: z.string(), detail: z.string(), isBreaking: z.boolean(),
        opinion: z.string(), confidence: z.enum(CONFIDENCE), reasons: z.array(z.string()), risks: z.array(z.string()),
      })),
    }),
    async run(v) { submitted = v; return '제출되었습니다'; },
  };
  const userText = `${MARKET_NAME[market]} 보유 종목 아침 브리핑을 만들어 주세요.\n\n${blocks.join('\n\n')}`;
  const base = { provider: 'claude' as const, tier: 'standard' as const, purpose: 'scheduled' as const, instructions: prompts.BRIEFING, tools: [submit], webSearch: { maxUses: 5 } };
  let history: { role: 'user' | 'assistant'; text: string }[] = [];
  let text = userText;
  let cost = 0;
  let model = '';
  for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
    let doneText = '';
    for await (const ev of deps.runAi({ ...base, history, userText: text })) {
      if (ev.type === 'error') { console.error(`브리핑 실패(${market})`, ev.message); return []; }
      if (ev.type === 'done') { doneText = ev.text; cost += ev.costUsd; model = ev.model; }
    }
    history = [...history, { role: 'user', text }, { role: 'assistant', text: doneText || '(응답 없음)' }];
    text = '결과를 아직 제출하지 않았습니다. submit_briefing 도구로 제출하세요.';
  }
  const result = submitted as { summary: string; items: BriefingItem[] } | null;
  if (!result) return [];

  addFeedItem(deps.db, deps.now, {
    kind: 'briefing', market, key: null, title: `${MARKET_NAME[market]} 아침 브리핑`,
    body: [result.summary, ...result.items.map((i) => `• ${i.headline}`)].join('\n'), isBreaking: false,
  });
  for (const item of result.items) {
    if (item.isBreaking) addFeedItem(deps.db, deps.now, { kind: 'breaking', market, key: item.key, title: item.headline, body: item.detail, isBreaking: true });
    const dt = dataTimes.get(item.key);
    if (dt === undefined || !choices.get(item.key)?.includes(item.opinion)) continue;
    saveAnalysis(deps.db, {
      key: item.key, horizon: 'swing', provider: 'claude', model, dataTime: dt, createdAt: deps.now(), costUsd: cost / result.items.length,
      opinion: item.opinion, confidence: item.confidence, summary: item.detail, reasons: item.reasons.slice(0, 6), risks: item.risks.slice(0, 6), news: [], origin: 'briefing', tier: 'standard',
    });
  }
  return result.items;
}

export async function runMorningBriefing(deps: BriefingDeps): Promise<void> {
  const breaking: BriefingItem[] = [];
  for (const market of MARKETS) {
    const holdings = await deps.market.getHoldings(market).catch(() => [] as Holding[]);
    if (holdings.length === 0) continue;
    const items = await briefTab(deps, market, holdings);
    breaking.push(...items.filter((i) => i.isBreaking));
  }
  if (breaking.length) {
    await deps.push.sendAll({
      title: `[속보] ${breaking[0]!.headline}`,
      body: breaking.length > 1 ? `외 ${breaking.length - 1}건 · ${breaking[0]!.detail}` : breaking[0]!.detail,
      url: '/',
    });
  }
}

function recentlyAlerted(db: Db, key: string, kind: string, direction: string, sinceMs: number): boolean {
  return Boolean(db.sql.prepare('SELECT 1 FROM alert_log WHERE key = ? AND kind = ? AND direction = ? AND sent_at >= ? LIMIT 1').get(key, kind, direction, sinceMs));
}

function kstDayStartMs(ms: number): number {
  return Date.parse(`${kstDay(ms)}T00:00:00+09:00`);
}

export async function checkSpikesAndLiquidation(deps: BriefingDeps): Promise<void> {
  const { db } = deps;
  const log = db.sql.prepare('INSERT INTO alert_log (key, kind, direction, sent_at) VALUES (?, ?, ?, ?)');
  for (const market of MARKETS) {
    if (!isMarketOpen(market, deps.now())) continue;
    const holdings = await deps.market.getHoldings(market).catch(() => [] as Holding[]);
    for (const h of holdings) {
      const key = instrumentKey(h.instrument);
      const quote = await deps.market.getQuote(h.instrument).catch(() => null);
      if (!quote) continue;
      const name = h.instrument.name ?? h.instrument.symbol;

      if (Math.abs(quote.changePct24h) >= 5) {
        const direction = quote.changePct24h > 0 ? 'up' : 'down';
        if (!recentlyAlerted(db, key, 'spike', direction, kstDayStartMs(deps.now()))) {
          log.run(key, 'spike', direction, deps.now());
          let reason = '';
          for await (const ev of deps.runAi({
            provider: 'claude', tier: 'light', purpose: 'scheduled', instructions: prompts.SPIKE, history: [],
            userText: `${key} (${name})가 24시간 ${quote.changePct24h.toFixed(2)}% 움직였다. 현재가 ${fmtNum(quote.price)} ${quote.currency}.`,
            tools: [], webSearch: { maxUses: 2 },
          })) {
            if (ev.type === 'done') reason = ev.text;
          }
          const pct = `${quote.changePct24h > 0 ? '+' : ''}${quote.changePct24h.toFixed(1)}%`;
          const title = `${name} ${direction === 'up' ? '급등' : '급락'} ${pct}`;
          const body = reason || '이유를 찾지 못했습니다';
          addFeedItem(db, deps.now, { kind: 'spike', market, key, title, body, isBreaking: true });
          await deps.push.sendAll({ title: `[속보] ${title}`, body, url: '/' });
        }
      }

      const mark = h.markPrice ?? quote.price;
      if (h.liqPrice && mark) {
        const dist = Math.abs(mark - h.liqPrice) / mark;
        if (dist <= 0.05 && !recentlyAlerted(db, key, 'liquidation', 'any', deps.now() - LIQ_ALERT_MS)) {
          log.run(key, 'liquidation', 'any', deps.now());
          const title = `청산 주의: ${name} 청산가까지 ${(dist * 100).toFixed(1)}%`;
          const body = `${h.side === 'short' ? '숏' : '롱'} ${h.leverage ? `${fmtNum(h.leverage)}배 ` : ''}포지션 · 현재 ${fmtNum(mark)} / 청산가 ${fmtNum(h.liqPrice)} ${h.currency}`;
          addFeedItem(db, deps.now, { kind: 'liquidation', market, key, title, body, isBreaking: true });
          await deps.push.sendAll({ title: `[속보] ${title}`, body, url: '/' });
        }
      }
    }
  }
}
