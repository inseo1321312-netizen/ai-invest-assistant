export type SseHandler = (type: string, data: any) => void;

/** 조각난 SSE 텍스트를 받아 완성된 이벤트마다 handler를 부른다. */
export function createSseParser(handler: SseHandler) {
  let buf = '';
  return {
    feed(chunk: string) {
      buf += chunk.replace(/\r\n/g, '\n');
      let idx: number;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let type = 'message';
        const data: string[] = [];
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) continue;
          if (line.startsWith('event:')) type = line.slice(6).trim();
          else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
        }
        if (!data.length) continue;
        try { handler(type, JSON.parse(data.join('\n'))); } catch { /* 깨진 이벤트는 무시 */ }
      }
    },
  };
}

/** POST 요청을 보내고 SSE 응답을 끝까지 읽는다. */
export async function streamSse(path: string, body: unknown, onEvent: SseHandler, signal?: AbortSignal): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (err) {
    if ((err as Error).name === 'AbortError') return;
    onEvent('error', { type: 'error', code: 'provider', message: '서버에 연결하지 못했습니다' });
    return;
  }
  if (!res.ok || !res.headers.get('content-type')?.includes('text/event-stream')) {
    const j = (await res.json().catch(() => null)) as { error?: string } | null;
    onEvent('error', { type: 'error', code: res.status === 401 ? 'auth' : 'provider', message: j?.error ?? '요청을 처리하지 못했습니다' });
    return;
  }
  const parser = createSseParser(onEvent);
  if (!res.body) {
    parser.feed(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parser.feed(dec.decode(value, { stream: true }));
    }
    parser.feed(dec.decode() + '\n\n');
  } catch (err) {
    if ((err as Error).name !== 'AbortError') onEvent('error', { type: 'error', code: 'provider', message: '연결이 끊겼습니다' });
  }
}
