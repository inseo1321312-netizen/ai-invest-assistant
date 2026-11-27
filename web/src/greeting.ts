import { marketStatus } from './insights';
import type { MarketId } from './types';

function kst(now: Date): { hour: number; weekday: number } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'Asia/Seoul', hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value ?? 0);
  const weekday = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? 'Mon');
  return { hour, weekday };
}

/** 홈 제목: 지금 보고 있는 시장과 시각에 맞춘 한마디 */
export function greeting(market: MarketId, now: Date = new Date()): string {
  const { hour, weekday } = kst(now);
  const weekend = weekday === 0 || weekday === 6;
  if (market === 'coin') return hour >= 1 && hour < 6 ? '잠 못 드는 밤, 코인 한 바퀴?' : '오늘은 무슨 코인을 볼까요?';
  if (market === 'us') {
    if (marketStatus('us', now).open) return '미국장이 열렸어요';
    return weekend ? '주말엔 느긋하게 둘러봐요' : '오늘 밤 미국장, 뭘 볼까요?';
  }
  if (marketStatus('kr', now).open) return '오늘은 뭐가 오를까요?';
  if (weekend) return '주말엔 느긋하게 둘러봐요';
  return hour < 9 ? '장 열리기 전, 미리 볼까요?' : '오늘 장은 어땠을까요?';
}
