import { useEffect, useState } from 'react';
import { api } from '../api';
import { changeClass } from '../format';
import type { CoinInfo, StockInfo } from '../types';

const CAUTION_LABEL: Record<string, string> = {
  PRICE_FLUCTUATIONS: '가격 급변동',
  TRADING_VOLUME_SOARING: '거래량 급증',
  DEPOSIT_AMOUNT_SOARING: '입금량 급증',
  GLOBAL_PRICE_DIFFERENCES: '해외 가격과 차이',
  CONCENTRATION_OF_SMALL_ACCOUNTS: '소수 계정 거래 집중',
};

/** 원화 큰 금액: 430조, 1.2조, 8,500억 */
export function bigKrw(n: number): string {
  if (n >= 1e12) return `${(n / 1e12).toLocaleString('ko-KR', { maximumFractionDigits: n >= 1e14 ? 0 : 1 })}조`;
  if (n >= 1e8) return `${Math.round(n / 1e8).toLocaleString('ko-KR')}억`;
  return `${Math.round(n).toLocaleString('ko-KR')}원`;
}
/** 달러 큰 금액: $3.5T, $350B, $1.2M, $500 */
export function bigUsd(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e12) return `$${(n / 1e12).toFixed(1)}T`;
  if (a >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (a >= 1e3) return `$${(n / 1e3).toFixed(1)}K`;
  return `$${Math.round(n)}`;
}

const dash = (v: string | null) => v ?? '—';
const fixed = (n: number | null, d = 2) => (n === null ? null : n.toLocaleString('en-US', { maximumFractionDigits: d }));

function Stock({ s }: { s: StockInfo }) {
  const price = (n: number | null) => (n === null ? null : s.currency === 'KRW' ? `${Math.round(n).toLocaleString('ko-KR')}원` : `$${fixed(n)}`);
  return (
    <section className="info-card rise" aria-label="기본 정보">
      <h3>기본 정보</h3>
      <dl className="stats">
        <div><dt>시가총액</dt><dd className="num">{dash(s.marketCap === null ? null : s.currency === 'KRW' ? bigKrw(s.marketCap) : bigUsd(s.marketCap))}</dd></div>
        <div><dt>PER</dt><dd className="num">{dash(fixed(s.per))}</dd></div>
        <div><dt>PBR</dt><dd className="num">{dash(fixed(s.pbr))}</dd></div>
        <div><dt>EPS</dt><dd className="num">{dash(s.eps === null ? null : s.currency === 'KRW' ? `${Math.round(s.eps).toLocaleString('ko-KR')}원` : `$${fixed(s.eps)}`)}</dd></div>
        <div><dt>52주 최고</dt><dd className="num">{dash(price(s.high52))}</dd></div>
        <div><dt>52주 최저</dt><dd className="num">{dash(price(s.low52))}</dd></div>
      </dl>
    </section>
  );
}

function Coin({ c }: { c: CoinInfo }) {
  const signedPct = (n: number, d = 2) => `${n > 0 ? '+' : ''}${n.toFixed(d)}%`;
  const liqTotal = c.liq1h ? c.liq1h.longUsd + c.liq1h.shortUsd : 0;
  return (
    <section className="info-card rise" aria-label="선물 지표">
      <h3>선물 지표</h3>
      {(c.upbitWarning || c.upbitCautions.length > 0) && (
        <p className="notice" style={{ margin: '0 0 10px' }}>
          업비트 {c.upbitWarning ? '투자유의 종목' : '주의'}{c.upbitCautions.length ? `: ${c.upbitCautions.map((k) => CAUTION_LABEL[k] ?? k).join(', ')}` : ''}
        </p>
      )}
      <dl className="stats">
        <div><dt>펀딩비(8시간)</dt><dd className={`num ${changeClass(c.fundingRate === null ? null : c.fundingRate * 1000)}`}>{dash(c.fundingRate === null ? null : signedPct(c.fundingRate * 100, 4))}</dd></div>
        <div><dt>미결제약정</dt><dd className="num">{dash(c.openInterestUsd === null ? null : bigUsd(c.openInterestUsd))}</dd></div>
        <div><dt>롱·숏 계정 비율</dt><dd className="num">{dash(c.longShortRatio === null ? null : `${c.longShortRatio.toFixed(2)} : 1`)}</dd></div>
        <div><dt>최근 1시간 청산</dt><dd className="num">{c.liq1h ? (liqTotal ? `롱 ${bigUsd(c.liq1h.longUsd)} · 숏 ${bigUsd(c.liq1h.shortUsd)}` : '없음') : '—'}</dd></div>
        <div><dt>김치 프리미엄</dt><dd className={`num ${changeClass(c.kimchiPct)}`}>{c.kimchiPct === null ? '업비트에 없어요' : signedPct(c.kimchiPct)}</dd></div>
      </dl>
    </section>
  );
}

/** 주식은 시가총액·PER 등, 코인은 펀딩비·미결제약정·청산·김프 */
export function InstrumentInfo({ keyId }: { keyId: string }) {
  const [info, setInfo] = useState<{ stock: StockInfo | null; coin: CoinInfo | null } | null>(null);
  useEffect(() => {
    let alive = true;
    api<{ stock: StockInfo | null; coin: CoinInfo | null }>(`/api/instrument/info?key=${encodeURIComponent(keyId)}`)
      .then((r) => { if (alive) setInfo(r); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [keyId]);
  if (info?.stock) return <Stock s={info.stock} />;
  if (info?.coin) return <Coin c={info.coin} />;
  return null;
}
