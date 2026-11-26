/**
 * 서버가 호출할 수 있는 KIS 주소 목록. 조회용만 있다.
 * 주문 주소(/trading/order*)는 절대 추가하지 않는다.
 * 확인: github.com/koreainvestment/open-trading-api examples_llm (2026-11-26)
 */
export const KIS_READ_PATHS: ReadonlySet<string> = new Set([
  '/uapi/domestic-stock/v1/quotations/inquire-price', // FHKST01010100
  '/uapi/domestic-stock/v1/quotations/inquire-daily-itemchartprice', // FHKST03010100
  '/uapi/domestic-stock/v1/quotations/inquire-time-itemchartprice', // FHKST03010200
  '/uapi/domestic-stock/v1/trading/inquire-balance', // TTTC8434R
  '/uapi/overseas-price/v1/quotations/price', // HHDFS00000300
  '/uapi/overseas-price/v1/quotations/dailyprice', // HHDFS76240000
  '/uapi/overseas-price/v1/quotations/inquire-time-itemchartprice', // HHDFS76950200
  '/uapi/overseas-stock/v1/trading/inquire-balance', // TTTS3012R
]);

export class KisBlockedError extends Error {
  constructor(path: string) {
    super(`허용되지 않은 KIS 주소: ${path}`);
  }
}

export function assertReadPath(path: string): void {
  if (!KIS_READ_PATHS.has(path)) throw new KisBlockedError(path);
}
