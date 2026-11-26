/** 정해진 각본대로 응답하는 가짜 Anthropic 클라이언트(beta.messages.stream만). */
export interface ScriptTurn {
  texts?: string[];
  content?: unknown[];
  stop_reason: string;
  model?: string;
  usage?: Partial<{ input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number; server_tool_use: { web_search_requests: number } }>;
}

export function fakeClaude(script: (ScriptTurn | Error)[]) {
  const params: any[] = [];
  let i = 0;
  const client = {
    beta: {
      messages: {
        stream(p: any) {
          params.push(structuredClone(p));
          const turn = script[i++];
          const listeners: ((d: string) => void)[] = [];
          return {
            on(ev: string, cb: (d: string) => void) {
              if (ev === 'text') listeners.push(cb);
              return this;
            },
            async finalMessage() {
              await Promise.resolve();
              if (!turn) throw new Error('script exhausted');
              if (turn instanceof Error) throw turn;
              for (const t of turn.texts ?? []) listeners.forEach((l) => l(t));
              const textBlocks = (turn.texts ?? []).length ? [{ type: 'text', text: (turn.texts ?? []).join('') }] : [];
              return {
                id: `msg_${i}`,
                model: turn.model ?? p.model,
                role: 'assistant',
                stop_reason: turn.stop_reason,
                content: [...textBlocks, ...(turn.content ?? [])],
                usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, server_tool_use: null, ...turn.usage },
              };
            },
          };
        },
      },
    },
  };
  return { client: client as any, params, calls: () => params.length };
}
