import type { Db } from '../db.js';
import * as prompts from '../ai/prompts.js';
import type { AiEvent, AiTurn, ProviderId } from '../ai/types.js';
import { parseInstrumentKey } from '../market/types.js';
import type { FeatureDeps } from './deps.js';
import { buildMarketTools } from './tools.js';
import { buildAgentTools } from './agentTools.js';
import { buildPriceAlertTools } from './priceAlerts.js';

export type ChatEvent = AiEvent | { type: 'chat'; chatId: number };

export interface ChatMessage { id: number; role: 'user' | 'assistant'; text: string; provider: ProviderId | null; createdAt: number }

export function listChats(db: Db, key: string | null): { id: number; key: string | null; title: string; createdAt: number }[] {
  const rows = (key
    ? db.sql.prepare('SELECT id, key, title, created_at FROM chats WHERE key = ? ORDER BY id DESC LIMIT 50').all(key)
    : db.sql.prepare('SELECT id, key, title, created_at FROM chats ORDER BY id DESC LIMIT 50').all()) as { id: number; key: string | null; title: string; created_at: number }[];
  return rows.map((r) => ({ id: r.id, key: r.key, title: r.title, createdAt: r.created_at }));
}

export function chatMessages(db: Db, chatId: number, limit = 200): ChatMessage[] {
  const rows = db.sql.prepare('SELECT id, role, text, provider, created_at FROM (SELECT * FROM chat_messages WHERE chat_id = ? ORDER BY id DESC LIMIT ?) ORDER BY id').all(chatId, limit) as { id: number; role: string; text: string; provider: string | null; created_at: number }[];
  return rows.map((r) => ({ id: r.id, role: r.role as ChatMessage['role'], text: r.text, provider: r.provider as ProviderId | null, createdAt: r.created_at }));
}

export async function* chatTurn(deps: FeatureDeps, args: { chatId: number | null; key: string | null; provider: ProviderId; model?: string | null; text: string; depth?: 'light' | 'standard' | 'deep' }): AsyncIterable<ChatEvent> {
  const { db } = deps;
  if (args.key) parseInstrumentKey(args.key);
  let chatId = args.chatId;
  const exists = chatId !== null && db.sql.prepare('SELECT id FROM chats WHERE id = ?').get(chatId);
  if (!exists) {
    const res = db.sql.prepare('INSERT INTO chats (key, title, created_at) VALUES (?, ?, ?)').run(args.key, args.text.slice(0, 30), deps.now());
    chatId = Number(res.lastInsertRowid);
  }
  yield { type: 'chat', chatId: chatId! };

  const history: AiTurn[] = chatMessages(db, chatId!, 20).map((m) => ({ role: m.role, text: m.text }));
  const insert = db.sql.prepare('INSERT INTO chat_messages (chat_id, role, text, provider, created_at) VALUES (?, ?, ?, ?, ?)');
  insert.run(chatId, 'user', args.text, null, deps.now());

  const userText = args.key ? `[지금 보고 있는 종목: ${args.key}]\n${args.text}` : args.text;
  for await (const ev of deps.runAi({
    provider: args.provider, tier: args.depth ?? 'standard', purpose: 'interactive', instructions: prompts.CHAT,
    history, userText, tools: [...buildMarketTools(deps.market, deps), ...buildAgentTools(deps), ...buildPriceAlertTools({ db: deps.db, getQuote: (i) => deps.market.getQuote(i), names: deps.instruments, now: deps.now })], webSearch: { maxUses: 3 }, ...(args.model ? { model: args.model } : {}),
  })) {
    if (ev.type === 'done') insert.run(chatId, 'assistant', ev.text, args.provider, deps.now());
    // 채팅 화면에서 어떤 모델이 답했는지 보여준다
    yield ev;
  }
}
