import type { FastifyReply } from 'fastify';

/** 이벤트를 SSE로 흘려보낸다. 클라이언트가 끊으면 abort로 AI 호출을 멈춘다. */
export async function sendSse(reply: FastifyReply, events: AsyncIterable<{ type: string }>, abort: AbortController): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  let closed = false;
  raw.on('close', () => { closed = true; abort.abort(); });
  const ping = setInterval(() => { if (!closed) raw.write(': ping\n\n'); }, 15_000);
  try {
    for await (const ev of events) {
      if (closed) break;
      raw.write(`event: ${ev.type}\ndata: ${JSON.stringify(ev)}\n\n`);
    }
  } catch {
    if (!closed) raw.write(`event: error\ndata: ${JSON.stringify({ type: 'error', code: 'provider', message: '처리 중 오류가 났습니다' })}\n\n`);
  } finally {
    clearInterval(ping);
    raw.end();
  }
}
