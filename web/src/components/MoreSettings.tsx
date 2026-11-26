import { useRef, useState } from 'react';
import { themeTransition } from '../motion';
import { api } from '../api';
import { applyPrefs, readPrefs, savePrefs, type Prefs, type Theme, type UpDown } from '../prefs';
import { Segmented, useToast } from '../ui';

/** 화면: 다크·라이트 모드, 상승·하락 색 */
export function DisplaySettings() {
  const [p, setP] = useState<Prefs>(readPrefs);
  const tap = useRef<{ x: number; y: number } | undefined>(undefined);
  const update = (next: Prefs) => {
    savePrefs(next);
    const run = () => { setP(next); applyPrefs(next); };
    if (next.theme !== p.theme || next.updown !== p.updown) themeTransition(run, tap.current);
    else run();
  };
  return (
    <section className="panel" id="set-display" aria-label="화면">
      <h2>화면</h2>
      <div onPointerDown={(e) => { tap.current = { x: e.clientX, y: e.clientY }; }}>
      <p className="set-label">모드</p>
      <Segmented small kind="radio" label="화면 모드" value={p.theme} onChange={(theme: Theme) => update({ ...p, theme })}
        options={[{ value: 'system', label: '휴대폰 설정' }, { value: 'light', label: '라이트' }, { value: 'dark', label: '다크' }]} />
      <p className="set-label">상승·하락 색</p>
      <Segmented small kind="radio" label="상승 하락 색" value={p.updown} onChange={(updown: UpDown) => update({ ...p, updown })}
        options={[{ value: 'kr', label: '빨강 상승' }, { value: 'global', label: '초록 상승' }]} />
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>
        {p.updown === 'kr' ? '한국식: 오르면 빨강, 내리면 파랑' : '해외식: 오르면 초록, 내리면 빨강'}
      </p>
    </section>
  );
}

/** 데이터: 최근 본 종목·대화 기록 지우기, 최신 버전 받기 */
export function DataSettings() {
  const [toast, showToast] = useToast();

  async function clearRecent() {
    if (!confirm('최근 본 종목 기록을 모두 지울까요?')) return;
    await api('/api/recent', { method: 'DELETE' }).then(() => showToast('최근 본 종목을 지웠어요')).catch(() => showToast('지우지 못했어요'));
  }

  async function clearChats() {
    if (!confirm('AI 상담 대화 기록을 모두 지울까요? 되돌릴 수 없어요.')) return;
    await api('/api/chats', { method: 'DELETE' }).then(() => showToast('대화 기록을 지웠어요')).catch(() => showToast('지우지 못했어요'));
  }

  /** 홈 화면 앱이 예전 화면을 붙잡고 있을 때: 저장된 화면 파일을 지우고 새로 받는다 */
  async function reloadLatest() {
    try {
      for (const r of (await navigator.serviceWorker?.getRegistrations?.()) ?? []) await r.unregister();
      for (const k of (await caches?.keys?.()) ?? []) await caches.delete(k);
    } catch { /* 지원하지 않으면 그냥 새로 고침 */ }
    location.reload();
  }

  return (
    <section className="panel" id="set-data" aria-label="데이터">
      <h2>데이터</h2>
      <div className="set-list">
        <button type="button" className="set-row" onClick={clearRecent}>최근 본 종목 지우기</button>
        <button type="button" className="set-row" onClick={clearChats}>대화 기록 모두 지우기</button>
        <button type="button" className="set-row" onClick={reloadLatest}>최신 버전 받기</button>
      </div>
      <p className="small muted" style={{ marginBottom: 0 }}>새 버전이 올라왔는데 화면이 그대로면 "최신 버전 받기"를 누르세요.</p>
      {toast}
    </section>
  );
}

/** 앱 정보 */
export function AboutSettings() {
  const built = typeof __BUILD_TIME__ === 'string' ? __BUILD_TIME__ : '';
  return (
    <section className="panel" id="set-about" aria-label="앱 정보">
      <h2>앱 정보</h2>
      <div className="kv"><span>서버 주소</span><span className="num" style={{ wordBreak: 'break-all', textAlign: 'right' }}>{typeof location !== 'undefined' ? location.host : ''}</span></div>
      {built && <div className="kv"><span>화면 버전</span><span className="num">{built}</span></div>}
      <p className="small muted" style={{ marginBottom: 0 }}>보기 전용 앱이에요. 주문 기능은 없어요. 투자 판단과 책임은 본인에게 있어요.</p>
    </section>
  );
}
