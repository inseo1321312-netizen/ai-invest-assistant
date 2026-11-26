import type { Db } from '../db.js';
import * as prompts from '../ai/prompts.js';
import type { AiEvent, ProviderId } from '../ai/types.js';
import type { Badge, BadgeLookup } from '../http/marketRoutes.js';
import { summarizeIndicators } from '../market/indicators.js';
import type { Candle, Holding, Horizon, Instrument } from '../market/types.js';
import { BAR_SECONDS, HORIZON_LABEL, horizonBars, instrumentKey, parseInstrumentKey } from '../market/types.js';
import { type FeatureDeps, fmtNum, kstDateTime } from './deps.js';
import { buildMarketTools, candlesCsv, makeSubmitAnalysisTool, opinionChoices, type AnalysisBody } from './tools.js';

export interface StoredAnalysis extends AnalysisBody {
  id: number;
  key: string;
  horizon: Horizon;
  provider: ProviderId;
  model: string;
  dataTime: number;
  createdAt: number;
  costUsd: number;
  /** user: 사용자가 요청한 분석, briefing: 아침 브리핑이 만든 요약, unverified: 보유 정보를 확인하지 못한 분석 */
  origin: 'user' | 'briefing' | 'unverified';
  tier: 'standard' | 'deep';
}

export type AnalysisEvent = AiEvent | { type: 'analysis'; analysis: StoredAnalysis; cached: boolean };

const HORIZON_TEXT: Record<Horizon, string> = { scalp: '단타(하루 안)', swing: '스윙(며칠~몇 주)', long: '장기(몇 달 이상)' };

interface Row { id: number; key: string; horizon: string; provider: string; model: string; data_time: number; created_at: number; body_json: string; cost_usd: number; origin: string; tier: string }

function fromRow(r: Row): StoredAnalysis {
  return {
    ...(JSON.parse(r.body_json) as AnalysisBody), id: r.id, key: r.key, horizon: r.horizon as Horizon, provider: r.provider as ProviderId,
    model: r.model, dataTime: r.data_time, createdAt: r.created_at, costUsd: r.cost_usd,
    origin: r.origin as StoredAnalysis['origin'], tier: r.tier as StoredAnalysis['tier'],
  };
}

