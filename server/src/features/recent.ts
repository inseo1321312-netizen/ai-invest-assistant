import type { Db } from '../db.js';
import type { MarketId } from '../market/types.js';
import { instrumentKey, parseInstrumentKey } from '../market/types.js';

const KEEP = 30;

/** 종목 화면을 열 때마다 기록한다. 30개만 남긴다. */
export function recordView(db: Db, key: string, nowMs: number): void {
  const inst = parseInstrumentKey(key);
  db.sql.prepare(`INSERT INTO recent_views (key, market, viewed_at, count) VALUES (?, ?, ?, 1)
    ON CONFLICT(key) DO UPDATE SET viewed_at = excluded.viewed_at, count = count + 1`).run(instrumentKey(inst), inst.market, nowMs);
  db.sql.prepare('DELETE FROM recent_views WHERE key NOT IN (SELECT key FROM recent_views ORDER BY viewed_at DESC LIMIT ?)').run(KEEP);
}

/** 최근 본 순서. exclude(즐겨찾기 등)는 뺀다. */
export function listRecent(db: Db, market: MarketId, limit: number, exclude: Set<string>): string[] {
  const rows = db.sql.prepare('SELECT key FROM recent_views WHERE market = ? ORDER BY viewed_at DESC').all(market) as { key: string }[];
  return rows.map((r) => r.key).filter((k) => !exclude.has(k)).slice(0, limit);
}
