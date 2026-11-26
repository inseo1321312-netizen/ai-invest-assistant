import { useEffect, useState } from 'react';
import { api, ApiError } from '../api';
import { useToast } from '../ui';

interface Settings { m5: number; m15: number; h1: number; events: boolean }
const FIELDS: [keyof Omit<Settings, 'events'>, string][] = [['m5', '5분 기준(%)'], ['m15', '15분 기준(%)'], ['h1', '1시간 기준(%)']];

function coinLabel(key: string): string {
  const [base, , kind] = key.slice(5).split('-');
  return kind === 'SWAP' ? `${base} 무기한` : base!;
}

/** 알림 코인 목록과 급변 기준 */
export function AlertSettings() {
  const [coins, setCoins] = useState<string[] | null>(null);
  const [text, setText] = useState<Record<string, string> | null>(null);
  const [events, setEvents] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, showToast] = useToast();

  useEffect(() => {
    api<{ coins: string[]; settings: Settings }>('/api/alerts').then((r) => {
      setCoins(r.coins);
      setText({ m5: String(r.settings.m5), m15: String(r.settings.m15), h1: String(r.settings.h1) });
      setEvents(r.settings.events);
    }).catch(() => setCoins([]));
  }, []);

  async function remove(key: string) {
    setCoins((c) => (c ?? []).filter((k) => k !== key));
    await api(`/api/alerts/coins?key=${encodeURIComponent(key)}`, { method: 'DELETE' }).catch(() => undefined);
  }

  async function save() {
    if (!text) return;
    const out = {} as Settings;
    for (const [k] of FIELDS) {
      const n = Number(text[k]);
      if (!Number.isFinite(n) || n < 0.5 || n > 50) { setError('기준은 0.5~50% 사이로 넣어 주세요'); return; }
      out[k] = n;
    }
    out.events = events;
    setError(null);
    try {
      await api('/api/alerts/settings', { method: 'PUT', body: JSON.stringify(out) });
      showToast('알림 기준을 저장했어요');
    } catch (e) {
      setError(e instanceof ApiError ? e.message : '저장하지 못했어요');
    }
  }

  return (
    <section className="panel" aria-label="알림 코인">
      <h2>알림 코인</h2>
      <p className="small muted" style={{ marginTop: 0 }}>코인 화면의 🔔을 누르면 여기에 추가돼요. 급변이나 상장폐지·입출금 중단·업비트 유의 지정·대규모 청산 같은 사건이 생기면 알려 드려요. 새벽 2시~6시에는 알림을 보내지 않아요.</p>
      {coins && coins.length === 0 && <p className="small muted">아직 알림 코인이 없어요.</p>}
      {coins && coins.length > 0 && (
        <ul className="chip-list">
          {coins.map((k) => (
            <li key={k} className="chip">
              <span>{coinLabel(k)}</span>
              <button type="button" className="chip-x" aria-label={`${coinLabel(k)} 알림 끄기`} onClick={() => remove(k)}>✕</button>
            </li>
          ))}
        </ul>
      )}
      {text && (
        <>
          <div className="field-row">
            {FIELDS.map(([k, label]) => (
              <label key={k} className="field">{label}
                <input type="number" inputMode="decimal" min={0.5} max={50} step={0.5} value={text[k]} onChange={(e) => setText({ ...text, [k]: e.target.value })} />
              </label>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={events} onChange={(e) => setEvents(e.target.checked)} />
            사건 알림(공지·유의 지정·청산·펀딩비·뉴스)
          </label>
          {error && <p className="error" role="alert">{error}</p>}
          <button type="button" className="btn btn-block" style={{ marginTop: 8 }} onClick={save}>알림 기준 저장</button>
        </>
      )}
      {toast}
    </section>
  );
}
