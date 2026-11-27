import { useEffect, useRef } from 'react';
import { api } from '../api';
import { Sheet } from '../ui';
import { OvernightView, type Recap } from './OvernightView';

const SEEN = 'overnight.seen';
const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

export const markOvernightSeen = (id: number) => { try { localStorage.setItem(SEEN, String(id)); } catch { /* 괜찮다 */ } };

/**
 * 아침에 앱을 열면(또는 돌아오면) 오늘 정리를 이 기기에서 처음 볼 때 한 번 띄운다.
 * 만드는 중이면 다 될 때까지 기다렸다가 띄운다. 정리 시각 전(어제 정리뿐)이면 띄우지 않는다.
 */
export function useOvernightPopup(open: () => void): void {
  const cb = useRef(open);
  cb.current = open;
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let fails = 0;
    const check = async () => {
      clearTimeout(timer);
      const v = await api<{ recap: Recap | null; making: boolean }>('/api/overnight').catch(() => null);
      if (!alive) return;
      // 못 읽었으면(서버가 깨는 중 등) 몇 번 더 묻는다
      if (!v) { if (++fails <= 10) timer = setTimeout(() => void check(), 8000); return; }
      fails = 0;
      if (v.making) { timer = setTimeout(() => void check(), 8000); return; }
      const r = v.recap;
      let seen: string | null = null;
      try { seen = localStorage.getItem(SEEN); } catch { /* 괜찮다 */ }
      if (r && r.day === kstToday() && seen !== String(r.id)) {
        markOvernightSeen(r.id);
        cb.current();
      }
    };
    void check();
    const back = () => { if (document.visibilityState === 'visible') void check(); };
    document.addEventListener('visibilitychange', back);
    return () => { alive = false; clearTimeout(timer); document.removeEventListener('visibilitychange', back); };
  }, []);
}

/** 밤사이: 아래에서 올라오는 창. 아래로 끌면 닫힌다 */
export function OvernightSheet({ onClose, onOpen }: { onClose: () => void; onOpen: (key: string) => void }) {
  return (
    <Sheet title="밤사이" onClose={onClose} full>
      <OvernightView embedded onOpen={(k) => { onClose(); onOpen(k); }} onSeen={markOvernightSeen} />
    </Sheet>
  );
}
