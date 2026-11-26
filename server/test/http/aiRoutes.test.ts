import { expect, test } from 'vitest';
import { buildApp } from '../../src/app.js';
import { loginCookie, testDeps } from '../helpers.js';
import { fakeRunAi } from '../ai/fakeRunAi.js';
import { saveAnalysis } from '../../src/features/analysis.js';

function parseSse(body: string) {
  return body.split('\n\n').filter((b) => b.startsWith('event:')).map((b) => JSON.parse(b.split('\ndata: ')[1]!));
}

test('chat route streams SSE events and requires login', async () => {
  const deps = testDeps();
  deps.runAi = fakeRunAi([[{ text: '안녕하세요' }]]).runAi;
  const app = await buildApp(deps);
  expect((await app.inject({ method: 'POST', url: '/api/chat', payload: { chatId: null, key: null, provider: 'claude', text: 'hi' } })).statusCode).toBe(401);
  const cookie = await loginCookie(app);
  const res = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { chatId: null, key: null, provider: 'claude', text: 'hi' } });
  expect(res.headers['content-type']).toMatch(/text\/event-stream/);
  const events = parseSse(res.body);
  expect(events.map((e) => e.type)).toEqual(['chat', 'text', 'done']);
  const chats = (await app.inject({ method: 'GET', url: '/api/chats', headers: { cookie } })).json();
  expect(chats.chats).toHaveLength(1);
  const msgs = (await app.inject({ method: 'GET', url: `/api/chats/${events[0].chatId}/messages`, headers: { cookie } })).json();
  expect(msgs.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant']);
});

test('analysis route validates body', async () => {
  const deps = testDeps();
  deps.runAi = fakeRunAi([]).runAi;
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const bad = await app.inject({ method: 'POST', url: '/api/analysis', headers: { cookie }, payload: { key: 'coin:BTC-USDT', horizon: 'forever', provider: 'claude', deep: false } });
  expect(bad.statusCode).toBe(400);
  const latest = await app.inject({ method: 'GET', url: '/api/analysis/latest?key=coin:BTC-USDT&horizon=swing', headers: { cookie } });
  expect(latest.json()).toEqual({ analyses: [] });
});

test('models endpoint lists provider models and current defaults', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const res = (await app.inject({ method: 'GET', url: '/api/ai/models', headers: { cookie } })).json();
  expect(res.lists.gpt.map((m: { id: string }) => m.id)).toContain('gpt-6-luna');
  expect(res.defaults.claude.standard).toBe('claude-sonnet-5-5');
});

test('chat passes chosen model to the AI and rejects unknown models', async () => {
  const deps = testDeps();
  const ai = fakeRunAi([[{ text: '네' }]]);
  deps.runAi = ai.runAi;
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const bad = await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { chatId: null, key: null, provider: 'gpt', model: 'gpt-nope', text: 'hi' } });
  expect(bad.statusCode).toBe(400);
  expect(bad.json()).toEqual({ error: '고를 수 없는 모델입니다' });
  await app.inject({ method: 'POST', url: '/api/chat', headers: { cookie }, payload: { chatId: null, key: null, provider: 'gpt', model: 'gpt-6.2-sol', text: 'hi' } });
  expect(ai.requests[0]!.model).toBe('gpt-6.2-sol');
});

test('analysis history lists past opinions for one instrument, newest first', async () => {
  const deps = testDeps();
  const app = await buildApp(deps);
  const cookie = await loginCookie(app);
  const base = { key: 'coin:BTC-USDT', model: 'm', costUsd: 0, origin: 'user' as const, tier: 'standard' as const, summary: '', reasons: [], risks: [], news: [] };
  saveAnalysis(deps.db, { ...base, horizon: 'swing', provider: 'claude', dataTime: 100, createdAt: 1000, opinion: '관망', confidence: '중간' });
  saveAnalysis(deps.db, { ...base, horizon: 'long', provider: 'gpt', dataTime: 200, createdAt: 2000, opinion: '매수', confidence: '높음' });
  saveAnalysis(deps.db, { ...base, key: 'coin:ETH-USDT', horizon: 'swing', provider: 'claude', dataTime: 300, createdAt: 3000, opinion: '매도', confidence: '낮음' });
  const res = (await app.inject({ method: 'GET', url: '/api/analysis/history?key=coin:BTC-USDT', headers: { cookie } })).json();
  expect(res.items.map((i: { opinion: string }) => i.opinion)).toEqual(['매수', '관망']);
  expect(res.items[0]).toMatchObject({ provider: 'gpt', horizon: 'long', confidence: '높음', dataTime: 200 });
  expect((await app.inject({ method: 'GET', url: '/api/analysis/history?key=nope', headers: { cookie } })).statusCode).toBe(400);
});
