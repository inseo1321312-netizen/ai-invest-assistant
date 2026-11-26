import { useState, type CSSProperties } from 'react';
import { changeClass, formatPct, formatPrice, formatTimeKst, HORIZON_LABEL } from '../format';
import { hueOf } from '../insights';
import type { Badge, Currency, MarketId } from '../types';
import { useFlash } from '../ui';
import { useTweened } from '../motion';

type Inst = { market: MarketId; symbol: string; name: string | null; exchange?: string | null };

export const MARKET_SHORT: Record<MarketId, string> = { coin: '코인', kr: '한국', us: '미국' };

function initials(inst: Inst): string {
  if (inst.market === 'coin') return inst.symbol.split('-')[0]!.slice(0, 4);
  if (inst.market === 'kr') return (inst.name ?? inst.symbol).slice(0, 2);
  return inst.symbol.slice(0, 4);
}

/** 로고를 부를 종목 키. 미국 주식은 거래소를 알아야 해서, 모르면 null */
function logoKeyOf(inst: Inst): string | null {
  if (inst.market === 'us') return inst.exchange ? `us:${inst.exchange}:${inst.symbol}` : null;
  return `${inst.market}:${inst.symbol}`;
}

/** 종목 아이콘: 서버가 받아 둔 로고를 보여 주고, 없으면 글자 아이콘 */
export function Avatar({ inst, logoKey }: { inst: Inst; logoKey?: string }) {
  const key = logoKey ?? logoKeyOf(inst);
  const [state, setState] = useState<'loading' | 'ok' | 'fail'>(key ? 'loading' : 'fail');
  return (
    <span className={`avatar ${inst.market}${state === 'ok' ? ' has-logo' : ''}`} style={{ '--h': hueOf(inst.symbol) } as CSSProperties} aria-hidden="true">
      <span className="avatar-text">{initials(inst)}</span>
      {key && state !== 'fail' && (
        <img src={`/api/logo?key=${encodeURIComponent(key)}`} alt="" loading="lazy" decoding="async" onLoad={() => setState('ok')} onError={() => setState('fail')} />
      )}
    </span>
  );
}

/** 이름을 크게, 기호를 작게. 코인 무기한 선물은 "무기한"을 붙인다. 화면 읽기용 전체 기호는 숨겨서 둔다. */
export function DisplayName({ inst }: { inst: Inst }) {
  if (inst.market === 'coin') {
    const [base, quote, kind] = inst.symbol.split('-');
    const sub = `${inst.name ? `${base} ` : ''}${kind === 'SWAP' ? `${quote} 무기한` : quote}`;
    return <><span aria-hidden="true">{inst.name ?? base}<span className="quote-ccy">{sub}</span></span><span className="sr-only">{inst.symbol}</span></>;
  }
  return <>{inst.name ?? inst.symbol}<span className="quote-ccy">{inst.symbol}</span></>;
}

export function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span className="opinion-chip">
      <b>{badge.opinion}</b>
      <span>{HORIZON_LABEL.swing} {formatTimeKst(badge.dataTime)}</span>
    </span>
  );
}

export function PriceCell({ price, currency, change }: { price: number | null; currency: Currency; change: number | null }) {
  const flash = useFlash(price);
  const shown = useTweened(price ?? 0);
  return (
    <span className="row-right">
      <span className={`row-price num ${flash}`}>{price !== null ? formatPrice(shown, currency) : '—'}</span>
      {change !== null && <span className={`change num ${changeClass(change)}`}>{formatPct(change)}</span>}
    </span>
  );
}
