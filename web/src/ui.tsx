import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { motionOk } from './motion';
import { createPortal } from 'react-dom';

/* ── 아이콘(선 아이콘, currentColor) ─────────────────── */
const svg = (d: ReactNode) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{d}</svg>
);
export const Icon = {
  home: () => svg(<><path d="M3 10.5 12 3l9 7.5" /><path d="M5 9.5V20h14V9.5" /></>),
  compare: () => svg(<><path d="M7 4 3 8l4 4" /><path d="M3 8h14" /><path d="m17 12 4 4-4 4" /><path d="M21 16H7" /></>),
  chat: () => svg(<path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12Z" />),
  settings: () => svg(<><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z" /></>),
  back: () => svg(<path d="M15 18l-6-6 6-6" />),
  send: () => svg(<><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7Z" /></>),
  refresh: () => svg(<><path d="M21 12a9 9 0 1 1-2.6-6.4" /><path d="M21 3v6h-6" /></>),
  plus: () => svg(<path d="M12 5v14M5 12h14" />),
  menu: () => svg(<path d="M4 7h16M4 12h16M4 17h10" />),
  compose: () => svg(<><path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" /></>),
  trash: () => svg(<><path d="M3 6h18" /><path d="M8 6V4h8v2" /><path d="M6 6l1 14h10l1-14" /></>),
  history: () => svg(<><path d="M3 12a9 9 0 1 0 3-6.7L3 8" /><path d="M3 3v5h5" /><path d="M12 7v5l3 2" /></>),
  close: () => svg(<path d="M18 6 6 18M6 6l12 12" />),
  chevron: () => svg(<path d="m6 9 6 6 6-6" />),
  search: () => svg(<><circle cx="11" cy="11" r="7" /><path d="m20 20-3.5-3.5" /></>),
  star: () => svg(<path d="m12 3 2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1-4.4-4.3 6.1-.9Z" />),
  bell: () => svg(<><path d="M6 8a6 6 0 1 1 12 0c0 7 3 8 3 8H3s3-1 3-8" /><path d="M10.3 21a1.9 1.9 0 0 0 3.4 0" /></>),
  news: () => svg(<><path d="M4 5h13v14H6a2 2 0 0 1-2-2Z" /><path d="M17 9h3v8a2 2 0 0 1-2 2" /><path d="M8 9h5M8 13h5" /></>),
  stop: () => <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="2" fill="currentColor" /></svg>,
  spark: () => svg(<><path d="M12 3v4M12 17v4M3 12h4M17 12h4" /><path d="m6 6 2.5 2.5M15.5 15.5 18 18M18 6l-2.5 2.5M8.5 15.5 6 18" /></>),
};

/* ── 뒤 화면 고정 ──────────────────────────────────── */
// 시트가 열려 있는 동안 뒤 화면이 같이 끌려 다니지 않게 body를 그 자리에 묶어 둔다(아이폰은 overflow만으로는 안 묶인다)
let locks = 0;
let lockedY = 0;
export function lockScroll(): () => void {
  if (locks++ === 0) {
    lockedY = window.scrollY;
    Object.assign(document.body.style, { position: 'fixed', top: `-${lockedY}px`, left: '0', right: '0', overflow: 'hidden' });
  }
  let done = false;
  return () => {
    if (done) return;
    done = true;
    if (--locks > 0) return;
    Object.assign(document.body.style, { position: '', top: '', left: '', right: '', overflow: '' });
    window.scrollTo(0, lockedY);
  };
}

/** 시트를 아래로 끌어 닫기: 맨 위까지 올라가 있을 때 아래로 끌면 시트가 손가락을 따라 내려오고, 충분히 내리면 닫힌다 */
function useDragToClose(ref: { current: HTMLDivElement | null }, onDismiss: () => void, backdrop: { current: HTMLDivElement | null }) {
  const cb = useRef(onDismiss);
  cb.current = onDismiss;
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    let y0: number | null = null;
    let t0 = 0;
    let dy = 0;
    let mode: 'idle' | 'drag' | 'scroll' = 'idle';
    const put = (px: number, animate: boolean) => {
      el.style.transition = animate ? 'transform 220ms cubic-bezier(0.2, 0.8, 0.2, 1)' : 'none';
      el.style.transform = px > 0 ? `translate(-50%, ${px}px)` : '';
      if (backdrop.current) {
        backdrop.current.style.transition = el.style.transition.replace('transform', 'opacity');
        backdrop.current.style.opacity = px > 0 ? String(Math.max(0.2, 1 - px / 400)) : '';
      }
    };
    const start = (e: TouchEvent) => {
      if (e.touches.length !== 1) { y0 = null; return; }
      y0 = e.touches[0]!.clientY;
      t0 = Date.now();
      dy = 0;
      mode = 'idle';
    };
    const move = (e: TouchEvent) => {
      if (y0 === null) return;
      const d = (e.touches[0]?.clientY ?? y0) - y0;
      if (mode === 'idle') {
        if (Math.abs(d) < 6) return;
        // 목록이 맨 위에 있고 아래로 끌 때만 시트를 내린다(아니면 평소처럼 목록이 움직인다)
        mode = d > 0 && el.scrollTop <= 0 ? 'drag' : 'scroll';
      }
      if (mode !== 'drag') return;
      if (e.cancelable) e.preventDefault();
      dy = Math.max(0, d);
      put(dy, false);
    };
    const end = () => {
      if (y0 === null) return;
      y0 = null;
      if (mode !== 'drag') return;
      const fast = dy / Math.max(1, Date.now() - t0) > 0.6;
      if (dy > 110 || (fast && dy > 40)) {
        put(el.offsetHeight || 600, true);
        const done = () => cb.current();
        if (motionOk()) setTimeout(done, 200); else done();
      } else {
        put(0, true);
      }
    };
    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end);
    el.addEventListener('touchcancel', end);
    return () => {
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
    };
  }, [ref, backdrop]);
}

/* ── 바텀 시트 ─────────────────────────────────────── */
export function Sheet({ title, onClose, children, full = false }: { title: string; onClose: () => void; children: ReactNode; full?: boolean }) {
  const [closing, setClosing] = useState(false);
  const sheet = useRef<HTMLDivElement>(null);
  const backdrop = useRef<HTMLDivElement>(null);
  const close = useCallback(() => {
    if (!motionOk()) { onClose(); return; }
    setClosing(true);
    setTimeout(onClose, 230);
  }, [onClose]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);
  // 화면 이동(맨 위로)보다 먼저 풀리도록 layout 단계에서 묶고 푼다
  useLayoutEffect(() => lockScroll(), []);
  useDragToClose(sheet, onClose, backdrop);
  // body에 그려서 부모의 transform·overflow 영향을 받지 않게 한다
  return createPortal(
    <>
      <div ref={backdrop} className={`sheet-backdrop${closing ? ' closing' : ''}`} onClick={close} />
      <div ref={sheet} className={`sheet${full ? ' full' : ''}${closing ? ' closing' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="sheet-handle" />
        <div className="sheet-head">
          <h2>{title}</h2>
          <button type="button" className="icon-btn" aria-label="닫기" onClick={close}><Icon.close /></button>
        </div>
        {children}
      </div>
    </>,
    document.body,
  );
}

/* ── 슬라이드 세그먼트 ─────────────────────────────── */
export function Segmented<T extends string>({ options, value, onChange, label, kind = 'tab', small = false }: {
  options: { value: T; label: string; hint?: string }[];
  value: T;
  onChange: (v: T) => void;
  label: string;
  kind?: 'tab' | 'radio' | 'pressed';
  small?: boolean;
}) {
  const idx = Math.max(0, options.findIndex((o) => o.value === value));
  const role = kind === 'tab' ? 'tablist' : kind === 'radio' ? 'radiogroup' : 'group';
  return (
    <div className={`seg${small ? ' small' : ''}`} role={role} aria-label={label}>
      <span className="seg-pill" style={{ width: `calc((100% - 8px) / ${options.length})`, transform: `translateX(${idx * 100}%)` }} aria-hidden="true" />
      {options.map((o) => {
        const on = o.value === value;
        const a11y = kind === 'tab' ? { role: 'tab', 'aria-selected': on } : kind === 'radio' ? { role: 'radio', 'aria-checked': on } : { 'aria-pressed': on };
        return (
          <button key={o.value} type="button" {...a11y} aria-label={o.label} title={o.hint} onClick={() => onChange(o.value)}>{o.label}</button>
        );
      })}
    </div>
  );
}

export function Dots() {
  return <span className="dots" aria-hidden="true"><i /><i /><i /></span>;
}

export function SkeletonList({ rows = 3 }: { rows?: number }) {
  return (
    <ul className="list" aria-label="불러오는 중">
      {Array.from({ length: rows }, (_, i) => (
        <li key={i} className="sk-row"><span className="skeleton a" /><span className="skeleton b" /><span className="skeleton c" /></li>
      ))}
    </ul>
  );
}

/* ── 미니 추세선 ───────────────────────────────────── */
export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="spark" />;
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const pts = values.map((v, i) => `${((i / (values.length - 1)) * 64).toFixed(1)},${(22 - ((v - min) / span) * 20).toFixed(1)}`).join(' ');
  const up = values[values.length - 1]! >= values[0]!;
  return (
    <svg className="spark" viewBox="0 0 64 24" aria-hidden="true">
      <polyline points={pts} fill="none" stroke={up ? 'var(--up)' : 'var(--down)'} strokeWidth={1.6} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}

/* ── 가격 변화 반짝임 ──────────────────────────────── */
export function useFlash(value: number | null | undefined): string {
  const prev = useRef(value);
  const [cls, setCls] = useState('');
  useEffect(() => {
    if (value === null || value === undefined || prev.current === null || prev.current === undefined || value === prev.current) {
      prev.current = value;
      return;
    }
    setCls(value > prev.current ? 'flash-up' : 'flash-down');
    prev.current = value;
    const t = setTimeout(() => setCls(''), 900);
    return () => clearTimeout(t);
  }, [value]);
  return cls;
}

/* ── 토스트 ────────────────────────────────────────── */
export function useToast(): [ReactNode, (msg: string) => void] {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2600);
    return () => clearTimeout(t);
  }, [msg]);
  return [msg ? createPortal(<div className="toast" role="status">{msg}</div>, document.body) : null, setMsg];
}

export function usd(n: number): string {
  return `$${n.toFixed(2)}`;
}

export function Disclaimer() {
  return <p className="disclaimer">투자 판단과 책임은 본인에게 있음</p>;
}
