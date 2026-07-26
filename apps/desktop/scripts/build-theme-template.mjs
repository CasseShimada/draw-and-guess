import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

const repoRoot = path.resolve(import.meta.dirname, "..", "..", "..");
const webSource = path.join(
  repoRoot,
  "apps",
  "web",
  "src",
  "theme",
  "default-template.css"
);
const desktopSource = path.join(
  repoRoot,
  "apps",
  "desktop",
  "src",
  "renderer",
  "theme",
  "desktop-template.css"
);
const outputPath = path.join(
  repoRoot,
  "apps",
  "desktop",
  "assets",
  "drawguess-theme-template.css"
);

const normalize = (value) => value.replaceAll("\r\n", "\n").trimEnd();

async function expectedTemplate() {
  const [web, desktop] = await Promise.all([
    readFile(webSource, "utf8"),
    readFile(desktopSource, "utf8")
  ]);
  return `/*
 * Draw & Guess Theme Template
 * Theme API Version: 1
 * Apply Mode: replace
 *
 * Import this complete file as a replacement theme, or copy individual rules
 * into a smaller override theme. :root is rewritten to the local theme root.
 *
 * Global state:
 *   [data-ui="theme-root"][data-platform="web|desktop"]
 *   [data-screen] [data-mode] [data-phase] [data-connection]
 *
 * Public component examples:
 *   [data-ui="home-screen"] [data-ui="room-entry"] [data-ui="topbar"]
 *   [data-ui="player-list"] [data-ui="player-card"] [data-ui="chat-panel"]
 *   [data-ui="drawing-board"] [data-ui="timer"] [data-ui="dialog"]
 *   [data-ui="primary-button"] [data-ui="secondary-button"]
 *
 * Local assets must use relative PNG/JPEG/WebP/GIF/WOFF/WOFF2 URLs:
 *   background-image: url("./assets/paper.png");
 *
 * Main variables:
 *   --ink --paper --paper-light --coral --coral-dark --teal --yellow
 *   --line --muted --shadow --font-display
 */

/* ===== Web game UI ===== */

${normalize(web)}

/* ===== Electron ordinary UI ===== */

${normalize(desktop)}
`;
}

function validate(css) {
  const failures = [];
  if (!css.includes("Theme API Version: 1") || !css.includes("Apply Mode: replace")) {
    failures.push("缺少主题接口版本头");
  }
  if (/@import\b/iu.test(css)) {
    failures.push("导出模板不能依赖 @import");
  }
  if (/url\(\s*["']?(?:https?:|\/\/|file:|data:)/iu.test(css)) {
    failures.push("导出模板包含网络或危险 URL");
  }
  if (/[A-Za-z]:\\|\/Users\/|\/home\/|node_modules/iu.test(css)) {
    failures.push("导出模板包含开发环境绝对路径");
  }
  for (const token of [
    ":root",
    '[data-ui="theme-root"]',
    '[data-ui="home-screen"]',
    '[data-ui="room-entry"]',
    '[data-ui="primary-button"]',
    '[data-ui="player-list"]',
    '[data-ui="player-card"]',
    '[data-ui="chat-panel"]',
    '[data-ui="chat-log"]',
    '[data-ui="drawing-board"]',
    '[data-ui="timer"]',
    '[data-ui="result-card"]',
    '[data-ui="desktop-toolbar"]',
    '[data-ui="settings-panel"]',
    '[data-ui="theme-preview"]',
    "--ink",
    ".panel",
    ".desktop-panel"
  ]) {
    if (!css.includes(token)) {
      failures.push(`导出模板缺少 ${token}`);
    }
  }
  if (
    css.includes('[data-ui="theme-safety-host"]') ||
    css.includes('[data-ui="sharing-safety"]')
  ) {
    failures.push("导出模板不得包含独立安全宿主样式");
  }
  if (Buffer.byteLength(css, "utf8") > 512 * 1024) {
    failures.push("导出模板超过 512 KiB");
  }
  if (failures.length > 0) {
    throw new Error(failures.join("；"));
  }
}

const expected = await expectedTemplate();
validate(expected);

if (process.argv.includes("--check")) {
  const actual = await readFile(outputPath, "utf8").catch(() => "");
  if (actual !== expected) {
    throw new Error("默认主题模板已过期；请运行 corepack pnpm theme:build-template");
  }
  process.stdout.write(
    `主题模板验证通过：${path.relative(repoRoot, outputPath)} (${Buffer.byteLength(
      expected,
      "utf8"
    )} bytes)\n`
  );
} else {
  await writeFile(outputPath, expected, "utf8");
  process.stdout.write(
    `已生成主题模板：${path.relative(repoRoot, outputPath)} (${Buffer.byteLength(
      expected,
      "utf8"
    )} bytes)\n`
  );
}
