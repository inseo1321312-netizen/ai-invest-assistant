/**
 * 아이폰 키보드: 키보드가 올라와도 화면(레이아웃) 크기는 그대로이고 보이는 부분만 줄어든다.
 * 보이는 부분의 높이·위치와 키보드가 가린 높이를 CSS 변수로 알려서
 * 입력창·시트·채팅이 키보드 바로 위에 붙게 한다.
 *   --vv-h: 보이는 높이, --vv-top: 보이는 부분의 위쪽 위치, --kb: 키보드가 가린 높이
 *   :root.kb-open: 키보드가 열려 있음(아래 메뉴를 숨긴다)
 */
/** 지난번 키보드 높이: 다음에 입력칸을 누르면 키보드가 다 올라오기 전에 미리 비켜 둔다 */
let lastKb = 0;

export function watchViewport(win: Window = window, doc: Document = document): () => void {
  const vv = win.visualViewport;
  if (!vv) return () => undefined;
  const root = doc.documentElement;

  const typing = () => {
    const el = doc.activeElement;
    if (el instanceof HTMLTextAreaElement) return true;
    if (el instanceof HTMLInputElement) return !['checkbox', 'radio', 'range', 'button', 'submit'].includes(el.type);
    return el instanceof HTMLElement && el.isContentEditable;
  };

  const update = () => {
    const covered = Math.round(win.innerHeight - vv.height - vv.offsetTop);
    // 손가락으로 확대한 것(scale>1)은 키보드가 아니다
    const open = typing() && vv.scale < 1.05 && win.innerHeight - vv.height > 120;
    root.classList.toggle('kb-open', open);
    if (open) {
      lastKb = Math.round(win.innerHeight - vv.height);
      root.style.setProperty('--kb', `${Math.max(0, covered)}px`);
      root.style.setProperty('--vv-h', `${Math.round(vv.height)}px`);
      root.style.setProperty('--vv-top', `${Math.round(vv.offsetTop)}px`);
    } else {
      root.style.removeProperty('--kb');
      root.style.removeProperty('--vv-h');
      root.style.removeProperty('--vv-top');
    }
  };

  // 키보드가 닫힐 때 아이폰이 화면을 밀어 올린 채로 두는 일이 있어 제자리로 돌린다
  const blur = () => setTimeout(() => {
    update();
    if (!typing() && vv.offsetTop > 0) win.scrollTo(win.scrollX, win.scrollY);
  }, 60);

  let settle: ReturnType<typeof setTimeout> | undefined;
  const focus = () => {
    clearTimeout(settle);
    if (typing() && lastKb > 0 && !root.classList.contains('kb-open')) {
      root.classList.add('kb-open');
      root.style.setProperty('--kb', `${lastKb}px`);
      root.style.setProperty('--vv-h', `${Math.round(win.innerHeight - lastKb)}px`);
      root.style.setProperty('--vv-top', '0px');
      // 키보드가 안 올라오면(블루투스 키보드 등) 짐작을 거둔다
      settle = setTimeout(update, 700);
    } else {
      update();
    }
  };

  vv.addEventListener('resize', update);
  vv.addEventListener('scroll', update);
  doc.addEventListener('focusin', focus);
  doc.addEventListener('focusout', blur);
  update();
  return () => {
    vv.removeEventListener('resize', update);
    vv.removeEventListener('scroll', update);
    doc.removeEventListener('focusin', focus);
    clearTimeout(settle);
    doc.removeEventListener('focusout', blur);
  };
}

/**
 * 앱 화면 확대 막기: 아이폰은 두 손가락으로 벌리면 페이지가 확대된다(gesture 이벤트).
 * 페이지 확대만 막고 터치는 그대로라 차트의 두 손가락 확대는 계속 된다.
 */
export function blockZoom(doc: Document = document): () => void {
  const stop = (e: Event) => e.preventDefault();
  const opts = { passive: false } as AddEventListenerOptions;
  for (const t of ['gesturestart', 'gesturechange', 'gestureend']) doc.addEventListener(t, stop, opts);
  return () => { for (const t of ['gesturestart', 'gesturechange', 'gestureend']) doc.removeEventListener(t, stop, opts); };
}
