import { BrowserWindow, desktopCapturer, type DesktopCapturerSource } from "electron";

import { CaptureSourceSchema, type DesktopBridge } from "../shared/ipc.js";
import type { RedactingLogger } from "./redacting-logger.js";

type CaptureSourceDto = Awaited<
  ReturnType<DesktopBridge["capture"]["listSources"]>
>[number];

export class CaptureSourceService {
  readonly #logger: RedactingLogger;
  readonly #sources = new Map<string, DesktopCapturerSource>();
  #selectedSourceId: string | null = null;

  constructor(logger: RedactingLogger) {
    this.#logger = logger;
  }

  async listSources(): Promise<CaptureSourceDto[]> {
    const ownSourceIds = new Set(
      BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getMediaSourceId())
    );
    const ownTitles = new Set(
      BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getTitle())
        .filter(Boolean)
    );
    const sources = await desktopCapturer.getSources({
      types: ["window", "screen"],
      thumbnailSize: { width: 320, height: 180 },
      fetchWindowIcons: true
    });
    this.#sources.clear();
    const result = sources
      .map((source) => {
        this.#sources.set(source.id, source);
        const dto: CaptureSourceDto = {
          id: source.id,
          name: source.name || "未命名来源",
          type:
            source.id.startsWith("screen:") || Boolean(source.display_id)
              ? "screen"
              : "window",
          thumbnailDataUrl: source.thumbnail.toDataURL(),
          appIconDataUrl: source.appIcon?.isEmpty()
            ? null
            : (source.appIcon?.toDataURL() ?? null),
          displayId: source.display_id || null,
          isOwnApp:
            ownSourceIds.has(source.id) ||
            ownTitles.has(source.name) ||
            /画猜现场|draw\s*&?\s*guess/i.test(source.name)
        };
        return CaptureSourceSchema.parse(dto);
      })
      .sort(
        (left, right) =>
          (left.type === right.type ? 0 : left.type === "window" ? -1 : 1) ||
          left.name.localeCompare(right.name, "zh-CN")
      );
    this.#logger.info("已刷新采集来源", {
      windows: result.filter((source) => source.type === "window").length,
      screens: result.filter((source) => source.type === "screen").length
    });
    return result;
  }

  selectSource(sourceId: string): void {
    const source = this.#sources.get(sourceId);
    if (!source) {
      throw new Error("采集来源已失效，请刷新列表");
    }
    const ownSourceIds = new Set(
      BrowserWindow.getAllWindows()
        .filter((window) => !window.isDestroyed())
        .map((window) => window.getMediaSourceId())
    );
    if (
      ownSourceIds.has(source.id) ||
      /画猜现场|draw\s*&?\s*guess/i.test(source.name)
    ) {
      throw new Error("为避免无限镜像，不能选择画猜现场自己的窗口");
    }
    this.#selectedSourceId = source.id;
    this.#logger.info("用户选择了采集来源", {
      type: source.id.startsWith("screen:") ? "screen" : "window"
    });
  }

  takeSelectedSource(): DesktopCapturerSource | null {
    const id = this.#selectedSourceId;
    this.#selectedSourceId = null;
    return id ? (this.#sources.get(id) ?? null) : null;
  }

  clearSelection(): void {
    this.#selectedSourceId = null;
  }
}
