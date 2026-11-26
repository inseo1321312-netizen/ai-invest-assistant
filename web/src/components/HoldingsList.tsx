import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, ApiError, post } from '../api';
import { changeClass, formatKrwApprox, formatPct, formatPrice, formatTimeKst, HORIZON_LABEL, parseUserSymbol } from '../format';
import type { Badge, HoldingView, MarketId, Overview, QuoteView } from '../types';
import { Icon, Segmented, Sheet, SkeletonList, Sparkline, useFlash } from '../ui';

const PLACEHOLDER: Record<MarketId, string> = { coin: '예: BTC, SOL-USDT', kr: '예: 005930', us: '예: AAPL, NYS:KO' };
const SOURCE: Record<MarketId, string> = { coin: 'OKX', kr: '한국투자증권', us: '한국투자증권' };
const REFRESH_MS = 30_000;

const num = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 8 });

function initials(h: { instrument: { market: MarketId; symbol: string; name: string | null } }): string {
  const { market, symbol, name } = h.instrument;
  if (market === 'coin') return symbol.split('-')[0]!.slice(0, 4);
  if (market === 'kr') return (name ?? symbol).slice(0, 2);
  return symbol.slice(0, 4);
}

/** 코인은 BTC를 크게, USDT·무기한을 작게 보여준다 */
function DisplayName({ inst }: { inst: { market: MarketId; symbol: string; name: string | null } }) {
  if (inst.market === 'coin') {
    const [base, quote, kind] = inst.symbol.split('-');
    return <><span aria-hidden="true">{base}<span className="quote-ccy">{kind === 'SWAP' ? `${quote} 무기한` : quote}</span></span><span className="sr-only">{inst.symbol}</span></>;
  }
  return <>{inst.name ?? inst.symbol}{inst.name && <span className="quote-ccy">{inst.symbol}</span>}</>;
}

function BadgeChip({ badge }: { badge: Badge }) {
  return (
    <span className="opinion-chip">
      <b>{badge.opinion}</b>
      <span>{HORIZON_LABEL.swing} {formatTimeKst(badge.dataTime)}</span>
    </span>
  );
}

function PriceCell({ price, currency, change }: { price: number | null; currency: HoldingView['currency']; change: number | null }) {
  const flash = useFlash(price);
  return (
    <span className="row-right">
      <span className={`row-price num ${flash}`}>{price !== null ? formatPrice(price, currency) : '—'}</span>
      {change !== null && <span className={`change num ${changeClass(change)}`}>{formatPct(change)}</span>}
    </span>
  );
}

function HoldingRow({ h, spark, onOpen }: { h: HoldingView; spark?: number[]; onOpen: (key: string) => void }) {
  const price = h.quote?.price ?? h.markPrice;
  const liqDist = h.liqPrice && price ? (Math.abs(price - h.liqPrice) / price) * 100 : null;
  return (
    <button type="button" className="row" onClick={() => onOpen(h.key)}>
      <span className={`avatar ${h.instrument.market}`} aria-hidden="true">{initials(h)}</span>
      <span className="row-name">
        {h.side && <span className={`side ${h.side}`}>{h.side === 'long' ? '롱' : '숏'}{h.leverage ? ` ${num(h.leverage)}x` : ''}</span>}
        <DisplayName inst={h.instrument} />
      </span>
      <PriceCell price={price} currency={h.currency} change={h.quote?.changePct24h ?? null} />
      <span className="row-sub num">
        {h.side && h.unrealizedPnl !== null
          ? <>미실현 <span className={changeClass(h.unrealizedPnl)}>{h.unrealizedPnl > 0 ? '+' : ''}{num(h.unrealizedPnl)} USDT</span></>
          : <>{num(h.quantity)}{h.instrument.market === 'coin' ? '개' : '주'}{h.avgPrice ? ` 평균 ${formatPrice(h.avgPrice, h.currency)}` : ''}</>}
        {h.krwValue !== null && h.currency !== 'KRW' && <span> {formatKrwApprox(h.krwValue)}</span>}
      </span>
      <span style={{ justifySelf: 'end' }}>{spark && <Sparkline values={spark} />}</span>
      <span className="row-meta">
        {h.pnlPct !== null && <span className="num">손익 <span className={changeClass(h.pnlPct)}>{formatPct(h.pnlPct)}</span></span>}
        {h.liqPrice !== null && <span className={`num${liqDist !== null && liqDist <= 5 ? ' warn' : ''}`}>청산가 {num(h.liqPrice)}{liqDist !== null && ` (${liqDist.toFixed(1)}% 남음)`}</span>}
        {h.side && h.fundingRate !== null && <span className="num">펀딩비 {(h.fundingRate * 100).toFixed(4)}%</span>}
        {h.source === 'manual' && <span>직접 입력</span>}
        {h.badge && <BadgeChip badge={h.badge} />}
      </span>
    </button>
  );
}

