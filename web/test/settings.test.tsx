import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer } from './fakeServer';
import { ChatgptConnect } from '../src/components/ChatgptConnect';
import { AlertSettings } from '../src/components/AlertSettings';

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
});

const LOGIN_URL = 'https://auth.openai.com/api/accounts/authorize?state=abc';
const PASTED = 'http://127.0.0.1:1455/auth/callback?code=C&state=abc&client_id=oaiapp_x';

test('ChatGPT: the button gives an OpenAI link, then pasting the copied address connects', async () => {
  const s = mockServer({ 'POST /api/admin/siwc-login/start': () => ({ url: LOGIN_URL }), 'POST /api/admin/siwc-login/finish': () => ({ ok: true }) });
  Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => PASTED }, configurable: true });
  const onConnected = vi.fn();
  render(<ChatgptConnect onConnected={onConnected} />);
  await userEvent.click(screen.getByRole('button', { name: 'ChatGPT 연결' }));
  const link = await screen.findByRole('link', { name: 'OpenAI 로그인 열기' });
  expect(link.getAttribute('href')).toBe(LOGIN_URL);
  await userEvent.click(screen.getByRole('button', { name: '붙여넣기' }));
  await waitFor(() => expect(s.calls.find((c) => c.url.pathname === '/api/admin/siwc-login/finish')?.body).toEqual({ url: PASTED }));
  expect(await screen.findByText(/연결됐어요/)).toBeTruthy();
  expect(onConnected).toHaveBeenCalled();
});

test('ChatGPT: when the clipboard cannot be read, the address can be typed in', async () => {
  const s = mockServer({ 'POST /api/admin/siwc-login/start': () => ({ url: LOGIN_URL }), 'POST /api/admin/siwc-login/finish': () => ({ ok: true }) });
  Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => { throw new Error('denied'); } }, configurable: true });
  render(<ChatgptConnect onConnected={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'ChatGPT 연결' }));
  await userEvent.click(await screen.findByRole('button', { name: '붙여넣기' }));
  const input = await screen.findByLabelText('복사한 주소');
  await userEvent.type(input, PASTED);
  await userEvent.click(screen.getByRole('button', { name: '연결하기' }));
  await waitFor(() => expect(s.calls.find((c) => c.url.pathname === '/api/admin/siwc-login/finish')?.body).toEqual({ url: PASTED }));
});

test('ChatGPT: server reasons are shown', async () => {
  mockServer({
    'POST /api/admin/siwc-login/start': () => ({ url: LOGIN_URL }),
    'POST /api/admin/siwc-login/finish': () => new Response(JSON.stringify({ error: '시간이 지나서 다시 해 주세요' }), { status: 400 }),
  });
  Object.defineProperty(navigator, 'clipboard', { value: { readText: async () => PASTED }, configurable: true });
  render(<ChatgptConnect onConnected={() => {}} />);
  await userEvent.click(screen.getByRole('button', { name: 'ChatGPT 연결' }));
  await userEvent.click(await screen.findByRole('button', { name: '붙여넣기' }));
  expect(await screen.findByText('시간이 지나서 다시 해 주세요')).toBeTruthy();
});

test('alert settings list coins, remove one, and save thresholds', async () => {
  const s = mockServer({
    '/api/alerts': () => ({ coins: ['coin:BTC-USDT', 'coin:ETH-USDT-SWAP'], settings: { m5: 2, m15: 3, h1: 5, events: true } }),
    'PUT /api/alerts/settings': () => ({ m5: 2, m15: 3, h1: 5, events: true }),
    'DELETE /api/alerts/coins': () => ({ ok: true }),
  });
  render(<AlertSettings />);
  expect(await screen.findByText('BTC', { ignore: '.avatar-text, script, style' })).toBeTruthy();
  await userEvent.click(screen.getByRole('button', { name: 'ETH 무기한 알림 끄기' }));
  await waitFor(() => expect(s.calls.some((c) => c.method === 'DELETE' && c.url.searchParams.get('key') === 'coin:ETH-USDT-SWAP')).toBe(true));
  await userEvent.click(screen.getByRole('button', { name: '알림 기준 저장' }));
  await waitFor(() => expect(s.calls.find((c) => c.method === 'PUT')?.body).toEqual({ m5: 2, m15: 3, h1: 5, events: true }));
});

test('alert settings reject out-of-range thresholds before saving', async () => {
  const s = mockServer({ '/api/alerts': () => ({ coins: [], settings: { m5: 2, m15: 3, h1: 5, events: true } }) });
  render(<AlertSettings />);
  const m5 = await screen.findByLabelText('5분 기준(%)');
  await userEvent.clear(m5);
  await userEvent.type(m5, '0.1');
  await userEvent.click(screen.getByRole('button', { name: '알림 기준 저장' }));
  expect(await screen.findByText(/0.5~50/)).toBeTruthy();
  expect(s.calls.some((c) => c.method === 'PUT')).toBe(false);
  expect(screen.getByText(/코인 화면에서 🔔을 누르면/)).toBeTruthy();
});
