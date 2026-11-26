export interface FakeCall { url: URL; init: RequestInit | undefined }
export type FakeHandler = (url: URL, init: RequestInit | undefined) => unknown | Response | Promise<unknown | Response>;

/**
 * 경로(pathname) 기준으로 응답을 돌려주는 가짜 fetch.
 * 핸들러가 Response를 돌려주면 그대로, 아니면 JSON 200으로 감싼다.
 */
export function fakeFetch(routes: Record<string, FakeHandler>) {
  const calls: FakeCall[] = [];
  const fn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url);
    calls.push({ url, init });
    const handler = routes[url.pathname];
    if (!handler) return new Response(JSON.stringify({ error: `no route ${url.pathname}` }), { status: 404 });
    const out = await handler(url, init);
    if (out instanceof Response) return out;
    return new Response(JSON.stringify(out), { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch & { calls: FakeCall[]; count(path: string): number };
  fn.calls = calls;
  fn.count = (path: string) => calls.filter((c) => c.url.pathname === path).length;
  return fn;
}
