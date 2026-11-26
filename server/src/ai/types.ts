import type { z } from 'zod';
import type { Bar } from '../market/types.js';

export type ProviderId = 'claude' | 'gpt';
export type Tier = 'light' | 'standard' | 'deep';
export type Purpose = 'interactive' | 'scheduled';

export interface ChartSpec {
  key: string;
  bar: Bar;
  from: number | null;
  to: number | null;
  markers: { time: number; text: string }[];
}

export type AiEvent =
  | { type: 'text'; delta: string }
  | { type: 'status'; message: string }
  | { type: 'chart'; spec: ChartSpec }
  | { type: 'done'; text: string; provider: ProviderId; model: string; costUsd: number }
  | { type: 'error'; code: 'budget' | 'auth' | 'provider' | 'refusal'; message: string };

export interface ToolCtx { emit(ev: AiEvent): void }

export interface AiTool<I = any> {
  name: string;
  description: string;
  /** z.strictObject, 모든 필드 필수(없을 수 있는 값은 nullable) — 두 공급자의 strict 모드용 */
  schema: z.ZodType<I>;
  run(input: I, ctx: ToolCtx): Promise<string>;
}

export interface AiTurn { role: 'user' | 'assistant'; text: string }

export interface AiRequest {
  provider: ProviderId;
  tier: Tier;
  purpose: Purpose;
  instructions: string;
  history: AiTurn[];
  userText: string;
  tools: AiTool[];
  webSearch: { maxUses: number } | null;
  /** 이 요청에만 쓸 모델(채팅에서 고른 모델). 없으면 설정의 tier 모델 */
  model?: string;
  signal?: AbortSignal;
}

export type AiAdapter = (req: AiRequest, model: string) => AsyncIterable<AiEvent>;
