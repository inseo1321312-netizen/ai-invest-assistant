/** 비교: 2~4개 종목 중 "지금 사기에" 어느 것이 나은지 AI가 순위를 매긴다. 숫자(facts)는 서버가 계산한다. */
import { z } from 'zod';
import type { Db } from '../db.js';
import * as prompts from '../ai/prompts.js';
import type { AiEvent, AiTool, ProviderId } from '../ai/types.js';
import { summarizeIndicators } from '../market/indicators.js';
import type { Candle, Currency, Horizon, Quote } from '../market/types.js';
import { MARKET_CURRENCY, horizonBars, parseInstrumentKey } from '../market/types.js';
import { newsQueryFor } from '../market/news.js';
import { type FeatureDeps, fmtNum, kstDateTime } from './deps.js';
import { buildMarketTools, CONFIDENCE, opinionChoices, type Confidence } from './tools.js';

export interface CompareFacts { price: number | null; currency: Currency | null; dayPct: number | null; monthPct: number | null; yearPos: number | null; aboveMa20: boolean | null }
export interface CompareRank { key: string; rank: number; opinion: string; reason: string; risk: string }
export interface CompareBody { pick: string | null; confidence: Confidence; summary: string; ranking: CompareRank[] }
export interface StoredCompare extends CompareBody {
  id: number;
  keys: string[];
  names: Record<string, string | null>;
  horizon: Horizon;
  provider: ProviderId;
  model: string;
  facts: Record<string, CompareFacts | null>;
  createdAt: number;
  costUsd: number;
}
export type CompareEvent = AiEvent | { type: 'compare'; result: StoredCompare; cached: boolean };

const REUSE_MS = 10 * 60_000;
const HORIZON_TEXT: Record<Horizon, string> = { scalp: '단타(하루 안)', swing: '스윙(며칠~몇 주)', long: '장기(몇 달 이상)' };

const DAY = 86400;

/**
 * 일봉으로 52주 위치·한 달 등락·20일선 위아래를, 시세로 지금 가격·오늘 등락을 구한다.
 * 기간은 봉 개수가 아니라 날짜로 센다(코인은 주말에도 거래한다). 52주 = 최근 365일, 한 달 = 30일 전 종가.
 */
export function computeFacts(daily: Candle[], quote: Quote | null): CompareFacts {
  const closes = daily.map((c) => c.close);
  const price = quote?.price ?? closes.at(-1) ?? null;
  const facts: CompareFacts = { price, currency: quote?.currency ?? null, dayPct: quote?.changePct24h ?? null, monthPct: null, yearPos: null, aboveMa20: null };
  if (price === null || daily.length === 0) return facts;
  const last = daily.at(-1)!.time;
  const monthAgo = [...daily].reverse().find((c) => c.time <= last - 30 * DAY);
  if (monthAgo) facts.monthPct = (price / monthAgo.close - 1) * 100;
  const year = daily.filter((c) => c.time >= last - 365 * DAY);
  if (year.length > 1) {
    const lo = Math.min(...year.map((c) => c.low));
    const hi = Math.max(...year.map((c) => c.high));
    if (hi > lo) facts.yearPos = Math.max(0, Math.min(100, ((price - lo) / (hi - lo)) * 100));
  }
  if (closes.length >= 20) facts.aboveMa20 = price > closes.slice(-20).reduce((a, b) => a + b, 0) / 20;
  return facts;
}

const setKey = (keys: string[]) => [...keys].sort().join('|');

interface Row { id: number; keys_json: string; horizon: string; provider: string; model: string; body_json: string; facts_json: string; names_json: string; created_at: number; cost_usd: number }

function fromRow(r: Row): StoredCompare {
  return {
    ...(JSON.parse(r.body_json) as CompareBody), id: r.id, keys: JSON.parse(r.keys_json), names: JSON.parse(r.names_json),
    horizon: r.horizon as Horizon, provider: r.provider as ProviderId, model: r.model, facts: JSON.parse(r.facts_json), createdAt: r.created_at, costUsd: r.cost_usd,
  };
}

