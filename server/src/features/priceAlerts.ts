/**
 * 목표가 알림: 종목이 정한 가격에 닿으면 푸시를 한 번 보내고 지운다.
 * 방향(이상/이하)은 정할 때의 현재가로 정한다. 새벽 2~6시에는 보내지 않고 아침에 다시 본다.
 */
import { z } from 'zod';
import type { Db } from '../db.js';
import type { AiTool } from '../ai/types.js';
import type { Push } from '../push.js';
import { instrumentKey, parseInstrumentKey, type Instrument, type Quote } from '../market/types.js';
import { isQuietHour } from './alerts.js';

export interface PriceAlert { id: number; key: string; name: string | null; op: 'above' | 'below'; price: number; createdAt: number }
type Names = { nameOf(key: string): string | null } | null | undefined;
type GetQuote = (inst: Instrument) => Promise<Quote>;

export const MAX_PRICE_ALERTS = 30;

const unitOf = (key: string) => (key.startsWith('kr:') ? '원' : key.startsWith('us:') ? '달러' : 'USDT');
export function fmtTarget(key: string, n: number): string {
  if (key.startsWith('kr:')) return `${Math.round(n).toLocaleString('ko-KR')}원`;
  if (key.startsWith('us:')) return `$${n.toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
  return `${n.toLocaleString('en-US', { maximumSignificantDigits: 8 })} USDT`;
}

export function listPriceAlerts(db: Db, names?: Names): PriceAlert[] {
  const rows = db.sql.prepare('SELECT id, key, op, price, created_at FROM price_alerts ORDER BY key, price').all() as { id: number; key: string; op: string; price: number; created_at: number }[];
  return rows.map((r) => ({ id: r.id, key: r.key, name: names?.nameOf(r.key) ?? null, op: r.op as PriceAlert['op'], price: r.price, createdAt: r.created_at }));
}

/** 현재가보다 높으면 '이상', 낮으면 '이하'로 저장한다 */
export async function addPriceAlert(db: Db, getQuote: GetQuote, key: string, price: number, now: number): Promise<PriceAlert> {
  if (!(price > 0) || !Number.isFinite(price)) throw new Error('가격은 0보다 커야 해요');
  const inst = parseInstrumentKey(key);
  const k = instrumentKey(inst);
  const count = (db.sql.prepare('SELECT COUNT(*) AS n FROM price_alerts').get() as { n: number }).n;
  if (count >= MAX_PRICE_ALERTS) throw new Error(`목표가 알림은 ${MAX_PRICE_ALERTS}개까지예요`);
  const current = (await getQuote(inst)).price;
  const op: PriceAlert['op'] = price >= current ? 'above' : 'below';
  const res = db.sql.prepare('INSERT INTO price_alerts (key, op, price, created_at) VALUES (?, ?, ?, ?)').run(k, op, price, now);
  return { id: Number(res.lastInsertRowid), key: k, name: null, op, price, createdAt: now };
}

export function removePriceAlert(db: Db, id: number): boolean {
  return Number(db.sql.prepare('DELETE FROM price_alerts WHERE id = ?').run(id).changes) > 0;
}

export function createPriceAlertMonitor(deps: { db: Db; now: () => number; getQuote: GetQuote; push: Pick<Push, 'sendAll'>; names?: Names }) {
  return {
    async tick(): Promise<void> {
      const alerts = listPriceAlerts(deps.db, deps.names);
      if (alerts.length === 0 || isQuietHour(deps.now())) return;
      const prices = new Map<string, number | null>();
      for (const key of new Set(alerts.map((a) => a.key))) {
        prices.set(key, await deps.getQuote(parseInstrumentKey(key)).then((q) => q.price).catch(() => null));
      }
      for (const a of alerts) {
        const p = prices.get(a.key);
        if (p === null || p === undefined) continue;
        const hit = a.op === 'above' ? p >= a.price : p <= a.price;
        if (!hit) continue;
        // 먼저 지워서 다음 확인 때 또 보내지 않게
        if (!removePriceAlert(deps.db, a.id)) continue;
        const name = a.name ?? a.key.split(':').at(-1)!;
        await deps.push.sendAll({ title: `[목표가] ${name} ${fmtTarget(a.key, a.price)} 도달`, body: `지금 ${fmtTarget(a.key, p)}`, url: '/' }).catch(() => undefined);
      }
    },
  };
}

/** 채팅 AI 도구: "삼성전자 18만원 넘으면 알려줘" */
export function buildPriceAlertTools(deps: { db: Db; getQuote: GetQuote; names?: Names; now: () => number }): AiTool[] {
  const label = (key: string) => deps.names?.nameOf(key) ?? key.split(':').at(-1)!;
  const set: AiTool<{ key: string; price: number }> = {
    name: 'set_price_alert',
    description: '목표가 알림을 건다. price는 그 종목 통화 기준(한국 주식 원, 미국 주식 달러, 코인 USDT). 현재가보다 높으면 그 이상, 낮으면 그 이하가 되는 순간 휴대폰 알림을 한 번 보낸다.',
    schema: z.strictObject({ key: z.string(), price: z.number().positive() }),
    async run({ key, price }, ctx) {
      const a = await addPriceAlert(deps.db, deps.getQuote, key, price, deps.now());
      const msg = `${label(a.key)} ${fmtTarget(a.key, a.price)} ${a.op === 'above' ? '이상' : '이하'}이면 알려 드릴게요`;
      ctx.emit({ type: 'status', message: msg });
      return `${msg} (단위: ${unitOf(a.key)}). 알림을 받으려면 설정에서 알림이 켜져 있어야 해요.`;
    },
  };
  const list: AiTool<Record<string, never>> = {
    name: 'list_price_alerts',
    description: '걸어 둔 목표가 알림 목록(id, 종목, 이상/이하, 가격).',
    schema: z.strictObject({}),
    async run() {
      return JSON.stringify(listPriceAlerts(deps.db, deps.names).map(({ id, key, name, op, price }) => ({ id, key, name, op, price })));
    },
  };
  const remove: AiTool<{ id: number }> = {
    name: 'remove_price_alert',
    description: '목표가 알림을 지운다(id는 list_price_alerts에서).',
    schema: z.strictObject({ id: z.number().int().positive() }),
    async run({ id }, ctx) {
      const ok = removePriceAlert(deps.db, id);
      const msg = ok ? '목표가 알림을 지웠어요' : '그 알림은 없어요';
      ctx.emit({ type: 'status', message: msg });
      return msg;
    },
  };
  return [set, list, remove];
}
