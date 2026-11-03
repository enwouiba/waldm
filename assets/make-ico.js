'use strict';
// Wrap the 256x256 PNG into a valid .ico (Windows accepts a PNG-compressed
// icon entry at 256px). No image tools needed.
const fs = require('fs');
const path = require('path');
const png = fs.readFileSync(path.join(__dirname, 'icon.png'));

const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type: icon
header.writeUInt16LE(1, 4); // count

const entry = Buffer.alloc(16);
entry.writeUInt8(0, 0); // width 0 => 256
entry.writeUInt8(0, 1); // height 0 => 256
entry.writeUInt8(0, 2); // palette
entry.writeUInt8(0, 3); // reserved
entry.writeUInt16LE(1, 4); // planes
entry.writeUInt16LE(32, 6); // bpp
entry.writeUInt32LE(png.length, 8); // size
entry.writeUInt32LE(6 + 16, 12); // offset

fs.writeFileSync(path.join(__dirname, 'icon.ico'), Buffer.concat([header, entry, png]));
console.log('wrote icon.ico (' + (6 + 16 + png.length) + ' bytes)');
