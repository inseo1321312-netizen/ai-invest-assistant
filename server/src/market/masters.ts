/**
 * KIS가 공개하는 종목 목록 파일(키 필요 없음).
 * 출처: github.com/koreainvestment/open-trading-api stocks_info/*.py (2026-11-26 확인)
 */
import type { UsExchange } from './types.js';
import { unzipFirst } from './zip.js';

/** cap: 시가총액(억원), 모르면 0 */
export interface KrMasterRow { code: string; name: string; group: string; cap: number }
export interface UsMasterRow { symbol: string; exchange: UsExchange; koName: string; enName: string }

const BASE = 'https://new.real.download.dws.co.kr/common/master';
/** 줄 끝의 고정 길이 꼬리(줄바꿈 제외). 공식 예제의 228/222에서 줄바꿈 1자를 뺀 값 */
const KR_TAIL = { kospi: 227, kosdaq: 221 } as const;
/** 꼬리 안의 시가총액(억원) 위치 [시작, 끝) */
const KR_CAP = { kospi: [212, 221], kosdaq: [206, 215] } as const;
/** ELW, 신주인수권증권·증서는 검색에서 뺀다 */
const KR_SKIP_GROUPS = new Set(['EW', 'SW', 'SR']);

export function parseKrMaster(text: string, kind: 'kospi' | 'kosdaq'): KrMasterRow[] {
  const tail = KR_TAIL[kind];
  const out: KrMasterRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.length <= tail + 21) continue;
    const head = line.slice(0, line.length - tail);
    const code = head.slice(0, 9).trim();
    const name = head.slice(21).trim();
    const t = line.slice(line.length - tail);
    const group = t.slice(0, 2);
    const cap = Number(t.slice(KR_CAP[kind][0], KR_CAP[kind][1]).trim()) || 0;
    if (!/^[0-9A-Z]{6}$/.test(code) || !name || KR_SKIP_GROUPS.has(group)) continue;
    out.push({ code, name, group, cap });
  }
  return out;
}

/** 탭 24열: 4 기호, 6 한글명, 7 영문명, 8 종류(1 지수, 2 주식, 3 ETP, 4 워런트). 머리글 줄은 기호·종류 형식으로 걸러진다. */
export function parseUsMaster(text: string, exchange: UsExchange): UsMasterRow[] {
  const out: UsMasterRow[] = [];
  for (const line of text.split(/\r?\n/)) {
    const cols = line.split('\t');
    const symbol = (cols[4] ?? '').trim();
    const type = (cols[8] ?? '').trim();
    if ((type !== '2' && type !== '3') || !/^[A-Z0-9.-]{1,10}$/.test(symbol)) continue;
    out.push({ symbol, exchange, koName: (cols[6] ?? '').trim(), enName: (cols[7] ?? '').trim() });
  }
  return out;
}

async function fetchText(fetchImpl: typeof fetch, file: string): Promise<string> {
  const res = await fetchImpl(`${BASE}/${file}.zip`, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) throw new Error(`${file} 받기 실패 (${res.status})`);
  return new TextDecoder('euc-kr').decode(unzipFirst(Buffer.from(await res.arrayBuffer())));
}

/** 다섯 파일을 받아 해석한다. 하나가 실패해도 나머지는 쓴다. */
export async function downloadMasters(fetchImpl: typeof fetch = fetch): Promise<{ kr: KrMasterRow[]; us: UsMasterRow[] }> {
  const jobs: [string, (t: string) => (KrMasterRow | UsMasterRow)[], 'kr' | 'us'][] = [
    ['kospi_code.mst', (t) => parseKrMaster(t, 'kospi'), 'kr'],
    ['kosdaq_code.mst', (t) => parseKrMaster(t, 'kosdaq'), 'kr'],
    ['nasmst.cod', (t) => parseUsMaster(t, 'NAS'), 'us'],
    ['nysmst.cod', (t) => parseUsMaster(t, 'NYS'), 'us'],
    ['amsmst.cod', (t) => parseUsMaster(t, 'AMS'), 'us'],
  ];
  const results = await Promise.all(jobs.map(async ([file, parse, market]) => {
    try {
      return { market, rows: parse(await fetchText(fetchImpl, file)) };
    } catch (err) {
      console.error('종목 목록 받기 실패', file, err instanceof Error ? err.message : err);
      return { market, rows: [] };
    }
  }));
  return {
    kr: results.filter((r) => r.market === 'kr').flatMap((r) => r.rows as KrMasterRow[]),
    us: results.filter((r) => r.market === 'us').flatMap((r) => r.rows as UsMasterRow[]),
  };
}
