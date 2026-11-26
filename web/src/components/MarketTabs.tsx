import { MARKET_LABEL } from '../format';
import type { MarketId } from '../types';
import { Segmented } from '../ui';

const ORDER: MarketId[] = ['coin', 'kr', 'us'];

export function readSavedTab(): MarketId {
  try {
    const v = localStorage.getItem('tab');
    if (v === 'coin' || v === 'kr' || v === 'us') return v;
  } catch { /* 저장소를 못 쓰면 기본값 */ }
  return 'coin';
}

export function saveTab(tab: MarketId) {
  try { localStorage.setItem('tab', tab); } catch { /* 무시 */ }
}

export function MarketTabs({ value, onChange }: { value: MarketId; onChange: (m: MarketId) => void }) {
  return <Segmented label="시장" options={ORDER.map((m) => ({ value: m, label: MARKET_LABEL[m] }))} value={value} onChange={onChange} />;
}
