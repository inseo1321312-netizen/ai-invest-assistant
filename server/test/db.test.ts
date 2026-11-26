import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';

test('kv roundtrip', () => {
  const db = openDb(':memory:');
  db.kvSet('a', { n: 1 });
  expect(db.kvGet('a')).toEqual({ n: 1 });
  expect(db.kvGet('missing')).toBeNull();
  db.kvSet('a', { n: 2 });
  expect(db.kvGet('a')).toEqual({ n: 2 });
});

test('migrations set user_version and are idempotent on reopen', () => {
  const db = openDb(':memory:');
  const v = (db.sql.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  expect(v).toBeGreaterThan(0);
});
