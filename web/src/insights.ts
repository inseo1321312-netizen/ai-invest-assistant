/** 화면에 보여 줄 간단한 계산들(서버 없이 브라우저에서 계산) */

const HOURS = {
  kr: { tz: 'Asia/Seoul', open: 9 * 60, close: 15 * 60 + 30 },
  us: { tz: 'America/New_York', open: 9 * 60 + 30, close: 16 * 60 },
} as const;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

function wallClock(now: Date, tz: string): { weekday: number; minute: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return { weekday: WEEKDAYS.indexOf(get('weekday')), minute: Number(get('hour')) * 60 + Number(get('minute')) };
}

export function formatDuration(minutes: number): string {
  const d = Math.floor(minutes / 1440);
  const h = Math.floor((minutes % 1440) / 60);
  const m = minutes % 60;
  if (d > 0) return h ? `${d}일 ${h}시간` : `${d}일`;
  if (h > 0) return m ? `${h}시간 ${m}분` : `${h}시간`;
  return `${m}분`;
}

/** 정규장 기준(공휴일은 모름). 열렸으면 마감까지, 닫혔으면 개장까지 남은 시간. */
export function marketStatus(market: 'kr' | 'us', now: Date): { open: boolean; text: string } {
  const { tz, open, close } = HOURS[market];
  const { weekday, minute } = wallClock(now, tz);
  const workday = (d: number) => d >= 1 && d <= 5;
  if (workday(weekday) && minute >= open && minute < close) return { open: true, text: `마감까지 ${formatDuration(close - minute)}` };
  let wait: number;
  if (workday(weekday) && minute < open) {
    wait = open - minute;
  } else {
    wait = 1440 - minute;
    let d = (weekday + 1) % 7;
    while (!workday(d)) { wait += 1440; d = (d + 1) % 7; }
    wait += open;
  }
  return { open: false, text: `개장까지 ${formatDuration(wait)}` };
}

export interface Slice { key: string; label: string; value: number; pct: number }

/** 비중이 큰 순서로 max개, 나머지는 '기타'로 묶는다 */
export function allocation(rows: { key: string; label: string; value: number }[], max = 5): Slice[] {
  const live = rows.filter((r) => r.value > 0).sort((a, b) => b.value - a.value);
  const total = live.reduce((s, r) => s + r.value, 0);
  if (total <= 0) return [];
  const top = live.slice(0, max).map((r) => ({ ...r, pct: (r.value / total) * 100 }));
  const rest = live.slice(max).reduce((s, r) => s + r.value, 0);
  return rest > 0 ? [...top, { key: '__rest', label: '기타', value: rest, pct: (rest / total) * 100 }] : top;
}

export interface YearStats { high: number; low: number; position: number; fromHighPct: number; avgVolume30: number; volatility30: number }

/** 일봉으로 1년 최고·최저, 지금 가격의 위치, 최근 30일 평균 거래량·하루 변동폭 */
export function yearStats(candles: { time: number; high: number; low: number; close: number; volume: number }[], price: number, nowSec: number): YearStats | null {
  const year = candles.filter((c) => c.time >= nowSec - 365 * 86400);
  if (year.length === 0) return null;
  const high = Math.max(...year.map((c) => c.high));
  const low = Math.min(...year.map((c) => c.low));
  const position = high > low ? Math.min(1, Math.max(0, (price - low) / (high - low))) : 0.5;
  const last = year.slice(-31);
  const vols = last.slice(-30).map((c) => c.volume);
  const rets = last.slice(1).map((c, i) => (c.close - last[i]!.close) / last[i]!.close);
  const mean = rets.reduce((s, r) => s + r, 0) / Math.max(1, rets.length);
  const sd = Math.sqrt(rets.reduce((s, r) => s + (r - mean) ** 2, 0) / Math.max(1, rets.length));
  return {
    high,
    low,
    position,
    fromHighPct: ((price - high) / high) * 100,
    avgVolume30: vols.reduce((s, v) => s + v, 0) / Math.max(1, vols.length),
    volatility30: sd * 100,
  };
}

/** 종목 이름으로 늘 같은 색을 고른다 */
export function hueOf(text: string): number {
  let h = 0;
  for (const ch of text) h = (h * 31 + ch.codePointAt(0)!) % 3600;
  return h % 360;
}
