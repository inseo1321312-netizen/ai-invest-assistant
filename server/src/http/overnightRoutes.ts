import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../db.js';
import { getOvernight, latestOvernight, overnightHistory, readSettings, saveSettings, SLEEP_TIMES, WAKE_TIMES, type Overnight } from '../features/overnight.js';

/** 밤사이 탭: 최신 정리(필요하면 뒤에서 만들기 시작), 다시 정리, 설정, 지난 정리 */
export function registerOvernightRoutes(app: FastifyInstance, deps: { db: Db; overnight?: Overnight | null }) {
  const view = () => ({
    recap: latestOvernight(deps.db),
    settings: readSettings(deps.db),
    making: deps.overnight?.state().making ?? false,
    error: deps.overnight?.state().error ?? null,
    sleepTimes: SLEEP_TIMES,
    wakeTimes: WAKE_TIMES,
  });

  app.get('/api/overnight', async () => {
    if (deps.overnight) void deps.overnight.ensure({ notify: false });
    return view();
  });

  app.post('/api/overnight/run', async (_req, reply) => {
    if (!deps.overnight) return reply.code(503).send({ error: '지금은 정리할 수 없어요' });
    void deps.overnight.rerun();
    return { making: true };
  });

  app.put('/api/overnight/settings', async (req, reply) => {
    const p = z.object({ sleep: z.string(), wake: z.string(), notify: z.boolean() }).safeParse(req.body);
    if (!p.success) return reply.code(400).send({ error: '설정을 확인해 주세요' });
    try {
      return { settings: saveSettings(deps.db, p.data) };
    } catch (e) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : '설정을 확인해 주세요' });
    }
  });

  app.get('/api/overnight/history', async () => ({ items: overnightHistory(deps.db) }));

  app.get('/api/overnight/:id', async (req, reply) => {
    const p = z.object({ id: z.coerce.number().int().positive() }).safeParse(req.params);
    if (!p.success) return reply.code(400).send({ error: '잘못된 요청입니다' });
    const recap = getOvernight(deps.db, p.data.id);
    if (!recap) return reply.code(404).send({ error: '지난 정리를 찾지 못했어요' });
    return { recap };
  });
}
