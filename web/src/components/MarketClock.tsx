import { useEffect, useState } from 'react';
import { marketStatus } from '../insights';

/** 한국·미국 정규장이 열렸는지와 남은 시간. 1분마다 다시 계산한다. */
export function MarketClock() {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(t);
  }, []);
  const kr = marketStatus('kr', now);
  const us = marketStatus('us', now);
  return (
    <div className="clock" role="group" aria-label="장 시간">
      <span className="clock-pill open"><i className="led" aria-hidden="true" /><b>코인</b>24시간</span>
      <span className={`clock-pill${kr.open ? ' open' : ''}`}><i className="led" aria-hidden="true" /><b>한국 {kr.open ? '장중' : '휴장'}</b>{kr.text}</span>
      <span className={`clock-pill${us.open ? ' open' : ''}`}><i className="led" aria-hidden="true" /><b>미국 {us.open ? '장중' : '휴장'}</b>{us.text}</span>
    </div>
  );
}
