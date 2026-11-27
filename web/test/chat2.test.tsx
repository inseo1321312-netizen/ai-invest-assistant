import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatView } from '../src/components/ChatView';
import { ExplainSheet } from '../src/components/InstrumentView';
import { resetAiReady } from '../src/aiReady';
import { mockServer, sseResponse } from './fakeServer';

beforeEach(() => resetAiReady());
afterEach(() => vi.unstubAllGlobals());

const MODELS = {
  lists: {
    claude: [{ id: 'claude-sonnet-5-5', label: 'Claude Sonnet 5.5' }],
    gpt: [{ id: 'gpt-6.1-sol', label: 'GPT-6.1 Sol' }, { id: 'gpt-6.1-terra', label: 'GPT-6.1 Terra' }],
  },
  defaults: { claude: { light: 'a', standard: 'claude-sonnet-5-5', deep: 'c' }, gpt: { light: 'x', standard: 'gpt-6.1-sol', deep: 'z' } },
};
const USAGE = { today: { interactive: 0.75, scheduled: 0 }, month: 1, gptMonth: 0, limits: { interactiveDailyUsd: 3, scheduledDailyUsd: 1.5, monthlyUsd: 80 }, requests: { gpt5h: 10, gptToday: 12, claudeToday: 0 }, gptLimitHitAt: null, gptWindow: { usedPct: 37, windowMinutes: 300, resetAt: Date.now() + 3600_000, at: Date.now() } };

function chatServer(over: Record<string, Parameters<typeof mockServer>[0][string]> = {}) {
  return mockServer({
    '/api/ai/models': () => MODELS,
    '/api/usage': () => USAGE,
    '/api/ai/ready': () => ({ claude: false, gpt: true, preferred: 'gpt' }),
    '/api/chats': () => ({ chats: [{ id: 7, key: null, title: '삼성 얘기', createdAt: Date.now() - 2 * 86400_000 }, { id: 5, key: null, title: '비트 얘기', createdAt: Date.now() - 3 * 86400_000 }] }),
    '/api/chats/7/messages': () => ({ messages: [{ id: 1, role: 'user', text: '삼성 어때', provider: null }, { id: 2, role: 'assistant', text: '좋아요', provider: 'gpt' }] }),
    'DELETE /api/chats/5': () => ({ ok: true }),
    '/api/chat': () => new Promise(() => {}),
    ...over,
  });
}

test('without a Claude key the chat starts with GPT, and while thinking it names the model you picked', async () => {
  localStorage.setItem('chat.pref', JSON.stringify({ provider: 'gpt', model: { claude: null, gpt: 'gpt-6.1-terra' } }));
  chatServer();
  render(<ChatView keyId={null} />);
  await screen.findByRole('button', { name: 'AI 모델 선택' });
  await userEvent.type(screen.getByLabelText('메시지'), '안녕');
  await userEvent.click(screen.getByRole('button', { name: '보내기' }));
  expect(await screen.findByText('GPT-6.1 Terra', { selector: '.msg-who' })).toBeTruthy();
});

test('no saved choice and no Claude key: GPT is picked first', async () => {
  chatServer();
  render(<ChatView keyId={null} />);
  await waitFor(() => expect(screen.getByRole('button', { name: 'AI 모델 선택' }).textContent).toContain('GPT-6.1 Sol'));
});

test('the menu slides out the conversation list; open, delete, and start a new one', async () => {
  const s = chatServer();
  render(<ChatView keyId={null} />);
  await userEvent.click(await screen.findByRole('button', { name: '대화 목록' }));
  const drawer = await screen.findByRole('dialog', { name: '대화 목록' });
  expect(within(drawer).getByText('삼성 얘기')).toBeTruthy();
  await userEvent.click(within(drawer).getByRole('button', { name: '비트 얘기 지우기' }));
  await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.url.pathname === '/api/chats/5')).toBe(true));
  expect(within(drawer).queryByText('비트 얘기')).toBeNull();
  await userEvent.click(within(drawer).getByRole('button', { name: /^삼성 얘기.*전$/ }));
  expect(await screen.findByText('좋아요')).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole('dialog', { name: '대화 목록' })).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: '새 대화' }));
  expect(screen.queryByText('좋아요')).toBeNull();
});

test('thinking depth is chosen next to the message box and sent with it', async () => {
  const s = chatServer();
  render(<ChatView keyId={null} />);
  await userEvent.click(await screen.findByRole('radio', { name: '깊게' }));
  await userEvent.type(screen.getByLabelText('메시지'), '분석해 줘');
  await userEvent.click(screen.getByRole('button', { name: '보내기' }));
  await waitFor(() => expect(s.calls.find((c) => c.url.pathname === '/api/chat')?.body).toMatchObject({ depth: 'deep', provider: 'gpt' }));
});

test('ChatGPT subscription usage shows the real 5-hour percent as a ring', async () => {
  chatServer();
  render(<ChatView keyId={null} />);
  const pill = await screen.findByRole('button', { name: /사용량/ });
  await waitFor(() => expect(pill.querySelector('svg circle.ring-fill')).not.toBeNull());
  await waitFor(() => expect(pill.textContent).toContain('37%'));
});

test('without a real number it never guesses: 여유, or 한도 right after hitting the limit', async () => {
  chatServer({ '/api/usage': () => ({ ...USAGE, gptWindow: null }) });
  const first = render(<ChatView keyId={null} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /사용량/ }).textContent).toContain('여유'));
  expect(screen.getByRole('button', { name: /사용량/ }).textContent).not.toMatch(/d+%/);
  first.unmount();
  chatServer({ '/api/usage': () => ({ ...USAGE, gptWindow: null, gptLimitHitAt: Date.now() - 600_000 }) });
  render(<ChatView keyId={null} />);
  await waitFor(() => expect(screen.getByRole('button', { name: /사용량/ }).textContent).toContain('한도'));
});

test('explaining a dragged stretch asks GPT first when there is no Claude key, with both ends', async () => {
  const s = mockServer({
    '/api/ai/ready': () => ({ claude: false, gpt: true, preferred: 'gpt' }),
    '/api/explain-point': () => sseResponse([{ type: 'explanation', text: '설명', cached: false }]),
    '/api/news': () => ({ items: [] }),
  });
  render(<ExplainSheet keyId="kr:005930" bar="1D" time={1000} to={2000} pct={4.2} onClose={() => {}} />);
  expect(await screen.findByText('설명')).toBeTruthy();
  expect(s.calls.find((c) => c.url.pathname === '/api/explain-point')?.body).toMatchObject({ provider: 'gpt', time: 1000, to: 2000 });
  expect(s.calls.find((c) => c.url.pathname === '/api/news')?.url.searchParams.get('to')).toBe('2000');
});
