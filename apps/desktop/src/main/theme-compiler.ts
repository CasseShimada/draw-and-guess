import { createHash } from "node:crypto";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import {
  CONTENT_LIMITS,
  THEME_API_VERSION,
  type ThemeApplyMode
} from "@draw-guess/content";
import postcss, { type AtRule, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";

export const THEME_PROTOCOL = "drawguess-theme";
export const THEME_ROOT_SELECTOR = '[data-ui="theme-root"]';

const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".woff",
  ".woff2"
]);
const MIME_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
} as const;
const FORBIDDEN_SAFETY_SELECTOR =
  /data-ui\s*=\s*["']?(?:protected-safety|sharing-safety|theme-recovery|theme-safety-host)|theme-safety-host/iu;
const SCRIPT_CSS_PATTERN =
  /(?:expression\s*\(|javascript\s*:|<\s*script|<\/\s*style)/iu;
const FORBIDDEN_RESOURCE_SCHEME =
  /(?:https?|ftp|file|data|javascript|blob)\s*:|(?:^|[\s("'=])\/\//iu;
const ALLOWED_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "layer",
  "font-face",
  "keyframes",
  "-webkit-keyframes"
]);

export type ThemeAssetMimeType = (typeof MIME_TYPES)[keyof typeof MIME_TYPES];

export interface CompiledThemeAsset {
  sourceReference: string;
  sourcePath: string;
  compiledName: string;
  byteLength: number;
  sha256: string;
  mimeType: ThemeAssetMimeType;
}

export interface ThemeCompileWarning {
  code: string;
  message: string;
}

export interface CompileThemeOptions {
  themeId: string;
  applyMode: ThemeApplyMode;
  sourceRoot: string;
  themeApiVersion: number;
}

export interface CompileThemeResult {
  css: string;
  assets: CompiledThemeAsset[];
  warnings: ThemeCompileWarning[];
}

export function themeApiVersionFromSource(source: string): number {
  const versions = new Set<number>();
  const parsed = postcss.parse(source);
  parsed.walkComments((comment) => {
    if (!/Theme API Version\s*:/iu.test(comment.text)) {
      return;
    }
    const matches = [...comment.text.matchAll(/Theme API Version\s*:\s*(\d+)\b/giu)];
    if (matches.length === 0) {
      throw comment.error("主题接口版本头必须是正整数");
    }
    for (const match of matches) {
      const version = Number(match[1]);
      if (!Number.isSafeInteger(version) || version < 1) {
        throw comment.error("主题接口版本头必须是正整数");
      }
      versions.add(version);
    }
  });
  if (versions.size > 1) {
    throw new Error("CSS 中包含互相冲突的主题接口版本头");
  }
  return versions.values().next().value ?? THEME_API_VERSION;
}

export function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function isInside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function safeAssetBasename(value: string): string {
  const sanitized = path
    .basename(value)
    .normalize("NFKC")
    .replace(/[^A-Za-z0-9._-]/gu, "-")
    .slice(-100);
  return sanitized || "asset";
}

function singleCssName(value: string, label: string): string {
  const parsed = valueParser(value);
  const significant = parsed.nodes.filter(
    (node) => node.type !== "space" && node.type !== "comment"
  );
  if (
    significant.length !== 1 ||
    (significant[0]?.type !== "word" && significant[0]?.type !== "string")
  ) {
    throw new Error(`${label} 必须使用单一、无转义的名称`);
  }
  const name = significant[0].value.trim();
  if (!/^[-_A-Za-z][-_A-Za-z0-9 ]{0,80}$/u.test(name)) {
    throw new Error(`${label} 名称无效`);
  }
  return name;
}

function rewriteCssNames(value: string, names: ReadonlyMap<string, string>): string {
  if (names.size === 0) {
    return value;
  }
  const parsed = valueParser(value);
  parsed.walk((node) => {
    if (node.type !== "word" && node.type !== "string") {
      return;
    }
    const replacement = names.get(node.value);
    if (replacement) {
      node.value = replacement;
    }
  });
  return valueParser.stringify(parsed.nodes);
}

function isKeyframes(rule: Rule): boolean {
  return (
    rule.parent?.type === "atrule" &&
    /^(?:-\w+-)?keyframes$/iu.test((rule.parent as AtRule).name)
  );
}

function scopeSelector(selector: string, rule: Rule): string {
  if (FORBIDDEN_SAFETY_SELECTOR.test(selector)) {
    throw rule.error("主题不能选择独立安全宿主或安全恢复控件");
  }
  if (selector.includes("&")) {
    throw rule.error("主题暂不支持 CSS nesting 的 & 选择器");
  }
  let beginsAtThemeRoot = false;
  const normalized = selectorParser((root) => {
    root.walkPseudos((pseudo) => {
      if (pseudo.value.toLowerCase() !== ":root") {
        return;
      }
      pseudo.replaceWith(
        selectorParser.attribute({
          attribute: "data-ui",
          operator: "=",
          quoteMark: '"',
          raws: {},
          value: "theme-root"
        })
      );
    });
    const parsedSelector = root.nodes[0];
    if (!parsedSelector || parsedSelector.type !== "selector") {
      return;
    }
    const firstNode = parsedSelector.nodes.find((node) => node.type !== "comment");
    beginsAtThemeRoot =
      firstNode?.type === "attribute" &&
      firstNode.attribute === "data-ui" &&
      firstNode.operator === "=" &&
      firstNode.value === "theme-root";
    if (!beginsAtThemeRoot) {
      return;
    }
    let confinedToDescendants = false;
    for (const node of parsedSelector.nodes) {
      if (node.type !== "combinator") {
        continue;
      }
      const combinator = node.value.trim();
      if (combinator === "" || combinator === ">") {
        confinedToDescendants = true;
      } else if (!confinedToDescendants) {
        throw rule.error("从主题根节点向相邻或外部节点逃逸的选择器不受支持");
      }
    }
  })
    .processSync(selector.trim())
    .replaceAll("[data-ui=theme-root]", THEME_ROOT_SELECTOR);
  if (beginsAtThemeRoot) {
    return normalized;
  }
  return `${THEME_ROOT_SELECTOR} ${normalized}`;
}

async function validateThemeAsset(
  sourceRoot: string,
  rawReference: string
): Promise<CompiledThemeAsset> {
  let reference: string;
  try {
    reference = decodeURIComponent(rawReference.replaceAll("\\", "/"));
  } catch {
    throw new Error("CSS 素材 URL 编码无效");
  }
  if (
    reference.startsWith("//") ||
    reference.startsWith("/") ||
    reference.includes("?") ||
    reference.includes("#") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(reference) ||
    path.win32.isAbsolute(reference)
  ) {
    throw new Error(`CSS 素材必须使用无查询参数的相对路径：${rawReference}`);
  }
  const segments = reference.split("/").filter((segment) => segment !== ".");
  if (segments.some((segment) => !segment || segment === "..")) {
    throw new Error(`CSS 素材路径包含 traversal：${rawReference}`);
  }
  const extension = path.extname(reference).toLowerCase();
  if (!ALLOWED_EXTENSIONS.has(extension)) {
    throw new Error(`CSS 素材类型不在允许列表中：${extension || "未知"}`);
  }
  let resolvedRoot: string;
  try {
    resolvedRoot = await realpath(sourceRoot);
  } catch {
    throw new Error("CSS 素材根目录不存在");
  }
  const candidate = path.resolve(resolvedRoot, ...segments);
  if (!isInside(resolvedRoot, candidate)) {
    throw new Error("CSS 素材路径超出 CSS 根目录");
  }
  let resolved: string;
  try {
    resolved = await realpath(candidate);
  } catch {
    throw new Error(`CSS 引用的素材不存在：${rawReference}`);
  }
  if (!isInside(resolvedRoot, resolved)) {
    throw new Error("CSS 素材符号链接逃逸了 CSS 根目录");
  }
  const info = await stat(resolved);
  if (!info.isFile() || info.size < 1 || info.size > CONTENT_LIMITS.themeAssetBytes) {
    throw new Error("CSS 单个素材必须在 1 字节到 5 MiB 之间");
  }
  const bytes = await readFile(resolved);
  const hash = sha256(bytes);
  const mimeType = MIME_TYPES[extension as keyof typeof MIME_TYPES];
  if (!mimeType) {
    throw new Error("CSS 素材 MIME 无法确定");
  }
  return {
    sourceReference: reference,
    sourcePath: resolved,
    compiledName: `${hash.slice(0, 16)}-${safeAssetBasename(reference)}`,
    byteLength: bytes.byteLength,
    sha256: hash,
    mimeType
  };
}

export async function compileThemeCss(
  source: string,
  options: CompileThemeOptions
): Promise<CompileThemeResult> {
  if (options.themeApiVersion !== THEME_API_VERSION) {
    throw new Error(
      `主题接口版本 ${String(options.themeApiVersion)} 不受支持；当前版本为 ${String(
        THEME_API_VERSION
      )}`
    );
  }
  if (Buffer.byteLength(source, "utf8") > CONTENT_LIMITS.themeCssBytes) {
    throw new Error("CSS 文件不能超过 512 KiB");
  }
  if (SCRIPT_CSS_PATTERN.test(source)) {
    throw new Error("CSS 包含脚本或 HTML 注入片段");
  }

  const parsed = postcss.parse(source, {
    from: path.join(options.sourceRoot, "source.css")
  });
  const assets = new Map<string, CompiledThemeAsset>();
  const namespace = sha256(
    Buffer.from(`${options.themeId}\0${options.applyMode}\0${source}`, "utf8")
  ).slice(0, 12);
  const globalNames = new Map<string, string>();

  parsed.walkAtRules((atRule) => {
    const name = atRule.name.toLowerCase();
    if (name === "import") {
      throw atRule.error("自定义 CSS 不允许 @import");
    }
    if (!ALLOWED_AT_RULES.has(name) || /\burl\s*\(/iu.test(atRule.params)) {
      throw atRule.error(`不支持或不安全的 @${atRule.name} 规则`);
    }
    if (name === "keyframes" || name === "-webkit-keyframes") {
      const original = singleCssName(atRule.params, "@keyframes");
      const scoped = `dg-theme-${namespace}-${original.replaceAll(" ", "-")}`;
      globalNames.set(original, scoped);
      atRule.params = scoped;
      return;
    }
    if (name === "font-face") {
      const family = atRule.nodes?.find(
        (node) => node.type === "decl" && node.prop.toLowerCase() === "font-family"
      );
      if (!family || family.type !== "decl") {
        throw atRule.error("@font-face 必须声明 font-family");
      }
      const original = singleCssName(family.value, "@font-face font-family");
      const scoped = `dg-theme-${namespace}-${original.replaceAll(" ", "-")}`;
      globalNames.set(original, scoped);
      family.value = `"${scoped}"`;
    }
  });

  const rewriteValue = async (rawValue: string): Promise<string> => {
    if (FORBIDDEN_RESOURCE_SCHEME.test(rawValue)) {
      throw new Error("CSS 声明包含网络或不安全的资源 URL");
    }
    const ast = valueParser(rawValue);
    const pending: Promise<void>[] = [];
    ast.walk((node) => {
      if (node.type !== "function") {
        return;
      }
      const functionName = node.value.toLowerCase();
      if (
        (functionName === "image-set" || functionName === "-webkit-image-set") &&
        node.nodes.some((child) => child.type === "string")
      ) {
        throw new Error("image-set() 中的素材必须显式使用 url(相对路径)");
      }
      if (functionName === "src") {
        throw new Error("主题资源必须使用可校验的 url(相对路径)");
      }
      if (functionName !== "url") {
        return;
      }
      const raw = valueParser.stringify(node.nodes).trim();
      const unquoted = raw.replace(/^(["'])(.*)\1$/su, "$2").trim();
      if (!unquoted || unquoted.startsWith("#")) {
        return;
      }
      pending.push(
        validateThemeAsset(options.sourceRoot, unquoted).then((asset) => {
          assets.set(asset.sourcePath, asset);
          node.nodes = [
            {
              type: "word",
              value: `${THEME_PROTOCOL}://active/assets/${asset.compiledName}`,
              sourceIndex: 0,
              sourceEndIndex: 0
            }
          ];
        })
      );
    });
    await Promise.all(pending);
    return valueParser.stringify(ast.nodes);
  };

  const declarationTasks: Promise<void>[] = [];
  parsed.walkDecls((declaration) => {
    if (
      SCRIPT_CSS_PATTERN.test(declaration.value) ||
      /^(?:behavior|-moz-binding)$/iu.test(declaration.prop)
    ) {
      throw declaration.error("CSS 声明包含脚本或浏览器绑定");
    }
    declarationTasks.push(
      rewriteValue(declaration.value)
        .then((value) => {
          declaration.value = rewriteCssNames(value, globalNames);
        })
        .catch((error: unknown) => {
          throw declaration.error(
            error instanceof Error ? error.message : "CSS 资源值校验失败"
          );
        })
    );
  });
  await Promise.all(declarationTasks);

  parsed.walkRules((rule) => {
    if (isKeyframes(rule)) {
      return;
    }
    rule.selectors = rule.selectors.map((selector) => scopeSelector(selector, rule));
  });

  const compiledAssets = [...assets.values()].sort((left, right) =>
    left.compiledName.localeCompare(right.compiledName)
  );
  const totalAssetBytes = compiledAssets.reduce(
    (total, asset) => total + asset.byteLength,
    0
  );
  if (
    compiledAssets.length > CONTENT_LIMITS.themeAssetFiles ||
    totalAssetBytes > CONTENT_LIMITS.themeTotalAssetBytes
  ) {
    throw new Error("主题素材数量或总大小超过限制");
  }

  const css = parsed.toString();
  if (Buffer.byteLength(css, "utf8") > CONTENT_LIMITS.themeCssBytes) {
    throw new Error("重写后的 CSS 超过 512 KiB");
  }
  return {
    css,
    assets: compiledAssets,
    warnings: []
  };
}
