import { inflateRawSync } from 'node:zlib';

const EOCD = 0x06054b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

/** zip 파일의 첫 항목을 풀어서 돌려준다(KIS 종목 목록 zip은 항목이 하나다). 저장(0)·deflate(8)만 지원. */
export function unzipFirst(buf: Buffer): Buffer {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === EOCD) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('zip 끝 정보를 찾지 못했습니다');
  const cd = buf.readUInt32LE(eocd + 16);
  if (buf.readUInt32LE(cd) !== CENTRAL) throw new Error('zip 목록이 올바르지 않습니다');
  const method = buf.readUInt16LE(cd + 10);
  const compSize = buf.readUInt32LE(cd + 20);
  const localOffset = buf.readUInt32LE(cd + 42);
  if (buf.readUInt32LE(localOffset) !== LOCAL) throw new Error('zip 항목이 올바르지 않습니다');
  const start = localOffset + 30 + buf.readUInt16LE(localOffset + 26) + buf.readUInt16LE(localOffset + 28);
  const data = buf.subarray(start, start + compSize);
  if (method === 0) return Buffer.from(data);
  if (method === 8) return inflateRawSync(data);
  throw new Error(`지원하지 않는 zip 압축 방식: ${method}`);
}
