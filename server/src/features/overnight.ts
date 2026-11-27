/** 밤사이: 잠든 시각부터 정리 시각까지 시장·내 종목·뉴스를 AI가 아침에 한눈에 정리한다. 숫자는 서버가 계산한다. */
import { z } from 'zod';
import type { Db } from '../db.js';
import { kstDay } from '../ai/budget.js';
import * as prompts from '../ai/prompts.js';
import type { AiTool, ProviderId } from '../ai/types.js';
import { newsQueryFor, type NewsItem } from '../market/news.js';
import type { OverviewItem } from '../market/overview.js';
import type { Currency, MarketId } from '../market/types.js';
import { parseInstrumentKey } from '../market/types.js';
import { listHoldings } from './holdings.js';
import { type FeatureDeps, fmtNum, kstDateTime } from './deps.js';

export interface OvernightSettings { sleep: string; wake: string; notify: boolean }
export const DEFAULT_SETTINGS: OvernightSettings = { sleep: '23:00', wake: '07:00', notify: true };

const halfHours = (fromMin: number, toMin: number) => {
  const out: string[] = [];
  for (let m = fromMin; m <= toMin; m += 30) out.push(`${String(Math.floor((m % 1440) / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`);
  return out;
};
/** 잠드는 시간 21:00~02:00, 정리 시각 06:00~11:00(새벽 2~6시는 서버가 잔다) */
export const SLEEP_TIMES = halfHours(21 * 60, 26 * 60);
export const WAKE_TIMES = halfHours(6 * 60, 11 * 60);
const KV = 'overnight.settings';

export function readSettings(db: Db): OvernightSettings {
  return { ...DEFAULT_SETTINGS, ...(db.kvGet<Partial<OvernightSettings>>(KV) ?? {}) };
}

