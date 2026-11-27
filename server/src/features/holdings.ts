/** 보유 종목: AI에게 말하거나 직접 넣은 종목(수량·평단은 몰라도 된다) */
import type { Db } from '../db.js';
import { instrumentKey, parseInstrumentKey } from '../market/types.js';

export interface Holding { key: string; market: string; name: string | null; quantity: number | null; avgPrice: number | null; addedAt: number }

export function listHoldings(db: Db, names?: { nameOf(key: string): string | null } | null): Holding[] {
  const rows = db.sql.prepare('SELECT key, market, quantity, avg_price, added_at FROM holdings ORDER BY added_at DESC, key').all() as { key: string; market: string; quantity: number | null; avg_price: number | null; added_at: number }[];
  return rows.map((r) => ({ key: r.key, market: r.market, name: names?.nameOf(r.key) ?? null, quantity: r.quantity, avgPrice: r.avg_price, addedAt: r.added_at }));
}

/** 이미 있으면 새로 알려 준 값만 바꾼다(모르는 값은 그대로 둔다) */
export function saveHolding(db: Db, key: string, v: { quantity: number | null; avgPrice: number | null }, now: number): string {
  const inst = parseInstrumentKey(key);
  const k = instrumentKey(inst);
  db.sql.prepare(`INSERT INTO holdings (key, market, quantity, avg_price, added_at) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET quantity = COALESCE(excluded.quantity, quantity), avg_price = COALESCE(excluded.avg_price, avg_price)`)
    .run(k, inst.market, v.quantity, v.avgPrice, now);
  return k;
}

export function removeHolding(db: Db, key: string): boolean {
  return Number(db.sql.prepare('DELETE FROM holdings WHERE key = ?').run(key).changes) > 0;
}
