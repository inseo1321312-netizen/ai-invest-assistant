/**
 * 종목 로고: 서버가 대신 받아서 기억해 두고 앱에 보낸다(앱은 자기 서버 그림만 불러오도록 막혀 있다).
 * - 한국·미국 주식: 네이버 증권 로고(미국은 네이버 코드 AAPL.O 등)
 * - 코인: 업비트 → OKX 순서
 * 없으면 null(앱이 글자 아이콘을 보여준다). 없는 것도 하루 동안 기억한다.
 */
import type { Instrument } from './types.js';
import { parseInstrumentKey } from './types.js';

export interface Logo { type: string; body: Buffer }
export interface Logos { get(key: string): Promise<Logo | null> }

const MAX_BYTES = 200_000;
const MISS_TTL_MS = 24 * 3600_000;
const MAX_ENTRIES = 600;
const NAVER = 'https://ssl.pstatic.net/imgstock/fn/real/logo/png/stock';

export function createLogos(deps: { fetch: typeof fetch; usCode: (inst: Instrument) => Promise<string>; now: () => number }): Logos {
  const cache = new Map<string, { at: number; logo: Logo | null }>();

  async function candidates(inst: Instrument): Promise<string[]> {
    if (inst.market === 'kr') return [`${NAVER}/Stock${inst.symbol}.png`];
    if (inst.market === 'us') return [`${NAVER}/Stock${encodeURIComponent(await deps.usCode(inst))}.png`];
    const base = inst.symbol.split('-')[0]!;
    return [`https://static.upbit.com/logos/${base}.png`, `https://static.okx.com/cdn/oksupport/asset/currency/icon/${base.toLowerCase()}.png`];
  }

  async function download(url: string): Promise<Logo | null> {
    try {
      const res = await deps.fetch(url, { headers: { 'user-agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
      const type = res.headers.get('content-type') ?? '';
      if (!res.ok || !type.startsWith('image/')) return null;
      const body = Buffer.from(await res.arrayBuffer());
      return body.length > 0 && body.length <= MAX_BYTES ? { type: type.split(';')[0]!, body } : null;
    } catch {
      return null;
    }
  }

  return {
    async get(key) {
      let inst: Instrument;
      try { inst = parseInstrumentKey(key); } catch { return null; }
      // 코인은 현물·선물이 같은 로고를 쓴다
      const id = inst.market === 'coin' ? `coin:${inst.symbol.split('-')[0]}` : key;
      const hit = cache.get(id);
      if (hit && (hit.logo || deps.now() - hit.at < MISS_TTL_MS)) return hit.logo;
      let logo: Logo | null = null;
      for (const url of await candidates(inst)) {
        logo = await download(url);
        if (logo) break;
      }
      cache.set(id, { at: deps.now(), logo });
      if (cache.size > MAX_ENTRIES) cache.delete(cache.keys().next().value!);
      return logo;
    },
  };
}
