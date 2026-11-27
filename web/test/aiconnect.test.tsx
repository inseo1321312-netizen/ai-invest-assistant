import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SettingsView } from '../src/components/SettingsView';
import { mockServer } from './fakeServer';

afterEach(() => vi.unstubAllGlobals());

const NONE = { set: false, source: null, tail: null };
const base = {
  models: { claude: { light: 'a', standard: 'b', deep: 'c' }, gpt: { light: 'd', standard: 'e', deep: 'f' } },
  gptMode: 'siwc', budget: { scheduledDailyUsd: 1.5, interactiveDailyUsd: 3, monthlyUsd: 80, gptMonthlyUsd: 5 },
  keys: { claude: false, openai: false, kis: false, push: true },
  apiKeys: { claude: NONE, openai: NONE },
};
const CLAUDE_KEY = 'sk-ant-' + 'a1'.repeat(12) + 'WXYZ';

function server(over: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    '/api/settings': () => base,
    '/api/usage': () => ({ today: { interactive: 0, scheduled: 0 }, month: 0, gptMonth: 0, requests: { gpt5h: 0, gptToday: 0 } }),
    '/api/admin/siwc-status': () => ({ connected: false, expiresAt: null }),
    '/api/alerts': () => ({ coins: [], settings: { m5: 2, m15: 3, h1: 5, events: true } }),
    ...over,
  });
}

async function picker() {
  return screen.findByRole('tablist', { name: 'AI 연결' });
}

test('one AI picker; Claude API asks for the key in a password box and shows only its last 4 characters after connecting', async () => {
  const s = server({ 'PUT /api/settings/api-key': () => ({ ...base, keys: { ...base.keys, claude: true }, apiKeys: { ...base.apiKeys, claude: { set: true, source: 'app', tail: 'WXYZ' } } }) });
  render(<SettingsView />);
  const tabs = await picker();
  expect(within(tabs).getAllByRole('tab').map((t) => t.textContent)).toEqual(['Claude API', 'ChatGPT 구독', 'ChatGPT API']);
  await userEvent.click(within(tabs).getByRole('tab', { name: 'Claude API' }));
  const box = screen.getByLabelText('Claude API 키') as HTMLInputElement;
  expect(box.type).toBe('password');
  await userEvent.type(box, CLAUDE_KEY);
  await userEvent.click(screen.getByRole('button', { name: '연결' }));
  await waitFor(() => expect(s.calls.find((c) => c.url.pathname === '/api/settings/api-key')?.body).toEqual({ provider: 'claude', key: CLAUDE_KEY }));
  expect(await screen.findByText(/연결됨 · 키 …WXYZ/)).toBeTruthy();
  expect((screen.getByLabelText('Claude API 키') as HTMLInputElement).value).toBe('');
  expect(document.body.textContent).not.toContain(CLAUDE_KEY);
});

test('ChatGPT 구독 shows the ChatGPT login and no key box', async () => {
  server();
  render(<SettingsView />);
  await userEvent.click(within(await picker()).getByRole('tab', { name: 'ChatGPT 구독' }));
  expect(screen.getByRole('button', { name: 'ChatGPT 연결' })).toBeTruthy();
  expect(screen.queryByLabelText(/API 키/)).toBeNull();
});

test('ChatGPT API: after connecting it is the method GPT uses', async () => {
  server({ 'PUT /api/settings/api-key': () => ({ ...base, gptMode: 'apikey', keys: { ...base.keys, openai: true }, apiKeys: { ...base.apiKeys, openai: { set: true, source: 'app', tail: 'QRST' } } }) });
  render(<SettingsView />);
  await userEvent.click(within(await picker()).getByRole('tab', { name: 'ChatGPT API' }));
  await userEvent.type(screen.getByLabelText('ChatGPT API 키'), 'sk-' + 'b2'.repeat(14) + 'QRST');
  await userEvent.click(screen.getByRole('button', { name: '연결' }));
  expect(await screen.findByText('GPT는 이 방식으로 써요')).toBeTruthy();
});

test('a refused key shows the reason', async () => {
  server({ 'PUT /api/settings/api-key': () => new Response(JSON.stringify({ error: '키가 맞지 않아요. Claude API 키를 다시 확인해 주세요' }), { status: 400 }) });
  render(<SettingsView />);
  await userEvent.click(within(await picker()).getByRole('tab', { name: 'Claude API' }));
  await userEvent.type(screen.getByLabelText('Claude API 키'), CLAUDE_KEY);
  await userEvent.click(screen.getByRole('button', { name: '연결' }));
  expect((await screen.findByRole('alert')).textContent).toContain('키가 맞지 않아요');
});

test('settings carries no filler explanations', async () => {
  server();
  render(<SettingsView />);
  await picker();
  const text = document.body.textContent ?? '';
  for (const filler of ['키 없이', '종량제', 'PC로 연결', 'npm run', '한국식', '보기 전용', '거래소·증권사', '그대로면', '구독에 포함', '알림 키']) {
    expect(text).not.toContain(filler);
  }
});
