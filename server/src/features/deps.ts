import type { Db } from '../db.js';
import type { AiEvent, AiRequest } from '../ai/types.js';
import type { MarketService } from '../market/service.js';

export type RunAi = (req: AiRequest) => AsyncIterable<AiEvent>;

export interface FeatureDeps {
  db: Db;
  market: MarketService;
  runAi: RunAi;
  now: () => number;
}

export function kstDateTime(unixSec: number): string {
  return new Date(unixSec * 1000 + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
