import OpenAI from 'openai';
import type { Budget } from './budget.js';
import { toolJsonSchema } from './claude.js';
import { costUsd } from './pricing.js';
import { OPENAI_BASE_URL, SIWC_AUTH_CODES, SIWC_USAGE_LIMIT_CODE } from './siwcConfig.js';
import { SiwcAuthError, type SiwcTokenStore } from './siwcTokens.js';
import type { AiAdapter, AiEvent, AiTool , Tier } from './types.js';

const MAX_TOOL_ROUNDS = 8;
const USAGE_LIMIT_MSG = 'ChatGPT Plus 사용량 한도에 도달했습니다 (chatgpt.com/settings/usage 에서 확인)';

class StreamFailure extends Error {
  constructor(public code: string | null, message: string) { super(message); }
}

function errorEvent(code: string | null, status: number | null, mode: 'siwc' | 'apikey', budget?: Budget): AiEvent {
  if (code === SIWC_USAGE_LIMIT_CODE) {
    budget?.noteLimitHit('gpt');
    return { type: 'error', code: 'budget', message: USAGE_LIMIT_MSG };
  }
  if (code === 'insufficient_quota' || code === 'organization_spend_limit_exceeded') {
    return { type: 'error', code: 'budget', message: '이번 달 GPT API 사용 한도에 도달했습니다' };
  }
  if (status === 401 || status === 403 || (code && SIWC_AUTH_CODES.has(code))) {
    return { type: 'error', code: 'auth', message: mode === 'siwc' ? 'ChatGPT 다시 로그인이 필요합니다' : 'ChatGPT API 키를 확인하세요' };
  }
  if (status === 429) return { type: 'error', code: 'provider', message: 'GPT 요청이 많아요. 잠시 뒤에 다시 시도하세요' };
  return { type: 'error', code: 'provider', message: 'GPT 응답 중 오류가 났습니다' };
}

const REASONING: Record<Tier, 'low' | 'medium' | 'high'> = { light: 'low', standard: 'medium', deep: 'high' };

