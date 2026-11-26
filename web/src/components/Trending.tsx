import { useEffect, useState } from 'react';
import { api } from '../api';
import { changeClass, formatPct, formatPrice } from '../format';
import type { MarketId, TrendItem } from '../types';
import { Segmented } from '../ui';
import { Avatar } from './rows';

type Kind = 'gainers' | 'value';

/** 지금 뜨는 종목: 급등·거래대금 상위를 옆으로 넘기는 카드로 보여준다. */
export function Trending({ market, onOpen }: { market: MarketId; onOpen: (key: string) => void }) {
  const [kind, setKind] = useState<Kind>('gainers');
  const [items, setItems] = useState<TrendItem[] | null>(null);
  const [needsKey, setNeedsKey] = useState(false);

  useEffect(() => {
    let alive = true;
    setItems(null);
    api<{ items: TrendItem[]; needsKey?: boolean }>(`/api/trending/${market}?kind=${kind}`)
      .then((r) => { if (alive) { setItems(r.items); setNeedsKey(r.needsKey === true); } })
      .catch(() => { if (alive) setItems([]); });
    return () => { alive = false; };
  }, [market, kind]);

  return (
    <section className="trending" aria-label="지금 뜨는">
      <div className="section-head">
        <h2 className="section-title">지금 뜨는</h2>
        <div className="mini-seg">
          <Segmented small kind="pressed" label="순위 기준" value={kind} onChange={setKind}
            options={[{ value: 'gainers', label: '급등' }, { value: 'value', label: '거래대금' }]} />
        </div>
      </div>
      {!items && <div className="trend-row" aria-hidden="true">{Array.from({ length: 3 }, (_, i) => <span key={i} className="trend-card skeleton" />)}</div>}
      {items && items.length === 0 && (
        <p className="empty">{needsKey ? '한투 앱키를 넣으면 한국·미국 순위가 보여요.' : '지금 순위를 불러오지 못했어요. 잠시 뒤 다시 열어 보세요.'}</p>
      )}
      {items && items.length > 0 && (
        <div className="trend-row">
          {items.map((t, i) => (
            <button key={t.key} type="button" className="trend-card" onClick={() => onOpen(t.key)}>
              <span className="trend-rank num">{i + 1}</span>
              <Avatar inst={{ market, symbol: t.symbol, name: t.name }} logoKey={t.key} />
              <span className="trend-name">{t.name}</span>
              <span className="trend-price num">{formatPrice(t.price, t.currency)}</span>
              <span className={`change num ${changeClass(t.changePct)}`}>{formatPct(t.changePct)}</span>
            </button>
          ))}
        </div>
      )}
    </section>
  );
}
