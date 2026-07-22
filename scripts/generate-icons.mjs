import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.join(__dirname, "../public/icons");

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = c & 1 ? (0xedb88320 ^ (c >>> 1)) : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crcBuf = Buffer.alloc(4);
  const crc = crc32(Buffer.concat([typeBuf, data]));
  crcBuf.writeUInt32BE(crc, 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/**
 * PNG icon with optional maskable safe-zone padding.
 * Normal icons fill the canvas; maskable keeps a larger padded edge so OS
 * masks do not clip the mark.
 */
function makePng(size, options = {}) {
  const rgb = options.rgb ?? [0x20, 0x5f, 0x50];
  const maskable = options.maskable === true;
  // Maskable safe zone is ~80% center; use 12% edge pad vs 4% for normal.
  const borderRatio = maskable ? 0.12 : 0.04;
  const edgeBg = maskable ? [0xf7, 0xf5, 0xed] : rgb;
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(stride * size);
  const border = Math.floor(size * borderRatio);
  const cx = (size - 1) / 2;
  const cy = (size - 1) / 2;
  const glyphR = size * (maskable ? 0.22 : 0.28);

  for (let y = 0; y < size; y++) {
    const row = y * stride;
    raw[row] = 0; // filter none
    for (let x = 0; x < size; x++) {
      const i = row + 1 + x * 3;
      const edge = Math.min(x, y, size - 1 - x, size - 1 - y);
      let r = rgb[0];
      let g = rgb[1];
      let b = rgb[2];
      if (edge < border) {
        r = edgeBg[0];
        g = edgeBg[1];
        b = edgeBg[2];
      } else {
        // Simple book-mark glyph in the safe zone so assets are not identical.
        const dx = x - cx;
        const dy = y - cy;
        const inGlyph =
          Math.abs(dx) < glyphR * 0.55 && Math.abs(dy) < glyphR * 0.85;
        const spine = dx > -glyphR * 0.55 && dx < -glyphR * 0.25 && Math.abs(dy) < glyphR * 0.85;
        if (inGlyph) {
          if (spine) {
            r = 0x14;
            g = 0x3d;
            b = 0x34;
          } else {
            r = 0xe8;
            g = 0xf0;
            b = 0xec;
          }
        }
      }
      raw[i] = r;
      raw[i + 1] = g;
      raw[i + 2] = b;
    }
  }
  const compressed = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk("IHDR", ihdr),
    chunk("IDAT", compressed),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(outDir, { recursive: true });
const icon192 = makePng(192, { maskable: false });
const icon512 = makePng(512, { maskable: false });
const maskable512 = makePng(512, { maskable: true });
fs.writeFileSync(path.join(outDir, "icon-192.png"), icon192);
fs.writeFileSync(path.join(outDir, "icon-512.png"), icon512);
fs.writeFileSync(path.join(outDir, "maskable-512.png"), maskable512);
const s192 = fs.statSync(path.join(outDir, "icon-192.png")).size;
const s512 = fs.statSync(path.join(outDir, "icon-512.png")).size;
const sMask = fs.statSync(path.join(outDir, "maskable-512.png")).size;
console.log("wrote icons", { s192, s512, sMask });
if (s192 < 200 || s512 < 500 || sMask < 500) process.exit(1);
// Maskable must differ from the normal 512 so installers get a real safe zone.
if (Buffer.compare(icon512, maskable512) === 0) {
  console.error("maskable-512 must not be byte-identical to icon-512");
  process.exit(1);
}