export function createGptAdapter(opts: {
  mode: () => 'siwc' | 'apikey';
  siwc: SiwcTokenStore;
  apiKey: () => string | null;
  budget: Budget;
  fetchImpl?: typeof fetch;
}): AiAdapter {
  return async function* runGpt(req, model) {
    const mode = opts.mode();
    if (mode === 'apikey') {
      if (!opts.apiKey()) {
        yield { type: 'error', code: 'auth', message: 'ChatGPT API 키가 없어요. 설정 → AI 연결에서 넣어 주세요' };
        return;
      }
      const allowed = opts.budget.check(req.purpose, 'gpt');
      if (!allowed.ok) {
        yield { type: 'error', code: 'budget', message: allowed.message };
        return;
      }
    } else if (!opts.siwc.has()) {
      yield { type: 'error', code: 'auth', message: 'ChatGPT 연결이 필요합니다. 설정에서 안내를 따라 연결하세요' };
      return;
    }

    const toolsByName = new Map<string, AiTool>(req.tools.map((t) => [t.name, t]));
    const fnTools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: toolJsonSchema(t.schema), strict: true }));
    let useWebSearch = Boolean(req.webSearch);
    const input: any[] = [
      ...req.history.map((t) => ({ role: t.role, content: t.text })),
      { role: 'user', content: req.userText },
    ];
    let fullText = '';
    let totalCost = 0;
    // 보통은 모델 기본값, 가볍게·깊게만 따로 보낸다
    let useReasoning = req.tier !== 'standard';
    let servedModel = model;

    const makeClient = async (forceRefresh: boolean) => {
      const key = mode === 'apikey' ? opts.apiKey()! : forceRefresh ? await opts.siwc.forceRefresh() : await opts.siwc.getAccessToken();
      return new OpenAI({ apiKey: key, baseURL: OPENAI_BASE_URL, maxRetries: 0, fetch: opts.fetchImpl });
    };

    try {
      for (let round = 0; round <= MAX_TOOL_ROUNDS; round++) {
        if (req.signal?.aborted) return;
        const body: Record<string, unknown> = { model, instructions: req.instructions, input, stream: true, store: false };
        if (useReasoning) body.reasoning = { effort: REASONING[req.tier] };
        const tools: unknown[] = [...fnTools];
        if (useWebSearch) tools.push({ type: 'web_search' });
        if (tools.length) body.tools = tools;

        let stream: AsyncIterable<any> | null = null;
        let refreshed = false;
        let droppedSearch = false;
        while (!stream) {
          try {
            const client = await makeClient(refreshed);
            stream = (await client.responses.create(body as never, { signal: req.signal })) as unknown as AsyncIterable<any>;
          } catch (err) {
            if (err instanceof OpenAI.APIError) {
              if (err.status === 401 && mode === 'siwc' && !refreshed) { refreshed = true; continue; }
              if (err.status === 400 && useReasoning && /reasoning/i.test(`${(err as { param?: string }).param ?? ''} ${err.message}`)) {
                useReasoning = false;
                delete body.reasoning;
                continue;
              }
              if (err.status === 400 && err.code === 'subscription_sharing_unsupported_capability' && useWebSearch && !droppedSearch) {
                droppedSearch = true;
                useWebSearch = false;
                body.tools = fnTools.length ? fnTools : undefined;
                yield { type: 'status', message: '이 계정에서는 GPT 웹 검색을 쓸 수 없어 검색 없이 답합니다' };
                continue;
              }
              yield errorEvent(err.code ?? null, err.status ?? null, mode, opts.budget);
              return;
            }
            throw err;
          }
        }

        const calls: { call_id: string; name: string; arguments: string }[] = [];
        let turnText = '';
        let searches = 0;
        let usage: { input_tokens?: number; output_tokens?: number; input_tokens_details?: { cached_tokens?: number } } = {};
        for await (const ev of stream) {
          if (ev.type === 'response.output_text.delta') {
            turnText += ev.delta;
            fullText += ev.delta;
            yield { type: 'text', delta: ev.delta };
          } else if (ev.type === 'response.output_item.done') {
            if (ev.item?.type === 'function_call') calls.push({ call_id: ev.item.call_id, name: ev.item.name, arguments: ev.item.arguments });
            if (ev.item?.type === 'web_search_call') searches++;
          } else if (ev.type === 'response.completed') {
            usage = ev.response?.usage ?? {};
            servedModel = ev.response?.model ?? servedModel;
          } else if (ev.type === 'response.failed') {
            throw new StreamFailure(ev.response?.error?.code ?? null, ev.response?.error?.message ?? 'failed');
          } else if (ev.type === 'response.incomplete') {
            throw new StreamFailure('incomplete', '답변이 중간에 끊겼습니다');
          } else if (ev.type === 'error') {
            throw new StreamFailure(ev.code ?? null, ev.message ?? 'error');
          }
        }

        if (mode === 'apikey') {
          const cached = usage.input_tokens_details?.cached_tokens ?? 0;
          totalCost += costUsd(servedModel, { input: (usage.input_tokens ?? 0) - cached, cacheRead: cached, output: usage.output_tokens ?? 0, cacheWrite: 0, webSearches: searches });
        }
        if (calls.length === 0) break;

        if (turnText) input.push({ role: 'assistant', content: turnText });
        for (const c of calls) {
          input.push({ type: 'function_call', call_id: c.call_id, name: c.name, arguments: c.arguments });
          const tool = toolsByName.get(c.name);
          let args: unknown = null;
          try { args = JSON.parse(c.arguments); } catch { /* 아래에서 오류 처리 */ }
          const parsed = tool?.schema.safeParse(args);
          let output: string;
          if (!tool || !parsed?.success) {
            output = JSON.stringify({ error: 'INVALID_INPUT' });
          } else {
            yield { type: 'status', message: `${tool.name} 확인 중…` };
            const emitted: AiEvent[] = [];
            try {
              output = await tool.run(parsed.data, { emit: (e) => emitted.push(e) });
            } catch (err) {
              output = JSON.stringify({ error: err instanceof Error ? err.message : '도구 오류' });
            }
            for (const e of emitted) yield e;
          }
          input.push({ type: 'function_call_output', call_id: c.call_id, output });
        }
      }
    } catch (err) {
      opts.budget.record(req.purpose, 'gpt', totalCost);
      if (err instanceof SiwcAuthError) {
        yield { type: 'error', code: 'auth', message: err.message };
        return;
      }
      if (err instanceof OpenAI.APIUserAbortError || req.signal?.aborted) return;
      if (err instanceof StreamFailure) {
        yield err.code === 'incomplete' ? { type: 'error', code: 'provider', message: err.message } : errorEvent(err.code, null, mode, opts.budget);
        return;
      }
      yield { type: 'error', code: 'provider', message: 'GPT 응답 중 오류가 났습니다' };
      return;
    }

    opts.budget.record(req.purpose, 'gpt', totalCost);
    yield { type: 'done', text: fullText, provider: 'gpt', model: servedModel, costUsd: totalCost };
  };
}
