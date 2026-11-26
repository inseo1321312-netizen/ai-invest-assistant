import { describe, expect, test } from 'vitest';
import { EventEmitter } from 'node:events';
import { openDb } from '../../src/db.js';
import { createMarketService } from '../../src/market/service.js';
import { parseInstrumentKey, type Candle } from '../../src/market/types.js';
import { buildMarketTools, makeSubmitAnalysisTool, opinionChoices } from '../../src/features/tools.js';
import { badgeLookupFor, latestAnalyses, runTimingAnalysis, saveAnalysis } from '../../src/features/analysis.js';
import { explainPoint } from '../../src/features/explainPoint.js';
import { chatMessages, chatTurn } from '../../src/features/chat.js';
import { sendSse } from '../../src/sse.js';
import { fakeKis, fakeOkx } from '../market/fakes.js';
import { fakeRunAi, type FakeStep } from '../ai/fakeRunAi.js';
import { makeClock } from '../helpers.js';

const NOW = Date.UTC(2026, 10, 26, 0, 30); // KST 09:30
const NOW_SEC = NOW / 1000;
const H4 = 4 * 3600;

function candlesEnding(lastStart: number, n: number, step: number): Candle[] {
  return Array.from({ length: n }, (_, i) => ({ time: lastStart - (n - 1 - i) * step, open: 100 + i, high: 102 + i, low: 99 + i, close: 101 + i, volume: 10 + (i === n - 5 ? 90 : 0) }));
}

function setup(script: FakeStep[][]) {
  const db = openDb(':memory:');
  const clock = makeClock(NOW);
  // 마지막 4H 캔들은 아직 마감 전(시작 시각이 지금보다 1시간 전)
  const lastOpen = Math.floor(NOW_SEC / H4) * H4;
  const okx = fakeOkx({
    async getCandles(_id, bar, limit) {
      const step = bar === '4H' ? H4 : bar === '1D' ? 86400 : 3600;
      const last = bar === '4H' ? lastOpen : Math.floor(NOW_SEC / step) * step;
      return candlesEnding(last, limit, step);
    },
    async getQuote(instId) { return { instrument: parseInstrumentKey(`coin:${instId}`), price: 96000, changePct24h: -2, currency: 'USDT', time: NOW_SEC }; },
  });
  const market = createMarketService({ okx, kis: fakeKis(), db, now: clock.now, fx: async () => 1400 });
  const ai = fakeRunAi(script);
  return { deps: { db, market, runAi: ai.runAi, now: clock.now }, ai, db, lastOpen };
}

async function collect<T>(it: AsyncIterable<T>) {
  const out: T[] = [];
  for await (const e of it) out.push(e);
  return out;
}

const submit = (opinion: string): FakeStep => ({ tool: 'submit_analysis', input: {
  opinion, confidence: '중간', summary: '요약', reasons: ['20일선 아래'], risks: ['10배 레버리지'], news: [{ title: '뉴스', url: 'https://example.com/a', date: '2026-11-25' }],
} });

describe('opinion choices', () => {
  test('buy/hold/sell for spot and stocks, long/hold/short for swaps', () => {
    expect(opinionChoices(parseInstrumentKey('coin:BTC-USDT'))).toEqual(['매수', '관망', '매도']);
    expect(opinionChoices(parseInstrumentKey('kr:005930'))).toEqual(['매수', '관망', '매도']);
    expect(opinionChoices(parseInstrumentKey('coin:BTC-USDT-SWAP'))).toEqual(['롱 진입', '관망', '숏 진입']);
  });

  test('submit tool rejects opinion outside choices', () => {
    const tool = makeSubmitAnalysisTool(['매수', '관망'], () => {});
    const base = { confidence: '중간', summary: 's', reasons: ['r'], risks: ['k'], news: [] };
    expect(tool.schema.safeParse({ ...base, opinion: '매도' }).success).toBe(false);
    expect(tool.schema.safeParse({ ...base, opinion: '관망' }).success).toBe(true);
  });

  test('market tools emit chart event and return indicator json', async () => {
    const { deps } = setup([]);
    const tools = buildMarketTools(deps.market);
    expect(tools.map((t) => t.name)).toEqual(['get_candles', 'get_indicators', 'show_chart']);
    const emitted: unknown[] = [];
    const show = tools.find((t) => t.name === 'show_chart')!;
    await show.run({ key: 'coin:BTC-USDT', bar: '1D', from: null, to: null, markers: [] }, { emit: (e) => emitted.push(e) });
    expect(emitted).toEqual([{ type: 'chart', spec: { key: 'coin:BTC-USDT', bar: '1D', from: null, to: null, markers: [] } }]);
    const ind = JSON.parse(await tools.find((t) => t.name === 'get_indicators')!.run({ key: 'coin:BTC-USDT', bar: '1D' }, { emit() {} }));
    expect(ind).toHaveProperty('rsi14');
  });
});

