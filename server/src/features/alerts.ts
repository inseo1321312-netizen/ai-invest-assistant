/**
 * 알림 코인: 사용자가 정한 코인의 급변과 사건을 푸시로 알린다.
 * - 시세는 1분마다(tickPrices), 공지·업비트 경고·청산·펀딩비·뉴스는 5분마다(tickEvents) 확인한다.
 * - 새벽 2~6시(한국 시간)에는 보내지 않는다. 기록은 계속한다.
 * - 서버가 처음 켜졌을 때 이미 있던 공지·뉴스는 "본 것"으로만 기록한다(폭주 방지).
 */
import { kstDay } from '../ai/budget.js';
import type { Db } from '../db.js';
import type { News } from '../market/news.js';
import type { OkxClient } from '../market/okx.js';
import { parseInstrumentKey } from '../market/types.js';
import type { UpbitClient } from '../market/upbit.js';
import type { Push } from '../push.js';
import { addFeedItem, type FeedKind } from './briefing.js';
import { fmtNum } from './deps.js';

export interface AlertSettings { m5: number; m15: number; h1: number; events: boolean }
export const DEFAULT_ALERT_SETTINGS: AlertSettings = { m5: 2, m15: 3, h1: 5, events: true };
export const MAX_ALERT_COINS = 20;

const SETTINGS_KEY = 'alerts.settings';
const UPBIT_STATE_KEY = 'alerts.upbitState';
const SAMPLE_KEEP_MS = 70 * 60_000;
const REPEAT_MS = 30 * 60_000;
const LIQ_WINDOW_MS = 5 * 60_000;
const LIQ_ALERT_USD = 1_000_000;
const FUNDING_ALERT = 0.001;
const NEWS_WORDS = ['해킹', '상장폐지', '상폐', '출금 중단', '입출금 중단', '소송', '규제', '파산', 'ETF 승인', '긴급'];
const ANN_TYPES = new Set(['announcements-new-listings', 'announcements-delistings', 'announcements-deposit-withdrawal-suspension-resumption']);
const CAUTION_LABEL: Record<string, string> = {
  PRICE_FLUCTUATIONS: '가격 급변동',
  TRADING_VOLUME_SOARING: '거래량 급증',
  DEPOSIT_AMOUNT_SOARING: '입금량 급증',
  GLOBAL_PRICE_DIFFERENCES: '해외 가격과 차이',
  CONCENTRATION_OF_SMALL_ACCOUNTS: '소수 계정 거래 집중',
};
const WINDOWS: { minutes: number; setting: 'h1' | 'm15' | 'm5'; label: string }[] = [
  { minutes: 60, setting: 'h1', label: '1시간' },
  { minutes: 15, setting: 'm15', label: '15분' },
  { minutes: 5, setting: 'm5', label: '5분' },
];

export function getAlertSettings(db: Db): AlertSettings {
  return { ...DEFAULT_ALERT_SETTINGS, ...(db.kvGet<Partial<AlertSettings>>(SETTINGS_KEY) ?? {}) };
}
export function setAlertSettings(db: Db, s: AlertSettings): void {
  db.kvSet(SETTINGS_KEY, s);
}
export function listAlertCoins(db: Db): string[] {
  return (db.sql.prepare('SELECT key FROM alert_coins ORDER BY added_at, key').all() as { key: string }[]).map((r) => r.key);
}
export function addAlertCoin(db: Db, key: string, nowMs: number): void {
  db.sql.prepare('INSERT OR IGNORE INTO alert_coins (key, added_at) VALUES (?, ?)').run(key, nowMs);
}
export function removeAlertCoin(db: Db, key: string): void {
  db.sql.prepare('DELETE FROM alert_coins WHERE key = ?').run(key);
}

/** 한국 시간 02:00~05:59 */
export function isQuietHour(ms: number): boolean {
  const h = new Date(ms + 9 * 3600_000).getUTCHours();
  return h >= 2 && h < 6;
}