export function saveAnalysis(db: Db, a: Omit<StoredAnalysis, 'id'>): StoredAnalysis {
  const { key, horizon, provider, model, dataTime, createdAt, costUsd, origin, tier, ...body } = a;
  const res = db.sql.prepare('INSERT INTO analyses (key, horizon, provider, model, data_time, created_at, body_json, cost_usd, origin, tier) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, horizon, provider, model, dataTime, createdAt, JSON.stringify(body), costUsd, origin, tier);
  return { ...a, id: Number(res.lastInsertRowid) };
}

/** 사용자가 요청해 만든, 같은 깊이(tier)의 분석만 다시 쓴다. 브리핑 요약이나 보유 확인 실패 분석은 쓰지 않는다. */
function findCached(db: Db, key: string, horizon: Horizon, provider: ProviderId, dataTime: number, tier: StoredAnalysis['tier']): StoredAnalysis | null {
  const r = db.sql.prepare("SELECT * FROM analyses WHERE key = ? AND horizon = ? AND provider = ? AND data_time = ? AND tier = ? AND origin = 'user' ORDER BY id DESC LIMIT 1")
    .get(key, horizon, provider, dataTime, tier) as Row | undefined;
  return r ? fromRow(r) : null;
}

/** 공급자별 최신 분석 1개씩 */
export function latestAnalyses(db: Db, key: string, horizon: Horizon): StoredAnalysis[] {
  const rows = db.sql.prepare(`SELECT a.* FROM analyses a JOIN (SELECT provider, MAX(id) AS id FROM analyses WHERE key = ? AND horizon = ? GROUP BY provider) m ON a.id = m.id ORDER BY a.provider`).all(key, horizon) as unknown as Row[];
  return rows.map(fromRow);
}

export interface HistoryItem { id: number; horizon: Horizon; provider: ProviderId; opinion: string; confidence: string; dataTime: number; createdAt: number; tier: string; origin: string }

/** 한 종목의 지난 AI 의견(기간·공급자 상관없이), 최신 순 */
export function analysisHistory(db: Db, key: string, limit = 12): HistoryItem[] {
  const rows = db.sql.prepare('SELECT * FROM analyses WHERE key = ? ORDER BY created_at DESC, id DESC LIMIT ?').all(key, limit) as unknown as Row[];
  return rows.map((r) => {
    const a = fromRow(r);
    return { id: a.id, horizon: a.horizon, provider: a.provider, opinion: a.opinion, confidence: a.confidence, dataTime: a.dataTime, createdAt: a.createdAt, tier: a.tier, origin: a.origin };
  });
}

/** 종목별 최신 스윙 분석 → 목록 배지 */
export function badgeLookupFor(db: Db): BadgeLookup {
  const stmt = db.sql.prepare("SELECT * FROM analyses WHERE key = ? AND horizon = 'swing' ORDER BY id DESC LIMIT 1");
  return (keys) => {
    const out = new Map<string, Badge>();
    for (const k of new Set(keys)) {
      const r = stmt.get(k) as Row | undefined;
      if (!r) continue;
      const a = fromRow(r);
      out.set(k, { opinion: a.opinion, confidence: a.confidence, dataTime: a.dataTime, provider: a.provider });
    }
    return out;
  };
}

/** 마지막 "마감된" 캔들의 시작 시각. 마감된 게 없으면 마지막 캔들 시각. */
export function lastClosedTime(candles: Candle[], barSeconds: number, nowSec: number): number | null {
  for (let i = candles.length - 1; i >= 0; i--) {
    if (candles[i]!.time + barSeconds <= nowSec) return candles[i]!.time;
  }
  return candles.at(-1)?.time ?? null;
}

export function holdingContext(h: Holding | null, price: number | null): string {
  if (!h) return '내 보유: 없음';
  const lines = [`내 보유: ${h.side ? (h.side === 'long' ? '롱' : '숏') + ' 포지션' : '현물'} 수량 ${fmtNum(h.quantity)}, 평균 단가 ${fmtNum(h.avgPrice)} ${h.currency}`];
  if (price !== null && h.avgPrice) {
    const pct = ((price - h.avgPrice) / h.avgPrice) * 100 * (h.side === 'short' ? -1 : 1);
    lines.push(`평균 단가 대비 손익(가격 기준): ${pct >= 0 ? '+' : ''}${pct.toFixed(2)}%`);
  }
  if (h.leverage) lines.push(`레버리지 ${fmtNum(h.leverage)}배`);
  if (h.liqPrice) {
    const ref = price ?? h.markPrice;
    const dist = ref ? (Math.abs(ref - h.liqPrice) / ref) * 100 : null;
    lines.push(`청산가 ${fmtNum(h.liqPrice)}${dist !== null ? ` (현재가에서 ${dist.toFixed(2)}% 거리)` : ''}`);
  }
  if (h.side) lines.push(`펀딩비 ${h.fundingRate === null ? '알 수 없음' : `${(h.fundingRate * 100).toFixed(4)}% (8시간 기준)`}`);
  return lines.join('\n');
}

/** known=false면 거래소·증권사 보유 조회가 실패해서 보유 여부를 모른다는 뜻 */
export async function findHolding(deps: FeatureDeps, inst: Instrument): Promise<{ holding: Holding | null; known: boolean }> {
  const key = instrumentKey(inst);
  try {
    const hs = await deps.market.getHoldings(inst.market);
    return { holding: hs.find((h) => instrumentKey(h.instrument) === key) ?? null, known: true };
  } catch {
    const manual = deps.market.getManualHoldings(inst.market).find((h) => instrumentKey(h.instrument) === key) ?? null;
    return { holding: manual, known: false };
  }
}

export async function* runTimingAnalysis(
  deps: FeatureDeps,
  args: { key: string; horizon: Horizon; provider: ProviderId; deep: boolean },
): AsyncIterable<AnalysisEvent> {
  const inst = parseInstrumentKey(args.key);
  const bars = horizonBars(inst.market, args.horizon);
  yield { type: 'status', message: '차트 데이터를 불러오는 중…' };
  let primary: Candle[];
  let secondary: Candle[];
  try {
    [primary, secondary] = await Promise.all([
      deps.market.getCandles(inst, bars.primary, bars.primaryLimit),
      deps.market.getCandles(inst, bars.secondary, bars.secondaryLimit),
    ]);
  } catch {
    yield { type: 'error', code: 'provider', message: '차트 데이터를 가져오지 못했습니다' };
    return;
  }
  const nowSec = Math.floor(deps.now() / 1000);
  const dataTime = lastClosedTime(primary, BAR_SECONDS[bars.primary], nowSec);
  if (dataTime === null) {
    yield { type: 'error', code: 'provider', message: '분석할 차트 데이터가 없습니다' };
    return;
  }
  const tier = args.deep ? 'deep' as const : 'standard' as const;
  const cached = findCached(deps.db, args.key, args.horizon, args.provider, dataTime, tier);
  if (cached) {
    yield { type: 'analysis', analysis: cached, cached: true };
    return;
  }

  const { holding, known: holdingKnown } = await findHolding(deps, inst);
  const quote = await deps.market.getQuote(inst).catch(() => null);
  const choices = opinionChoices(holding, inst);
  const userText = [
    `종목: ${args.key}${inst.name ? ` (${inst.name})` : ''}`,
    `분석 기간: ${HORIZON_TEXT[args.horizon]}`,
    `데이터 기준 시각: ${kstDateTime(dataTime)} (한국 시간, 마지막 마감 캔들)`,
    `현재가: ${quote ? `${fmtNum(quote.price)} ${quote.currency} (24시간 ${quote.changePct24h.toFixed(2)}%)` : '알 수 없음'}`,
    holdingKnown ? holdingContext(holding, quote?.price ?? null) : `${holdingContext(holding, quote?.price ?? null)}\n(주의: 거래소·증권사 보유 정보를 확인하지 못했습니다. 보유 여부가 확실하지 않다고 답변에 밝혀 주세요.)`,
    `[주 차트 ${bars.primary}] 지표 요약: ${JSON.stringify(summarizeIndicators(primary))}`,
    `[보조 차트 ${bars.secondary}] 지표 요약: ${JSON.stringify(summarizeIndicators(secondary))}`,
    `[주 차트 ${bars.primary}] 최근 캔들 30개:\n${candlesCsv(primary.slice(-30))}`,
    `고를 수 있는 의견: ${choices.join(' / ')}`,
  ].join('\n\n');

  let submitted: AnalysisBody | null = null;
  const tools = [...buildMarketTools(deps.market), makeSubmitAnalysisTool(choices, (a) => { submitted = a; })];
  const base = {
    provider: args.provider, tier, purpose: 'interactive' as const,
    instructions: prompts.ANALYSIS, tools, webSearch: { maxUses: 3 },
  };

  let history: { role: 'user' | 'assistant'; text: string }[] = [];
  let text = userText;
  let cost = 0;
  let model = '';
  for (let attempt = 0; attempt < 2; attempt++) {
    let doneText = '';
    for await (const ev of deps.runAi({ ...base, history, userText: text })) {
      if (ev.type === 'error') { yield ev; return; }
      if (ev.type === 'done') { doneText = ev.text; cost += ev.costUsd; model = ev.model; continue; }
      yield ev;
    }
    if (submitted) break;
    history = [...history, { role: 'user', text }, { role: 'assistant', text: doneText || '(응답 없음)' }];
    text = '결과를 아직 제출하지 않았습니다. submit_analysis 도구로 결과를 제출하세요.';
  }
  if (!submitted) {
    yield { type: 'error', code: 'provider', message: '분석 결과를 만들지 못했습니다' };
    return;
  }
  const saved = saveAnalysis(deps.db, {
    ...(submitted as AnalysisBody), key: args.key, horizon: args.horizon, provider: args.provider, model, dataTime, createdAt: deps.now(), costUsd: cost,
    origin: holdingKnown ? 'user' : 'unverified', tier,
  });
  yield { type: 'analysis', analysis: saved, cached: false };
  yield { type: 'done', text: '', provider: args.provider, model, costUsd: cost };
}

export { HORIZON_LABEL };
