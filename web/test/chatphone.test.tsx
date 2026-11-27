import { afterEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ChatView } from '../src/components/ChatView';
import { resetAiReady } from '../src/aiReady';
import { mockServer, sseResponse } from './fakeServer';

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); resetAiReady(); });

const phone = () => vi.stubGlobal('matchMedia', (q: string) => ({ matches: q === '(pointer: coarse)', media: q, addEventListener() {}, removeEventListener() {} }));

test('on a phone, Return makes a new line; only the send button sends', async () => {
  phone();
  const s = mockServer({ '/api/chats': () => ({ chats: [] }), 'POST /api/chat': () => sseResponse([]) });
  render(<ChatView keyId={null} />);
  const box = screen.getByRole('textbox', { name: '메시지' }) as HTMLTextAreaElement;
  await userEvent.type(box, '삼성전자{Enter}어때');
  expect(box.value).toBe('삼성전자\n어때');
  expect(s.calls.some((c) => c.method === 'POST' && c.url.pathname === '/api/chat')).toBe(false);
  await userEvent.click(screen.getByRole('button', { name: '보내기' }));
  await waitFor(() => expect(s.calls.find((c) => c.method === 'POST' && c.url.pathname === '/api/chat')?.body).toMatchObject({ text: '삼성전자\n어때' }));
});

test('on a computer, Enter still sends', async () => {
  const s = mockServer({ '/api/chats': () => ({ chats: [] }), 'POST /api/chat': () => sseResponse([]) });
  render(<ChatView keyId={null} />);
  await userEvent.type(screen.getByRole('textbox', { name: '메시지' }), '안녕{Enter}');
  await waitFor(() => expect(s.calls.some((c) => c.method === 'POST' && c.url.pathname === '/api/chat')).toBe(true));
});

test('while an answer streams, only the conversation scrolls — the page is never pulled', async () => {
  const pulled = vi.fn();
  Element.prototype.scrollIntoView = pulled;
  mockServer({
    '/api/chats': () => ({ chats: [] }),
    'POST /api/chat': () => sseResponse([{ type: 'text', delta: '첫 ' }, { type: 'text', delta: '답' }, { type: 'done', provider: 'claude', model: 'm', costUsd: 0 }]),
  });
  render(<ChatView keyId={null} />);
  await userEvent.type(screen.getByRole('textbox', { name: '메시지' }), '질문{Enter}');
  expect(await screen.findByText(/첫 답/)).toBeTruthy();
  await userEvent.click(screen.getByRole('textbox', { name: '메시지' }));
  await new Promise((r) => setTimeout(r, 400));
  expect(pulled).not.toHaveBeenCalled();
});
