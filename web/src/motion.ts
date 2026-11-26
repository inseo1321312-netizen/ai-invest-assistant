/**
 * 화면 전환과 숫자 움직임.
 * - 지원하는 브라우저(iOS 18+ Safari 등)에서는 View Transitions로 화면이 스르륵 바뀐다.
 * - "동작 줄이기"를 켰거나 지원하지 않으면 그냥 바로 바꾼다.
 */
import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';

export type NavKind = 'forward' | 'back' | 'tab' | 'theme';

type Vt = { finished: Promise<void>; ready?: Promise<void>; updateCallbackDone?: Promise<void> };
type VtDoc = { startViewTransition?: (cb: () => void) => Vt };

/** 움직임을 써도 되는지: 브라우저가 알려 주고(matchMedia), "동작 줄이기"가 꺼져 있을 때만 */
export function motionOk(): boolean {
  try {
    return typeof matchMedia === 'function' && !matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/** 화면 이동과 색 바꾸기는 따로 센다(색 바꾼 직후 화면을 옮겨도 색이 빠지지 않게) */
const latest = { nav: 0, theme: 0 };

/**
 * 화면 바꾸기: forward(들어가기), back(나오기), tab(메뉴 바꾸기), theme(색 모드).
 * 빠르게 여러 번 누르면 앞의 전환은 건너뛰어진다. 그때 늦게 불리는 예전 변경은 무시하고 마지막 것만 반영한다.
 */
export function navigate(kind: NavKind, update: () => void): void {
  const group = kind === 'theme' ? 'theme' : 'nav';
  const id = ++latest[group];
  const doc = document as unknown as VtDoc;
  if (!doc.startViewTransition || !motionOk()) {
    update();
    return;
  }
  const root = document.documentElement;
  root.dataset.nav = kind;
  try {
    const t = doc.startViewTransition(() => { if (id === latest[group]) flushSync(update); });
    // 전환 중에 새 전환이 시작되면 이전 것은 건너뛰어진다(AbortError): 정상이니 조용히 넘긴다
    void t.ready?.catch(() => undefined);
    void t.updateCallbackDone?.catch(() => undefined);
    void t.finished.catch(() => undefined).then(() => { if (root.dataset.nav === kind) delete root.dataset.nav; });
  } catch {
    delete root.dataset.nav;
    update();
  }
}

/** 다크·라이트 전환: 누른 곳에서 원이 퍼지며 새 색이 덮는다. 지원하지 않으면 색이 천천히 바뀐다. */
export function themeTransition(update: () => void, origin?: { x: number; y: number }): void {
  const root = document.documentElement;
  const doc = document as unknown as VtDoc;
  if (doc.startViewTransition && motionOk()) {
    const w = typeof innerWidth === 'number' ? innerWidth : 0;
    const h = typeof innerHeight === 'number' ? innerHeight : 0;
    const x = origin?.x ?? w / 2;
    const y = origin?.y ?? h / 2;
    root.style.setProperty('--vt-x', `${x}px`);
    root.style.setProperty('--vt-y', `${y}px`);
    root.style.setProperty('--vt-r', `${Math.ceil(Math.hypot(Math.max(x, w - x), Math.max(y, h - y)))}px`);
    navigate('theme', update);
    return;
  }
  if (motionOk()) {
    root.classList.add('theme-fade');
    update();
    setTimeout(() => root.classList.remove('theme-fade'), 500);
    return;
  }
  update();
}

const easeOut = (t: number) => 1 - (1 - t) ** 3;

/** 값이 바뀌면 이전 값에서 새 값까지 부드럽게 따라간다. 처음 값은 바로 보여 준다. */
export function useTweened(value: number, durationMs = 520): number {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    if (raf.current !== null) cancelAnimationFrame(raf.current);
    const start = from.current;
    if (start === value || !motionOk() || typeof requestAnimationFrame !== 'function' || !Number.isFinite(start)) {
      from.current = value;
      setShown(value);
      return;
    }
    const t0 = performance.now();
    const step = (now: number) => {
      const p = Math.min(1, (now - t0) / durationMs);
      const v = start + (value - start) * easeOut(p);
      from.current = v;
      setShown(v);
      if (p < 1) raf.current = requestAnimationFrame(step);
      else { raf.current = null; from.current = value; }
    };
    raf.current = requestAnimationFrame(step);
    return () => { if (raf.current !== null) cancelAnimationFrame(raf.current); };
  }, [value, durationMs]);

  return shown;
}
