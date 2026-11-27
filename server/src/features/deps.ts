import type { Db } from '../db.js';
import type { AiEvent, AiRequest } from '../ai/types.js';
import type { MarketService } from '../market/service.js';
import type { News } from '../market/news.js';
import type { Trending } from '../market/trending.js';

export type RunAi = (req: AiRequest) => AsyncIterable<AiEvent>;

export interface FeatureDeps {
  db: Db;
  market: MarketService;
  runAi: RunAi;
  now: () => number;
  /** 지금 뜨는 종목(브리핑·AI 도구) */
  trending?: Pick<Trending, 'get'> | null;
  /** 종목 뉴스(AI 도구) */
  news?: Pick<News, 'search'> | null;
  /** 종목 이름(뉴스 검색어) */
  instruments?: { nameOf(key: string): string | null; search?(q: string, limit?: number): Promise<{ key: string; name: string; market: string }[]> } | null;
}

export function kstDateTime(unixSec: number): string {
  return new Date(unixSec * 1000 + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ');
}

export function fmtNum(n: number): string {
  return n.toLocaleString('en-US', { maximumFractionDigits: 8 });
}
