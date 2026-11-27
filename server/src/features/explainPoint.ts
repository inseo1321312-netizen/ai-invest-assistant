import * as prompts from '../ai/prompts.js';
import type { AiEvent, ProviderId } from '../ai/types.js';
import type { Bar } from '../market/types.js';
import { parseInstrumentKey } from '../market/types.js';
import { type FeatureDeps, fmtNum, kstDateTime } from './deps.js';
import { candlesCsv } from './tools.js';

export type ExplainEvent = AiEvent | { type: 'explanation'; text: string; cached: boolean };

/**
 * 차트에서 고른 곳이 왜 움직였는지 설명한다.
 * time만 있으면 캔들 하나, to도 있으면 time~to 구간(끌어서 고른 범위)을 한 덩어리로 본다.
 */
export async function* explainPoint(deps: FeatureDeps, args: { key: string; bar: Bar; time: number; to?: number | null; provider: ProviderId }): AsyncIterable<ExplainEvent> {
  const { db } = deps;
  const range = args.to && args.to > args.time ? args.to : null;
  // 구간 설명은 bar 칸에 끝 시각을 붙여 한 점 설명과 따로 기억한다
  const cacheBar = range ? `${args.bar}~${range}` : args.bar;
  const hit = db.sql.prepare('SELECT text FROM point_explanations WHERE key = ? AND bar = ? AND time = ? AND provider = ?').get(args.key, cacheBar, args.time, args.provider) as { text: string } | undefined;
  if (hit) {
    yield { type: 'explanation', text: hit.text, cached: true };
    return;
  }
  const inst = parseInstrumentKey(args.key);
  const candles = await deps.market.getCandles(inst, args.bar, 300).catch(() => []);
  const idx = candles.findIndex((c) => c.time === args.time);
  const endIdx = range ? candles.findIndex((c) => c.time === range) : idx;
  if (idx < 0 || endIdx < 0) {
    yield { type: 'error', code: 'provider', message: '선택한 지점의 데이터를 찾지 못했습니다' };
    return;
  }
  const c = candles[idx]!;
  const end = candles[endIdx]!;
  const inside = candles.slice(idx, endIdx + 1);
  const before = candles.slice(Math.max(0, idx - 20), idx);
  const after = candles.slice(endIdx + 1, endIdx + 11);
  const avgVol = before.length ? before.reduce((s, x) => s + x.volume, 0) / before.length : null;
  const prevClose = before.at(-1)?.close ?? c.open;
  const head = `종목: ${args.key}${inst.name ? ` (${inst.name})` : ''}, 캔들 단위 ${args.bar}`;
  const userText = range
    ? [
      head,
      `고른 구간: ${kstDateTime(c.time)} ~ ${kstDateTime(end.time)} (한국 시간, 캔들 ${inside.length}개)`,
      `구간 등락 ${(((end.close - prevClose) / prevClose) * 100).toFixed(2)}% (시작 직전 종가 ${fmtNum(prevClose)} → 끝 종가 ${fmtNum(end.close)}), 구간 최고 ${fmtNum(Math.max(...inside.map((x) => x.high)))}, 최저 ${fmtNum(Math.min(...inside.map((x) => x.low)))}`,
      `구간 평균 거래량: ${fmtNum(inside.reduce((s, x) => s + x.volume, 0) / inside.length)}${avgVol ? ` (직전 ${before.length}개 평균의 ${(inside.reduce((s, x) => s + x.volume, 0) / inside.length / avgVol).toFixed(1)}배)` : ''}`,
      `앞 ${before.length}개, 구간, 뒤 ${after.length}개 캔들:\n${candlesCsv([...before, ...inside, ...after])}`,
      '이 구간 동안 가격이 왜 이렇게 움직였는지, 그 기간의 뉴스를 찾아 흐름대로 설명해 주세요.',
    ].join('\n\n')
    : [
      head,
      `누른 지점: ${kstDateTime(c.time)} (한국 시간)`,
      `그 캔들: 시가 ${fmtNum(c.open)}, 고가 ${fmtNum(c.high)}, 저가 ${fmtNum(c.low)}, 종가 ${fmtNum(c.close)}, 직전 종가 대비 ${(((c.close - prevClose) / prevClose) * 100).toFixed(2)}%`,
      `거래량: ${fmtNum(c.volume)}${avgVol ? ` (직전 ${before.length}개 평균의 ${(c.volume / avgVol).toFixed(1)}배)` : ''}`,
      `앞 ${before.length}개와 뒤 ${after.length}개 캔들:\n${candlesCsv([...before, c, ...after])}`,
      '이 지점에서 가격이 왜 이렇게 움직였는지, 그 날짜 전후 뉴스를 찾아 설명해 주세요.',
    ].join('\n\n');

  let text = '';
  let finished = false;
  for await (const ev of deps.runAi({
    provider: args.provider, tier: 'standard', purpose: 'interactive', instructions: prompts.EXPLAIN,
    history: [], userText, tools: [], webSearch: { maxUses: 3 },
  })) {
    if (ev.type === 'error') { yield ev; return; }
    if (ev.type === 'done') { text = ev.text; finished = true; yield ev; continue; }
    yield ev;
  }
  if (!finished || !text.trim()) return; // 중간에 끊긴 설명은 저장하지 않는다
  db.sql.prepare('INSERT OR REPLACE INTO point_explanations (key, bar, time, provider, text, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(args.key, cacheBar, args.time, args.provider, text, deps.now());
  yield { type: 'explanation', text, cached: false };
}
