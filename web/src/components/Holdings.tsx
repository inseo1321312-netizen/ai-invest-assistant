import { useEffect, useState } from 'react';
import { api } from '../api';
import { changeClass, formatPct, formatPrice } from '../format';
import type { Instrument, MarketId, Quote } from '../types';
import { Avatar, DisplayName, PriceCell } from './rows';

interface Holding {
  key: string; market: string; name: string | null; quantity: number | null; avgPrice: number | null;
  instrument: Instrument; quote: Quote | null; plPct: number | null;
}

const unit = (market: string) => (market === 'coin' ? '개' : '주');

/** 홈 '보유 종목': AI에게 말해서 넣은 종목. 이 시장 것만, 없으면 숨긴다 */
export function Holdings({ market, onOpen }: { market: MarketId; onOpen: (key: string) => void }) {
  const [items, setItems] = useState<Holding[] | null>(null);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    let alive = true;
    api<{ items: Holding[] }>('/api/holdings').then((r) => { if (alive) setItems(r.items); }).catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, []);

  async function remove(key: string) {
    setItems((list) => (list ?? []).filter((h) => h.key !== key));
    await api(`/api/holdings?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  const mine = (items ?? []).filter((h) => h.market === market);
  if (mine.length === 0) return null;

  return (
    <section aria-label="보유 종목">
      <div className="section-head">
        <h2 className="section-title">보유 종목</h2>
        <button type="button" className="btn btn-ghost small" onClick={() => setEditing((v) => !v)}>{editing ? '완료' : '편집'}</button>
      </div>
      <ul className="list">
        {mine.map((h) => (
          <li key={h.key} className={editing ? 'editing' : undefined}>
            <button type="button" className="row" onClick={() => onOpen(h.key)}>
              <Avatar inst={h.instrument} />
              <span className="row-name"><DisplayName inst={h.instrument} /></span>
              <PriceCell price={h.quote?.price ?? null} currency={h.quote?.currency ?? 'USDT'} change={h.quote?.changePct24h ?? null} />
              <span className="row-sub num">
                {h.quantity !== null ? `${h.quantity.toLocaleString('ko-KR')}${unit(h.market)}` : '수량 모름'}
                {h.avgPrice !== null && h.quote && ` · 평단 ${formatPrice(h.avgPrice, h.quote.currency)}`}
              </span>
              <span className={`hold-pl num ${changeClass(h.plPct)}`}>{h.plPct !== null ? formatPct(h.plPct) : ''}</span>
            </button>
            {editing && (
              <button type="button" className="remove-btn" aria-label={`${h.name ?? h.instrument.symbol} 보유 종목에서 빼기`} onClick={() => remove(h.key)}>빼기</button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
