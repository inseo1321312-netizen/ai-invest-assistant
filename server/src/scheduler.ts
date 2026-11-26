import { Cron } from 'croner';

type CronFactory = (pattern: string, opts: Record<string, unknown>, fn: () => Promise<void>) => { stop(): void };

const defaultFactory: CronFactory = (pattern, opts, fn) => new Cron(pattern, opts, fn);

export function startScheduler(jobs: { briefing: () => Promise<void>; alertPrices: () => Promise<void>; alertEvents: () => Promise<void> }, factory: CronFactory = defaultFactory): { stop(): void } {
  const wrap = (name: string, fn: () => Promise<void>) => async () => {
    try { await fn(); } catch (err) { console.error(`예약 작업 실패(${name})`, err instanceof Error ? err.message : err); }
  };
  const opts = { timezone: 'Asia/Seoul', protect: true };
  const crons = [
    factory('0 8 * * *', opts, wrap('아침 브리핑', jobs.briefing)),
    factory('* * * * *', opts, wrap('알림 코인 시세', jobs.alertPrices)),
    factory('*/5 * * * *', opts, wrap('알림 코인 사건', jobs.alertEvents)),
  ];
  return { stop: () => crons.forEach((c) => c.stop()) };
}
