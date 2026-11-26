import { OPENAI_BASE_URL } from './siwcConfig.js';
import { DEFAULT_MODELS } from './router.js';
import type { ProviderId } from './types.js';

export interface ModelOption { id: string; label: string }
export type ModelLists = Record<ProviderId, ModelOption[]>;

const TTL_MS = 60 * 60_000;
const MODEL_ID = /^[a-z0-9][a-z0-9._-]{1,79}$/;

const LABELS: Record<string, string> = {
  'claude-haiku-5-5': 'Claude Haiku 5.5', 'claude-sonnet-5-5': 'Claude Sonnet 5.5', 'claude-opus-5-5': 'Claude Opus 5.5',
  'gpt-6-luna': 'GPT-6 Luna', 'gpt-6.1-sol': 'GPT-6.1 Sol', 'gpt-6.2-sol': 'GPT-6.2 Sol',
};

function fallback(p: ProviderId): ModelOption[] {
  return [...new Set(Object.values(DEFAULT_MODELS[p]))].sort().map((id) => ({ id, label: LABELS[id] ?? id }));
}

/** ChatGPT 로그인(SIWC) 응답은 { models: [{ slug, display_name, visibility }] }, API 키 응답은 { data: [{ id }] }. */
export async function fetchGptModels(bearer: string, fetchImpl: typeof fetch = fetch): Promise<ModelOption[]> {
  const res = await fetchImpl(`${OPENAI_BASE_URL}/models`, { headers: { authorization: `Bearer ${bearer}` } });
  if (!res.ok) throw new Error(`models ${res.status}`);
  const json = (await res.json()) as { models?: { slug: string; display_name?: string; visibility?: string }[]; data?: { id: string }[] };
  if (Array.isArray(json.models)) {
    return json.models.filter((m) => m.visibility === 'list' && MODEL_ID.test(m.slug)).map((m) => ({ id: m.slug, label: m.display_name ?? m.slug }));
  }
  return (json.data ?? []).filter((m) => /^gpt-/.test(m.id) && MODEL_ID.test(m.id)).map((m) => ({ id: m.id, label: LABELS[m.id] ?? m.id }));
}

export interface ModelCatalog {
  list(): Promise<ModelLists>;
  isAllowed(provider: ProviderId, model: string): Promise<boolean>;
}

export function createModelCatalog(opts: {
  now: () => number;
  listClaude: () => Promise<ModelOption[]>;
  listGpt: () => Promise<ModelOption[]>;
}): ModelCatalog {
  let cache: { at: number; lists: ModelLists } | null = null;

  async function load(p: ProviderId): Promise<ModelOption[]> {
    try {
      const got = await (p === 'claude' ? opts.listClaude() : opts.listGpt());
      const clean = got.filter((m) => MODEL_ID.test(m.id));
      return clean.length ? clean : fallback(p);
    } catch {
      return fallback(p);
    }
  }

  return {
    async list() {
      if (cache && opts.now() - cache.at < TTL_MS) return cache.lists;
      const [claude, gpt] = await Promise.all([load('claude'), load('gpt')]);
      cache = { at: opts.now(), lists: { claude, gpt } };
      return cache.lists;
    },
    async isAllowed(provider, model) {
      if (!MODEL_ID.test(model)) return false;
      const lists = await this.list();
      return lists[provider].some((m) => m.id === model) || Object.values(DEFAULT_MODELS[provider]).includes(model);
    },
  };
}
