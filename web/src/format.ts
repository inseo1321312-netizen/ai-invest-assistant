import type { Currency, Horizon, MarketId } from './types';

/** 가격 단위: 원래 단위 또는 원화(달러·USDT를 환율로 바꿔 보여 준다) */
let priceUnit: 'native' | 'krw' = 'native';
let usdKrw: number | null = null;
export function setPriceUnit(u: 'native' | 'krw'): void { priceUnit = u; }
export function setUsdKrw(rate: number | null): void { usdKrw = rate && rate > 0 ? rate : null; }
/** 지금 원화로 바꿔 보여 주는 중인지 */
export const wonMode = (): boolean => priceUnit === 'krw' && usdKrw !== null;

function formatWon(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 100) return `${Math.round(v).toLocaleString('ko-KR')}원`;
  if (abs >= 1) return `${v.toLocaleString('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}원`;
  return `${v.toLocaleString('ko-KR', { maximumSignificantDigits: 3 })}원`;
}

export function formatPrice(n: number, currency: Currency): string {
  if (currency === 'KRW') return `${Math.round(n).toLocaleString('ko-KR')}원`;
  if (priceUnit === 'krw' && usdKrw) return formatWon(n * usdKrw);
  const abs = Math.abs(n);
  const opts: Intl.NumberFormatOptions = abs >= 100
    ? { maximumFractionDigits: 2 }
    : abs >= 1
      ? { minimumFractionDigits: 2, maximumFractionDigits: 4 }
      : { maximumSignificantDigits: 4 };
  if (currency === 'USD') return `$${n.toLocaleString('en-US', abs >= 1 ? { minimumFractionDigits: 2, maximumFractionDigits: 2 } : opts)}`;
  return `${n.toLocaleString('en-US', opts)} USDT`;
}

export function formatKrwApprox(n: number): string {
  const v = Math.round(n);
  if (Math.abs(v) >= 1e8) {
    const eok = Math.trunc(v / 1e8);
    const man = Math.round((Math.abs(v) % 1e8) / 1e4);
    return man ? `≈ ${eok}억 ${man.toLocaleString('ko-KR')}만원` : `≈ ${eok}억원`;
  }
  if (Math.abs(v) >= 1e4) return `≈ ${Math.round(v / 1e4).toLocaleString('ko-KR')}만원`;
  return `≈ ${v.toLocaleString('ko-KR')}원`;
}

export function formatPct(n: number): string {
  const s = n.toFixed(1);
  if (s === '0.0' || s === '-0.0') return '0.0%';
  return `${n > 0 ? '+' : ''}${s}%`;
}

function kstIso(unixSec: number): string {
  return new Date(unixSec * 1000 + 9 * 3600_000).toISOString();
}

export function formatTimeKst(unixSec: number): string {
  const iso = kstIso(unixSec);
  return `${iso.slice(5, 10)} ${iso.slice(11, 16)}`;
}

export function formatDateTimeKst(unixSec: number): string {
  const iso = kstIso(unixSec);
  return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
}

export const HORIZON_LABEL: Record<Horizon, string> = { scalp: '단타', swing: '스윙', long: '장기' };
export const MARKET_LABEL: Record<MarketId, string> = { coin: '코인', kr: '한국주식', us: '미국주식' };

/** 사용자가 입력한 종목 이름을 서버 종목 키로 바꾼다. 못 바꾸면 null. */
export function parseUserSymbol(market: MarketId, input: string): string | null {
  const s = input.trim().toUpperCase();
  if (market === 'coin') {
    if (/^[A-Z0-9]+$/.test(s)) return `coin:${s}-USDT`;
    if (/^[A-Z0-9]+-[A-Z0-9]+(-SWAP)?$/.test(s)) return `coin:${s}`;
    return null;
  }
  if (market === 'kr') return /^[0-9A-Z]{6}$/.test(s) ? `kr:${s}` : null;
  const m = /^(?:(NAS|NYS|AMS):)?([A-Z0-9.-]{1,10})$/.exec(s);
  return m ? `us:${m[1] ?? 'NAS'}:${m[2]}` : null;
}

/** 종목 키 → 아이콘에 쓸 정보 */
export function parseKey(key: string, name: string | null = null): { market: MarketId; symbol: string; name: string | null; exchange: string | null } {
  const [market, a, b] = key.split(':');
  if (market === 'us') return { market: 'us', symbol: b ?? '', name, exchange: a ?? null };
  return { market: (market as MarketId) ?? 'coin', symbol: a ?? '', name, exchange: null };
}

export function changeClass(n: number | null | undefined): string {
  if (n === null || n === undefined || Math.abs(n) < 0.05) return 'flat';
  return n > 0 ? 'up' : 'down';
}
