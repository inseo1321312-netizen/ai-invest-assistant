import crypto from 'node:crypto';
import { z } from 'zod';
import type { Db } from '../db.js';
import { SIWC_PLAN_SCOPE, SIWC_RESOURCE, SIWC_TOKEN_URL, SIWC_UNUSABLE_REFRESH_CODES } from './siwcConfig.js';

const TOKENS_KEY = 'siwc.tokens';
const HOST_KEY = 'siwc.hostId';
const CLIENT_KEY = 'siwc.clientId';
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export class SiwcAuthError extends Error {
  constructor(message = 'ChatGPT 다시 로그인이 필요합니다') {
    super(message);
  }
}

export const siwcTokensSchema = z.object({
  clientId: z.string().min(1),
  accessToken: z.string().min(1),
  refreshToken: z.string().min(1),
  idToken: z.string().nullable(),
  expiresAt: z.number().int().positive(),
  scopes: z.array(z.string()).refine((s) => s.includes(SIWC_PLAN_SCOPE), `${SIWC_PLAN_SCOPE} 권한이 없습니다`),
});
export type SiwcTokens = z.infer<typeof siwcTokensSchema>;

export interface SiwcTokenStore {
  has(): boolean;
  status(): { connected: boolean; expiresAt: number | null };
  getAccessToken(): Promise<string>;
  /** 401을 받았을 때 만료 전이라도 강제로 갱신한다. */
  forceRefresh(): Promise<string>;
  save(t: SiwcTokens): void;
  clear(): void;
  /** 이 서버(VM)의 고정 ext_agent_host_id */
  hostId(): string;
  /** 발급받은 client_id (다음 로그인 때 재사용, 연결을 끊어도 유지) */
  clientId(): string | null;
}

export function createSiwcTokenStore(opts: { db: Db; fetchImpl?: typeof fetch; now?: () => number }): SiwcTokenStore {
  const { db } = opts;
  const doFetch = opts.fetchImpl ?? fetch;
  const now = opts.now ?? (() => Date.now());
  let refreshing: Promise<string> | null = null;

  const load = () => db.kvGet<SiwcTokens>(TOKENS_KEY);

  async function refresh(): Promise<string> {
    const t = load();
    if (!t) throw new SiwcAuthError('ChatGPT 연결이 필요해요. 설정 → AI 연결에서 연결해 주세요');
    const res = await doFetch(SIWC_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'refresh_token', client_id: t.clientId, refresh_token: t.refreshToken, resource: SIWC_RESOURCE }).toString(),
    });
    const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
    if (!res.ok || !json?.access_token) {
      const code = typeof json?.error === 'string' ? json.error : (json?.error as { code?: string } | undefined)?.code;
      if (code && SIWC_UNUSABLE_REFRESH_CODES.has(code)) {
        db.kvDelete(TOKENS_KEY);
        throw new SiwcAuthError();
      }
      if (code === 'invalid_client') throw new SiwcAuthError('ChatGPT 앱 등록 정보가 잘못됐습니다. 다시 로그인하세요');
      throw new Error(`ChatGPT 토큰 갱신 실패 (${res.status})`);
    }
    const next: SiwcTokens = {
      ...t,
      accessToken: String(json.access_token),
      refreshToken: typeof json.refresh_token === 'string' ? json.refresh_token : t.refreshToken,
      idToken: typeof json.id_token === 'string' ? json.id_token : t.idToken,
      expiresAt: now() + (Number(json.expires_in) || 3600) * 1000,
      scopes: typeof json.scope === 'string' ? json.scope.split(' ') : t.scopes,
    };
    db.kvSet(TOKENS_KEY, next); // 회전된 리프레시 토큰을 즉시 저장
    return next.accessToken;
  }

  function singleFlight(): Promise<string> {
    if (!refreshing) refreshing = refresh().finally(() => { refreshing = null; });
    return refreshing;
  }

  return {
    has: () => load() !== null,
    status() {
      const t = load();
      return { connected: t !== null, expiresAt: t?.expiresAt ?? null };
    },
    async getAccessToken() {
      if (refreshing) return refreshing;
      const t = load();
      if (!t) throw new SiwcAuthError('ChatGPT 연결이 필요합니다. 설정에서 안내를 따라 연결하세요');
      if (t.expiresAt - REFRESH_MARGIN_MS > now()) return t.accessToken;
      return singleFlight();
    },
    forceRefresh: singleFlight,
    save(t) {
      const parsed = siwcTokensSchema.parse(t);
      db.kvSet(TOKENS_KEY, parsed);
      db.kvSet(CLIENT_KEY, parsed.clientId);
    },
    clear() {
      db.kvDelete(TOKENS_KEY);
    },
    clientId: () => db.kvGet<string>(CLIENT_KEY),
    hostId() {
      let id = db.kvGet<string>(HOST_KEY);
      if (!id) {
        id = `urn:uuid:${crypto.randomUUID()}`;
        db.kvSet(HOST_KEY, id);
      }
      return id;
    },
  };
}
