import crypto from 'node:crypto';
import {
  SIWC_AGENT_NAME, SIWC_AUTHORIZE_URL, SIWC_DYNAMIC_CLIENT_ID, SIWC_PLAN_SCOPE, SIWC_RESOURCE, SIWC_SCOPES, SIWC_TOKEN_URL,
} from './siwcConfig.js';
import type { SiwcTokens } from './siwcTokens.js';

export function makePkce(): { verifier: string; challenge: string } {
  const verifier = crypto.randomBytes(48).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export function randomToken(): string {
  return crypto.randomBytes(24).toString('base64url');
}

export function buildAuthorizeUrl(p: { clientId: string | null; redirectUri: string; challenge: string; state: string; nonce: string; hostId: string }): string {
  const url = new URL(SIWC_AUTHORIZE_URL);
  const q = url.searchParams;
  q.set('response_type', 'code');
  q.set('client_id', p.clientId ?? SIWC_DYNAMIC_CLIENT_ID);
  q.set('redirect_uri', p.redirectUri);
  q.set('scope', SIWC_SCOPES.join(' '));
  q.set('code_challenge', p.challenge);
  q.set('code_challenge_method', 'S256');
  q.set('state', p.state);
  q.set('nonce', p.nonce);
  q.set('resource', SIWC_RESOURCE);
  q.set('ext_agent_host_id', p.hostId);
  if (!p.clientId) q.set('agent_name_hint', SIWC_AGENT_NAME);
  return url.toString();
}

export async function exchangeCode(p: { clientId: string; code: string; verifier: string; redirectUri: string; fetchImpl?: typeof fetch; now?: () => number }): Promise<SiwcTokens> {
  const res = await (p.fetchImpl ?? fetch)(SIWC_TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code', client_id: p.clientId, code: p.code, code_verifier: p.verifier, redirect_uri: p.redirectUri, resource: SIWC_RESOURCE,
    }).toString(),
  });
  const json = (await res.json().catch(() => null)) as Record<string, unknown> | null;
  if (!res.ok || !json?.access_token || !json.refresh_token) {
    throw new Error(`ChatGPT 로그인 코드 교환 실패 (${res.status}) ${JSON.stringify(json?.error ?? '')}`);
  }
  const scopes = typeof json.scope === 'string' ? json.scope.split(' ') : [];
  if (!scopes.includes(SIWC_PLAN_SCOPE)) throw new Error('ChatGPT 플랜 사용 권한이 허락되지 않았습니다. 동의 화면에서 허용했는지 확인하세요');
  return {
    clientId: p.clientId,
    accessToken: String(json.access_token),
    refreshToken: String(json.refresh_token),
    idToken: typeof json.id_token === 'string' ? json.id_token : null,
    expiresAt: (p.now ?? Date.now)() + (Number(json.expires_in) || 3600) * 1000,
    scopes,
  };
}
