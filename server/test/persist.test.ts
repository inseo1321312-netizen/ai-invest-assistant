import { mkdtempSync, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { createPgSnapshotStore, restoreSnapshot, startPersistence, type SnapshotStore } from '../src/persist.js';

function memoryStore() {
  let data: Buffer | null = null;
  let saves = 0;
  const store: SnapshotStore & { saves(): number; raw(): Buffer | null } = {
    async load() { return data; },
    async save(d) { saves++; data = Buffer.from(d); },
    saves: () => saves,
    raw: () => data,
  };
  return store;
}

const tmpFile = () => path.join(mkdtempSync(path.join(os.tmpdir(), 'snap-')), 'app.db');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('snapshot persistence', () => {
  test('restore does nothing when the store is empty', async () => {
    const file = tmpFile();
    expect(await restoreSnapshot(memoryStore(), file)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  test('flush then restore brings the data back into a fresh file', async () => {
    const store = memoryStore();
    const fileA = tmpFile();
    const dbA = openDb(fileA);
    dbA.kvSet('siwc.tokens', { refreshToken: 'RT-9' });
    const p = startPersistence({ db: dbA, store, intervalMs: 10_000 });
    await p.flush();
    await p.stop();
    const fileB = tmpFile();
    expect(await restoreSnapshot(store, fileB)).toBe(true);
    expect(openDb(fileB).kvGet('siwc.tokens')).toEqual({ refreshToken: 'RT-9' });
  });

  test('saves only when something changed', async () => {
    const store = memoryStore();
    const db = openDb(tmpFile());
    const p = startPersistence({ db, store, intervalMs: 20 });
    await wait(80);
    expect(store.saves()).toBe(0);
    db.kvSet('a', 1);
    await wait(80);
    expect(store.saves()).toBe(1);
    await wait(80);
    expect(store.saves()).toBe(1);
    await p.stop();
  });

  test('urgent changes are saved right away and the last state wins', async () => {
    const store = memoryStore();
    const db = openDb(tmpFile());
    const p = startPersistence({ db, store, intervalMs: 60_000 });
    db.kvSet('siwc.tokens', { refreshToken: 'RT-1' });
    p.markUrgent();
    db.kvSet('siwc.tokens', { refreshToken: 'RT-2' });
    p.markUrgent();
    await p.idle();
    const file = tmpFile();
    await restoreSnapshot(store, file);
    expect(openDb(file).kvGet('siwc.tokens')).toEqual({ refreshToken: 'RT-2' });
    await p.stop();
  });

  test('a failing store does not crash and is reported', async () => {
    const db = openDb(tmpFile());
    const store: SnapshotStore = { async load() { return null; }, async save() { throw new Error('network'); } };
    const p = startPersistence({ db, store, intervalMs: 60_000 });
    db.kvSet('a', 1);
    await p.flush();
    expect(p.status()).toMatchObject({ enabled: true, lastError: '데이터 저장에 실패했어요' });
    await p.stop();
  });
});

describe('postgres snapshot store', () => {
  test('creates the table, saves with upsert, loads the latest', async () => {
    const calls: { text: string; params?: unknown[] }[] = [];
    let saved: Buffer | null = null;
    const query = async (text: string, params?: unknown[]) => {
      calls.push({ text, params });
      if (/INSERT INTO app_snapshot/.test(text)) saved = params![0] as Buffer;
      if (/SELECT data FROM app_snapshot/.test(text)) return { rows: saved ? [{ data: saved }] : [] };
      return { rows: [] };
    };
    const store = createPgSnapshotStore(query);
    expect(await store.load()).toBeNull();
    await store.save(Buffer.from('hello'));
    expect((await store.load())!.toString()).toBe('hello');
    expect(calls[0]!.text).toMatch(/CREATE TABLE IF NOT EXISTS app_snapshot/);
    expect(calls.some((c) => /ON CONFLICT \(id\) DO UPDATE/.test(c.text))).toBe(true);
  });
});
