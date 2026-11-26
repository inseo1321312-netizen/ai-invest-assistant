import crypto from 'node:crypto';
import cookie from '@fastify/cookie';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from './app.js';

const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 3600 * 1000;
const FAIL_WINDOW_MS = 10 * 60 * 1000;
const FAIL_LIMIT = 5;
const PUBLIC_PATHS = new Set(['/api/health', '/api/login', '/api/me']);
export const SESSION_COOKIE = 'sid';

/** 퍼센트 인코딩을 풀고 소문자로 바꾼 경로(쿼리 제외). 잘못된 인코딩이면 원래 값을 쓴다. */
function decodedPath(rawUrl: string): string {
  const p = rawUrl.split('?')[0] ?? '';
  let out = p;
  for (let i = 0; i < 3; i++) {
    try {
      const next = decodeURIComponent(out);
      if (next === out) break;
      out = next;
    } catch {
      break;
    }
  }
  return out.toLowerCase();
}

function hash(s: string): Buffer {
  return crypto.createHash('sha256').update(s, 'utf8').digest();
}

export async function registerAuth(app: FastifyInstance, deps: AppDeps): Promise<void> {
  const { db, config, now } = deps;
  await app.register(cookie, { secret: config.sessionSecret });

  const insert = db.sql.prepare('INSERT INTO sessions (id, created_at, expires_at) VALUES (?, ?, ?)');
  const find = db.sql.prepare('SELECT expires_at FROM sessions WHERE id = ?');
  const remove = db.sql.prepare('DELETE FROM sessions WHERE id = ?');
  const purge = db.sql.prepare('DELETE FROM sessions WHERE expires_at < ?');
  const expected = hash(config.appPassword);
  let failures: number[] = [];

  function sessionId(req: FastifyRequest): string | null {
    const raw = req.cookies[SESSION_COOKIE];
    if (!raw) return null;
    const un = req.unsignCookie(raw);
    if (!un.valid || !un.value) return null;
    const row = find.get(un.value) as { expires_at: number } | undefined;
    if (!row || row.expires_at <= now()) return null;
    return un.value;
  }

  app.decorateRequest('sessionId', null);

  // 주소 문자열(인코딩 가능)이 아니라 실제로 연결된 경로로 판단한다. 공개 경로가 아니면 기본 차단.
  app.addHook('onRequest', async (req, reply) => {
    const route = req.routeOptions?.url;
    const path = decodedPath(req.url);
    const isApi = (route !== undefined && route.startsWith('/api')) || path.startsWith('/api');
    if (!isApi) return;
    const sid = sessionId(req);
    (req as FastifyRequest & { sessionId: string | null }).sessionId = sid;
    if (route !== undefined && PUBLIC_PATHS.has(route)) return;
    if (!sid) return reply.code(401).send({ error: '로그인이 필요합니다' });
  });

  app.post('/api/login', async (req, reply) => {
    const t = now();
    failures = failures.filter((f) => t - f < FAIL_WINDOW_MS);
    if (failures.length >= FAIL_LIMIT) {
      return reply.code(429).send({ error: '로그인 시도가 너무 많습니다. 10분 뒤에 다시 시도하세요' });
    }
    const body = z.object({ password: z.string().max(200) }).safeParse(req.body);
    const ok = body.success && crypto.timingSafeEqual(hash(body.data.password), expected);
    if (!ok) {
      failures.push(t);
      return reply.code(401).send({ error: '비밀번호가 틀렸습니다' });
    }
    failures = [];
    purge.run(t);
    const id = crypto.randomBytes(32).toString('base64url');
    insert.run(id, t, t + SESSION_MS);
    reply.setCookie(SESSION_COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: config.production,
      signed: true,
      maxAge: SESSION_MS / 1000,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const sid = (req as FastifyRequest & { sessionId: string | null }).sessionId;
    if (sid) remove.run(sid);
    reply.clearCookie(SESSION_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req) => ({
    loggedIn: Boolean((req as FastifyRequest & { sessionId: string | null }).sessionId),
  }));
}
