'use strict';
// Generates assets/icon.png (256x256) — a blue rounded square with a white
// download arrow. No image libraries; raw PNG via zlib.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 256;
const buf = Buffer.alloc(S * S * 4);
function px(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = a;
}
const rad = 48;
function inRounded(x, y) {
  const m = 10, r = rad;
  const x0 = m, y0 = m, x1 = S - m, y1 = S - m;
  if (x < x0 || y < y0 || x > x1 || y > y1) return false;
  const cx = Math.min(Math.max(x, x0 + r), x1 - r);
  const cy = Math.min(Math.max(y, y0 + r), y1 - r);
  return (x - cx) ** 2 + (y - cy) ** 2 <= r * r;
}
for (let y = 0; y < S; y++) {
  for (let x = 0; x < S; x++) {
    if (inRounded(x, y)) {
      // vertical gradient blue
      const t = y / S;
      px(x, y, Math.round(59 + t * -10), Math.round(130 + t * -40), Math.round(246 + t * -40));
    } else {
      px(x, y, 0, 0, 0, 0);
    }
  }
}
// white download arrow
const cx = S / 2;
for (let y = 70; y < 160; y++) {
  for (let x = cx - 18; x < cx + 18; x++) px(x, y, 255, 255, 255);
}
for (let y = 150; y < 190; y++) {
  const w = (190 - y) * 1.9;
  for (let x = cx - w; x < cx + w; x++) px(Math.round(x), y, 255, 255, 255);
}
for (let x = 70; x < S - 70; x++) {
  for (let y = 196; y < 212; y++) px(x, y, 255, 255, 255);
}

// encode PNG
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])) >>> 0, 0);
  return Buffer.concat([len, t, data, crc]);
}
function crc32(b) {
  let c = ~0;
  for (let i = 0; i < b.length; i++) {
    c ^= b[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c;
}
const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8-bit RGBA
const raw = Buffer.alloc((S * 4 + 1) * S);
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0;
  buf.copy(raw, y * (S * 4 + 1) + 1, y * S * 4, (y + 1) * S * 4);
}
const idat = zlib.deflateSync(raw);
const png = Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
fs.writeFileSync(path.join(__dirname, 'icon.png'), png);
fs.writeFileSync(path.join(__dirname, '..', 'extension', 'chrome', 'icon128.png'), png);
console.log('wrote icon.png (' + png.length + ' bytes)');
