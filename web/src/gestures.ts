import { useEffect, useRef, useState } from 'react';

/** 이만큼(px) 당기면 놓았을 때 새로 고친다 */
export const PULL_TRIGGER = 70;
const PULL_MAX = 110;

const atTop = () => (document.scrollingElement?.scrollTop ?? window.scrollY ?? 0) <= 0;

/** 화면 맨 위에서 아래로 당기면 onRefresh. 지금 당긴 거리(0~110)를 돌려준다. 열린 시트가 있으면 무시 */
export function usePullToRefresh(onRefresh: () => void): number {
  const [pull, setPull] = useState(0);
  const cb = useRef(onRefresh);
  cb.current = onRefresh;

  useEffect(() => {
    let startY: number | null = null;
    let dist = 0;
    const start = (e: TouchEvent) => {
      const y = e.touches[0]?.clientY;
      startY = e.touches.length === 1 && y !== undefined && atTop() && !document.querySelector('[role="dialog"]') ? y : null;
      dist = 0;
    };
    const move = (e: TouchEvent) => {
      if (startY === null) return;
      const dy = (e.touches[0]?.clientY ?? startY) - startY;
      dist = dy > 0 && atTop() ? Math.min(dy * 0.5, PULL_MAX) : 0;
      setPull(dist);
    };
    const end = () => {
      if (startY === null) return;
      startY = null;
      if (dist >= PULL_TRIGGER) cb.current();
      dist = 0;
      setPull(0);
    };
    window.addEventListener('touchstart', start, { passive: true });
    window.addEventListener('touchmove', move, { passive: true });
    window.addEventListener('touchend', end);
    window.addEventListener('touchcancel', end);
    return () => {
      window.removeEventListener('touchstart', start);
      window.removeEventListener('touchmove', move);
      window.removeEventListener('touchend', end);
      window.removeEventListener('touchcancel', end);
    };
  }, []);

  return pull;
}

/** 'online' | 'offline' | 'back'(다시 연결된 직후 잠깐) */
export function useNetwork(): 'online' | 'offline' | 'back' {
  const [state, setState] = useState<'online' | 'offline' | 'back'>(() => (typeof navigator !== 'undefined' && navigator.onLine === false ? 'offline' : 'online'));
  useEffect(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    const off = () => { clearTimeout(t); setState('offline'); };
    const on = () => {
      clearTimeout(t);
      setState((s) => (s === 'offline' ? 'back' : s));
      t = setTimeout(() => setState('online'), 2500);
    };
    window.addEventListener('offline', off);
    window.addEventListener('online', on);
    return () => { clearTimeout(t); window.removeEventListener('offline', off); window.removeEventListener('online', on); };
  }, []);
  return state;
}
