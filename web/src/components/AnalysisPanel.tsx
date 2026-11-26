import { formatDateTimeKst, HORIZON_LABEL } from '../format';
import type { Analysis, ProviderId } from '../types';
import { Dots } from '../ui';

export const PROVIDER_LABEL: Record<ProviderId, string> = { claude: 'Claude', gpt: 'GPT' };

export interface RunState {
  running: boolean;
  status: string | null;
  text: string;
  analysis: (Analysis & { origin?: string; tier?: string }) | null;
  error: string | null;
}

export const emptyRun = (): RunState => ({ running: false, status: null, text: '', analysis: null, error: null });

const SCALES = [
  ['추가 매수', '유지', '일부 매도', '매도'],
  ['유지', '일부 정리', '청산 고려'],
  ['매수', '관망'],
  ['롱 진입', '숏 진입', '관망'],
];

/** 의견이 어느 선택지 묶음에 속하는지(선물이면 선물 묶음 먼저) */
function scaleFor(opinion: string, isSwap: boolean): string[] | null {
  const order = isSwap ? [SCALES[1]!, SCALES[3]!, SCALES[0]!, SCALES[2]!] : [SCALES[0]!, SCALES[2]!, SCALES[1]!, SCALES[3]!];
  return order.find((s) => s.includes(opinion)) ?? null;
}

const CONF_LEVEL: Record<string, number> = { 낮음: 1, 중간: 2, 높음: 3 };

function AnalysisCard({ a, who, isSwap }: { a: NonNullable<RunState['analysis']>; who: ProviderId; isSwap: boolean }) {
  const scale = scaleFor(a.opinion, isSwap);
  const level = CONF_LEVEL[a.confidence] ?? 0;
  return (
    <>
      <div className="analysis-top">
        <span className="analysis-who">{PROVIDER_LABEL[who]}{a.tier === 'deep' ? ' 심층' : ''}{a.origin === 'briefing' ? ' · 아침 브리핑' : ''}</span>
        <span className="conf" aria-label={`확신 ${a.confidence}`}>
          {[1, 2, 3].map((i) => <i key={i} className={i <= level ? 'on' : ''} />)}
          <span>확신 {a.confidence}</span>
        </span>
      </div>
      <p className="analysis-opinion">{a.opinion}</p>
      {scale && (
        <div className="scale" role="img" aria-label={`선택지 ${scale.length}개 중 위치`}>
          {scale.map((s) => <span key={s} className={s === a.opinion ? 'on' : ''} data-label={s} />)}
        </div>
      )}
      <p className="meta">{HORIZON_LABEL[a.horizon]} 분석, {formatDateTimeKst(a.dataTime)} 기준</p>
      {a.summary && <p className="summary-text">{a.summary}</p>}
      <h4>근거</h4>
      <ul>{a.reasons.map((r, i) => <li key={`${i}-${r}`}>{r}</li>)}</ul>
      <h4>위험</h4>
      <ul>{a.risks.map((r, i) => <li key={`${i}-${r}`}>{r}</li>)}</ul>
      {a.news.length > 0 && (
        <>
          <h4>참고한 뉴스</h4>
          <ul>
            {a.news.map((n, i) => (
              <li key={`${i}-${n.url}`}>
                <a href={n.url} target="_blank" rel="noreferrer noopener">{n.title}</a>
                {n.date && <span className="muted small"> {n.date}</span>}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

export function AnalysisPanel({ runs, isSwap = false }: { runs: Partial<Record<ProviderId, RunState>>; isSwap?: boolean }) {
  const entries = (Object.entries(runs) as [ProviderId, RunState][]).filter(([, r]) => r.running || r.analysis || r.error || r.text);
  if (entries.length === 0) return <p className="empty">아직 분석이 없어요. 기간을 고르고 아래 AI 타이밍 분석을 눌러 보세요.</p>;
  return (
    <div className={`analysis-grid${entries.length > 1 ? ' two' : ''}`}>
      {entries.map(([p, r]) => (
        <section key={p} className="analysis" aria-label={`${PROVIDER_LABEL[p]} 분석`}>
          {r.running && (
            <p className="status" aria-live="polite"><Dots /> {r.status ?? `${PROVIDER_LABEL[p]}가 분석 중…`}</p>
          )}
          {r.running && r.text && <p className="stream">{r.text}</p>}
          {r.error && <p className="error" role="alert">{r.error}</p>}
          {r.analysis && !r.running && <AnalysisCard a={r.analysis} who={p} isSwap={isSwap} />}
        </section>
      ))}
    </div>
  );
}
