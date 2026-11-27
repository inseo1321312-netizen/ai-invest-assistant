import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { mockServer } from './fakeServer';
import { applyPrefs, readPrefs } from '../src/prefs';
import { DataSettings, DisplaySettings } from '../src/components/MoreSettings';

beforeEach(() => {
  localStorage.clear();
  delete document.documentElement.dataset.theme;
  delete document.documentElement.dataset.updown;
});
afterEach(() => vi.unstubAllGlobals());

test('defaults follow the phone and use Korean colors', () => {
  expect(readPrefs()).toEqual({ theme: 'system', updown: 'kr', unit: 'native' });
  applyPrefs(readPrefs());
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(document.documentElement.dataset.updown).toBe('kr');
});

test('choosing dark or light mode applies at once and is remembered', async () => {
  render(<DisplaySettings />);
  await userEvent.click(screen.getByRole('radio', { name: '다크' }));
  expect(document.documentElement.dataset.theme).toBe('dark');
  expect(readPrefs().theme).toBe('dark');
  await userEvent.click(screen.getByRole('radio', { name: '라이트' }));
  expect(document.documentElement.dataset.theme).toBe('light');
  await userEvent.click(screen.getByRole('radio', { name: '휴대폰 설정' }));
  expect(document.documentElement.dataset.theme).toBeUndefined();
  expect(readPrefs().theme).toBe('system');
});

test('up/down colors can switch to the global style', async () => {
  render(<DisplaySettings />);
  await userEvent.click(screen.getByRole('radio', { name: '초록 상승' }));
  expect(document.documentElement.dataset.updown).toBe('global');
  expect(readPrefs().updown).toBe('global');
});

test('data menu clears recent views and chats after confirming, and can reload the latest version', async () => {
  const s = mockServer({ 'DELETE /api/recent': () => ({ ok: true }), 'DELETE /api/chats': () => ({ ok: true }) });
  vi.stubGlobal('confirm', () => true);
  render(<DataSettings />);
  await userEvent.click(screen.getByRole('button', { name: '최근 본 종목 지우기' }));
  await userEvent.click(screen.getByRole('button', { name: '대화 기록 모두 지우기' }));
  await waitFor(() => expect(s.calls.filter((c) => c.method === 'DELETE').map((c) => c.url.pathname)).toEqual(['/api/recent', '/api/chats']));
  expect(screen.getByRole('button', { name: '최신 버전 받기' })).toBeTruthy();
});

test('nothing is deleted when the confirm is cancelled', async () => {
  const s = mockServer({ 'DELETE /api/recent': () => ({ ok: true }) });
  vi.stubGlobal('confirm', () => false);
  render(<DataSettings />);
  await userEvent.click(screen.getByRole('button', { name: '최근 본 종목 지우기' }));
  expect(s.calls.some((c) => c.method === 'DELETE')).toBe(false);
});