describe('timing analysis', () => {
  test('uses last closed candle time as dataTime and saves analysis', async () => {
    const { deps, lastOpen } = setup([[{ text: '분석 중' }, submit('관망')]]);
    const ev = await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    const a = ev.find((e) => e.type === 'analysis') as { analysis: { dataTime: number; opinion: string; horizon: string; provider: string } };
    expect(a.analysis).toMatchObject({ opinion: '관망', horizon: 'swing', provider: 'claude', dataTime: lastOpen - H4 });
    expect(latestAnalyses(deps.db, 'coin:BTC-USDT-SWAP', 'swing')).toHaveLength(1);
  });

  test('cached analysis returned without calling AI', async () => {
    const { deps, ai } = setup([[submit('관망')], [submit('롱 진입')]]);
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    const ev = await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    expect(ai.calls()).toBe(1);
    expect(ev.find((e) => e.type === 'analysis')).toMatchObject({ analysis: { opinion: '관망' }, cached: true });
  });

  test('different provider is not served from the other provider cache', async () => {
    const { deps, ai } = setup([[submit('관망')], [submit('롱 진입')]]);
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'gpt', deep: false }));
    expect(ai.calls()).toBe(2);
    expect(latestAnalyses(deps.db, 'coin:BTC-USDT-SWAP', 'swing').map((a) => a.provider).sort()).toEqual(['claude', 'gpt']);
  });

  test('re-prompts once when submit missing, then errors', async () => {
    const { deps, ai } = setup([[{ text: '음' }], [{ text: '그래도' }]]);
    const ev = await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    expect(ai.calls()).toBe(2);
    expect(ai.requests[1]!.userText).toContain('submit_analysis');
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'provider', message: '분석 결과를 만들지 못했습니다' });
  });

  test('re-prompt succeeds on second try', async () => {
    const { deps } = setup([[{ text: '음' }], [submit('관망')]]);
    const ev = await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    expect(ev.some((e) => e.type === 'analysis')).toBe(true);
  });

  test('futures prompt offers long/hold/short and no holdings context', async () => {
    const { deps, ai } = setup([[submit('관망')]]);
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: true }));
    const r = ai.requests[0]!;
    expect(r.userText).toContain('롱 진입 / 관망 / 숏 진입');
    expect(r.userText).not.toContain('내 보유');
    expect(r.tier).toBe('deep');
    expect(r.webSearch).toEqual({ maxUses: 3 });
    expect(r.instructions).not.toMatch(/2026/); // 지시문에는 바뀌는 값(날짜)이 없다
  });

  test('badge lookup returns latest swing analysis per key', async () => {
    const { deps } = setup([[submit('관망')]]);
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'gpt', deep: false }));
    const b = badgeLookupFor(deps.db)(['coin:BTC-USDT-SWAP', 'coin:ETH-USDT']);
    expect(b.get('coin:BTC-USDT-SWAP')).toMatchObject({ opinion: '관망', confidence: '중간', provider: 'gpt' });
    expect(b.has('coin:ETH-USDT')).toBe(false);
  });

  test('AI error is forwarded and nothing saved', async () => {
    const db = openDb(':memory:');
    const market = createMarketService({ okx: fakeOkx(), kis: fakeKis(), db, now: () => NOW, fx: async () => null });
    async function* runAi() { yield { type: 'error' as const, code: 'budget' as const, message: '오늘 AI 사용 한도에 도달했습니다' }; }
    const ev = await collect(runTimingAnalysis({ db, market, runAi, now: () => NOW }, { key: 'coin:BTC-USDT', horizon: 'scalp', provider: 'claude', deep: false }));
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'budget', message: '오늘 AI 사용 한도에 도달했습니다' });
    expect(latestAnalyses(db, 'coin:BTC-USDT', 'scalp')).toEqual([]);
  });
});

describe('explain point', () => {
  test('explains clicked candle and reuses stored explanation', async () => {
    const { deps, ai } = setup([[{ text: '거래량이 급증했고 ' }, { text: '뉴스가 있었습니다' }]]);
    const t = Math.floor(NOW_SEC / 86400) * 86400 - 5 * 86400;
    const first = await collect(explainPoint(deps, { key: 'coin:BTC-USDT', bar: '1D', time: t, provider: 'claude' }));
    expect(first.find((e) => e.type === 'explanation')).toMatchObject({ text: '거래량이 급증했고 뉴스가 있었습니다' });
    expect(ai.requests[0]!.userText).toContain('2026-11-21');
    expect(ai.requests[0]!.webSearch).toEqual({ maxUses: 3 });
    const again = await collect(explainPoint(deps, { key: 'coin:BTC-USDT', bar: '1D', time: t, provider: 'claude' }));
    expect(ai.calls()).toBe(1);
    expect(again.find((e) => e.type === 'explanation')).toMatchObject({ cached: true });
  });

  test('unknown point → Korean error', async () => {
    const { deps } = setup([]);
    const ev = await collect(explainPoint(deps, { key: 'coin:BTC-USDT', bar: '1D', time: 12345, provider: 'claude' }));
    expect(ev.at(-1)).toEqual({ type: 'error', code: 'provider', message: '선택한 지점의 데이터를 찾지 못했습니다' });
  });
});

