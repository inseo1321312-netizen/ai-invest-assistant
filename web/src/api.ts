export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, {
      credentials: 'same-origin',
      ...init,
      headers: { ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, '서버에 연결하지 못했습니다. 인터넷 연결을 확인하세요');
  }
  const body = (await res.json().catch(() => null)) as { error?: string } | null;
  if (res.status === 401 && path !== '/api/login') {
    onUnauthorized?.();
    throw new ApiError(401, '로그인이 필요합니다');
  }
  if (!res.ok) throw new ApiError(res.status, body?.error ?? '요청을 처리하지 못했습니다');
  return body as T;
}

export const post = <T>(path: string, data: unknown) => api<T>(path, { method: 'POST', body: JSON.stringify(data) });
