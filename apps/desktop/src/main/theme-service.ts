import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile
} from "node:fs/promises";
import path from "node:path";

import { CONTENT_LIMITS } from "@draw-guess/content";
import { protocol } from "electron";
import postcss, { type AtRule, type Rule } from "postcss";
import selectorParser from "postcss-selector-parser";
import valueParser from "postcss-value-parser";
import { z } from "zod";

import { ThemeStatusSchema, type ThemeStatus } from "../shared/ipc.js";
import type { RedactingLogger } from "./redacting-logger.js";
import type { SettingsService } from "./settings-service.js";

export const THEME_PROTOCOL = "drawguess-theme";
const THEME_ROOT_SELECTOR = '[data-ui="theme-root"]';
const ALLOWED_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".webp",
  ".gif",
  ".woff",
  ".woff2"
]);
const MIME_TYPES: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".woff": "font/woff",
  ".woff2": "font/woff2"
};
const PROTECTED_SELECTOR_PATTERN =
  /data-ui\s*=\s*["']?(?:protected-safety|sharing-safety|theme-recovery)/i;
const SCRIPT_CSS_PATTERN = /(?:expression\s*\(|javascript\s*:|<\s*script|<\/\s*style)/i;
const FORBIDDEN_URL_PATTERN =
  /(?:^|[\s("'=])(?:https?|file|ftp|javascript|data):|(?:^|[\s("'=])\/\//i;
const ALLOWED_AT_RULES = new Set([
  "media",
  "supports",
  "container",
  "font-face",
  "keyframes",
  "-webkit-keyframes"
]);

const ThemeAssetSchema = z
  .object({
    original: z.string().min(1).max(512),
    storedName: z.string().regex(/^[a-f0-9]{16}-[A-Za-z0-9._-]+$/),
    byteLength: z.number().int().positive(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    mimeType: z.enum([
      "image/png",
      "image/jpeg",
      "image/webp",
      "image/gif",
      "font/woff",
      "font/woff2"
    ])
  })
  .strict();

const ThemeManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    sourceFileName: z.string().min(1).max(260),
    importedAt: z.string().datetime({ offset: true }),
    cssBytes: z.number().int().positive().max(CONTENT_LIMITS.themeCssBytes),
    cssSha256: z.string().regex(/^[a-f0-9]{64}$/),
    assets: z.array(ThemeAssetSchema).max(CONTENT_LIMITS.themeAssetFiles)
  })
  .strict();

type ThemeManifest = z.infer<typeof ThemeManifestSchema>;

function isInside(root: string, target: string): boolean {
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
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .slice(-100);
  return sanitized || "asset";
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
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
    /^(?:-\w+-)?keyframes$/i.test((rule.parent as AtRule).name)
  );
}

interface ValidatedAsset {
  original: string;
  sourcePath: string;
  storedName: string;
  byteLength: number;
  sha256: string;
  mimeType: ThemeManifest["assets"][number]["mimeType"];
}

export class ThemeService {
  readonly #themesRoot: string;
  readonly #activeRoot: string;
  readonly #settings: SettingsService;
  readonly #logger: RedactingLogger;
  #manifest: ThemeManifest | null = null;
  #safeMode = false;
  #error: string | null = null;

  constructor(
    userDataPath: string,
    settings: SettingsService,
    logger: RedactingLogger
  ) {
    this.#themesRoot = path.resolve(userDataPath, "themes");
    this.#activeRoot = path.join(this.#themesRoot, "active");
    this.#settings = settings;
    this.#logger = logger;
  }

  get status(): ThemeStatus {
    return ThemeStatusSchema.parse({
      installed: Boolean(this.#manifest),
      enabled:
        Boolean(this.#manifest) &&
        this.#settings.settings.customCssEnabled &&
        !this.#safeMode,
      fileName: this.#manifest?.sourceFileName ?? null,
      importedAt: this.#manifest?.importedAt ?? null,
      assetCount: this.#manifest?.assets.length ?? 0,
      cssBytes: this.#manifest?.cssBytes ?? 0,
      safeMode: this.#safeMode,
      error: this.#error
    });
  }

  async initialize(safeMode = false): Promise<void> {
    await mkdir(this.#themesRoot, { recursive: true });
    this.#safeMode = safeMode;
    if (safeMode && this.#settings.settings.customCssEnabled) {
      await this.#settings.update({ customCssEnabled: false });
    }
    try {
      this.#manifest = ThemeManifestSchema.parse(
        JSON.parse(
          await readFile(path.join(this.#activeRoot, "manifest.json"), "utf8")
        ) as unknown
      );
      const css = await readFile(path.join(this.#activeRoot, "style.css"));
      if (
        css.byteLength !== this.#manifest.cssBytes ||
        sha256(css) !== this.#manifest.cssSha256
      ) {
        throw new Error("主题 CSS 与 manifest 校验不一致");
      }
      this.#error = null;
    } catch (error) {
      this.#manifest = null;
      if (await this.#activeExists()) {
        this.#error =
          error instanceof Error ? `本地主题无效：${error.message}` : "本地主题无效";
      }
    }
  }

  async activeCss(): Promise<string | null> {
    if (!this.status.enabled) {
      return null;
    }
    try {
      const css = await readFile(path.join(this.#activeRoot, "style.css"), "utf8");
      if (
        Buffer.byteLength(css, "utf8") > CONTENT_LIMITS.themeCssBytes ||
        !this.#manifest ||
        sha256(Buffer.from(css, "utf8")) !== this.#manifest.cssSha256
      ) {
        throw new Error("主题 CSS 校验失败");
      }
      return css;
    } catch (error) {
      this.#error = error instanceof Error ? error.message : "主题 CSS 读取失败";
      return null;
    }
  }

  async importFromPath(cssPathInput: string): Promise<ThemeStatus> {
    const cssPath = path.resolve(cssPathInput);
    const cssInfo = await stat(cssPath);
    if (
      !cssInfo.isFile() ||
      path.extname(cssPath).toLowerCase() !== ".css" ||
      cssInfo.size < 1 ||
      cssInfo.size > CONTENT_LIMITS.themeCssBytes
    ) {
      throw new Error("CSS 文件必须是 1 字节到 512 KiB 的 .css 文件");
    }
    const sourceRoot = await realpath(path.dirname(cssPath));
    const cssText = await readFile(cssPath, "utf8");
    if (SCRIPT_CSS_PATTERN.test(cssText)) {
      throw new Error("CSS 包含脚本、HTML 或不安全协议");
    }
    const parsed = postcss.parse(cssText, { from: cssPath });
    const assets = new Map<string, ValidatedAsset>();
    const namespace = sha256(Buffer.from(cssText, "utf8")).slice(0, 12);
    const globalNames = new Map<string, string>();

    parsed.walkAtRules((atRule) => {
      const name = atRule.name.toLowerCase();
      if (name === "import") {
        throw atRule.error("自定义 CSS 不允许 @import");
      }
      if (
        !ALLOWED_AT_RULES.has(name) ||
        /\burl\s*\(/iu.test(atRule.params) ||
        FORBIDDEN_URL_PATTERN.test(atRule.params)
      ) {
        throw atRule.error("CSS at-rule 包含不允许的 URL 或作用域");
      }
      if (name === "keyframes" || name === "-webkit-keyframes") {
        const original = singleCssName(atRule.params, "@keyframes");
        const scoped = `dg-theme-${namespace}-${original.replaceAll(" ", "-")}`;
        globalNames.set(original, scoped);
        atRule.params = scoped;
      } else if (name === "font-face") {
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
      const ast = valueParser(rawValue);
      const pending: Promise<void>[] = [];
      ast.walk((node) => {
        if (node.type !== "function" || node.value.toLowerCase() !== "url") {
          return;
        }
        const raw = valueParser.stringify(node.nodes).trim();
        const unquoted = raw.replace(/^(["'])(.*)\1$/s, "$2").trim();
        if (!unquoted || unquoted.startsWith("#")) {
          return;
        }
        pending.push(
          this.#validateAsset(sourceRoot, unquoted).then((asset) => {
            assets.set(asset.sourcePath, asset);
            node.nodes = [
              {
                type: "word",
                value: `${THEME_PROTOCOL}://active/assets/${asset.storedName}`,
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

    const declarations: Promise<void>[] = [];
    parsed.walkDecls((declaration) => {
      if (
        SCRIPT_CSS_PATTERN.test(declaration.value) ||
        FORBIDDEN_URL_PATTERN.test(declaration.value) ||
        /^(?:behavior|-moz-binding)$/i.test(declaration.prop)
      ) {
        throw declaration.error("CSS 声明包含脚本或浏览器绑定");
      }
      declarations.push(
        rewriteValue(declaration.value).then((value) => {
          declaration.value = rewriteCssNames(value, globalNames);
        })
      );
    });
    await Promise.all(declarations);

    parsed.walkRules((rule) => {
      if (isKeyframes(rule)) {
        return;
      }
      if (PROTECTED_SELECTOR_PATTERN.test(rule.selector)) {
        throw rule.error("主题不能选择受保护的安全控件");
      }
      const rootSelectors = new Set<string>();
      const selectors = rule.selectors.map((selector) => {
        const trimmed = selector.trim();
        selectorParser().processSync(trimmed);
        if (trimmed === ":root") {
          rootSelectors.add(THEME_ROOT_SELECTOR);
          return THEME_ROOT_SELECTOR;
        }
        if (
          trimmed.includes(THEME_ROOT_SELECTOR) ||
          (/\[\s*data-ui\s*[*^$|~]?=/iu.test(trimmed) &&
            /theme-root/iu.test(trimmed)) ||
          trimmed.includes("&")
        ) {
          throw rule.error(
            "主题选择器不能直接声明根作用域；请使用 :root 或根节点内的稳定 data-ui hook"
          );
        }
        return `${THEME_ROOT_SELECTOR} ${trimmed}`;
      });
      rule.selectors = selectors;
      if (rootSelectors.size > 0) {
        rule.walkDecls((declaration) => {
          if (
            /^(?:position|z-index|isolation|transform|filter|opacity)$/i.test(
              declaration.prop
            )
          ) {
            throw declaration.error("主题根节点不能修改安全层所依赖的堆叠属性");
          }
        });
      }
    });

    const validatedAssets = [...assets.values()];
    const totalBytes = validatedAssets.reduce(
      (total, asset) => total + asset.byteLength,
      0
    );
    if (
      validatedAssets.length > CONTENT_LIMITS.themeAssetFiles ||
      totalBytes > CONTENT_LIMITS.themeTotalAssetBytes
    ) {
      throw new Error("主题素材数量或总大小超过限制");
    }
    const outputCss = parsed.toString();
    const outputBytes = Buffer.from(outputCss, "utf8");
    if (outputBytes.byteLength > CONTENT_LIMITS.themeCssBytes) {
      throw new Error("重写后的 CSS 超过 512 KiB");
    }

    const staging = path.join(this.#themesRoot, `.staging-${randomUUID()}`);
    const backup = path.join(this.#themesRoot, `.backup-${randomUUID()}`);
    if (!isInside(this.#themesRoot, staging) || !isInside(this.#themesRoot, backup)) {
      throw new Error("主题暂存目录无效");
    }
    await mkdir(path.join(staging, "assets"), { recursive: true });
    const previousManifest = this.#manifest;
    const previousSafeMode = this.#safeMode;
    const previousError = this.#error;
    const previousEnabled = this.#settings.settings.customCssEnabled;
    let swapped = false;
    let hadActive = false;
    try {
      await Promise.all(
        validatedAssets.map((asset) =>
          copyFile(asset.sourcePath, path.join(staging, "assets", asset.storedName))
        )
      );
      const manifest = ThemeManifestSchema.parse({
        schemaVersion: 1,
        sourceFileName: path.basename(cssPath),
        importedAt: new Date().toISOString(),
        cssBytes: outputBytes.byteLength,
        cssSha256: sha256(outputBytes),
        assets: validatedAssets.map(
          ({ original, storedName, byteLength, sha256: hash, mimeType }) => ({
            original,
            storedName,
            byteLength,
            sha256: hash,
            mimeType
          })
        )
      });
      await Promise.all([
        writeFile(path.join(staging, "style.css"), outputBytes, { mode: 0o600 }),
        writeFile(
          path.join(staging, "manifest.json"),
          `${JSON.stringify(manifest, null, 2)}\n`,
          { encoding: "utf8", mode: 0o600 }
        )
      ]);

      hadActive = await this.#activeExists();
      if (hadActive) {
        await rename(this.#activeRoot, backup);
      }
      try {
        await rename(staging, this.#activeRoot);
        swapped = true;
      } catch (error) {
        if (hadActive) {
          await rename(backup, this.#activeRoot).catch(() => undefined);
        }
        throw error;
      }
      await this.#settings.update({ customCssEnabled: true });
      this.#manifest = manifest;
      this.#error = null;
      this.#safeMode = false;
      await rm(backup, { recursive: true, force: true }).catch(() => undefined);
      this.#logger.info("已导入本地自定义 CSS", {
        fileName: manifest.sourceFileName,
        assetCount: manifest.assets.length,
        cssBytes: manifest.cssBytes
      });
      return this.status;
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      if (swapped) {
        await rm(this.#activeRoot, { recursive: true, force: true }).catch(
          () => undefined
        );
        if (hadActive) {
          await rename(backup, this.#activeRoot).catch(() => undefined);
        }
      }
      this.#manifest = previousManifest;
      this.#safeMode = previousSafeMode;
      this.#error = previousError;
      if (this.#settings.settings.customCssEnabled !== previousEnabled) {
        await this.#settings
          .update({ customCssEnabled: previousEnabled })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async enable(): Promise<ThemeStatus> {
    if (!this.#manifest) {
      throw new Error("当前没有已导入的自定义 CSS");
    }
    this.#safeMode = false;
    await this.#settings.update({ customCssEnabled: true });
    return this.status;
  }

  async disable(): Promise<ThemeStatus> {
    this.#safeMode = false;
    await this.#settings.update({ customCssEnabled: false });
    return this.status;
  }

  async delete(): Promise<ThemeStatus> {
    await this.disable();
    if (!isInside(this.#themesRoot, this.#activeRoot)) {
      throw new Error("主题目录边界校验失败");
    }
    await rm(this.#activeRoot, { recursive: true, force: true });
    this.#manifest = null;
    this.#error = null;
    return this.status;
  }

  registerProtocol(): Promise<void> {
    protocol.handle(THEME_PROTOCOL, (request) => this.responseForProtocol(request.url));
    return Promise.resolve();
  }

  async responseForProtocol(requestUrl: string): Promise<Response> {
    try {
      const url = new URL(requestUrl);
      if (url.protocol !== `${THEME_PROTOCOL}:` || url.host !== "active") {
        return new Response("Not found", { status: 404 });
      }
      const match = /^\/assets\/([^/]+)$/u.exec(decodeURIComponent(url.pathname));
      const storedName = match?.[1];
      const asset = this.#manifest?.assets.find(
        (candidate) => candidate.storedName === storedName
      );
      if (!storedName || !asset || path.basename(storedName) !== storedName) {
        return new Response("Not found", { status: 404 });
      }
      const target = path.resolve(this.#activeRoot, "assets", storedName);
      if (!isInside(path.join(this.#activeRoot, "assets"), target)) {
        return new Response("Forbidden", { status: 403 });
      }
      const bytes = await readFile(target);
      if (bytes.byteLength !== asset.byteLength || sha256(bytes) !== asset.sha256) {
        return new Response("Not found", { status: 404 });
      }
      return new Response(Uint8Array.from(bytes), {
        headers: {
          "Content-Type": asset.mimeType,
          "Content-Length": String(bytes.byteLength),
          "Cache-Control": "private, max-age=31536000, immutable",
          "Content-Security-Policy": "default-src 'none'",
          "X-Content-Type-Options": "nosniff"
        }
      });
    } catch {
      return new Response("Bad request", { status: 400 });
    }
  }

  async #validateAsset(
    sourceRoot: string,
    rawReference: string
  ): Promise<ValidatedAsset> {
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
    const candidate = path.resolve(sourceRoot, ...segments);
    if (!isInside(sourceRoot, candidate)) {
      throw new Error("CSS 素材路径超出 CSS 根目录");
    }
    let resolved: string;
    try {
      resolved = await realpath(candidate);
    } catch {
      throw new Error(`CSS 引用的素材不存在：${rawReference}`);
    }
    if (!isInside(sourceRoot, resolved)) {
      throw new Error("CSS 素材符号链接逃逸了 CSS 根目录");
    }
    const info = await stat(resolved);
    if (!info.isFile() || info.size < 1 || info.size > CONTENT_LIMITS.themeAssetBytes) {
      throw new Error("CSS 单个素材必须在 1 字节到 5 MiB 之间");
    }
    const bytes = await readFile(resolved);
    const hash = sha256(bytes);
    const mimeType = MIME_TYPES[extension];
    if (!mimeType) {
      throw new Error("CSS 素材 MIME 无法确定");
    }
    return {
      original: reference,
      sourcePath: resolved,
      storedName: `${hash.slice(0, 16)}-${safeAssetBasename(reference)}`,
      byteLength: bytes.byteLength,
      sha256: hash,
      mimeType: mimeType as ValidatedAsset["mimeType"]
    };
  }

  async #activeExists(): Promise<boolean> {
    try {
      return (await stat(this.#activeRoot)).isDirectory();
    } catch {
      return false;
    }
  }
}