function WatchRow({ w, spark, onOpen }: { w: QuoteView; spark?: number[]; onOpen: (key: string) => void }) {
  return (
    <button type="button" className="row" onClick={() => onOpen(w.key)}>
      <span className={`avatar ${w.instrument.market}`} aria-hidden="true">{initials(w)}</span>
      <span className="row-name"><DisplayName inst={w.instrument} /></span>
      <PriceCell price={w.quote?.price ?? null} currency={w.quote?.currency ?? 'USDT'} change={w.quote?.changePct24h ?? null} />
      <span className="row-sub num">{w.krwValue !== null && w.quote?.currency !== 'KRW' ? formatKrwApprox(w.krwValue) : ''}</span>
      <span style={{ justifySelf: 'end' }}>{spark && <Sparkline values={spark} />}</span>
      {w.badge && <span className="row-meta"><BadgeChip badge={w.badge} /></span>}
    </button>
  );
}

function ManualHoldingSheet({ market, onClose, onSaved }: { market: MarketId; onClose: () => void; onSaved: () => void }) {
  const [symbol, setSymbol] = useState('');
  const [qty, setQty] = useState('');
  const [avg, setAvg] = useState('');
  const [side, setSide] = useState<'spot' | 'long' | 'short'>('spot');
  const [lev, setLev] = useState('');
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    let key = parseUserSymbol(market, symbol);
    if (key && market === 'coin' && side !== 'spot' && !key.endsWith('-SWAP')) key = `${key}-SWAP`;
    const quantity = Number(qty);
    const avgPrice = Number(avg);
    if (!key) return setError(`종목 이름을 확인하세요 (${PLACEHOLDER[market]})`);
    if (!(quantity > 0)) return setError('수량은 0보다 커야 해요');
    if (!(avgPrice >= 0) || avg.trim() === '') return setError('평균 단가를 입력하세요');
    try {
      await post('/api/manual-holdings', { key, quantity, avgPrice, side: side === 'spot' ? null : side, leverage: side === 'spot' || !lev ? null : Number(lev) });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '저장하지 못했어요');
    }
  }

  return (
    <Sheet title="보유 직접 입력" onClose={onClose}>
      <p className="small muted" style={{ marginTop: 0 }}>거래소·증권사에서 자동으로 못 불러오는 종목을 직접 넣어요.</p>
      <form onSubmit={submit}>
        <label className="field">종목<input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value)} placeholder={PLACEHOLDER[market]} autoCapitalize="characters" /></label>
        {market === 'coin' && (
          <Segmented small kind="radio" label="방향" value={side} onChange={setSide}
            options={[{ value: 'spot', label: '현물' }, { value: 'long', label: '롱' }, { value: 'short', label: '숏' }]} />
        )}
        <label className="field">수량<input className="input" inputMode="decimal" value={qty} onChange={(e) => setQty(e.target.value)} /></label>
        <label className="field">평균 단가<input className="input" inputMode="decimal" value={avg} onChange={(e) => setAvg(e.target.value)} /></label>
        {market === 'coin' && side !== 'spot' && (
          <label className="field">레버리지(배)<input className="input" inputMode="decimal" value={lev} onChange={(e) => setLev(e.target.value)} /></label>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        <button type="submit" className="btn btn-primary btn-block" style={{ marginTop: 8 }}>저장</button>
      </form>
    </Sheet>
  );
}

function sumKrw(rows: { krwValue: number | null; currency: string; quote: { price: number } | null; quantity?: number }[]): number {
  return rows.reduce((s, r) => s + (r.krwValue ?? 0), 0);
}

