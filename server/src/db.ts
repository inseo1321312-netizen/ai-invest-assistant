import { DatabaseSync } from 'node:sqlite';

export interface Db {
  sql: DatabaseSync;
  kvGet<T = unknown>(key: string): T | null;
  kvSet(key: string, value: unknown): void;
  kvDelete(key: string): void;
}

/** 순서대로 한 번씩 적용된다. 새 마이그레이션은 배열 끝에 추가한다. */
export const MIGRATIONS: string[] = [
  `CREATE TABLE kv (key TEXT PRIMARY KEY, value TEXT NOT NULL, updated_at INTEGER NOT NULL);`,
  `CREATE TABLE sessions (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL);`,
  `CREATE TABLE candles (key TEXT NOT NULL, bar TEXT NOT NULL, time INTEGER NOT NULL, o REAL, h REAL, l REAL, c REAL, v REAL, PRIMARY KEY (key, bar, time));
   CREATE TABLE candle_meta (key TEXT NOT NULL, bar TEXT NOT NULL, fetched_at INTEGER NOT NULL, PRIMARY KEY (key, bar));
   CREATE TABLE watchlist (key TEXT PRIMARY KEY, market TEXT NOT NULL, added_at INTEGER NOT NULL);
   CREATE TABLE manual_holdings (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, market TEXT NOT NULL, quantity REAL NOT NULL, avg_price REAL NOT NULL, currency TEXT NOT NULL, side TEXT, leverage REAL);`,
  `CREATE TABLE ai_usage (id INTEGER PRIMARY KEY AUTOINCREMENT, day TEXT NOT NULL, month TEXT NOT NULL, purpose TEXT NOT NULL, provider TEXT NOT NULL, usd REAL NOT NULL, at INTEGER NOT NULL);
   CREATE INDEX ai_usage_day ON ai_usage (day, purpose);
   CREATE INDEX ai_usage_month ON ai_usage (month);`,
  `CREATE TABLE analyses (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, horizon TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, data_time INTEGER NOT NULL, created_at INTEGER NOT NULL, body_json TEXT NOT NULL, cost_usd REAL NOT NULL);
   CREATE INDEX analyses_lookup ON analyses (key, horizon, provider, data_time);
   CREATE TABLE point_explanations (key TEXT NOT NULL, bar TEXT NOT NULL, time INTEGER NOT NULL, provider TEXT NOT NULL, text TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (key, bar, time, provider));
   CREATE TABLE chats (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT, title TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE TABLE chat_messages (id INTEGER PRIMARY KEY AUTOINCREMENT, chat_id INTEGER NOT NULL REFERENCES chats(id) ON DELETE CASCADE, role TEXT NOT NULL, text TEXT NOT NULL, provider TEXT, created_at INTEGER NOT NULL);`,
  `CREATE TABLE feed_items (id INTEGER PRIMARY KEY AUTOINCREMENT, created_at INTEGER NOT NULL, day TEXT NOT NULL, kind TEXT NOT NULL, market TEXT NOT NULL, key TEXT, title TEXT NOT NULL, body TEXT NOT NULL, is_breaking INTEGER NOT NULL);
   CREATE INDEX feed_day ON feed_items (day);
   CREATE TABLE alert_log (key TEXT NOT NULL, kind TEXT NOT NULL, direction TEXT NOT NULL, sent_at INTEGER NOT NULL);
   CREATE INDEX alert_lookup ON alert_log (key, kind, direction, sent_at);
   CREATE TABLE push_subs (endpoint TEXT PRIMARY KEY, json TEXT NOT NULL);`,
  `ALTER TABLE analyses ADD COLUMN origin TEXT NOT NULL DEFAULT 'user';
   ALTER TABLE analyses ADD COLUMN tier TEXT NOT NULL DEFAULT 'standard';`,
  `CREATE TABLE recent_views (key TEXT PRIMARY KEY, market TEXT NOT NULL, viewed_at INTEGER NOT NULL, count INTEGER NOT NULL DEFAULT 1);`,
  `CREATE TABLE alert_coins (key TEXT PRIMARY KEY, added_at INTEGER NOT NULL);
   CREATE TABLE seen_events (id TEXT PRIMARY KEY, seen_at INTEGER NOT NULL);`,
  `CREATE TABLE holdings (key TEXT PRIMARY KEY, market TEXT NOT NULL, quantity REAL, avg_price REAL, added_at INTEGER NOT NULL);`,
  `CREATE TABLE price_alerts (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT NOT NULL, op TEXT NOT NULL, price REAL NOT NULL, created_at INTEGER NOT NULL);`,
  `CREATE TABLE comparisons (id INTEGER PRIMARY KEY AUTOINCREMENT, set_key TEXT NOT NULL, keys_json TEXT NOT NULL, horizon TEXT NOT NULL, provider TEXT NOT NULL, model TEXT NOT NULL, body_json TEXT NOT NULL, facts_json TEXT NOT NULL, names_json TEXT NOT NULL, created_at INTEGER NOT NULL, cost_usd REAL NOT NULL);`,
];

export function openDb(file: string): Db {
  const sql = new DatabaseSync(file);
  if (file !== ':memory:') sql.exec('PRAGMA journal_mode = WAL;');
  sql.exec('PRAGMA foreign_keys = ON;');
  const current = (sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  for (let i = current; i < MIGRATIONS.length; i++) {
    sql.exec('BEGIN');
    try {
      sql.exec(MIGRATIONS[i]!);
      sql.exec(`PRAGMA user_version = ${i + 1}`);
      sql.exec('COMMIT');
    } catch (err) {
      sql.exec('ROLLBACK');
      throw err;
    }
  }
  const getStmt = sql.prepare('SELECT value FROM kv WHERE key = ?');
  const setStmt = sql.prepare(
    'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
  );
  const delStmt = sql.prepare('DELETE FROM kv WHERE key = ?');
  return {
    sql,
    kvGet<T>(key: string): T | null {
      const row = getStmt.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as T) : null;
    },
    kvSet(key, value) {
      setStmt.run(key, JSON.stringify(value), Date.now());
    },
    kvDelete(key) {
      delStmt.run(key);
    },
  };
}