export interface AlertDeps {
  db: Db;
  now: () => number;
  okx: Pick<OkxClient, 'getTickers' | 'getAnnouncements' | 'getLiquidations' | 'getFundingRate'>;
  upbit: Pick<UpbitClient, 'markets'>;
  news: Pick<News, 'search'>;
  instruments: { koreanCoinName(base: string): string | null };
  push: Pick<Push, 'sendAll'>;
  /** 급변 이유 한 줄(AI). 없거나 실패하면 null */
  explain?: (key: string, name: string, pct: number, window: string) => Promise<string | null>;
}

export function createAlertMonitor(deps: AlertDeps): { tickPrices(): Promise<void>; tickEvents(): Promise<void> } {
  const { db } = deps;
  const samples = new Map<string, { t: number; p: number }[]>();
  const q = {
    recent: db.sql.prepare('SELECT 1 FROM alert_log WHERE key = ? AND kind = ? AND direction = ? AND sent_at >= ? LIMIT 1'),
    log: db.sql.prepare('INSERT INTO alert_log (key, kind, direction, sent_at) VALUES (?, ?, ?, ?)'),
    seen: db.sql.prepare('SELECT 1 FROM seen_events WHERE id = ?'),
    markSeen: db.sql.prepare('INSERT OR IGNORE INTO seen_events (id, seen_at) VALUES (?, ?)'),
  };
  const baseOf = (key: string) => parseInstrumentKey(key).symbol.split('-')[0]!;
  const nameOf = (key: string) => { const b = baseOf(key); return deps.instruments.koreanCoinName(b) ?? b; };
  const recently = (key: string, kind: string, dir: string, sinceMs: number) => Boolean(q.recent.get(key, kind, dir, sinceMs));
  /** 처음 본 사건이면 true(기록도 한다) */
  const firstSeen = (id: string) => {
    if (q.seen.get(id)) return false;
    q.markSeen.run(id, deps.now());
    return true;
  };
  const seeded = (source: string) => db.kvGet<boolean>(`alerts.seeded.${source}`) === true;
  const seed = (source: string) => db.kvSet(`alerts.seeded.${source}`, true);

  async function send(key: string, title: string, body: string, kind: FeedKind = 'alert') {
    if (isQuietHour(deps.now())) return;
    addFeedItem(db, deps.now, { kind, market: 'coin', key, title, body, isBreaking: true });
    await deps.push.sendAll({ title, body, url: '/' });
  }

  return {
    async tickPrices() {
      const coins = listAlertCoins(db);
      if (coins.length === 0) return;
      const settings = getAlertSettings(db);
      const now = deps.now();
      const needSwap = coins.some((k) => k.endsWith('-SWAP'));
      const needSpot = coins.some((k) => !k.endsWith('-SWAP'));
      const [spot, swap] = await Promise.all([
        needSpot ? deps.okx.getTickers('SPOT').catch(() => []) : [],
        needSwap ? deps.okx.getTickers('SWAP').catch(() => []) : [],
      ]);
      const last = new Map([...spot, ...swap].map((t) => [t.instId, t.last]));
      for (const key of coins) {
        const price = last.get(parseInstrumentKey(key).symbol);
        if (!price) continue;
        const list = (samples.get(key) ?? []).filter((s) => s.t >= now - SAMPLE_KEEP_MS);
        list.push({ t: now, p: price });
        samples.set(key, list);
        for (const w of WINDOWS) {
          const span = w.minutes * 60_000;
          const past = list.find((s) => s.t >= now - span - 30_000);
          if (!past || now - past.t < span - 30_000) continue;
          const pct = (price / past.p - 1) * 100;
          if (Math.abs(pct) < settings[w.setting]) continue;
          const dir = pct > 0 ? 'up' : 'down';
          if (recently(key, 'spike', dir, now - REPEAT_MS)) break;
          q.log.run(key, 'spike', dir, now);
          if (isQuietHour(now)) break;
          const name = nameOf(key);
          const reason = deps.explain ? await deps.explain(key, name, pct, w.label).catch(() => null) : null;
          await send(key, `[급변] ${name} ${w.label} ${pct > 0 ? '+' : ''}${pct.toFixed(1)}%`, [`현재 ${fmtNum(price)} USDT`, reason].filter(Boolean).join('\n'), 'spike');
          break;
        }
      }
    },

    async tickEvents() {
      const coins = listAlertCoins(db);
      if (coins.length === 0 || !getAlertSettings(db).events) return;
      const now = deps.now();
      const bases = new Map(coins.map((k) => [baseOf(k), k]));

      // OKX 공지
      const anns = await deps.okx.getAnnouncements().catch(() => null);
      if (anns) {
        const wasSeeded = seeded('ann');
        for (const a of anns) {
          if (!ANN_TYPES.has(a.type) || !firstSeen(`ann:${a.url}`) || !wasSeeded) continue;
          for (const [base, key] of bases) {
            if (new RegExp(`\\b${base}\\b`, 'i').test(a.title)) await send(key, `[공지] ${nameOf(key)}: ${a.title}`, `OKX 공지\n${a.url}`);
          }
        }
        if (!wasSeeded) seed('ann');
      }

      // 업비트 유의·주의
      const markets = await deps.upbit.markets().catch(() => null);
      if (markets) {
        const prev = db.kvGet<Record<string, { warning: boolean; cautions: string[] }>>(UPBIT_STATE_KEY) ?? {};
        const next: typeof prev = { ...prev };
        for (const [base, key] of bases) {
          const m = markets.find((x) => x.market === `KRW-${base}`);
          if (!m) continue;
          const before = prev[base];
          next[base] = { warning: m.warning, cautions: m.cautions };
          if (!before) continue;
          if (m.warning && !before.warning) await send(key, `[업비트] ${nameOf(key)} 투자유의 종목 지정`, '업비트가 투자유의 종목으로 지정했어요. 거래 지원이 끝날 수 있어요.');
          for (const c of m.cautions.filter((c) => !before.cautions.includes(c))) {
            await send(key, `[업비트] ${nameOf(key)} 주의: ${CAUTION_LABEL[c] ?? c}`, '업비트가 주의 표시를 붙였어요.');
          }
        }
        db.kvSet(UPBIT_STATE_KEY, next);
      }

      for (const [base, key] of bases) {
        const name = nameOf(key);
        // 짧은 시간 대규모 청산
        const liqs = await deps.okx.getLiquidations(`${base}-USDT`).catch(() => []);
        const recent = liqs.filter((l) => l.ts >= now - LIQ_WINDOW_MS);
        const total = recent.reduce((s, l) => s + l.usd, 0);
        if (total >= LIQ_ALERT_USD && !recently(key, 'liq', 'any', now - REPEAT_MS)) {
          q.log.run(key, 'liq', 'any', now);
          const longPct = Math.round((recent.filter((l) => l.side === 'long').reduce((s, l) => s + l.usd, 0) / total) * 100);
          await send(key, `[청산] ${name} 5분간 청산 $${(total / 1e6).toFixed(1)}M`, `롱 ${longPct}% · 숏 ${100 - longPct}%`);
        }

        // 펀딩비 극단값(하루 한 번)
        const rate = await deps.okx.getFundingRate(`${base}-USDT-SWAP`).catch(() => null);
        if (rate !== null && Math.abs(rate) >= FUNDING_ALERT) {
          const dir = rate > 0 ? 'up' : 'down';
          const dayStart = Date.parse(`${kstDay(now)}T00:00:00+09:00`);
          if (!recently(key, 'funding', dir, dayStart)) {
            q.log.run(key, 'funding', dir, now);
            await send(key, `[펀딩비] ${name} 펀딩비 ${rate > 0 ? '+' : ''}${(rate * 100).toFixed(3)}%`, rate > 0 ? '롱이 크게 쏠려 있어요(롱이 숏에게 지급).' : '숏이 크게 쏠려 있어요(숏이 롱에게 지급).');
          }
        }

        // 핵심어가 든 뉴스
        const ko = deps.instruments.koreanCoinName(base);
        const items = await deps.news.search(ko ?? `${base} 코인`).catch(() => null);
        if (items) {
          const source = `news:${key}`;
          const wasSeeded = seeded(source);
          for (const n of items) {
            if (!firstSeen(`news:${n.url}`) || !wasSeeded) continue;
            const word = NEWS_WORDS.find((w) => n.title.includes(w));
            if (word) await send(key, `[뉴스] ${name}: ${n.title}`, `${n.source ?? ''} ${n.url}`.trim());
          }
          if (!wasSeeded) seed(source);
        }
      }
    },
  };
}
