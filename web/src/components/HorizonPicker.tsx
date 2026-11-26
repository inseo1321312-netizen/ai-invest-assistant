import type { Horizon } from '../types';

const OPTIONS: { value: Horizon; label: string; hint: string }[] = [
  { value: 'scalp', label: '단타', hint: '하루 안' },
  { value: 'swing', label: '스윙', hint: '며칠~몇 주' },
  { value: 'long', label: '장기', hint: '몇 달 이상' },
];

export function HorizonPicker({ value, onChange }: { value: Horizon; onChange: (h: Horizon) => void }) {
  return (
    <div className="segmented" role="radiogroup" aria-label="분석 기간">
      {OPTIONS.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} aria-label={o.label} title={o.hint} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}
