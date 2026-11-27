import { useEffect, useState } from 'react';
import { api } from './api';
import type { ProviderId } from './types';

/** 지금 답할 수 있는 AI. Claude 키가 없으면 GPT를 먼저 고른다 */
export interface AiReady { claude: boolean; gpt: boolean; preferred: ProviderId; gptMode?: 'siwc' | 'apikey' }

let cache: Promise<AiReady> | null = null;

export function aiReady(): Promise<AiReady> {
  cache ??= api<AiReady>('/api/ai/ready').catch(() => ({ claude: true, gpt: true, preferred: 'claude' as const }));
  return cache;
}

/** 설정에서 키를 바꾼 뒤 다시 묻게 */
export function resetAiReady(): void { cache = null; }

export function usePreferredProvider(): ProviderId {
  const [p, setP] = useState<ProviderId>('claude');
  useEffect(() => {
    let alive = true;
    void aiReady().then((r) => { if (alive) setP(r.preferred); });
    return () => { alive = false; };
  }, []);
  return p;
}
