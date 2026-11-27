import type { Db } from '../db.js';
import type { ProviderId, Purpose } from './types.js';

export interface BudgetLimits { scheduledDailyUsd: number; interactiveDailyUsd: number; monthlyUsd: number; gptMonthlyUsd: number }
export const DEFAULT_LIMITS: BudgetLimits = { scheduledDailyUsd: 1.5, interactiveDailyUsd: 3, monthlyUsd: 80, gptMonthlyUsd: 5 };
const LIMITS_KEY = 'settings.budget';

export interface GptWindow { usedPct: number; windowMinutes: number | null; resetAt: number | null; at: number }

export interface UsageSummary {
  today: { interactive: number; scheduled: number };
  month: number;
  gptMonth: number;
  limits: BudgetLimits;
  requests: { gpt5h: number; gptToday: number; claudeToday: number };
  gptLimitHitAt: number | null;
  /** ChatGPT가 답과 함께 알려 준 5시간 사용률(%). 알려 준 적 없으면 null */
  gptWindow: GptWindow | null;
}

export interface Budget {
  check(purpose: Purpose, provider: ProviderId): { ok: true } | { ok: false; message: string };
  record(purpose: Purpose, provider: ProviderId, usd: number): void;
  usage(): UsageSummary;
  limits(): BudgetLimits;
  setLimits(l: BudgetLimits): void;
  /** 공급자 쪽 사용량 한도에 걸린 시각을 기억한다(ChatGPT Plus 5시간 한도 등) */
  noteLimitHit(provider: ProviderId): void;
  /** ChatGPT 구독 응답 헤더의 실제 사용률을 기억한다 */
  noteGptWindow(w: { usedPct: number; windowMinutes: number | null; resetAfterSec: number | null }): void;
}

/** 한국 시간 기준 'YYYY-MM-DD' */
export function kstDay(ms: number): string {
  return new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
}

export function createBudget(db: Db, now: () => number): Budget {
  const ins = db.sql.prepare('INSERT INTO ai_usage (day, month, purpose, provider, usd, at) VALUES (?, ?, ?, ?, ?, ?)');
  const sumDay = db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM ai_usage WHERE day = ? AND purpose = ?');
  const sumMonth = db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM ai_usage WHERE month = ?');
  const sumMonthProvider = db.sql.prepare('SELECT COALESCE(SUM(usd), 0) AS s FROM ai_usage WHERE month = ? AND provider = ?');
  const s = (row: unknown) => (row as { s: number }).s;
  const countSince = db.sql.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE provider = ? AND at >= ?');
  const countDay = db.sql.prepare('SELECT COUNT(*) AS n FROM ai_usage WHERE provider = ? AND day = ?');
  const n = (row: unknown) => (row as { n: number }).n;

  const limits = (): BudgetLimits => ({ ...DEFAULT_LIMITS, ...(db.kvGet<Partial<BudgetLimits>>(LIMITS_KEY) ?? {}) });

  return {
    limits,
    setLimits(l) { db.kvSet(LIMITS_KEY, l); },
    noteLimitHit(provider) { db.kvSet(`limitHit.${provider}`, now()); },
    noteGptWindow(w) {
      const t = now();
      db.kvSet('gptWindow', { usedPct: w.usedPct, windowMinutes: w.windowMinutes, resetAt: w.resetAfterSec !== null ? t + w.resetAfterSec * 1000 : null, at: t } satisfies GptWindow);
    },

    check(purpose, provider) {
      const l = limits();
      const day = kstDay(now());
      const month = day.slice(0, 7);
      if (provider === 'gpt' && s(sumMonthProvider.get(month, 'gpt')) >= l.gptMonthlyUsd) {
        return { ok: false, message: '이번 달 GPT API 사용 한도에 도달했습니다' };
      }
      if (s(sumMonth.get(month)) >= l.monthlyUsd) return { ok: false, message: '이번 달 AI 사용 한도에 도달했습니다' };
      if (purpose === 'scheduled' && s(sumDay.get(day, 'scheduled')) >= l.scheduledDailyUsd) {
        return { ok: false, message: '오늘 예약 작업 AI 사용 한도에 도달했습니다' };
      }
      if (purpose === 'interactive' && s(sumDay.get(day, 'interactive')) >= l.interactiveDailyUsd) {
        return { ok: false, message: '오늘 AI 사용 한도에 도달했습니다' };
      }
      return { ok: true };
    },

    record(purpose, provider, usd) {
      const day = kstDay(now());
      ins.run(day, day.slice(0, 7), purpose, provider, usd, now());
    },

    usage() {
      const day = kstDay(now());
      const month = day.slice(0, 7);
      return {
        today: { interactive: s(sumDay.get(day, 'interactive')), scheduled: s(sumDay.get(day, 'scheduled')) },
        month: s(sumMonth.get(month)),
        gptMonth: s(sumMonthProvider.get(month, 'gpt')),
        limits: limits(),
        requests: {
          gpt5h: n(countSince.get('gpt', now() - 5 * 3600_000)),
          gptToday: n(countDay.get('gpt', day)),
          claudeToday: n(countDay.get('claude', day)),
        },
        gptLimitHitAt: db.kvGet<number>('limitHit.gpt'),
        gptWindow: db.kvGet<GptWindow>('gptWindow'),
      };
    },
  };
}