export function HoldingsList({ market, onOpen }: { market: MarketId; onOpen: (key: string) => void }) {
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [spark, setSpark] = useState<Record<string, number[]>>({});
  const [symbol, setSymbol] = useState('');
  const [formError, setFormError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState(false);

  const load = useCallback(() => {
    api<Overview>(`/api/market/${market}/overview`)
      .then((o) => { setData(o); setError(null); })
      .catch((e) => setError(e instanceof ApiError ? e.message : '목록을 불러오지 못했어요'));
  }, [market]);

  useEffect(() => {
    setData(null);
    setSpark({});
    load();
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const keysSig = data ? [...data.holdings.map((h) => h.key), ...data.watchlist.map((w) => w.key)].join(',') : '';
  useEffect(() => {
    if (!keysSig) return;
    let alive = true;
    api<{ sparklines: Record<string, number[]> }>(`/api/market/sparklines?keys=${encodeURIComponent(keysSig)}`)
      .then((r) => { if (alive) setSpark(r.sparklines); })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [keysSig]);

  async function addWatch(e: FormEvent) {
    e.preventDefault();
    const key = parseUserSymbol(market, symbol);
    if (!key) { setFormError(`종목 이름을 확인하세요 (${PLACEHOLDER[market]})`); return; }
    setFormError(null);
    try {
      await post('/api/watchlist', { key });
      setSymbol('');
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : '추가하지 못했어요');
    }
  }

  async function remove(path: string) {
    await api(path, { method: 'DELETE' }).catch(() => undefined);
    load();
  }

  const futures = data?.holdings.filter((h) => h.side !== null) ?? [];
  const spot = data?.holdings.filter((h) => h.side === null) ?? [];
  const total = data ? sumKrw(data.holdings) : 0;
  const pnlUsdt = futures.reduce((s, h) => s + (h.unrealizedPnl ?? 0), 0);

  const removeBtn = (label: string, path: string) => (editing
    ? <button type="button" className="remove-btn" aria-label={label} onClick={() => remove(path)}>빼기</button>
    : null);
  const canEdit = Boolean(data && (data.watchlist.length > 0 || data.holdings.some((x) => x.manualId !== undefined)));
  const editToggle = canEdit ? <button type="button" className="btn btn-ghost small" onClick={() => setEditing((v) => !v)}>{editing ? '완료' : '편집'}</button> : null;
  const liClass = (removable: boolean) => (editing && removable ? 'editing' : undefined);

  return (
    <div>
      {data && data.holdings.length > 0 && (
        <section className="summary fade-in" aria-label="보유 요약">
          <p className="summary-label">평가금액(원화 환산)</p>
          <p className="summary-value num">{total ? formatKrwApprox(total).replace('≈ ', '') : '—'}</p>
          <div className="summary-chips">
            <span className="chip">보유 {data.holdings.length}</span>
            {data.watchlist.length > 0 && <span className="chip">관심 {data.watchlist.length}</span>}
            {futures.length > 0 && <span className={`chip num ${changeClass(pnlUsdt)}`}>미실현 {pnlUsdt > 0 ? '+' : ''}{num(Math.round(pnlUsdt * 100) / 100)} USDT</span>}
            {market !== 'kr' && data.usdKrw && <span className="chip num">환율 {Math.round(data.usdKrw).toLocaleString('ko-KR')}원</span>}
          </div>
        </section>
      )}

      {error && <p className="notice" role="alert">{error}</p>}
      {data?.errors.map((m) => <p key={m} className="notice">{m}</p>)}
      {data && !data.connected && <p className="notice">{SOURCE[market]} 계정이 연결되지 않았어요. 직접 입력한 종목과 관심 종목만 보여요.</p>}

      {!data && !error && <div style={{ marginTop: 16 }}><SkeletonList /></div>}
      {data && data.holdings.length === 0 && <p className="empty">보유 종목이 없어요. 직접 입력하거나 관심 종목을 추가해 보세요.</p>}

      {futures.length > 0 && (
        <>
          <div className="section-head"><h2 className="section-title">선물 포지션</h2>{futures.some((x) => x.manualId !== undefined) && editToggle}</div>
          <ul className="list">{futures.map((h) => (
            <li key={`${h.key}-${h.source}-${h.manualId ?? ''}`} className={liClass(h.manualId !== undefined)}>
              <HoldingRow h={h} spark={spark[h.key]} onOpen={onOpen} />
              {h.manualId !== undefined && removeBtn(`${h.instrument.symbol} 직접 입력 삭제`, `/api/manual-holdings/${h.manualId}`)}
            </li>
          ))}</ul>
        </>
      )}
      {spot.length > 0 && (
        <>
          <div className="section-head"><h2 className="section-title">{market === 'coin' ? '현물' : '보유'}</h2>{spot.some((x) => x.manualId !== undefined) && editToggle}</div>
          <ul className="list">{spot.map((h) => (
            <li key={`${h.key}-${h.source}-${h.manualId ?? ''}`} className={liClass(h.manualId !== undefined)}>
              <HoldingRow h={h} spark={spark[h.key]} onOpen={onOpen} />
              {h.manualId !== undefined && removeBtn(`${h.instrument.symbol} 직접 입력 삭제`, `/api/manual-holdings/${h.manualId}`)}
            </li>
          ))}</ul>
        </>
      )}
      {data && data.watchlist.length > 0 && (
        <>
          <div className="section-head"><h2 className="section-title">관심</h2>{editToggle}</div>
          <ul className="list">{data.watchlist.map((w) => (
            <li key={w.key} className={liClass(true)}>
              <WatchRow w={w} spark={spark[w.key]} onOpen={onOpen} />
              {removeBtn(`${w.instrument.symbol} 관심 종목에서 빼기`, `/api/watchlist?key=${encodeURIComponent(w.key)}`)}
            </li>
          ))}</ul>
        </>
      )}

      <form className="row-form" onSubmit={addWatch}>
        <input className="input" aria-label="관심 종목 추가" placeholder={PLACEHOLDER[market]} value={symbol} onChange={(e) => setSymbol(e.target.value)} autoCapitalize="characters" />
        <button className="btn" type="submit" disabled={!symbol.trim()}>추가</button>
      </form>
      {formError && <p className="error" style={{ margin: '6px 16px 0' }}>{formError}</p>}
      <div style={{ margin: '10px 16px 0' }}>
        <button type="button" className="btn btn-block" onClick={() => setAdding(true)}><Icon.plus /> 보유 직접 입력</button>
      </div>
      {adding && <ManualHoldingSheet market={market} onClose={() => setAdding(false)} onSaved={load} />}
    </div>
  );
}
