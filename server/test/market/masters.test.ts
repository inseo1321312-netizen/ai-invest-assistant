import { describe, expect, test } from 'vitest';
import { downloadMasters, parseKrMaster, parseUsMaster } from '../../src/market/masters.js';
import { unzipFirst } from '../../src/market/zip.js';
import { fakeFetch } from '../fakeFetch.js';
import { krLine, makeZip, usLine } from './zipFixture.js';

describe('zip', () => {
  test('reads stored and deflated single-entry zips', () => {
    const text = Buffer.from('hello 종목 목록 '.repeat(50));
    expect(unzipFirst(makeZip('a.mst', text, 0)).equals(text)).toBe(true);
    expect(unzipFirst(makeZip('a.mst', text, 8)).equals(text)).toBe(true);
  });
});

describe('KIS master files', () => {
  test('domestic: code and Korean name, ELW and warrants dropped, CRLF ok', () => {
    const text = [krLine('005930', '삼성전자', 'ST'), krLine('57JB12', '삼성JB12콜', 'EW'), krLine('069500', 'KODEX 200', 'EF'), ''].join('\r\n');
    expect(parseKrMaster(text, 'kospi')).toEqual([
      { code: '005930', name: '삼성전자', group: 'ST' },
      { code: '069500', name: 'KODEX 200', group: 'EF' },
    ]);
  });

  test('kosdaq uses a 221-character tail', () => {
    expect(parseKrMaster(krLine('247540', '에코프로비엠', 'ST', 221), 'kosdaq')).toEqual([{ code: '247540', name: '에코프로비엠', group: 'ST' }]);
  });

  test('US: stocks and ETPs only, header row ignored', () => {
    const header = ['National code', 'Exchange id', 'Exchange code', 'Exchange name', 'Symbol', 'realtime symbol', 'Korea name', 'English name', 'Security type'].join('\t');
    const text = [header, usLine('AAPL', '애플', 'APPLE INC', '2'), usLine('COMP', '나스닥 종합', 'NASDAQ COMPOSITE', '1'), usLine('QQQ', '인베스코 QQQ', 'INVESCO QQQ', '3')].join('\n');
    expect(parseUsMaster(text, 'NAS')).toEqual([
      { symbol: 'AAPL', exchange: 'NAS', koName: '애플', enName: 'APPLE INC' },
      { symbol: 'QQQ', exchange: 'NAS', koName: '인베스코 QQQ', enName: 'INVESCO QQQ' },
    ]);
  });

  test('downloadMasters unzips each file and keeps going when one fails', async () => {
    const f = fakeFetch({
      '/common/master/kospi_code.mst.zip': () => new Response(new Uint8Array(makeZip('kospi_code.mst', Buffer.from(krLine('005930', 'SAMSUNG', 'ST'))))),
      '/common/master/kosdaq_code.mst.zip': () => new Response('nope', { status: 500 }),
      '/common/master/nasmst.cod.zip': () => new Response(new Uint8Array(makeZip('nasmst.cod', Buffer.from(usLine('AAPL', 'APPLE', 'APPLE INC', '2'))))),
    });
    const m = await downloadMasters(f);
    expect(m.kr).toEqual([{ code: '005930', name: 'SAMSUNG', group: 'ST' }]);
    expect(m.us.map((u) => `${u.exchange}:${u.symbol}`)).toEqual(['NAS:AAPL']);
    expect(f.calls.map((c) => c.url.host)).toContain('new.real.download.dws.co.kr');
  });
});
