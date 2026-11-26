import { expect, test } from 'vitest';
import { openDb } from '../../src/db.js';
import { listRecent, recordView } from '../../src/features/recent.js';

test('records views newest first and keeps 30', () => {
  const db = openDb(':memory:');
  for (let i = 0; i < 31; i++) recordView(db, `coin:C${i}-USDT`, 1000 + i);
  const all = listRecent(db, 'coin', 100, new Set());
  expect(all).toHaveLength(30);
  expect(all[0]).toBe('coin:C30-USDT');
  expect(all).not.toContain('coin:C0-USDT');
});

test('same key bumps time and count; filtered by market and exclusions', () => {
  const db = openDb(':memory:');
  recordView(db, 'coin:BTC-USDT', 1);
  recordView(db, 'kr:005930', 2);
  recordView(db, 'coin:ETH-USDT', 3);
  recordView(db, 'coin:BTC-USDT', 4);
  expect(listRecent(db, 'coin', 10, new Set())).toEqual(['coin:BTC-USDT', 'coin:ETH-USDT']);
  expect(listRecent(db, 'coin', 10, new Set(['coin:BTC-USDT']))).toEqual(['coin:ETH-USDT']);
  expect(listRecent(db, 'kr', 10, new Set())).toEqual(['kr:005930']);
  expect(db.sql.prepare('SELECT count FROM recent_views WHERE key = ?').get('coin:BTC-USDT')).toEqual({ count: 2 });
});
