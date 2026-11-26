import crypto from 'node:crypto';
import { expect, test } from 'vitest';
import { buildAuthorizeUrl, exchangeCode, makePkce } from '../../src/ai/siwcLogin.js';
import { SIWC_TOKEN_URL } from '../../src/ai/siwcConfig.js';
import { fakeFetch } from '../fakeFetch.js';

test('pkce challenge is base64url sha256 of verifier without padding', () => {
  const { verifier, challenge } = makePkce();
  expect(verifier.length).toBeGreaterThanOrEqual(43);
  expect(challenge).toBe(crypto.createHash('sha256').update(verifier).digest('base64url'));
  expect(challenge).not.toContain('=');
});

test('first sign-in uses dynamic client and agent name hint', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: null, redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge: 'C', state: 'S', nonce: 'N', hostId: 'urn:uuid:1' }));
  expect(url.origin + url.pathname).toBe('https://auth.openai.com/api/accounts/authorize');
  const p = Object.fromEntries(url.searchParams);
  expect(p).toMatchObject({
    response_type: 'code', client_id: 'dynamic_agent_client', redirect_uri: 'http://127.0.0.1:1455/auth/callback',
    code_challenge: 'C', code_challenge_method: 'S256', state: 'S', nonce: 'N', resource: 'https://api.openai.com/v1', ext_agent_host_id: 'urn:uuid:1',
  });
  expect(p.scope!.split(' ')).toContain('chatgpt.tokens.use.direct');
  expect(p.agent_name_hint).toBeTruthy();
});

test('later sign-in reuses issued client id without agent name hint', () => {
  const url = new URL(buildAuthorizeUrl({ clientId: 'oaiapp_x', redirectUri: 'http://127.0.0.1:1455/auth/callback', challenge: 'C', state: 'S', nonce: 'N', hostId: 'h' }));
  expect(url.searchParams.get('client_id')).toBe('oaiapp_x');
  expect(url.searchParams.has('agent_name_hint')).toBe(false);
});

test('exchangeCode posts form and maps to SiwcTokens', async () => {
  const f = fakeFetch({ [new URL(SIWC_TOKEN_URL).pathname]: (_u, init) => {
    expect(Object.fromEntries(new URLSearchParams(String(init?.body)))).toEqual({
      grant_type: 'authorization_code', client_id: 'oaiapp_x', code: 'CODE', code_verifier: 'V', redirect_uri: 'http://127.0.0.1:1455/auth/callback', resource: 'https://api.openai.com/v1',
    });
    return { access_token: 'AT', refresh_token: 'RT', id_token: 'IDT', expires_in: 3600, scope: 'openid chatgpt.tokens.use.direct' };
  } });
  const t = await exchangeCode({ clientId: 'oaiapp_x', code: 'CODE', verifier: 'V', redirectUri: 'http://127.0.0.1:1455/auth/callback', fetchImpl: f, now: () => 1000 });
  expect(t).toEqual({ clientId: 'oaiapp_x', accessToken: 'AT', refreshToken: 'RT', idToken: 'IDT', expiresAt: 1000 + 3600_000, scopes: ['openid', 'chatgpt.tokens.use.direct'] });
});

test('exchangeCode without plan scope throws Korean error', async () => {
  const f = fakeFetch({ [new URL(SIWC_TOKEN_URL).pathname]: () => ({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600, scope: 'openid' }) });
  await expect(exchangeCode({ clientId: 'c', code: 'x', verifier: 'v', redirectUri: 'r', fetchImpl: f })).rejects.toThrow(/플랜 사용 권한/);
});
