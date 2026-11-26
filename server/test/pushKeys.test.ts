import { expect, test } from 'vitest';
import { openDb } from '../src/db.js';
import { createPush } from '../src/push.js';

test('without configured keys the server makes its own VAPID keys once and keeps them', async () => {
  const db = openDb(':memory:');
  const a = createPush({ vapid: null, db, subject: 'https://x.onrender.com' });
  const b = createPush({ vapid: null, db, subject: 'https://x.onrender.com' });
  expect(a.publicKey()).toMatch(/^[A-Za-z0-9_-]{80,}$/);
  expect(b.publicKey()).toBe(a.publicKey());
  let opts: Record<string, unknown> | null = null;
  const c = createPush({ vapid: null, db, subject: 'https://x.onrender.com', send: async (_s, _p, o) => { opts = o; return {}; } });
  c.subscribe({ endpoint: 'https://push/1', keys: { p256dh: 'p', auth: 'a' } });
  await c.sendAll({ title: 't', body: 'b', url: '/' });
  expect((opts as unknown as { vapidDetails: { publicKey: string; subject: string } }).vapidDetails).toMatchObject({ publicKey: a.publicKey(), subject: 'https://x.onrender.com' });
});
