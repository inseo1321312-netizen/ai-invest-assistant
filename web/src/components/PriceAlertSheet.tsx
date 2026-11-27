import { useEffect, useState, type FormEvent } from 'react';
import { api, ApiError } from '../api';
import type { Currency } from '../types';
import { Icon, Sheet } from '../ui';

export interface PriceAlert { id: number; key: string; name: string | null; op: 'above' | 'below'; price: number; createdAt: number }

const UNIT: Record<Currency, string> = { KRW: '원', USD: '달러', USDT: 'USDT' };

/** 목표가는 종목 통화 그대로 보여준다(원화 단위 설정과 상관없이: 알림도 이 값으로 온다) */
export function fmtTarget(key: string, n: number): string {
  if (key.startsWith('kr:')) return `${Math.round(n).toLocaleString('ko-KR')}원`;
  if (key.startsWith('us:')) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${n.toLocaleString('en-US', { maximumSignificantDigits: 8 })} USDT`;
}

export const alertLabel = (a: PriceAlert) => `${fmtTarget(a.key, a.price)} ${a.op === 'above' ? '이상' : '이하'}`;

/** 종목 화면 → 목표가 알림: 지금 가격에서 시작, 높으면 '이상'·낮으면 '이하'를 지켜본다 */
export function PriceAlertSheet({ keyId, name, price, currency, onClose }: { keyId: string; name: string | null; price: number; currency: Currency; onClose: () => void }) {
  const [text, setText] = useState(String(price));
  const [alerts, setAlerts] = useState<PriceAlert[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ alerts: PriceAlert[] }>('/api/price-alerts').then((r) => setAlerts(r.alerts.filter((a) => a.key === keyId))).catch(() => setAlerts([]));
  }, [keyId]);

  const target = Number(text.replace(/,/g, ''));
  const valid = Number.isFinite(target) && target > 0;
  const dir = valid ? (target >= price ? '이상' : '이하') : null;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid) return;
    setBusy(true);
    setError(null);
    try {
      const { alert } = await api<{ alert: PriceAlert }>('/api/price-alerts', { method: 'POST', body: JSON.stringify({ key: keyId, price: target }) });
      setAlerts((list) => [...(list ?? []), alert]);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '알림을 걸지 못했어요');
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: number) {
    setAlerts((list) => (list ?? []).filter((a) => a.id !== id));
    await api(`/api/price-alerts/${id}`, { method: 'DELETE' }).catch(() => undefined);
  }

  return (
    <Sheet title="목표가 알림" onClose={onClose}>
      <form onSubmit={submit} className="target-form">
        <label className="field">목표가({UNIT[currency]})
          <input inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" />
        </label>
        <p className="target-hint">
          {dir ? `${name ?? keyId.split(':').at(-1)} ${fmtTarget(keyId, target)} ${dir}이 되면 알려 드려요` : '가격을 숫자로 넣어 주세요'}
        </p>
        <button type="submit" className="btn btn-primary btn-block" disabled={busy || !valid}><Icon.bell /> 알림 걸기</button>
        {error && <p className="error" role="alert">{error}</p>}
      </form>
      {alerts && alerts.length > 0 && (
        <ul className="target-list" aria-label="걸어 둔 목표가">
          {alerts.map((a) => (
            <li key={a.id}>
              <span className={`target-dir ${a.op}`} aria-hidden="true">{a.op === 'above' ? '▲' : '▼'}</span>
              <span className="num">{alertLabel(a)}</span>
              <button type="button" className="icon-btn" aria-label={`${alertLabel(a)} 알림 지우기`} onClick={() => remove(a.id)}><Icon.trash /></button>
            </li>
          ))}
        </ul>
      )}
    </Sheet>
  );
}