export function saveSettings(db: Db, s: OvernightSettings): OvernightSettings {
  if (!SLEEP_TIMES.includes(s.sleep)) throw new Error('잠드는 시간은 밤 9시~새벽 2시, 30분 단위로 골라 주세요');
  if (!WAKE_TIMES.includes(s.wake)) throw new Error('정리 시각은 아침 6시~11시, 30분 단위로 골라 주세요');
  const v = { sleep: s.sleep, wake: s.wake, notify: !!s.notify };
  db.kvSet(KV, v);
  return v;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/** 오늘(한국 날짜) 범위: 잠든 시각(정오 이후면 어젯밤, 이전이면 오늘 새벽) ~ 오늘 정리 시각. ms */
export function overnightWindow(s: OvernightSettings, nowMs: number): { from: number; to: number; day: string } {
  const day = kstDay(nowMs);
  const midnight = Date.parse(`${day}T00:00:00+09:00`);
  const sleep = minutesOf(s.sleep);
  const from = midnight + (sleep >= 12 * 60 ? sleep - 24 * 60 : sleep) * 60_000;
  return { from, to: midnight + minutesOf(s.wake) * 60_000, day };
}

export interface OvernightItemFacts {
  key: string; name: string | null; market: MarketId; price: number | null; fromPrice: number | null; currency: Currency | null; pct: number | null;
  /** night: 밤새 거래(코인), session: 밤사이 열린 정규장(미국), today: 지금 장중(한국), closed: 밤사이 거래 없음(한국 밤, 미국 휴장) */
  kind: 'night' | 'session' | 'today' | 'closed';
  extended: { price: number; changePct: number } | null;
}
export interface OvernightFacts {
  market: {
    /** traded: 범위 안에 미국 정규장이 있었는지(모르면 null) */
    spx: { value: number; changePct: number | null; traded?: boolean | null } | null;
    nasdaq: { value: number; changePct: number | null; traded?: boolean | null } | null;
    btc: { from: number; to: number; pct: number; high: number; low: number } | null;
    usdkrw: number | null;
    kimchi: number | null;
    /** 금·은·구리 선물(달러, 직전 대비 등락) */
    metals?: { gold: { value: number; changePct: number | null } | null; silver: { value: number; changePct: number | null } | null; copper: { value: number; changePct: number | null } | null };
  };
  items: OvernightItemFacts[];
  news: { n: number; title: string; url: string; source: string | null; publishedAt: number; key: string | null }[];
}
export interface OvernightBody { headline: string; points: string[]; items: { key: string; note: string }[]; news: { n: number; why: string }[]; today: string[] }
export interface StoredOvernight extends OvernightBody {
  id: number; day: string; from: number; to: number; origin: 'scheduled' | 'manual'; provider: ProviderId; model: string; facts: OvernightFacts; createdAt: number; costUsd: number;
}

export type OvernightDeps = FeatureDeps & { overview?: { get(): Promise<OverviewItem[]> } | null; provider: ProviderId };

const MAX_ITEMS = 12;
const BTC = 'coin:BTC-USDT';
const MARKET_NEWS = ['뉴욕증시', '비트코인'];
const MAX_NEWS = 15;

/** 제목에 이 종목이 나오는지: 한글 이름은 그대로, 영문 기호는 단어 단위로(F가 ETF에 걸리지 않게) */
export function mentions(title: string, words: string[]): boolean {
  const t = title.toLowerCase();
  return words.some((w) => {
    const x = w.toLowerCase();
    if (!/^[a-z0-9.]+$/.test(x)) return t.includes(x);
    return new RegExp(`(^|[^a-z0-9])${x.replace(/\./g, '\\.')}($|[^a-z0-9])`).test(t);
  });
}

/** 보유 → 즐겨찾기, 중복 없이 최대 12개 */
function myKeys(db: Db): string[] {
  const fav = (db.sql.prepare('SELECT key FROM watchlist ORDER BY added_at DESC, key').all() as { key: string }[]).map((r) => r.key);
  return [...new Set([...listHoldings(db).map((h) => h.key), ...fav])].slice(0, MAX_ITEMS);
}

/** 코인: 범위 안 1시간봉의 첫 시가 → 지금 가격, 최고·최저 */
async function nightMove(deps: OvernightDeps, key: string, fromMs: number, toMs: number, price: number | null) {
  const hours = Math.ceil((toMs - fromMs) / 3600_000) + 2;
  const candles = await deps.market.getCandles(parseInstrumentKey(key), '1H', Math.min(hours, 48)).catch(() => []);
  const inside = candles.filter((c) => c.time * 1000 >= fromMs && c.time * 1000 <= toMs);
  if (!inside.length) return null;
  const open = inside[0]!.open;
  const to = price ?? inside.at(-1)!.close;
  return { from: open, to, pct: (to / open - 1) * 100, high: Math.max(...inside.map((c) => c.high)), low: Math.min(...inside.map((c) => c.low)) };
}

async function gatherFacts(deps: OvernightDeps, fromMs: number, toMs: number): Promise<OvernightFacts> {
  const overview = await (deps.overview?.get() ?? Promise.resolve([] as OverviewItem[])).catch(() => [] as OverviewItem[]);
  const ov = (id: string) => overview.find((o) => o.id === id);
  const idx = (id: string) => { const o = ov(id); return o && o.value !== null ? { value: o.value, changePct: o.changePct } : null; };
  // 미국 지수의 마지막 체결이 범위 안이면 밤사이 장이 있었다(주말·휴일이면 범위 앞)
  const usTraded = (id: string) => { const t = ov(id)?.tradedAt; return t ? t * 1000 >= fromMs : null; };
  const usIdx = (id: string) => { const v = idx(id); return v ? { ...v, traded: usTraded(id) } : null; };
  const btcQuote = await deps.market.getQuote(parseInstrumentKey(BTC)).catch(() => null);

  const keys = myKeys(deps.db);
  const items = await Promise.all(keys.map(async (key): Promise<OvernightItemFacts> => {
    const inst = parseInstrumentKey(key);
    const name = deps.instruments?.nameOf(key) ?? inst.name ?? null;
    const q = await deps.market.getQuote(inst).catch(() => null);
    const ext = q?.session?.extended;
    const extended = ext && ext.price ? { price: ext.price, changePct: ext.changePct } : null;
    if (inst.market === 'coin') {
      const m = await nightMove(deps, key, fromMs, toMs, q?.price ?? null);
      return { key, name, market: 'coin', price: m?.to ?? q?.price ?? null, fromPrice: m?.from ?? null, currency: q?.currency ?? 'USDT', pct: m?.pct ?? null, kind: 'night', extended: null };
    }
    const pct = q ? q.changePct24h : null;
    const traded = q?.session?.tradedAt ?? null;
    // 미국: 마지막 체결이 범위 앞이면 밤사이 휴장. 한국: 지금 장이 열려 있으면 오늘 장중
    const kind: OvernightItemFacts['kind'] = inst.market === 'us'
      ? (traded !== null && traded * 1000 < fromMs ? 'closed' : 'session')
      : (q?.session?.open ? 'today' : 'closed');
    return {
      key, name, market: inst.market, price: q?.price ?? null, currency: q?.currency ?? (inst.market === 'kr' ? 'KRW' : 'USD'), pct,
      fromPrice: (kind === 'session' || kind === 'today') && q && pct !== null ? q.price / (1 + pct / 100) : null,
      kind, extended,
    };
  }));

  // 뉴스: 범위 안(초 단위) 것만. 종목은 이름·기호가 제목에 든 것 2개, 시장은 검색어마다 3개
  const range = { from: Math.floor(fromMs / 1000), to: Math.floor(toMs / 1000) };
  const inRange = (n: NewsItem) => n.publishedAt >= range.from && n.publishedAt <= range.to;
  const search = (q: string) => (deps.news ? deps.news.search(q, range).catch(() => [] as NewsItem[]) : Promise.resolve([] as NewsItem[]));
  const perItem = await Promise.all(items.map(async (it) => {
    const inst = parseInstrumentKey(it.key);
    const words = [it.name, inst.symbol.split('-')[0]].filter((w): w is string => !!w);
    const list = (await search(newsQueryFor(inst, it.name))).filter((n) => inRange(n) && mentions(n.title, words));
    return list.slice(0, 2).map((n) => ({ ...n, key: it.key }));
  }));
  const market = await Promise.all(MARKET_NEWS.map(async (q) => (await search(q)).filter(inRange).slice(0, 3).map((n) => ({ ...n, key: null as string | null }))));
  // 시장 뉴스 자리를 먼저 잡아 두고, 남는 자리를 종목 뉴스로 채운다(종목이 많아도 시장 소식이 밀려나지 않게)
  const seen = new Set<string>();
  const uniq = <T extends { url: string }>(list: T[]) => list.filter((n) => (seen.has(n.url) ? false : (seen.add(n.url), true)));
  const marketNews = uniq(market.flat());
  const itemNews = uniq(perItem.flat()).slice(0, Math.max(0, MAX_NEWS - marketNews.length));
  const news = [...itemNews, ...marketNews]
    .map((n, i) => ({ n: i + 1, title: n.title, url: n.url, source: n.source, publishedAt: n.publishedAt, key: n.key }));

  return {
    market: {
      spx: usIdx('spx'), nasdaq: usIdx('nasdaq'),
      btc: await nightMove(deps, BTC, fromMs, toMs, btcQuote?.price ?? null),
      usdkrw: ov('usdkrw')?.value ?? null, kimchi: ov('kimchi')?.value ?? null,
      metals: { gold: idx('gold'), silver: idx('silver'), copper: idx('copper') },
    },
    items,
    news,
  };
}

const DAYS = ['일', '월', '화', '수', '목', '금', '토'];
/** '2026-11-28(토) 07:00' */
const withDay = (ms: number) => { const s = kstDateTime(Math.floor(ms / 1000)); return `${s.slice(0, 10)}(${DAYS[new Date(ms + 9 * 3600_000).getUTCDay()]})${s.slice(10)}`; };

const pct = (n: number | null) => (n === null ? '알 수 없음' : `${n > 0 ? '+' : ''}${n.toFixed(2)}%`);

function factsText(f: OvernightFacts, fromMs: number, toMs: number): string {
  const m = f.market;
  const lines = [
    `범위: ${withDay(fromMs)} ~ ${withDay(toMs)} (한국 시간)`,
    `[시장]`,
    m.spx?.traded === false
      ? `미국장 휴장(밤사이 정규장 없음). 마지막 거래 기준 S&P500 ${fmtNum(m.spx.value)} (${pct(m.spx.changePct)}), 나스닥 ${m.nasdaq ? `${fmtNum(m.nasdaq.value)} (${pct(m.nasdaq.changePct)})` : '알 수 없음'}`
      : `S&P500 ${m.spx ? `${fmtNum(m.spx.value)} (${pct(m.spx.changePct)})` : '알 수 없음'}, 나스닥 ${m.nasdaq ? `${fmtNum(m.nasdaq.value)} (${pct(m.nasdaq.changePct)})` : '알 수 없음'} — 밤사이 미국 정규장 결과`,
    `비트코인 밤사이 ${m.btc ? `${fmtNum(m.btc.from)} → ${fmtNum(m.btc.to)} USDT (${pct(m.btc.pct)}, 최고 ${fmtNum(m.btc.high)}, 최저 ${fmtNum(m.btc.low)})` : '알 수 없음'}`,
    `원/달러 ${m.usdkrw === null ? '알 수 없음' : `${m.usdkrw.toFixed(1)}원`}, 김치 프리미엄 ${pct(m.kimchi)}`,
    `원자재(선물, 달러): ${(['gold', 'silver', 'copper'] as const).map((k) => { const v = m.metals?.[k]; const label = { gold: '금', silver: '은', copper: '구리' }[k]; return v ? `${label} $${v.value.toLocaleString('en-US', { maximumFractionDigits: 2 })} (${pct(v.changePct)})` : `${label} 알 수 없음`; }).join(', ')}`,
    `[사용자 종목] ${f.items.length ? '' : '없음'}`,
    ...f.items.map((it) => {
      const label = `${it.key}${it.name ? ` (${it.name})` : ''}`;
      if (it.price === null) return `${label}: 시세를 가져오지 못했습니다`;
      if (it.kind === 'night') return `${label}: 밤사이 ${it.fromPrice !== null ? `${fmtNum(it.fromPrice)} → ` : ''}${fmtNum(it.price)} ${it.currency} (${pct(it.pct)})`;
      const ext = it.extended ? `, 시간외 ${fmtNum(it.extended.price)} (${pct(it.extended.changePct)})` : '';
      if (it.kind === 'session') return `${label}: 밤사이 정규장 ${fmtNum(it.price)} ${it.currency} (${pct(it.pct)})${ext}`;
      if (it.kind === 'today') return `${label}: 오늘 장중 ${fmtNum(it.price)} ${it.currency} (${pct(it.pct)})${ext}`;
      return it.market === 'us'
        ? `${label}: 미국장 휴장. 마지막 종가 ${fmtNum(it.price)} ${it.currency} (${pct(it.pct)})${ext}`
        : `${label}: 밤엔 거래 없음. 어제 종가 ${fmtNum(it.price)} ${it.currency} (${pct(it.pct)})${ext}`;
    }),
    `[뉴스 목록] ${f.news.length ? '' : '없음'}`,
    ...f.news.map((n) => `${n.n}. ${n.title}${n.source ? ` — ${n.source}` : ''} (${kstDateTime(n.publishedAt)})`),
  ];
  return lines.join('\n');
}

function problemOf(b: OvernightBody, f: OvernightFacts): string | null {
  const keys = new Set(f.items.map((i) => i.key));
  const badKey = b.items.find((i) => !keys.has(i.key));
  if (badKey) return `items에는 사용자 종목(${[...keys].join(', ') || '없음'})만 넣을 수 있습니다. ${badKey.key}는 없습니다`;
  const badNews = b.news.find((n) => !f.news.some((x) => x.n === n.n));
  if (badNews) return `news의 n은 뉴스 목록 번호(1~${f.news.length})만 쓸 수 있습니다`;
  if (!b.headline.trim() || b.points.length === 0) return 'headline과 points를 채워야 합니다';
  return null;
}

function makeSubmitTool(f: OvernightFacts, onSubmit: (b: OvernightBody | null, problem: string | null) => void): AiTool<OvernightBody> {
  return {
    name: 'submit_overnight',
    description: '밤사이 정리를 제출한다. 반드시 마지막에 한 번 호출한다.',
    schema: z.strictObject({
      headline: z.string(),
      points: z.array(z.string()),
      items: z.array(z.strictObject({ key: z.string(), note: z.string() })),
      news: z.array(z.strictObject({ n: z.number().int(), why: z.string() })),
      today: z.array(z.string()),
    }) as z.ZodType<OvernightBody>,
    async run(b) {
      const problem = problemOf(b, f);
      if (problem) { onSubmit(null, problem); return `제출이 거절되었습니다: ${problem}. 고쳐서 다시 submit_overnight를 호출하세요.`; }
      const dedupe = <T,>(list: T[], id: (t: T) => string | number) => list.filter((x, i) => list.findIndex((y) => id(y) === id(x)) === i);
      onSubmit({
        headline: b.headline.trim(), points: b.points.slice(0, 5), items: dedupe(b.items, (i) => i.key),
        news: dedupe(b.news, (n) => n.n).slice(0, 5), today: b.today.slice(0, 3),
      }, null);
      return '제출되었습니다';
    },
  };
}

interface Row { id: number; day: string; from_ts: number; to_ts: number; origin: string; provider: string; model: string; body_json: string; facts_json: string; created_at: number; cost_usd: number }
function fromRow(r: Row): StoredOvernight {
  return {
    ...(JSON.parse(r.body_json) as OvernightBody), id: r.id, day: r.day, from: r.from_ts, to: r.to_ts, origin: r.origin as StoredOvernight['origin'],
    provider: r.provider as ProviderId, model: r.model, facts: JSON.parse(r.facts_json), createdAt: r.created_at, costUsd: r.cost_usd,
  };
}

export function latestOvernight(db: Db): StoredOvernight | null {
  const r = db.sql.prepare('SELECT * FROM overnight_recaps ORDER BY created_at DESC, id DESC LIMIT 1').get() as Row | undefined;
  return r ? fromRow(r) : null;
}
export function getOvernight(db: Db, id: number): StoredOvernight | null {
  const r = db.sql.prepare('SELECT * FROM overnight_recaps WHERE id = ?').get(id) as Row | undefined;
  return r ? fromRow(r) : null;
}
export function overnightHistory(db: Db, limit = 7) {
  const rows = db.sql.prepare('SELECT * FROM overnight_recaps ORDER BY created_at DESC, id DESC LIMIT ?').all(limit) as unknown as Row[];
  return rows.map((r) => { const o = fromRow(r); return { id: o.id, day: o.day, from: o.from, to: o.to, origin: o.origin, headline: o.headline }; });
}
export function hasScheduled(db: Db, day: string): boolean {
  return !!db.sql.prepare("SELECT 1 FROM overnight_recaps WHERE day = ? AND origin = 'scheduled' LIMIT 1").get(day);
}

const FAILED = '밤사이 정리를 만들지 못했어요';

export async function runOvernight(deps: OvernightDeps, args: { from: number; to: number; day: string; origin: 'scheduled' | 'manual' }): Promise<StoredOvernight> {
  const facts = await gatherFacts(deps, args.from, args.to);
  let submitted: OvernightBody | null = null;
  let problem: string | null = null;
  const tool = makeSubmitTool(facts, (b, p) => { if (submitted) return; submitted = b; problem = p; });
  const base = { provider: deps.provider, tier: 'standard' as const, purpose: 'scheduled' as const, instructions: prompts.OVERNIGHT, tools: [tool], webSearch: { maxUses: 3 } };
  const first = factsText(facts, args.from, args.to);
  let history: { role: 'user' | 'assistant'; text: string }[] = [];
  let text = first;
  let cost = 0;
  let model = '';
  for (let attempt = 0; attempt < 2 && !submitted; attempt++) {
    let doneText = '';
    for await (const ev of deps.runAi({ ...base, history, userText: text })) {
      if (ev.type === 'error') throw new Error(ev.message);
      if (ev.type === 'done') { doneText = ev.text; cost += ev.costUsd; model = ev.model; }
    }
    if (submitted) break;
    history = [...history, { role: 'user', text }, { role: 'assistant', text: doneText || '(응답 없음)' }];
    text = problem ? `제출이 거절되었습니다: ${problem}. submit_overnight로 다시 제출하세요.` : '결과를 아직 제출하지 않았습니다. submit_overnight 도구로 제출하세요.';
  }
  const body = submitted as OvernightBody | null;
  if (!body) throw new Error(FAILED);
  const createdAt = deps.now();
  const res = deps.db.sql.prepare('INSERT INTO overnight_recaps (day, from_ts, to_ts, origin, provider, model, body_json, facts_json, created_at, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(args.day, args.from, args.to, args.origin, deps.provider, model, JSON.stringify(body), JSON.stringify(facts), createdAt, cost);
  return { ...body, id: Number(res.lastInsertRowid), day: args.day, from: args.from, to: args.to, origin: args.origin, provider: deps.provider, model, facts, createdAt, costUsd: cost };
}

const RETRY_AFTER_FAIL_MS = 30 * 60_000;
const MAX_AUTO_TRIES = 3;
/** 정리 시각에서 이만큼 지나 만든 것(서버가 자고 있다 깨어난 경우)은 알림을 보내지 않는다 */
const PUSH_WINDOW_MS = 30 * 60_000;

/** 지금보다 앞선 가장 최근 잠든 시각: 오늘 잠든 시각이 아직 안 왔으면 하루 전 */
export function lastBedtime(s: OvernightSettings, nowMs: number): number {
  const midnight = Date.parse(`${kstDay(nowMs)}T00:00:00+09:00`);
  const t = midnight + minutesOf(s.sleep) * 60_000;
  return t > nowMs ? t - 24 * 3600_000 : t;
}

/**
 * 언제 만들지: 오늘 정리 시각이 지났는데 오늘 자동 정리가 없으면 뒤에서 하나 만든다(한 번에 하나).
 * tick은 1분 작업에서(설정의 알림 켬/끔을 따름), ensure({notify:false})는 앱을 열 때.
 * 실패하면 30분 동안은 자동으로 다시 하지 않는다('다시 정리'는 바로 된다).
 */
export function createOvernight(deps: Omit<OvernightDeps, 'provider'> & { provider: () => ProviderId; push: { sendAll(p: { title: string; body: string; url?: string }): Promise<void> } }) {
  let running: Promise<void> | null = null;
  let error: string | null = null;
  let failedAt = 0;

  function start(origin: 'scheduled' | 'manual', notify: boolean): Promise<void> {
    if (running) return running;
    error = null;
    const s = readSettings(deps.db);
    const w = overnightWindow(s, deps.now());
    const from = origin === 'manual' ? lastBedtime(s, deps.now()) : w.from;
    if (origin === 'scheduled') {
      const tries = deps.db.kvGet<{ day: string; n: number }>('overnight.autoTries');
      deps.db.kvSet('overnight.autoTries', { day: w.day, n: tries?.day === w.day ? tries.n + 1 : 1 });
    }
    running = runOvernight({ ...deps, provider: deps.provider() }, { from, to: deps.now(), day: w.day, origin })
      .then(async (r) => {
        if (notify && deps.now() - w.to < PUSH_WINDOW_MS) await deps.push.sendAll({ title: '밤사이 정리', body: r.headline, url: '/?tab=overnight' }).catch(() => undefined);
      })
      .catch((e: unknown) => {
        error = e instanceof Error && e.message ? e.message : FAILED;
        if (origin === 'scheduled') failedAt = deps.now();
      })
      .finally(() => { running = null; });
    return running;
  }

  function ensure(opts: { notify: boolean }): Promise<void> {
    if (running) return running;
    const w = overnightWindow(readSettings(deps.db), deps.now());
    if (deps.now() < w.to || hasScheduled(deps.db, w.day)) return Promise.resolve();
    if (failedAt && deps.now() - failedAt < RETRY_AFTER_FAIL_MS) return Promise.resolve();
    const tries = deps.db.kvGet<{ day: string; n: number }>('overnight.autoTries');
    if (tries?.day === w.day && tries.n >= MAX_AUTO_TRIES) return Promise.resolve();
    return start('scheduled', opts.notify);
  }

  return {
    ensure,
    tick: () => ensure({ notify: readSettings(deps.db).notify }),
    rerun: () => start('manual', false),
    state: () => ({ making: running !== null, error }),
  };
}
export type Overnight = ReturnType<typeof createOvernight>;
