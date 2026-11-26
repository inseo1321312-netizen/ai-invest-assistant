import { deflateRawSync } from 'node:zlib';

/** 항목 하나짜리 zip을 손으로 만든다(테스트용). method 0 = 저장, 8 = deflate */
export function makeZip(name: string, data: Buffer, method: 0 | 8 = 8): Buffer {
  const body = method === 8 ? deflateRawSync(data) : data;
  const nameBuf = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(body.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(nameBuf.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(body.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(nameBuf.length, 28);
  central.writeUInt32LE(0, 42);
  const cdOffset = 30 + nameBuf.length + body.length;
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + nameBuf.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Buffer.concat([local, nameBuf, body, central, nameBuf, eocd]);
}

/** KIS 국내 종목 목록 한 줄(꼬리 길이: 코스피 227, 코스닥 221) */
export function krLine(code: string, name: string, group: string, tail: 227 | 221 = 227): string {
  return `${code.padEnd(9)}KR7${code}003${name}${group}${' '.repeat(tail - 2)}`;
}

/** KIS 미국 종목 목록 한 줄(탭 24열) */
export function usLine(symbol: string, ko: string, en: string, type: string): string {
  const cols = Array.from({ length: 24 }, () => '');
  cols[0] = 'US'; cols[2] = 'NAS'; cols[4] = symbol; cols[5] = `DNAS${symbol}`; cols[6] = ko; cols[7] = en; cols[8] = type;
  return cols.join('\t');
}
