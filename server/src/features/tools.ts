import { z } from 'zod';
import type { AiTool } from '../ai/types.js';
import { summarizeIndicators } from '../market/indicators.js';
import type { MarketService } from '../market/service.js';
import type { Bar, Holding, Instrument } from '../market/types.js';
import { BARS, instrumentKey, MARKETS, parseInstrumentKey } from '../market/types.js';

const barEnum = z.enum(BARS as [Bar, ...Bar[]]);
const keyString = z.string().describe('종목 키. 예: coin:BTC-USDT, coin:BTC-USDT-SWAP, kr:005930, us:NAS:AAPL');

export function candlesCsv(candles: { time: number; open: number; high: number; low: number; close: number; volume: number }[]): string {
  const rows = candles.map((c) => `${new Date(c.time * 1000 + 9 * 3600_000).toISOString().slice(0, 16).replace('T', ' ')},${c.open},${c.high},${c.low},${c.close},${c.volume}`);
  return ['time(KST),open,high,low,close,volume', ...rows].join('\n');
}

export function buildMarketTools(market: MarketService): AiTool[] {
  const getCandles: AiTool<{ key: string; bar: Bar; limit: number }> = {
    name: 'get_candles',
    description: '종목의 캔들(시가·고가·저가·종가·거래량)을 오래된 것부터 가져온다. limit 최대 300.',
    schema: z.strictObject({ key: keyString, bar: barEnum, limit: z.number().int() }),
    async run({ key, bar, limit }) {
      const c = await market.getCandles(parseInstrumentKey(key), bar, Math.max(1, Math.min(300, limit)));
      return candlesCsv(c);
    },
  };
  const getIndicators: AiTool<{ key: string; bar: Bar }> = {
    name: 'get_indicators',
    description: '종목의 최근 지표 요약(이동평균, RSI, MACD, 볼린저밴드, 거래량 배수)을 가져온다.',
    schema: z.strictObject({ key: keyString, bar: barEnum }),
    async run({ key, bar }) {
      return JSON.stringify(summarizeIndicators(await market.getCandles(parseInstrumentKey(key), bar, 200)));
    },
  };
  const getHoldings: AiTool<{ market: 'coin' | 'kr' | 'us' }> = {
    name: 'get_holdings',
    description: '사용자의 보유 현황(현물·주식·선물 포지션)을 가져온다.',
    schema: z.strictObject({ market: z.enum(MARKETS as ['coin', 'kr', 'us']) }),
    async run({ market: m }) {
      const hs = await market.getHoldings(m);
      return JSON.stringify(hs.map((h) => ({ key: instrumentKey(h.instrument), name: h.instrument.name, quantity: h.quantity, avgPrice: h.avgPrice, currency: h.currency, side: h.side, leverage: h.leverage, liqPrice: h.liqPrice, fundingRate: h.fundingRate })));
    },
  };
  const showChart: AiTool<{ key: string; bar: Bar; from: number | null; to: number | null; markers: { time: number; text: string }[] }> = {
    name: 'show_chart',
    description: '사용자 화면에 차트를 보여준다. from/to는 unix 초(없으면 null), markers는 표시할 지점.',
    schema: z.strictObject({
      key: keyString, bar: barEnum, from: z.number().nullable(), to: z.number().nullable(),
      markers: z.array(z.strictObject({ time: z.number(), text: z.string() })),
    }),
    async run(spec, ctx) {
      parseInstrumentKey(spec.key);
      ctx.emit({ type: 'chart', spec });
      return '차트를 표시했습니다';
    },
  };
  return [getCandles, getIndicators, getHoldings, showChart];
}

export function opinionChoices(holding: Holding | null, inst: Instrument): string[] {
  const swap = inst.kind === 'swap';
  if (holding) return swap ? ['유지', '일부 정리', '청산 고려'] : ['추가 매수', '유지', '일부 매도', '매도'];
  return swap ? ['롱 진입', '숏 진입', '관망'] : ['매수', '관망'];
}

export const CONFIDENCE = ['낮음', '중간', '높음'] as const;
export type Confidence = (typeof CONFIDENCE)[number];

export interface AnalysisBody {
  opinion: string;
  confidence: Confidence;
  summary: string;
  reasons: string[];
  risks: string[];
  news: { title: string; url: string; date: string | null }[];
}

export const newsSchema = z.strictObject({ title: z.string(), url: z.string(), date: z.string().nullable() });

export function makeSubmitAnalysisTool(choices: string[], onSubmit: (a: AnalysisBody) => void): AiTool<AnalysisBody> {
  return {
    name: 'submit_analysis',
    description: '분석 결과를 제출한다. 반드시 마지막에 한 번 호출한다.',
    schema: z.strictObject({
      opinion: z.enum(choices as [string, ...string[]]),
      confidence: z.enum(CONFIDENCE),
      summary: z.string(),
      reasons: z.array(z.string()),
      risks: z.array(z.string()),
      news: z.array(newsSchema),
    }) as z.ZodType<AnalysisBody>,
    async run(a) {
      onSubmit({ ...a, reasons: a.reasons.slice(0, 6), risks: a.risks.slice(0, 6), news: a.news.filter((n) => /^https?:\/\//i.test(n.url)).slice(0, 8) });
      return '제출되었습니다';
    },
  };
}
