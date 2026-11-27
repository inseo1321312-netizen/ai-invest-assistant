/**
 * 앱 설정 화면에서 넣은 Claude·ChatGPT API 키.
 * DB(바깥 저장소로도 복사됨)에는 SESSION_SECRET으로 암호화해서 넣고, 화면에는 끝 4자리만 보낸다.
 * 앱에서 넣은 키가 없으면 서버 환경 변수(ANTHROPIC_API_KEY, OPENAI_API_KEY)를 쓴다.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Db } from '../db.js';

export type KeyProvider = 'claude' | 'openai';
export interface KeyInfo { set: boolean; source: 'app' | 'server' | null; tail: string | null }
export interface ApiKeys {
  get(p: KeyProvider): string | null;
  info(p: KeyProvider): KeyInfo;
  set(p: KeyProvider, key: string): void;
  clear(p: KeyProvider): void;
}
export type VerifyResult = 'ok' | 'bad' | 'unreachable';

const kvKey = (p: KeyProvider) => `secret.apiKey.${p}`;

export function createApiKeys(deps: { db: Db; secret: string; env: Record<KeyProvider, string | null> }): ApiKeys {
  const aesKey = createHash('sha256').update(`api-keys:${deps.secret}`).digest();
  const cache = new Map<KeyProvider, string | null>();

  function encrypt(plain: string): string {
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', aesKey, iv);
    const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString('base64');
  }

  function decrypt(stored: string): string | null {
    try {
      const raw = Buffer.from(stored, 'base64');
      const d = createDecipheriv('aes-256-gcm', aesKey, raw.subarray(0, 12));
      d.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([d.update(raw.subarray(28)), d.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  function appKey(p: KeyProvider): string | null {
    if (!cache.has(p)) {
      const stored = deps.db.kvGet<string>(kvKey(p));
      cache.set(p, stored ? decrypt(stored) : null);
    }
    return cache.get(p) ?? null;
  }

  return {
    get: (p) => appKey(p) ?? deps.env[p],
    info(p) {
      const own = appKey(p);
      const key = own ?? deps.env[p];
      return { set: key !== null, source: own ? 'app' : key ? 'server' : null, tail: key ? key.slice(-4) : null };
    },
    set(p, key) {
      deps.db.kvSet(kvKey(p), encrypt(key));
      cache.set(p, key);
    },
    clear(p) {
      deps.db.kvDelete(kvKey(p));
      cache.set(p, null);
    },
  };
}

/** 모양만 먼저 본다(공백·이상한 글자 거르기) */
export function checkKeyShape(p: KeyProvider, key: string): boolean {
  if (!/^[A-Za-z0-9_-]{20,300}$/.test(key)) return false;
  return p === 'claude' ? key.startsWith('sk-ant-') : key.startsWith('sk-') && !key.startsWith('sk-ant-');
}

/** 모델 목록을 한 번 불러 키가 맞는지 본다(요금 없음) */
export async function verifyKey(p: KeyProvider, key: string, fetchImpl: typeof fetch = fetch): Promise<VerifyResult> {
  const req: { url: string; headers: Record<string, string> } = p === 'claude'
    ? { url: 'https://api.anthropic.com/v1/models?limit=1', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' } }
    : { url: 'https://api.openai.com/v1/models', headers: { authorization: `Bearer ${key}` } };
  try {
    const res = await fetchImpl(req.url, { headers: req.headers, signal: AbortSignal.timeout(15_000) });
    if (res.ok) return 'ok';
    return res.status === 401 || res.status === 403 ? 'bad' : 'unreachable';
  } catch {
    return 'unreachable';
  }
}
