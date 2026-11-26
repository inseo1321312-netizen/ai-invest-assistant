/**
 * Sign in with ChatGPT(SIWC) "ChatGPT plan usage" 설정값.
 * 출처 (2026-11-26 확인):
 *  - https://developers.openai.com/siwc/token-sharing-open-source/sign-in
 *  - https://developers.openai.com/siwc/token-sharing-open-source/token-reference
 *  - https://developers.openai.com/siwc/token-sharing-open-source/profiles-and-sessions
 *  - https://developers.openai.com/siwc/token-sharing-open-source/errors-and-recovery
 *  - https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms
 *  - https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations
 * 주의: 로그인 페이지 일부(authorize 주소, scope 목록)는 요약본으로 확인했다. 처음 로그인할 때 문서와 다시 대조한다.
 */
export const SIWC_AUTHORIZE_URL = 'https://auth.openai.com/api/accounts/authorize';
export const SIWC_TOKEN_URL = 'https://auth.openai.com/api/accounts/oauth/token';
/** 처음 로그인할 때만 쓰는 동적 등록 client_id. 콜백이 oaiapp_… 형태의 실제 client_id를 돌려준다. */
export const SIWC_DYNAMIC_CLIENT_ID = 'dynamic_agent_client';
export const SIWC_AGENT_NAME = 'AI 투자 비서 (open source)';
export const SIWC_RESOURCE = 'https://api.openai.com/v1';
export const SIWC_PLAN_SCOPE = 'chatgpt.tokens.use.direct';
export const SIWC_SCOPES = ['openid', 'profile', 'email', 'offline_access', 'resource.invoke', SIWC_PLAN_SCOPE];
/** 127.0.0.1만 쓴다(localhost 아님). 포트는 바뀌어도 되지만 scheme·host·path는 같아야 한다. */
export const SIWC_REDIRECT_HOST = '127.0.0.1';
export const SIWC_REDIRECT_PORT = 1455;
export const SIWC_REDIRECT_PATH = '/auth/callback';
export const OPENAI_BASE_URL = 'https://api.openai.com/v1';

/** 이 코드들이 오면 리프레시 토큰은 더 쓸 수 없다 → 지우고 다시 로그인. */
export const SIWC_UNUSABLE_REFRESH_CODES = new Set([
  'invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused',
]);

export const SIWC_USAGE_LIMIT_CODE = 'subscription_sharing_usage_limit_exceeded';
export const SIWC_AUTH_CODES = new Set(['subscription_sharing_invalid_user', 'chatpass_v2_scope_not_authorized', 'chatpass_v2_invalid_authorization_context']);
