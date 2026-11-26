/**
 * 사용자 PC에서 실행: ChatGPT Plus 로그인 → Railway 서버로 토큰 업로드.
 *   npm run siwc:login -w server -- --server https://<앱 주소>
 * 로그인 결과 토큰은 PC에 저장하지 않는다.
 */
import { exec } from 'node:child_process';
import http from 'node:http';
import { createInterface } from 'node:readline/promises';
import { buildAuthorizeUrl, exchangeCode, makePkce, randomToken } from '../src/ai/siwcLogin.js';
import { SIWC_REDIRECT_HOST, SIWC_REDIRECT_PATH, SIWC_REDIRECT_PORT } from '../src/ai/siwcConfig.js';

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? null : null;
}

function openBrowser(url: string) {
  const cmd = process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => undefined);
}

async function main() {
  const server = arg('server')?.replace(/\/$/, '');
  if (!server) throw new Error('사용법: npm run siwc:login -w server -- --server https://<앱 주소>');

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const password = await rl.question('앱 비밀번호: ');
  rl.close();

  const login = await fetch(`${server}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password }) });
  if (!login.ok) throw new Error('앱 로그인 실패: 비밀번호를 확인하세요');
  const cookie = (login.headers.get('set-cookie') ?? '').split(';')[0]!;
  const authed = (path: string, init: RequestInit = {}) => fetch(`${server}${path}`, { ...init, headers: { ...(init.headers ?? {}), cookie, 'content-type': 'application/json' } });

  const { hostId, clientId } = (await (await authed('/api/admin/siwc-host-id')).json()) as { hostId: string; clientId: string | null };
  const { verifier, challenge } = makePkce();
  const state = randomToken();
  const nonce = randomToken();

  const result = await new Promise<{ code: string; clientId: string; redirectUri: string }>((resolve, reject) => {
    const srv = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', `http://${SIWC_REDIRECT_HOST}`);
      if (url.pathname !== SIWC_REDIRECT_PATH) { res.writeHead(404).end(); return; }
      const fail = (msg: string) => { res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8' }).end(msg); srv.close(); reject(new Error(msg)); };
      if (url.searchParams.get('state') !== state) return fail('state가 맞지 않습니다. 다시 시도하세요');
      if (url.searchParams.get('error')) return fail(`로그인이 취소됐습니다: ${url.searchParams.get('error')}`);
      const code = url.searchParams.get('code');
      const issued = url.searchParams.get('client_id') ?? clientId;
      if (!code || !issued) return fail('로그인 코드가 없습니다');
      res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' }).end('로그인 완료. 이 창을 닫고 터미널로 돌아가세요.');
      srv.close();
      resolve({ code, clientId: issued, redirectUri });
    });
    let redirectUri = '';
    srv.on('error', reject);
    // 시작 포트가 사용 중이면 다른 포트를 쓴다(scheme·host·path는 같다).
    srv.listen(SIWC_REDIRECT_PORT, SIWC_REDIRECT_HOST).on('error', () => srv.listen(0, SIWC_REDIRECT_HOST));
    srv.on('listening', () => {
      const port = (srv.address() as { port: number }).port;
      redirectUri = `http://${SIWC_REDIRECT_HOST}:${port}${SIWC_REDIRECT_PATH}`;
      const url = buildAuthorizeUrl({ clientId, redirectUri, challenge, state, nonce, hostId });
      console.log('브라우저에서 ChatGPT 로그인 창을 엽니다. 안 열리면 아래 주소를 직접 여세요:\n' + url);
      openBrowser(url);
    });
  });

  const tokens = await exchangeCode({ clientId: result.clientId, code: result.code, verifier, redirectUri: result.redirectUri });
  const up = await authed('/api/admin/siwc-tokens', { method: 'POST', body: JSON.stringify(tokens) });
  if (!up.ok) throw new Error(`서버에 저장하지 못했습니다 (${up.status})`);
  console.log('ChatGPT Plus 연결 완료. 이제 앱에서 GPT를 쓸 수 있습니다.');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
