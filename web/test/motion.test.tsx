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

test('light/dark switches at once: no screen snapshot and no all-element color fade (they stutter on iPhone)', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const start = vi.fn((cb: () => void) => { cb(); return { finished: Promise.resolve() }; });
  (document as { startViewTransition?: unknown }).startViewTransition = start;
  const update = vi.fn();
  themeTransition(update, { x: 100, y: 200 });
  expect(update).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  expect(document.documentElement.classList.contains('theme-fade')).toBe(false);
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
  // 탭 바꾸기는 바로 바뀌므로, 미끄러지는 전환(들어가기·나오기)으로 확인한다
  navigate('forward', () => applied.push('settings'));
  navigate('back', () => applied.push('chat'));
  navigate('forward', () => applied.push('home'));
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
  navigate('forward', () => applied.push('home'));
  queued.forEach((q) => q());
  expect(applied).toEqual(['dark', 'home']);
});

test('switching tabs does not snapshot the page (the menu animates live, without stutter); going into a page still slides', () => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  const start = vi.fn((cb: () => void) => { cb(); return { finished: Promise.resolve() }; });
  (document as { startViewTransition?: unknown }).startViewTransition = start;
  const update = vi.fn();
  navigate('tab', update);
  expect(update).toHaveBeenCalledTimes(1);
  expect(start).not.toHaveBeenCalled();
  navigate('forward', vi.fn());
  expect(start).toHaveBeenCalledTimes(1);
});

test('the menu highlight is ready to move on the GPU', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles.css', 'utf8');
  expect(css).toMatch(/\.bottom-nav::before \{[^}]*will-change: transform/);
});

test('switching tabs does not wobble the menu: no overshoot on the highlight or icons, the new screen only fades', async () => {
  const { readFileSync } = await import('node:fs');
  const css = readFileSync('src/styles.css', 'utf8');
  const last = (sel: RegExp) => { const all = [...css.matchAll(sel)]; return all.at(-1)?.[0] ?? ''; };
  const pill = last(/\.bottom-nav::before \{[^}]*transition:[^}]*\}/g);
  expect(pill).toContain('cubic-bezier(0.2, 0.8, 0.2, 1)');
  expect(pill).not.toMatch(/cubic-bezier\([^)]*1\.\d/);
  expect(css).toMatch(/\.bottom-nav button\[aria-current='page'\] svg \{ transform: none; \}/);
  expect(last(/@keyframes tab-in \{[^}]*\}/g)).not.toContain('transform');
});
