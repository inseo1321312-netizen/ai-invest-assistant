import { existsSync } from 'node:fs';
import fastifyStatic from '@fastify/static';
import type { FastifyInstance } from 'fastify';

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join('; ');

export async function registerStatic(app: FastifyInstance, webDist: string | undefined) {
  app.addHook('onSend', async (_req, reply) => {
    reply.header('content-security-policy', CSP);
    reply.header('x-content-type-options', 'nosniff');
    reply.header('referrer-policy', 'no-referrer');
    reply.header('x-frame-options', 'DENY');
  });

  const hasWeb = Boolean(webDist && existsSync(webDist));
  if (hasWeb) {
    await app.register(fastifyStatic, {
      root: webDist!,
      // 파일을 요청 때마다 찾는다: 다시 빌드해 이름이 바뀐 파일도 서버를 껐다 켜지 않고 제공된다.
      wildcard: true,
      setHeaders(res, filePath) {
        // index.html과 서비스 워커는 항상 새로 받게 한다(업데이트가 바로 반영되도록).
        if (/index\.html$|sw\.js$|manifest\.webmanifest$/.test(filePath)) res.header('cache-control', 'no-cache');
        else if (/[\\/]assets[\\/]/.test(filePath)) res.header('cache-control', 'public, max-age=31536000, immutable');
      },
    });
  }

  app.setNotFoundHandler(async (req, reply) => {
    const pathOnly = req.url.split('?')[0] ?? '';
    // 없는 파일(확장자가 있거나 /assets/ 아래)에는 화면 HTML 대신 404를 준다.
    const looksLikeFile = /\.[a-z0-9]+$/i.test(pathOnly) || pathOnly.startsWith('/assets/');
    if (req.url.startsWith('/api/') || !hasWeb || req.method !== 'GET' || looksLikeFile) {
      return reply.code(404).send({ error: '없는 주소입니다' });
    }
    reply.header('cache-control', 'no-cache');
    return reply.sendFile('index.html');
  });
}
