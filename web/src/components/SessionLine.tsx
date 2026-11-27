import { changeClass, formatPct, formatPrice, formatTimeKst } from '../format';
import type { Currency, MarketSession } from '../types';

const EXT_LABEL = { pre: '프리마켓', after: '애프터마켓' } as const;

/** 주식 가격 아래: 장이 열렸는지, 닫혔으면 마지막 거래 시각, 프리·애프터마켓 가격(종가 대비) */
export function SessionLine({ session, currency }: { session: MarketSession; currency: Currency }) {
  const ext = session.extended;
  return (
    <div className="session-line">
      <span className="session-main">
        <i className={`session-dot${session.open ? ' live' : ''}`} aria-hidden="true" />
        {session.open ? '정규장 · 실시간' : session.beforeOpen ? '개장 전' : '장 마감'}
        {!session.open && !ext?.open && session.tradedAt !== null && <span className="muted"> · 마지막 거래 {formatTimeKst(session.tradedAt).replace('-', '/')}</span>}
      </span>
      {ext && (
        <span className="session-ext">
          <i className={`session-dot${ext.open ? ' live' : ''}`} aria-hidden="true" />
          {EXT_LABEL[ext.kind]}{ext.open ? ' 거래 중' : ''}
          <b className="num">{formatPrice(ext.price, currency)}</b>
          <span className={`num ${changeClass(ext.changePct)}`}>{formatPct(ext.changePct)}</span>
          <span className="muted">종가 대비</span>
        </span>
      )}
    </div>
  );
}