describe('chat', () => {
  test('persists both turns, emits chatId first, sends history next time', async () => {
    const { deps, ai } = setup([[{ text: '답1' }], [{ text: '답2' }]]);
    const ev1 = await collect(chatTurn(deps, { chatId: null, key: 'coin:BTC-USDT', provider: 'claude', text: '지금 살까?' }));
    expect(ev1[0]).toMatchObject({ type: 'chat' });
    const chatId = (ev1[0] as { chatId: number }).chatId;
    await collect(chatTurn(deps, { chatId, key: 'coin:BTC-USDT', provider: 'gpt', text: '그럼 언제?' }));
    expect(ai.requests[1]!.history).toEqual([{ role: 'user', text: '지금 살까?' }, { role: 'assistant', text: '답1' }]);
    expect(ai.requests[1]!.userText).toContain('coin:BTC-USDT');
    expect(chatMessages(deps.db, chatId).map((m) => [m.role, m.text, m.provider])).toEqual([
      ['user', '지금 살까?', null], ['assistant', '답1', 'claude'], ['user', '그럼 언제?', null], ['assistant', '답2', 'gpt'],
    ]);
  });

  test('show_chart in chat emits chart event', async () => {
    const { deps } = setup([[{ tool: 'show_chart', input: { key: 'coin:BTC-USDT', bar: '4H', from: null, to: null, markers: [] } }, { text: '보세요' }]]);
    const ev = await collect(chatTurn(deps, { chatId: null, key: null, provider: 'claude', text: '차트 보여줘' }));
    expect(ev.some((e) => e.type === 'chart')).toBe(true);
  });
});

describe('sse', () => {
  test('writes events and aborts on client disconnect', async () => {
    const raw = Object.assign(new EventEmitter(), {
      chunks: [] as string[], headers: {} as Record<string, unknown>,
      writeHead(_s: number, h: Record<string, unknown>) { this.headers = h; return this; },
      write(c: string) { this.chunks.push(c); return true; },
      end() { this.ended = true; }, ended: false,
    });
    const reply = { raw, hijack() {} } as never;
    const abort = new AbortController();
    async function* events() {
      yield { type: 'text', delta: 'a' };
      raw.emit('close');
      await new Promise((r) => setTimeout(r, 1));
      yield { type: 'text', delta: 'b' };
    }
    await sendSse(reply, events(), abort);
    expect(abort.signal.aborted).toBe(true);
    expect(raw.chunks[0]).toBe('event: text\ndata: {"type":"text","delta":"a"}\n\n');
    expect(raw.headers['content-type']).toMatch(/text\/event-stream/);
    expect(raw.ended).toBe(true);
  });
});

describe('review fixes', () => {
  test('aborted explanation (no done) is not cached', async () => {
    const db = openDb(':memory:');
    const t = Math.floor(NOW_SEC / 86400) * 86400 - 5 * 86400;
    const okx = fakeOkx({ async getCandles(_id, _bar, limit) { return candlesEnding(Math.floor(NOW_SEC / 86400) * 86400, limit, 86400); } });
    const market = createMarketService({ okx, kis: fakeKis(), db, now: () => NOW, fx: async () => 1 });
    let calls = 0;
    async function* silent() { calls++; yield { type: 'text' as const, delta: '부분' }; }
    const deps = { db, market, runAi: silent, now: () => NOW };
    await collect(explainPoint(deps, { key: 'coin:BTC-USDT', bar: '1D', time: t, provider: 'claude' }));
    await collect(explainPoint(deps, { key: 'coin:BTC-USDT', bar: '1D', time: t, provider: 'claude' }));
    expect(calls).toBe(2);
  });

  test('deep analysis is not served from a standard-tier cache', async () => {
    const { deps, ai } = setup([[submit('관망')], [submit('롱 진입')]]);
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    const ev = await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: true }));
    expect(ai.calls()).toBe(2);
    expect(ev.find((e) => e.type === 'analysis')).toMatchObject({ cached: false, analysis: { opinion: '롱 진입' } });
  });

  test('briefing-origin analysis is not served for an explicit request', async () => {
    const { deps, ai, lastOpen } = setup([[submit('관망')]]);
    saveAnalysis(deps.db, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', model: 'm', dataTime: lastOpen - H4, createdAt: NOW, costUsd: 0,
      opinion: '롱 진입', confidence: '낮음', summary: '브리핑', reasons: ['r'], risks: ['k'], news: [], origin: 'briefing', tier: 'standard' });
    await collect(runTimingAnalysis(deps, { key: 'coin:BTC-USDT-SWAP', horizon: 'swing', provider: 'claude', deep: false }));
    expect(ai.calls()).toBe(1);
  });

  test('news links that are not http(s) are dropped', async () => {
    let got: { news: { url: string }[] } | null = null;
    const tool = makeSubmitAnalysisTool(['관망'], (a) => { got = a; });
    await tool.run({ opinion: '관망', confidence: '중간', summary: 's', reasons: ['r'], risks: ['k'], news: [
      { title: 'ok', url: 'https://a.example/x', date: null }, { title: 'bad', url: 'javascript:alert(1)', date: null },
    ] } as never, { emit() {} });
    expect(got!.news.map((n) => n.url)).toEqual(['https://a.example/x']);
  });
});
