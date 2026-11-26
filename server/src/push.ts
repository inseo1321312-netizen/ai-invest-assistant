import { sendNotification } from 'web-push';
import type { Config } from './config.js';
import type { Db } from './db.js';

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPayload { title: string; body: string; url: string }

export interface Push {
  subscribe(sub: PushSub): void;
  sendAll(payload: PushPayload): Promise<void>;
}

type Sender = (sub: PushSub, payload: string, options: Record<string, unknown>) => Promise<unknown>;

export function createPush(opts: { vapid: Config['vapid']; db: Db; send?: Sender }): Push {
  const { db, vapid } = opts;
  const send: Sender = opts.send ?? ((sub, payload, options) => sendNotification(sub, payload, options as never));
  const upsert = db.sql.prepare('INSERT INTO push_subs (endpoint, json) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json');
  const all = db.sql.prepare('SELECT json FROM push_subs');
  const del = db.sql.prepare('DELETE FROM push_subs WHERE endpoint = ?');
  return {
    subscribe(sub) {
      upsert.run(sub.endpoint, JSON.stringify(sub));
    },
    async sendAll(payload) {
      if (!vapid) return;
      const subs = (all.all() as { json: string }[]).map((r) => JSON.parse(r.json) as PushSub);
      await Promise.all(subs.map(async (sub) => {
        try {
          await send(sub, JSON.stringify(payload), {
            TTL: 3600,
            vapidDetails: { subject: vapid.subject, publicKey: vapid.publicKey, privateKey: vapid.privateKey },
          });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) del.run(sub.endpoint);
          else console.error('푸시 전송 실패', code ?? err);
        }
      }));
    },
  };
}
