import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

// Offline converter for this pixel-art sheet's rectangular run paths, NOT a
// general SVG renderer. Never execute SVG scripts or resolve external resources.
const source = readFileSync(new URL("../kirby-pixel-overview.svg", import.meta.url), "utf8");
const size = 64;
const ICON_COLUMNS = 3;
const DOT_ROWS = 4;
const BRAILLE_BITS = [[0, 3], [1, 4], [2, 5], [6, 7]];

// The UI has one fixed thumbnail size. Compile the final cells here instead of
// shipping full-resolution pixels and redoing this work inside every Pi process.
function thumbnail(pixels, palette, crop) {
  const [left, top, side] = crop;
  const colors = palette.map((color) => color && [1, 3, 5].map((offset) => parseInt(color.slice(offset, offset + 2), 16)));
  let icon = "";
  for (let column = 0; column < ICON_COLUMNS; column++) {
    let mask = 0, visiblePixels = 0;
    const rgb = [0, 0, 0];
    for (let y = 0; y < DOT_ROWS; y++) {
      for (let x = 0; x < 2; x++) {
        const x0 = left + Math.floor((column * 2 + x) * side / (ICON_COLUMNS * 2));
        const x1 = left + Math.floor((column * 2 + x + 1) * side / (ICON_COLUMNS * 2));
        const y0 = top + Math.floor(y * side / DOT_ROWS);
        const y1 = top + Math.floor((y + 1) * side / DOT_ROWS);
        let covered = 0;
        const sum = [0, 0, 0];
        for (let sy = y0; sy < y1; sy++) {
          for (let sx = x0; sx < x1; sx++) {
            const color = colors[pixels[sy * size + sx]];
            if (!color) continue;
            covered++;
            for (let channel = 0; channel < 3; channel++) sum[channel] += color[channel];
          }
        }
        // Area coverage retains small moving effects better than point sampling.
        if (covered < (x1 - x0) * (y1 - y0) * 0.2) continue;
        mask |= 1 << BRAILLE_BITS[y][x];
        visiblePixels += covered;
        for (let channel = 0; channel < 3; channel++) rgb[channel] += sum[channel];
      }
    }
    icon += mask
      ? `\x1b[38;2;${rgb.map((value) => Math.round(value / visiblePixels)).join(";")}m${String.fromCodePoint(0x2800 + mask)}`
      : " ";
  }
  return icon + "\x1b[0m";
}

const sprites = [];
for (const [, body] of source.matchAll(/<svg\b[^>]*viewBox="0 0 64 64"[^>]*>([\s\S]*?)<\/svg>/gu)) {
  const name = body.match(/<title>([^<>]+)<\/title>/u)?.[1];
  if (!name) throw new Error("Missing sprite title.");
  if (body.replace(/<title>[^<>]+<\/title>/u, "").replace(/<g opacity="[01]">[\s\S]*?<\/g>/gu, "").trim()) {
    throw new Error(`Unsupported sprite content: ${name}`);
  }
  const palette = [null];
  const frames = [];
  let minX = size, minY = size, maxX = 0, maxY = 0;
  for (const [, frame] of body.matchAll(/<g opacity="[01]">([\s\S]*?)<\/g>/gu)) {
    const animation = frame.match(/<animate\b[^>]*\/>/u)?.[0];
    const values = [0, 1, 2, 3, 0].map((index) => index === frames.length ? 1 : 0).join(";");
    if (!animation?.includes('dur="0.8s"') || !animation.includes('calcMode="discrete"')
      || !animation.includes('attributeName="opacity"') || !animation.includes('repeatCount="indefinite"')
      || !animation.includes(`values="${values}"`) || !animation.includes('keyTimes="0;.25;.5;.75;1"')) {
      throw new Error(`Unsupported timing: ${name}`);
    }
    const pixels = Buffer.alloc(size * size);
    const paths = [...frame.matchAll(/<path fill="(#[\da-f]{6})" d="([^"]+)"\s*\/>/gu)];
    if (!paths.length || frame.replace(/<animate\b[^>]*\/>/gu, "").replace(/<path fill="(#[\da-f]{6})" d="([^"]+)"\s*\/>/gu, "").trim()) {
      throw new Error(`Unsupported SVG frame content: ${name}`);
    }
    for (const [, color, path] of paths) {
      if (!palette.includes(color)) palette.push(color);
      const colorIndex = palette.indexOf(color);
      if (colorIndex > 255) throw new Error("Too many palette colors.");
      const runs = [...path.matchAll(/M(\d+) (\d+)h(\d+)v1H(\d+)z/gu)];
      if (runs.map((run) => run[0]).join("") !== path) throw new Error(`Unsupported pixel path: ${name}`);
      for (const [, xText, yText, widthText, endText] of runs) {
        const [x, y, width, end] = [xText, yText, widthText, endText].map(Number);
        if (x !== end || width < 1 || x + width > size || y >= size) throw new Error(`Pixel outside canvas: ${name}`);
        pixels.fill(colorIndex, y * size + x, y * size + x + width);
        minX = Math.min(minX, x); minY = Math.min(minY, y);
        maxX = Math.max(maxX, x + width - 1); maxY = Math.max(maxY, y);
      }
    }
    frames.push(pixels);
  }
  if (frames.length !== 4) throw new Error(`Expected four frames: ${name}`);
  // Use a fixed square crop across all four frames, so motion never changes scale.
  const side = Math.max(maxX - minX + 1, maxY - minY + 1) + 2;
  const cropSize = Math.min(size, side);
  const crop = [
    Math.max(0, Math.min(size - cropSize, Math.floor((minX + maxX + 1 - cropSize) / 2))),
    Math.max(0, Math.min(size - cropSize, Math.floor((minY + maxY + 1 - cropSize) / 2))),
    cropSize,
  ];
  sprites.push({ name, frames: frames.map((pixels) => thumbnail(pixels, palette, crop)) });
}
if (sprites.length !== 18) throw new Error("Expected eighteen sprites.");
const data = { source: "kirby-pixel-overview.svg", sha256: createHash("sha256").update(source).digest("hex"), columns: ICON_COLUMNS, frameCount: 4, frameMs: 200, sprites };
const output = `// Generated by scripts/build-kirby-frames.mjs. Do not edit by hand.\nexport default ${JSON.stringify(data, null, 2)};\n`;
const destination = new URL("../src/kirby-frames.js", import.meta.url);
if (process.argv.includes("--check")) {
  if (readFileSync(destination, "utf8") !== output) throw new Error("Kirby frames are stale; run npm run build:kirby.");
} else {
  writeFileSync(destination, output);
}
console.log(`Kirby sprites: ${sprites.length} forms × 4 frames (${Buffer.byteLength(output)} bytes).`);
