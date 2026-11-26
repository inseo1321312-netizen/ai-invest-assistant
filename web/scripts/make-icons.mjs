// 앱 아이콘(PNG)을 코드로 그린다: 남색 바탕에 빨간·파란 캔들 두 개.
import { writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(size) {
  const bg = [0x16, 0x20, 0x2e], red = [0xff, 0x5a, 0x52], blue = [0x5b, 0x9b, 0xff];
  const rows = [];
  const rect = (x, y, w, h) => ({ x: x * size, y: y * size, w: w * size, h: h * size });
  const shapes = [
    { c: red, r: [rect(0.30, 0.22, 0.03, 0.56), rect(0.24, 0.34, 0.15, 0.34)] },
    { c: blue, r: [rect(0.64, 0.26, 0.03, 0.50), rect(0.58, 0.40, 0.15, 0.24)] },
  ];
  for (let y = 0; y < size; y++) {
    const row = [0];
    for (let x = 0; x < size; x++) {
      let col = bg;
      for (const s of shapes) for (const r of s.r) if (x >= r.x && x < r.x + r.w && y >= r.y && y < r.y + r.h) col = s.c;
      row.push(...col);
    }
    rows.push(Buffer.from(row));
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0); ihdr.writeUInt32BE(size, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
for (const s of [192, 512]) writeFileSync(new URL(`../public/icons/icon-${s}.png`, import.meta.url), png(s));
console.log('icons written');
