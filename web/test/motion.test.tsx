import { afterEach, expect, test, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import { navigate, themeTransition, useTweened } from '../src/motion';

afterEach(() => {
  vi.unstubAllGlobals();
  delete (document as { startViewTransition?: unknown }).startViewTransition;
  delete document.documentElement.dataset.nav;
});

test('without view transitions the update simply runs', () => {
  const update = vi.fn();
  navigate('forward', update);
  expect(update).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.nav).toBeUndefined();
});

test('with view transitions the update runs inside one, tagged with the direction', async () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  let resolve!: () => void;
  const finished = new Promise<void>((r) => { resolve = r; });
  const start = vi.fn((cb: () => void) => { cb(); return { finished }; });
  (document as { startViewTransition?: unknown }).startViewTransition = start;
  const update = vi.fn();
  navigate('back', update);
  expect(start).toHaveBeenCalledTimes(1);
  expect(update).toHaveBeenCalledTimes(1);
  expect(document.documentElement.dataset.nav).toBe('back');
  resolve();
  await finished;
  await Promise.resolve();
  expect(document.documentElement.dataset.nav).toBeUndefined();
});

test('reduced motion skips the transition', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: true }));
  const start = vi.fn();
  (document as { startViewTransition?: unknown }).startViewTransition = start;
  const update = vi.fn();
  navigate('tab', update);
  expect(start).not.toHaveBeenCalled();
  expect(update).toHaveBeenCalled();
});

test('theme reveal grows a circle from the tap point to cover the screen', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => { cb(); return { finished: Promise.resolve() }; };
  vi.stubGlobal('innerWidth', 400);
  vi.stubGlobal('innerHeight', 800);
  const update = vi.fn();
  themeTransition(update, { x: 100, y: 200 });
  const s = document.documentElement.style;
  expect(s.getPropertyValue('--vt-x')).toBe('100px');
  expect(s.getPropertyValue('--vt-y')).toBe('200px');
  expect(s.getPropertyValue('--vt-r')).toBe(`${Math.ceil(Math.hypot(300, 600))}px`);
  expect(update).toHaveBeenCalled();
});

function Show({ v }: { v: number }) {
  return <span>{useTweened(v).toFixed(0)}</span>;
}

test('numbers show their first value at once and jump when motion is off', () => {
  const { rerender } = render(<Show v={100} />);
  expect(screen.getByText('100')).toBeTruthy();
  act(() => rerender(<Show v={250} />));
  expect(screen.getByText('250')).toBeTruthy();
});

test('when taps come quickly, only the last change is applied', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const queued: (() => void)[] = [];
  (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => { queued.push(cb); return { finished: new Promise(() => {}) }; };
  const applied: string[] = [];
  navigate('tab', () => applied.push('settings'));
  navigate('tab', () => applied.push('chat'));
  navigate('tab', () => applied.push('home'));
  // 브라우저가 앞의 전환을 건너뛰며 콜백을 늦게, 순서가 섞여서 부를 수 있다
  queued[2]!(); queued[0]!(); queued[1]!();
  expect(applied).toEqual(['home']);
});

test('a quick screen change does not drop a color change', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const queued: (() => void)[] = [];
  (document as { startViewTransition?: unknown }).startViewTransition = (cb: () => void) => { queued.push(cb); return { finished: new Promise(() => {}) }; };
  const applied: string[] = [];
  navigate('theme', () => applied.push('dark'));
  navigate('tab', () => applied.push('home'));
  queued.forEach((q) => q());
  expect(applied).toEqual(['dark', 'home']);
});
