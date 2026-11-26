import { describe, expect, test } from 'vitest';
import { formatKrwApprox, formatPct, formatPrice, formatTimeKst, formatDateTimeKst, parseUserSymbol } from '../src/format';
import { createSseParser } from '../src/sse';

describe('format', () => {
  test('krw approximations', () => {
    expect(formatKrwApprox(142_300_000)).toBe('≈ 1억 4,230만원');
    expect(formatKrwApprox(5_080_000)).toBe('≈ 508만원');
    expect(formatKrwApprox(200_000_000)).toBe('≈ 2억원');
    expect(formatKrwApprox(7_300)).toBe('≈ 7,300원');
  });
  test('percent with sign', () => {
    expect(formatPct(-3.8)).toBe('-3.8%');
    expect(formatPct(1.2)).toBe('+1.2%');
    expect(formatPct(0)).toBe('0.0%');
  });
  test('prices by currency', () => {
    expect(formatPrice(70500, 'KRW')).toBe('70,500원');
    expect(formatPrice(96420, 'USDT')).toBe('96,420 USDT');
    expect(formatPrice(0.000123, 'USDT')).toBe('0.000123 USDT');
    expect(formatPrice(231.5, 'USD')).toBe('$231.50');
  });
  test('kst times', () => {
    const t = Date.UTC(2026, 10, 26, 0, 0) / 1000;
    expect(formatTimeKst(t)).toBe('11-26 09:00');
    expect(formatDateTimeKst(t)).toBe('2026-11-26 09:00');
  });
  test('user symbol input becomes instrument key', () => {
    expect(parseUserSymbol('coin', 'btc-usdt')).toBe('coin:BTC-USDT');
    expect(parseUserSymbol('coin', 'btc')).toBe('coin:BTC-USDT');
    expect(parseUserSymbol('coin', 'BTC-USDT-SWAP')).toBe('coin:BTC-USDT-SWAP');
    expect(parseUserSymbol('kr', '005930')).toBe('kr:005930');
    expect(parseUserSymbol('us', 'aapl')).toBe('us:NAS:AAPL');
    expect(parseUserSymbol('us', 'NYS:KO')).toBe('us:NYS:KO');
    expect(parseUserSymbol('kr', '삼성')).toBeNull();
  });
});

describe('sse parser', () => {
  test('handles events split across chunks and ignores pings', () => {
    const got: [string, unknown][] = [];
    const p = createSseParser((type, data) => got.push([type, data]));
    p.feed('event: text\ndata: {"type":"text","del');
    p.feed('ta":"안"}\n\n: ping\n\nevent: done\n');
    p.feed('data: {"type":"done"}\n\n');
    expect(got).toEqual([['text', { type: 'text', delta: '안' }], ['done', { type: 'done' }]]);
  });
  test('handles CRLF line endings', () => {
    const got: string[] = [];
    const p = createSseParser((type) => got.push(type));
    p.feed('event: status\r\ndata: {"type":"status"}\r\n\r\n');
    expect(got).toEqual(['status']);
  });
});
