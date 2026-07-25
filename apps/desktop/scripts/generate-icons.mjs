import { readFile, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";

import sharp from "sharp";

const require = createRequire(import.meta.url);
const png2icons = require("png2icons");
const desktopRoot = path.resolve(import.meta.dirname, "..");
const assets = path.join(desktopRoot, "assets");
const svg = await readFile(path.join(assets, "icon.svg"));
const png = await sharp(svg).resize(1024, 1024).png().toBuffer();

await writeFile(path.join(assets, "icon.png"), png);
const ico = png2icons.createICO(png, png2icons.BICUBIC2, 0, false, true);
const icns = png2icons.createICNS(png, png2icons.BICUBIC2, 0);
if (!ico || !icns) {
  throw new Error("无法生成桌面图标");
}
await Promise.all([
  writeFile(path.join(assets, "icon.ico"), ico),
  writeFile(path.join(assets, "icon.icns"), icns)
]);
