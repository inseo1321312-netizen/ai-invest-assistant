import { z } from 'zod';
import type { Db } from '../db.js';
import { kstDay } from '../ai/budget.js';
import * as prompts from '../ai/prompts.js';
import type { AiTool } from '../ai/types.js';
import { summarizeIndicators } from '../market/indicators.js';
import type { Instrument, MarketId } from '../market/types.js';
import { BAR_SECONDS, horizonBars, instrumentKey, MARKETS } from '../market/types.js';
import type { Push } from '../push.js';
import { lastClosedTime, saveAnalysis } from './analysis.js';
import { type FeatureDeps, fmtNum } from './deps.js';
import { CONFIDENCE, opinionChoices, type Confidence } from './tools.js';

export interface BriefingDeps extends FeatureDeps { push: Push }

export type FeedKind = 'briefing' | 'breaking' | 'spike' | 'liquidation';
export interface FeedItem { id: number; createdAt: number; day: string; kind: FeedKind; market: MarketId; key: string | null; title: string; body: string; isBreaking: boolean }

const MARKET_NAME: Record<MarketId, string> = { coin: '코인', kr: '한국주식', us: '미국주식' };

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

async function briefTab(deps: BriefingDeps, market: MarketId, instruments: Instrument[]): Promise<BriefingItem[]> {
  const blocks: string[] = [];
  const choices = new Map<string, string[]>();
  const dataTimes = new Map<string, number>();
  const nowSec = Math.floor(deps.now() / 1000);
  for (const inst of instruments) {
    const key = instrumentKey(inst);
    if (choices.has(key)) continue;
    choices.set(key, opinionChoices(inst));
    const bars = horizonBars(market, 'swing');
    const quote = await deps.market.getQuote(inst).catch(() => null);
    const candles = await deps.market.getCandles(inst, bars.primary, bars.primaryLimit).catch(() => []);
    const dt = lastClosedTime(candles, BAR_SECONDS[bars.primary], nowSec);
    if (dt !== null) dataTimes.set(key, dt);
    blocks.push([
      `## ${key}${inst.name ? ` (${inst.name})` : ''}`,
      `현재가: ${quote ? `${fmtNum(quote.price)} ${quote.currency}, 24시간 ${quote.changePct24h.toFixed(2)}%` : '알 수 없음'}`,
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
  const userText = `${MARKET_NAME[market]} 즐겨찾기 종목 아침 브리핑을 만들어 주세요.\n\n${blocks.join('\n\n')}`;
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
    const favorites = deps.market.listWatchlist(market);
    if (favorites.length === 0) continue;
    const items = await briefTab(deps, market, favorites);
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

let catchUpRunning: Promise<void> | null = null;

/**
 * 무료 서버는 앱을 열 때만 깨어나므로, 깨어날 때(그리고 앱이 소식을 불러갈 때) 밀린 작업을 한다.
 * - 오늘 08:00(한국 시간)이 지났는데 아침 브리핑이 없으면 한 번 만든다.
 */
export function ensureCatchUp(deps: BriefingDeps): Promise<void> {
  if (!catchUpRunning) {
    catchUpRunning = runCatchUp(deps).finally(() => { catchUpRunning = null; });
  }
  return catchUpRunning;
}

async function runCatchUp(deps: BriefingDeps): Promise<void> {
  const { db } = deps;
  const t = deps.now();
  const day = kstDay(t);
  const kstHour = new Date(t + 9 * 3600_000).getUTCHours();
  const hasBriefing = listFeed(db, day).some((f) => f.kind === 'briefing');
  if (kstHour >= 8 && !hasBriefing && db.kvGet<string>('catchup.briefingDay') !== day) {
    db.kvSet('catchup.briefingDay', day);
    await runMorningBriefing(deps).catch((err) => console.error('브리핑 실패', err instanceof Error ? err.message : err));
  }
}
