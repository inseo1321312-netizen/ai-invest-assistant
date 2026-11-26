import type { Db } from '../db.js';
import type { AiAdapter, AiEvent, AiRequest, ProviderId, Tier } from './types.js';

export type ModelTable = Record<ProviderId, Record<Tier, string>>;

export const DEFAULT_MODELS: ModelTable = {
  claude: { light: 'claude-haiku-5-5', standard: 'claude-sonnet-5-5', deep: 'claude-opus-5-5' },
  // SIWC 문서 예시(gpt-6.1-sol, gpt-6.2-sol)와 Plus의 Codex 모델(GPT-6 Luna) 기준. 설정에서 /v1/models 목록으로 바꿀 수 있다.
  gpt: { light: 'gpt-6-luna', standard: 'gpt-6.1-sol', deep: 'gpt-6.2-sol' },
};

const MODELS_KEY = 'settings.models';
const GPT_MODE_KEY = 'settings.gptMode';

export interface AiRouter {
  runAi(req: AiRequest): AsyncIterable<AiEvent>;
  models(): ModelTable;
  setModels(m: ModelTable): void;
  gptMode(): 'siwc' | 'apikey';
  setGptMode(m: 'siwc' | 'apikey'): void;
}

export function createAiRouter(opts: { claude: AiAdapter; gpt: AiAdapter; db: Db }): AiRouter {
  const { db } = opts;
  const models = (): ModelTable => {
    const saved = db.kvGet<Partial<ModelTable>>(MODELS_KEY) ?? {};
    return { claude: { ...DEFAULT_MODELS.claude, ...saved.claude }, gpt: { ...DEFAULT_MODELS.gpt, ...saved.gpt } };
  };
  return {
    models,
    setModels(m) { db.kvSet(MODELS_KEY, m); },
    gptMode: () => db.kvGet<'siwc' | 'apikey'>(GPT_MODE_KEY) ?? 'siwc',
    setGptMode(m) { db.kvSet(GPT_MODE_KEY, m); },
    runAi(req) {
      const model = req.model ?? models()[req.provider][req.tier];
      return req.provider === 'claude' ? opts.claude(req, model) : opts.gpt(req, model);
    },
  };
}
