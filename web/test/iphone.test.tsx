import { afterEach, expect, test, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fireEvent, render, screen } from '@testing-library/react';
import { Sheet } from '../src/ui';
import { watchViewport } from '../src/viewport';
import { greeting } from '../src/greeting';
import { ChatView } from '../src/components/ChatView';
import { mockServer } from './fakeServer';

afterEach(() => { vi.unstubAllGlobals(); document.documentElement.className = ''; document.documentElement.removeAttribute('style'); });

const css = readFileSync('src/styles.css', 'utf8');

function touch(el: Element, type: 'touchStart' | 'touchMove' | 'touchEnd', y: number) {
  const t = { clientX: 100, clientY: y, identifier: 1, target: el };
  fireEvent[type](el, { touches: type === 'touchEnd' ? [] : [t], changedTouches: [t] });
}

test('pulling a sheet down by its body closes it', () => {
  const onClose = vi.fn();
  render(<Sheet title="종목 검색" onClose={onClose}><p>내용</p></Sheet>);
  const sheet = screen.getByRole('dialog', { name: '종목 검색' });
  touch(sheet, 'touchStart', 200);
  touch(sheet, 'touchMove', 260);
  touch(sheet, 'touchMove', 360);
  touch(sheet, 'touchEnd', 360);
  expect(onClose).toHaveBeenCalled();
});

test('a short pull snaps back, and a pull while the list is scrolled just scrolls', () => {
  const onClose = vi.fn();
  render(<Sheet title="종목 검색" onClose={onClose}><p>내용</p></Sheet>);
  const sheet = screen.getByRole('dialog', { name: '종목 검색' });
  touch(sheet, 'touchStart', 200);
  touch(sheet, 'touchMove', 230);
  touch(sheet, 'touchEnd', 230);
  expect(onClose).not.toHaveBeenCalled();
  sheet.scrollTop = 120;
  touch(sheet, 'touchStart', 200);
  touch(sheet, 'touchMove', 400);
  touch(sheet, 'touchEnd', 400);
  expect(onClose).not.toHaveBeenCalled();
});

test('the page behind an open sheet does not scroll, and comes back where it was', () => {
  const scrollTo = vi.fn();
  vi.stubGlobal('scrollTo', scrollTo);
  Object.defineProperty(window, 'scrollY', { value: 480, configurable: true });
  const { unmount } = render(<Sheet title="종목 검색" onClose={() => {}}><p>내용</p></Sheet>);
  expect(document.body.style.position).toBe('fixed');
  expect(document.body.style.top).toBe('-480px');
  unmount();
  expect(document.body.style.position).toBe('');
  expect(scrollTo).toHaveBeenCalledWith(0, 480);
  Object.defineProperty(window, 'scrollY', { value: 0, configurable: true });
});

test('when the keyboard opens, the screen knows how much of it is covered', () => {
  const vv = Object.assign(new EventTarget(), { height: 800, offsetTop: 0, scale: 1 });
  vi.stubGlobal('visualViewport', vv);
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  const stop = watchViewport();
  const box = document.createElement('textarea');
  document.body.append(box);
  box.focus();
  Object.assign(vv, { height: 460, offsetTop: 40 });
  vv.dispatchEvent(new Event('resize'));
  const root = document.documentElement;
  expect(root.classList.contains('kb-open')).toBe(true);
  expect(root.style.getPropertyValue('--kb')).toBe('300px');
  expect(root.style.getPropertyValue('--vv-h')).toBe('460px');
  expect(root.style.getPropertyValue('--vv-top')).toBe('40px');
  box.blur();
  Object.assign(vv, { height: 800, offsetTop: 0 });
  vv.dispatchEvent(new Event('resize'));
  expect(root.classList.contains('kb-open')).toBe(false);
  expect(root.style.getPropertyValue('--kb')).toBe('');
  stop();
  box.remove();
});

test('pinch zoom without typing is not mistaken for the keyboard', () => {
  const vv = Object.assign(new EventTarget(), { height: 400, offsetTop: 100, scale: 2 });
  vi.stubGlobal('visualViewport', vv);
  Object.defineProperty(window, 'innerHeight', { value: 800, configurable: true });
  const stop = watchViewport();
  vv.dispatchEvent(new Event('resize'));
  expect(document.documentElement.classList.contains('kb-open')).toBe(false);
  stop();
});

test('typing never zooms the iPhone in: every text box is at least 16px', () => {
  expect(css).toMatch(/input:not\(\[type='checkbox'\], \[type='radio'\], \[type='range'\]\), textarea, select \{ font-size: max\(16px, 1em\); \}/);
});

test('the active menu item has no dot running into its label', () => {
  expect(css).not.toMatch(/bottom-nav button\[aria-current='page'\]::after/);
});

test('home headline is a little nudge for the tab you are on, not a time label', () => {
  const at = (s: string) => new Date(`${s}+09:00`);
  expect(greeting('coin', at('2026-11-27T14:00:00'))).toBe('오늘은 무슨 코인을 볼까요?');
  expect(greeting('kr', at('2026-11-27T10:00:00'))).toBe('오늘은 뭐가 오를까요?');
  expect(greeting('kr', at('2026-11-27T08:10:00'))).toBe('장 열리기 전, 미리 볼까요?');
  expect(greeting('kr', at('2026-11-27T19:00:00'))).toBe('오늘 장은 어땠을까요?');
  expect(greeting('kr', at('2026-11-28T11:00:00'))).toBe('주말엔 느긋하게 둘러봐요');
  expect(greeting('us', at('2026-11-27T23:40:00'))).toBe('미국장이 열렸어요');
  expect(greeting('us', at('2026-11-27T13:00:00'))).toBe('오늘 밤 미국장, 뭘 볼까요?');
  expect(greeting('coin', at('2026-11-27T02:30:00'))).toBe('잠 못 드는 밤, 코인 한 바퀴?');
  for (const m of ['kr', 'us', 'coin'] as const) expect(greeting(m, at('2026-11-27T19:00:00'))).not.toContain('하루 정리');
});

test('the chat keeps its own disclaimer and does not stretch the page', () => {
  mockServer({});
  render(<ChatView keyId={null} />);
  const chat = screen.getByRole('region', { name: 'AI 채팅' });
  expect(chat.textContent).toContain('투자 판단과 책임은 본인에게 있음');
  expect(css).toMatch(/\.chat \.messages \{[^}]*overflow-y: auto/);
  expect(css).not.toMatch(/\.messages \{ padding: 8px var\(--gutter\) 214px/);
});

test('Korean lines break between words, not in the middle of one', () => {
  expect(css).toMatch(/body \{ word-break: keep-all; overflow-wrap: break-word; \}/);
});
