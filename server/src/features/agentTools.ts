/**
 * 채팅 AI가 앱 안에서 직접 하는 일(에이전트 도구): 종목 찾기, 보유 종목·즐겨찾기 넣고 빼기.
 * 한 일은 채팅에 짧은 상태 줄로도 보여 준다.
 */
import { z } from 'zod';
import type { Db } from '../db.js';
import type { AiTool } from '../ai/types.js';
import type { MarketService } from '../market/service.js';
import { parseInstrumentKey } from '../market/types.js';
import { listHoldings, removeHolding, saveHolding } from './holdings.js';

type Names = { nameOf(key: string): string | null; search?(q: string, limit?: number): Promise<{ key: string; name: string; market: string }[]> };

const unitOf = (key: string) => (key.startsWith('coin:') ? '개' : '주');

export function buildAgentTools(deps: { db: Db; market: Pick<MarketService, 'addWatch' | 'removeWatch'>; instruments?: Names | null; now: () => number }): AiTool[] {
  const label = (key: string) => deps.instruments?.nameOf(key) ?? key.split(':').at(-1)!;
  const checkKey = (key: string) => { parseInstrumentKey(key); return key; };

  const find: AiTool<{ query: string }> = {
    name: 'find_instrument',
    description: '종목 이름이나 기호로 종목 키를 찾는다(예: "삼성" → kr:005930). 보유·즐겨찾기 도구를 쓰기 전에 키를 모르면 먼저 부른다.',
    schema: z.strictObject({ query: z.string().min(1).max(40) }),
    async run({ query }) {
      const hits = deps.instruments?.search ? await deps.instruments.search(query, 5) : [];
      return JSON.stringify(hits.slice(0, 5).map((h) => ({ key: h.key, name: h.name, market: h.market })));
    },
  };

  const addHolding: AiTool<{ key: string; quantity: number | null; avgPrice: number | null }> = {
    name: 'add_holding',
    description: '사용자가 가지고 있다고 말한 종목을 보유 종목에 넣는다. 수량·평단(그 종목 통화 기준)을 모르면 null. 이미 있으면 알려 준 값만 바꾼다.',
    schema: z.strictObject({ key: z.string(), quantity: z.number().positive().nullable(), avgPrice: z.number().positive().nullable() }),
    async run({ key, quantity, avgPrice }, ctx) {
      const k = saveHolding(deps.db, checkKey(key), { quantity, avgPrice }, deps.now());
      const msg = `${label(k)}를 보유 종목에 넣었어요${quantity ? ` (${quantity.toLocaleString('ko-KR')}${unitOf(k)})` : ''}`;
      ctx.emit({ type: 'status', message: msg });
      return msg;
    },
  };

  const removeHold: AiTool<{ key: string }> = {
    name: 'remove_holding',
    description: '보유 종목에서 뺀다(팔았다고 할 때).',
    schema: z.strictObject({ key: z.string() }),
    async run({ key }, ctx) {
      const ok = removeHolding(deps.db, checkKey(key));
      const msg = ok ? `${label(key)}를 보유 종목에서 뺐어요` : `${label(key)}는 보유 종목에 없어요`;
      ctx.emit({ type: 'status', message: msg });
      return msg;
    },
  };

  const listHold: AiTool<Record<string, never>> = {
    name: 'list_holdings',
    description: '지금 보유 종목 목록(키, 이름, 수량, 평단)을 가져온다.',
    schema: z.strictObject({}),
    async run() {
      return JSON.stringify(listHoldings(deps.db, deps.instruments).map(({ key, name, quantity, avgPrice }) => ({ key, name, quantity, avgPrice })));
    },
  };

  const addFav: AiTool<{ key: string }> = {
    name: 'add_favorite',
    description: '종목을 즐겨찾기(자주 보는 종목)에 넣는다.',
    schema: z.strictObject({ key: z.string() }),
    async run({ key }, ctx) {
      deps.market.addWatch(checkKey(key));
      const msg = `${label(key)}를 즐겨찾기에 넣었어요`;
      ctx.emit({ type: 'status', message: msg });
      return msg;
    },
  };

  const removeFav: AiTool<{ key: string }> = {
    name: 'remove_favorite',
    description: '종목을 즐겨찾기에서 뺀다.',
    schema: z.strictObject({ key: z.string() }),
    async run({ key }, ctx) {
      deps.market.removeWatch(checkKey(key));
      const msg = `${label(key)}를 즐겨찾기에서 뺐어요`;
      ctx.emit({ type: 'status', message: msg });
      return msg;
    },
  };

  return [find, addHolding, removeHold, listHold, addFav, removeFav];
}
