/** 이 기기에만 저장하는 화면 설정 */
export type Theme = 'system' | 'light' | 'dark';
export type UpDown = 'kr' | 'global';
export interface Prefs { theme: Theme; updown: UpDown }

const KEY = 'prefs';
const DEFAULTS: Prefs = { theme: 'system', updown: 'kr' };

export function readPrefs(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? 'null') as Partial<Prefs> | null;
    return {
      theme: v?.theme === 'light' || v?.theme === 'dark' ? v.theme : 'system',
      updown: v?.updown === 'global' ? 'global' : 'kr',
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function savePrefs(p: Prefs): void {
  try { localStorage.setItem(KEY, JSON.stringify(p)); } catch { /* 저장소를 못 쓰면 이번만 적용 */ }
}

/** <html data-theme="dark|light">(휴대폰 설정이면 속성 없음), data-updown="kr|global" */
export function applyPrefs(p: Prefs, doc: Document = document): void {
  const root = doc.documentElement;
  if (p.theme === 'system') delete root.dataset.theme;
  else root.dataset.theme = p.theme;
  root.dataset.updown = p.updown;
  // 상태 막대 색도 맞춘다
  const dark = p.theme === 'dark' || (p.theme === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches);
  for (const m of doc.querySelectorAll<HTMLMetaElement>('meta[name="theme-color"]')) {
    if (p.theme === 'system') { m.content = m.media.includes('dark') ? '#080b14' : '#f3f4f8'; continue; }
    m.content = dark ? '#080b14' : '#f3f4f8';
  }
}
