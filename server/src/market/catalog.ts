/** 세 시장 종목의 이름과 검색. 종목 목록은 메모리에만 두고 하루에 한 번 새로 받는다. */
import type { KrMasterRow, UsMasterRow } from './masters.js';
import type { OkxTicker } from './okx.js';
import type { MarketId } from './types.js';
import type { UpbitMarket } from './upbit.js';

export interface SearchHit { key: string; market: MarketId; name: string; symbol: string }

export interface InstrumentCatalog {
  search(q: string, limit?: number): Promise<SearchHit[]>;
  /** 화면에 보일 이름. 불러오기 전이거나 모르면 null */
  nameOf(key: string): string | null;
  koreanCoinName(base: string): string | null;
  /** 국내 종목 한글명(정확히 같은 이름)으로 6자리 코드를 찾는다 */
  findKrCode(name: string): string | null;
  warm(): Promise<void>;
}

interface Entry { hit: SearchHit; aliases: string[]; weight: number }

const REFRESH_MS = 24 * 3600_000;
const RETRY_MS = 5 * 60_000;
const norm = (s: string) => s.replace(/\s+/g, '').toUpperCase();

export function createInstrumentCatalog(deps: {
  now: () => number;
  loadMasters: () => Promise<{ kr: KrMasterRow[]; us: UsMasterRow[] }>;
  okx: { getTickers(instType: 'SPOT'): Promise<OkxTicker[]> };
  upbit: { markets(): Promise<UpbitMarket[]> };
}): InstrumentCatalog {
  let stocks: Entry[] = [];
  let coins: Entry[] = [];
  const names = new Map<string, string>();
  const coinKo = new Map<string, string>();
  const krByName = new Map<string, string>();
  /** 부분별 상태: 실패하면 RETRY_MS 뒤 다시, 성공하면 하루 뒤 새로 */
  const parts = {
    stocks: { at: 0, ok: false, loading: null as Promise<void> | null },
    coins: { at: 0, ok: false, loading: null as Promise<void> | null },
  };

  async function loadStocks() {
    const m = await deps.loadMasters();
    const next: Entry[] = [];
    for (const r of m.kr) next.push({ hit: { key: `kr:${r.code}`, market: 'kr', name: r.name, symbol: r.code }, aliases: [norm(r.name), r.code], weight: r.cap });
    for (const r of m.us) {
      const name = r.koName || r.enName || r.symbol;
      next.push({ hit: { key: `us:${r.exchange}:${r.symbol}`, market: 'us', name, symbol: r.symbol }, aliases: [norm(r.koName), norm(r.enName), r.symbol].filter(Boolean), weight: 0 });
    }
    if (next.length === 0) throw new Error('종목 목록이 비어 있습니다');
    stocks = next;
    for (const e of next) names.set(e.hit.key, e.hit.name);
    krByName.clear();
    for (const r of m.kr) if (!krByName.has(r.name)) krByName.set(r.name, r.code);
  }

  async function loadCoins() {
    // 업비트 한글명은 OKX가 실패해도 먼저 채운다(알림 제목·뉴스 검색어에 쓰인다)
    const markets = await deps.upbit.markets().catch(() => [] as UpbitMarket[]);
    const en = new Map<string, string>();
    for (const m of markets) {
      const base = m.market.split('-')[1];
      if (!base) continue;
      if (!coinKo.has(base)) coinKo.set(base, m.koreanName);
      if (!en.has(base)) en.set(base, m.englishName);
    }
    const tickers = await deps.okx.getTickers('SPOT');
    const next: Entry[] = [];
    for (const t of tickers) {
      const m = /^([A-Z0-9]+)-USDT$/.exec(t.instId);
      if (!m) continue;
      const base = m[1]!;
      const ko = coinKo.get(base) ?? null;
      next.push({
        hit: { key: `coin:${base}-USDT`, market: 'coin', name: ko ?? base, symbol: base },
        aliases: [ko ? norm(ko) : '', base, norm(en.get(base) ?? '')].filter(Boolean),
        weight: t.volCcy24h,
      });
    }
    if (next.length === 0) throw new Error('코인 목록이 비어 있습니다');
    coins = next;
  }

  function run(name: 'stocks' | 'coins', fn: () => Promise<void>): Promise<void> {
    const p = parts[name];
    p.loading ??= fn()
      .then(() => { p.ok = true; })
      .catch((err) => { p.ok = false; console.error(`종목 목록 실패(${name})`, err instanceof Error ? err.message : err); })
      .finally(() => { p.at = deps.now(); p.loading = null; });
    return p.loading;
  }

  async function ensure() {
    const now = deps.now();
    const waits: Promise<void>[] = [];
    for (const [name, fn] of [['stocks', loadStocks], ['coins', loadCoins]] as const) {
      const p = parts[name];
      if (p.at === 0 || (!p.ok && now - p.at >= RETRY_MS)) waits.push(run(name, fn));
      else if (p.ok && now - p.at > REFRESH_MS) void run(name, fn);
    }
    await Promise.all(waits);
  }

  return {
    async search(q, limit = 30) {
      const n = norm(q);
      if (!n) return [];
      await ensure();
      const scored: { e: Entry; stage: number }[] = [];
      for (const e of [...coins, ...stocks]) {
        let stage = 3;
        for (const a of e.aliases) {
          if (a === n) { stage = 0; break; }
          if (a.startsWith(n)) stage = Math.min(stage, 1);
          else if (a.includes(n)) stage = Math.min(stage, 2);
        }
        if (stage < 3) scored.push({ e, stage });
      }
      scored.sort((a, b) => a.stage - b.stage
        // 같은 시장끼리는 큰 것 먼저(코인은 거래대금, 한국 주식은 시가총액)
        || (a.e.hit.market === b.e.hit.market && a.e.hit.market !== 'us' ? b.e.weight - a.e.weight : 0)
        || a.e.hit.name.length - b.e.hit.name.length
        || a.e.hit.name.localeCompare(b.e.hit.name));
      return scored.slice(0, limit).map((s) => s.e.hit);
    },

    nameOf(key) {
      if (key.startsWith('coin:')) {
        const base = key.slice(5).split('-')[0] ?? '';
        return coinKo.get(base) ?? null;
      }
      return names.get(key) ?? null;
    },

    koreanCoinName: (base) => coinKo.get(base) ?? null,
    findKrCode: (name) => krByName.get(name.trim()) ?? null,
    warm: () => ensure(),
  };
}
