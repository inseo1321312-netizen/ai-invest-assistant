import type { AiEvent, AiRequest } from '../../src/ai/types.js';

/**
 * 각본대로 동작하는 가짜 runAi.
 * step: 도구 호출 {tool, input} 또는 텍스트 {text}. 각 호출(runAi 1회)마다 script 한 줄을 쓴다.
 */
export type FakeStep = { tool: string; input: unknown } | { text: string };

export function fakeRunAi(script: FakeStep[][]) {
  const requests: AiRequest[] = [];
  let i = 0;
  async function* runAi(req: AiRequest): AsyncIterable<AiEvent> {
    requests.push(req);
    const steps = script[i++] ?? [];
    let text = '';
    for (const s of steps) {
      if ('text' in s) {
        text += s.text;
        yield { type: 'text', delta: s.text };
      } else {
        const tool = req.tools.find((t) => t.name === s.tool);
        if (!tool) throw new Error(`no tool ${s.tool}`);
        const parsed = tool.schema.safeParse(s.input);
        if (!parsed.success) continue; // 실제 어댑터처럼 잘못된 입력은 실행하지 않음
        const emitted: AiEvent[] = [];
        await tool.run(parsed.data, { emit: (e) => emitted.push(e) });
        yield* emitted;
      }
    }
    yield { type: 'done', text, provider: req.provider, model: `${req.provider}-model`, costUsd: 0.01 };
  }
  return { runAi, requests, calls: () => requests.length };
}
