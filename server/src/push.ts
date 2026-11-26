import { generateVAPIDKeys, sendNotification } from 'web-push';
import type { Config } from './config.js';
import type { Db } from './db.js';

export interface PushSub { endpoint: string; keys: { p256dh: string; auth: string } }
export interface PushPayload { title: string; body: string; url: string }

export interface Push {
  subscribe(sub: PushSub): void;
  sendAll(payload: PushPayload): Promise<void>;
  /** 브라우저가 구독할 때 쓰는 공개 키 */
  publicKey(): string;
}

type Sender = (sub: PushSub, payload: string, options: Record<string, unknown>) => Promise<unknown>;
const KEYS_KV = 'push.vapid';

/**
 * 알림 키(VAPID)가 설정에 없으면 서버가 한 번 만들어 DB에 저장해 둔다.
 * (DB는 바깥 저장소에 백업되므로 서버가 다시 켜져도 같은 키를 쓴다)
 */
export function createPush(opts: { vapid: Config['vapid']; db: Db; subject?: string | null; send?: Sender }): Push {
  const { db } = opts;
  const send: Sender = opts.send ?? ((sub, payload, options) => sendNotification(sub, payload, options as never));
  let keys = opts.vapid ? { publicKey: opts.vapid.publicKey, privateKey: opts.vapid.privateKey } : db.kvGet<{ publicKey: string; privateKey: string }>(KEYS_KV);
  if (!keys) {
    keys = generateVAPIDKeys();
    db.kvSet(KEYS_KV, keys);
  }
  const subject = opts.vapid?.subject ?? opts.subject ?? 'mailto:owner@invest.local';
  const upsert = db.sql.prepare('INSERT INTO push_subs (endpoint, json) VALUES (?, ?) ON CONFLICT(endpoint) DO UPDATE SET json = excluded.json');
  const all = db.sql.prepare('SELECT json FROM push_subs');
  const del = db.sql.prepare('DELETE FROM push_subs WHERE endpoint = ?');
  const k = keys;
  return {
    publicKey: () => k.publicKey,
    subscribe(sub) {
      upsert.run(sub.endpoint, JSON.stringify(sub));
    },
    async sendAll(payload) {
      const subs = (all.all() as { json: string }[]).map((r) => JSON.parse(r.json) as PushSub);
      await Promise.all(subs.map(async (sub) => {
        try {
          await send(sub, JSON.stringify(payload), { TTL: 3600, vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey } });
        } catch (err) {
          const code = (err as { statusCode?: number }).statusCode;
          if (code === 404 || code === 410) del.run(sub.endpoint);
          else console.error('푸시 전송 실패', code ?? err);
        }
      }));
    },
  };
}