export function getCompare(db: Db, id: number): StoredCompare | null {
  const r = db.sql.prepare('SELECT * FROM comparisons WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}

export function compareHistory(db: Db, limit = 10) {
  const rows = db.sql.prepare('SELECT * FROM comparisons ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as Row[];
  return rows.map((r) => {
    const c = fromRow(r);
    return { id: c.id, keys: c.keys, names: c.names, horizon: c.horizon, provider: c.provider, pick: c.pick, createdAt: c.createdAt };
  });
}

/** 결과 검사: 고른 종목 전부, 순위 1..n 겹침 없음, pick은 고른 것 중 하나나 null, 의견은 그 종목 선택지 */
function problemOf(body: CompareBody, keys: string[], choices: Record<string, string[]>): string | null {
  const ranked = body.ranking.map((r) => r.key);
  if (ranked.length !== keys.length || new Set(ranked).size !== keys.length || !keys.every((k) => ranked.includes(k))) return `ranking에 고른 종목(${keys.join(', ')})을 하나씩 모두 넣어야 합니다`;
  const ranks = body.ranking.map((r) => r.rank).sort((a, b) => a - b);
  if (ranks.some((r, i) => r !== i + 1)) return `rank는 1부터 ${keys.length}까지 겹치지 않아야 합니다`;
  if (body.pick !== null && !keys.includes(body.pick)) return 'pick은 고른 종목 중 하나이거나 null이어야 합니다';
  if (body.pick !== null && body.ranking.find((r) => r.rank === 1)?.key !== body.pick) return 'pick은 rank 1인 종목이어야 합니다';
  const bad = body.ranking.find((r) => !choices[r.key]!.includes(r.opinion));
  if (bad) return `${bad.key}의 opinion은 ${choices[bad.key]!.join(' / ')} 중 하나여야 합니다`;
  return null;
}

function makeSubmitTool(keys: string[], choices: Record<string, string[]>, onSubmit: (b: CompareBody | null, problem: string | null) => void): AiTool<CompareBody> {
  return {
    name: 'submit_comparison',
    description: '비교 결과를 제출한다. 반드시 마지막에 한 번 호출한다.',
    schema: z.strictObject({
      pick: z.string().nullable(),
      confidence: z.enum(CONFIDENCE),
      summary: z.string(),
      ranking: z.array(z.strictObject({ key: z.string(), rank: z.number().int(), opinion: z.string(), reason: z.string(), risk: z.string() })),
    }) as z.ZodType<CompareBody>,
    async run(b) {
      const problem = problemOf(b, keys, choices);
      onSubmit(problem ? null : { ...b, ranking: [...b.ranking].sort((x, y) => x.rank - y.rank) }, problem);
      return problem ? `제출이 거절되었습니다: ${problem}. 고쳐서 다시 submit_comparison을 호출하세요.` : '제출되었습니다';
    },
  };
}

const pct = (n: number | null) => (n === null ? '알 수 없음' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);

export async function* runCompare(deps: FeatureDeps, args: { keys: string[]; horizon: Horizon; provider: ProviderId }): AsyncIterable<CompareEvent> {
  const cached = deps.db.sql.prepare('SELECT * FROM comparisons WHERE set_key = ? AND horizon = ? AND provider = ? AND created_at > ? ORDER BY id DESC LIMIT 1')
    .get(setKey(args.keys), args.horizon, args.provider, deps.now() - REUSE_MS) as Row | undefined;
  if (cached) {
    yield { type: 'compare', result: fromRow(cached), cached: true };
    return;
  }

  const insts = args.keys.map((k) => parseInstrumentKey(k));
  const names: Record<string, string | null> = {};
  for (const [i, k] of args.keys.entries()) names[k] = deps.instruments?.nameOf(k) ?? insts[i]!.name ?? null;
  const label = (k: string) => names[k] ?? k.split(':').at(-1)!;

  const facts: Record<string, CompareFacts | null> = {};
  const blocks: string[] = [];
  const choices: Record<string, string[]> = {};
  yield { type: 'status', message: `${args.keys.map(label).join(', ')} 보는 중…` };
  // 뉴스 시각(publishedAt)은 초 단위
  const weekAgo = Math.floor(deps.now() / 1000) - 7 * DAY;
  const loaded = await Promise.all(args.keys.map((key, i) => {
    const inst = insts[i]!;
    const bar = horizonBars(inst.market, args.horizon).primary;
    return Promise.allSettled([
      deps.market.getCandles(inst, '1D', inst.market === 'coin' ? 370 : 260),
      deps.market.getQuote(inst),
      bar === '1D' ? Promise.resolve(null) : deps.market.getCandles(inst, bar, 60),
      deps.news ? deps.news.search(newsQueryFor(inst, names[key] ?? null)) : Promise.resolve([]),
    ]);
  }));
  for (const [i, key] of args.keys.entries()) {
    const inst = insts[i]!;
    const bar = horizonBars(inst.market, args.horizon).primary;
    const [daily, quote, primary, news] = loaded[i]!;
    const headlines = news.status === 'fulfilled' ? news.value.filter((n) => n.publishedAt >= weekAgo).slice(0, 3) : [];
    const d = daily.status === 'fulfilled' ? daily.value : [];
    const q = quote.status === 'fulfilled' ? quote.value : null;
    const f = computeFacts(d, q);
    facts[key] = f.price === null ? null : { ...f, currency: f.currency ?? MARKET_CURRENCY[inst.market] };
    choices[key] = opinionChoices(inst);
    const p = primary.status === 'fulfilled' ? (primary.value ?? d.slice(-60)) : [];
    const fx = facts[key];
    blocks.push([
      `[${i + 1}] ${key}${names[key] ? ` (${names[key]})` : ''}`,
      fx
        ? `현재가 ${fmtNum(fx.price!)} ${fx.currency} (24시간 ${pct(fx.dayPct)}), 한 달 ${pct(fx.monthPct)}, 52주 위치 ${fx.yearPos === null ? '알 수 없음' : `${Math.round(fx.yearPos)}%`}(0=최저, 100=최고), 20일선 ${fx.aboveMa20 === null ? '알 수 없음' : fx.aboveMa20 ? '위' : '아래'}`
        : '데이터를 가져오지 못했습니다',
      p.length > 1 ? `[${bar}] 지표 요약: ${JSON.stringify(summarizeIndicators(p))}` : '',
      headlines.length ? `최근 뉴스: ${headlines.map((n) => `${n.title} (${kstDateTime(n.publishedAt)})`).join(' / ')}` : '',
      `고를 수 있는 의견: ${choices[key]!.join(' / ')}`,
    ].filter(Boolean).join('\n'));
  }
  if (args.keys.every((k) => facts[k] === null)) {
    yield { type: 'error', code: 'provider', message: '비교할 데이터를 가져오지 못했습니다' };
    return;
  }

  const userText = [`분석 기간: ${HORIZON_TEXT[args.horizon]}`, `고른 종목 ${args.keys.length}개:`, ...blocks].join('\n\n');
  let submitted: CompareBody | null = null;
  let problem: string | null = null;
  const tools = [...buildMarketTools(deps.market, deps), makeSubmitTool(args.keys, choices, (b, pr) => { if (submitted) return; submitted = b; problem = pr; })];
  const base = { provider: args.provider, tier: 'standard' as const, purpose: 'interactive' as const, instructions: prompts.COMPARE, tools, webSearch: { maxUses: 3 } };

  yield { type: 'status', message: 'AI가 비교하는 중…' };
  let history: { role: 'user' | 'assistant'; text: string }[] = [];
  let text = userText;
  let cost = 0;
  let model = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let doneText = '';
    for await (const ev of deps.runAi({ ...base, history, userText: text })) {
      if (ev.type === 'error') { yield ev; return; }
      if (ev.type === 'done') { doneText = ev.text; cost += ev.costUsd; model = ev.model; continue; }
      if (ev.type === 'text') continue; // 판정 카드만 보여 준다
      yield ev;
    }
    if (submitted) break;
    history = [...history, { role: 'user', text }, { role: 'assistant', text: doneText || '(응답 없음)' }];
    text = problem ? `제출이 거절되었습니다: ${problem}. submit_comparison으로 다시 제출하세요.` : '결과를 아직 제출하지 않았습니다. submit_comparison 도구로 결과를 제출하세요.';
  }
  const body = submitted as CompareBody | null;
  if (!body) {
    yield { type: 'error', code: 'provider', message: '비교 결과를 만들지 못했습니다' };
    return;
  }
  const createdAt = deps.now();
  const res = deps.db.sql.prepare('INSERT INTO comparisons (set_key, keys_json, horizon, provider, model, body_json, facts_json, names_json, created_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(setKey(args.keys), JSON.stringify(args.keys), args.horizon, args.provider, model, JSON.stringify(body), JSON.stringify(facts), JSON.stringify(names), createdAt, cost);
  const result: StoredCompare = { ...body, id: Number(res.lastInsertRowid), keys: args.keys, names, horizon: args.horizon, provider: args.provider, model, facts, createdAt, costUsd: cost };
  yield { type: 'compare', result, cached: false };
  yield { type: 'done', text: '', provider: args.provider, model, costUsd: cost };
}
