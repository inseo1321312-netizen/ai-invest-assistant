import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { addAlertCoin, getAlertSettings, listAlertCoins, MAX_ALERT_COINS, removeAlertCoin, setAlertSettings } from '../features/alerts.js';
import { instrumentKey, parseInstrumentKey } from '../market/types.js';

const pct = z.number().min(0.5).max(50);

export function registerAlertRoutes(app: FastifyInstance, deps: { db: Db; now: () => number }) {
  app.get('/api/alerts', async () => ({ coins: listAlertCoins(deps.db), settings: getAlertSettings(deps.db) }));

  app.put('/api/alerts/settings', async (req, reply) => {
    const p = z.strictObject({ m5: pct, m15: pct, h1: pct, events: z.boolean() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '기준은 0.5~50% 사이로 넣어 주세요' });
    setAlertSettings(deps.db, p.data);
    return getAlertSettings(deps.db);
  });

  app.post('/api/alerts/coins', async (req, reply) => {
    const p = z.object({ key: z.string() }).safeParse(req.body);
    let key: string;
    try {
      const inst = parseInstrumentKey(p.success ? p.data.key : '');
      if (inst.market !== 'coin') throw new Error('not coin');
      key = instrumentKey(inst);
    } catch {
      return reply.code(400).send({ error: '알림은 코인만 정할 수 있어요' });
    }
    const coins = listAlertCoins(deps.db);
    if (!coins.includes(key) && coins.length >= MAX_ALERT_COINS) return reply.code(400).send({ error: `알림 코인은 ${MAX_ALERT_COINS}개까지예요` });
    addAlertCoin(deps.db, key, deps.now());
    return { ok: true };
  });

  app.delete('/api/alerts/coins', async (req, reply) => {
    const p = z.object({ key: z.string() }).safeParse(req.query);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    removeAlertCoin(deps.db, p.data.key);
    return { ok: true };
  });
}
