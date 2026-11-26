import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { gunzipSync, gzipSync } from 'node:zlib';
import type { Db } from './db.js';

/**
 * 무료 서버(Render)는 잠들거나 재시작하면 디스크가 지워진다.
 * 그래서 SQLite 파일 전체를 압축해 바깥 DB(Neon Postgres)에 통째로 저장하고, 켜질 때 되살린다.
 */
export interface SnapshotStore {
  load(): Promise<Buffer | null>;
  save(data: Buffer): Promise<void>;
}

type Query = (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;

export function createPgSnapshotStore(query: Query): SnapshotStore {
  let ready: Promise<unknown> | null = null;
  const ensure = () => (ready ??= query('CREATE TABLE IF NOT EXISTS app_snapshot (id INT PRIMARY KEY, data BYTEA NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now())'));
  return {
    async load() {
      await ensure();
      const r = await query('SELECT data FROM app_snapshot WHERE id = 1');
      const v = r.rows[0]?.data;
      return v ? Buffer.from(v as Uint8Array) : null;
    },
    async save(data) {
      await ensure();
      await query(
        'INSERT INTO app_snapshot (id, data, updated_at) VALUES (1, $1, now()) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now()',
        [data],
      );
    },
  };
}

/** 저장된 스냅샷이 있으면 file에 풀어 놓는다. 있었으면 true. */
export async function restoreSnapshot(store: SnapshotStore, file: string): Promise<boolean> {
  const data = await store.load();
  if (!data) return false;
  mkdirSync(path.dirname(file), { recursive: true });
  for (const extra of [`${file}-wal`, `${file}-shm`]) if (existsSync(extra)) rmSync(extra);
  writeFileSync(file, gunzipSync(data));
  return true;
}

export interface Persistence {
  /** 지금 바로 저장(바뀐 게 없어도) */
  flush(): Promise<void>;
  /** 로그인 토큰처럼 잃으면 안 되는 값이 바뀌었을 때: 곧바로 저장 */
  markUrgent(): void;
  /** 진행 중인 저장이 끝날 때까지 기다림 */
  idle(): Promise<void>;
  status(): { enabled: true; lastSavedAt: number | null; lastError: string | null };
  stop(): Promise<void>;
}

export function startPersistence(opts: { db: Db; store: SnapshotStore; intervalMs?: number; now?: () => number }): Persistence {
  const { db, store } = opts;
  const now = opts.now ?? (() => Date.now());
  const changesStmt = db.sql.prepare('SELECT total_changes() AS n');
  const changes = () => (changesStmt.get() as { n: number }).n;
  let savedAt = changes();
  let lastSavedAt: number | null = null;
  let lastError: string | null = null;
  let chain: Promise<void> = Promise.resolve();

  function snapshot(): Buffer {
    const tmp = path.join(os.tmpdir(), `snap-${crypto.randomUUID()}.db`);
    try {
      db.sql.exec(`VACUUM INTO '${tmp.replace(/'/g, "''")}'`);
      return gzipSync(readFileSync(tmp));
    } finally {
      if (existsSync(tmp)) rmSync(tmp);
    }
  }

  async function doFlush(force: boolean) {
    const n = changes();
    if (!force && n === savedAt) return;
    try {
      await store.save(snapshot());
      savedAt = n;
      lastSavedAt = now();
      lastError = null;
    } catch (err) {
      lastError = '데이터 저장에 실패했어요';
      console.error('스냅샷 저장 실패', err instanceof Error ? err.message : err);
    }
  }

  const enqueue = (force: boolean) => {
    chain = chain.then(() => doFlush(force));
    return chain;
  };

  const timer = setInterval(() => { void enqueue(false); }, opts.intervalMs ?? 3000);
  timer.unref?.();

  return {
    flush: () => enqueue(true),
    markUrgent: () => { void enqueue(false); },
    idle: () => chain,
    status: () => ({ enabled: true, lastSavedAt, lastError }),
    async stop() {
      clearInterval(timer);
      await chain;
    },
  };
}
