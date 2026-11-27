/**
 * Render 무료 서버는 15분 동안 들어오는 요청이 없으면 잠든다.
 * 깃허브 예약 작업만으로는 자주 밀려서(몇 시간씩) 서버가 자기 공개 주소를 직접 부른다.
 * 공개 주소로 나갔다 들어오는 요청이라 Render는 바깥 요청으로 센다.
 */
export function createKeepAwake(deps: { fetch: typeof fetch; url: string }): () => Promise<void> {
  const target = `${deps.url.replace(/\/+$/, '')}/api/health`;
  return async () => {
    try {
      await deps.fetch(target, { signal: AbortSignal.timeout(30_000) });
    } catch {
      /* 다음 차례에 다시 부른다 */
    }
  };
}
