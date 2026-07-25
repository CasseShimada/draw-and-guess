import type {
  CaptureProvider,
  CaptureSource,
  CaptureStartOptions,
  CaptureStreamHandle
} from "../capture-provider.js";

export interface DesktopCaptureBridge {
  listSources: () => Promise<CaptureSource[]>;
  selectSource: (sourceId: string) => Promise<void>;
}

export interface DisplayMediaDevices {
  getDisplayMedia: (constraints?: DisplayMediaStreamOptions) => Promise<MediaStream>;
}

type DisplayVideoConstraints = MediaTrackConstraints & {
  cursor: "never";
};

export class DesktopMediaProvider implements CaptureProvider {
  readonly #bridge: DesktopCaptureBridge;
  readonly #mediaDevices: DisplayMediaDevices;
  #active: CaptureStreamHandle | null = null;

  constructor(
    bridge: DesktopCaptureBridge,
    mediaDevices: DisplayMediaDevices = navigator.mediaDevices
  ) {
    this.#bridge = bridge;
    this.#mediaDevices = mediaDevices;
  }

  async listSources(): Promise<CaptureSource[]> {
    return this.#bridge.listSources();
  }

  async start(
    source: CaptureSource,
    options: CaptureStartOptions = {}
  ): Promise<CaptureStreamHandle> {
    if (source.isOwnApp) {
      throw new Error("为避免无限镜像，不能采集画猜现场自己的窗口");
    }
    this.stop();
    await this.#bridge.selectSource(source.id);
    const videoConstraints: DisplayVideoConstraints = {
      frameRate: { ideal: 5, max: 5 },
      cursor: "never"
    };
    const stream = await this.#mediaDevices.getDisplayMedia({
      audio: false,
      video: videoConstraints
    });
    const track = stream.getVideoTracks()[0];
    if (!track) {
      for (const item of stream.getTracks()) {
        item.stop();
      }
      throw new Error("系统没有返回可用的视频轨道");
    }
    let stopped = false;
    const onEnded = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      this.#active = null;
      for (const item of stream.getTracks()) {
        item.stop();
      }
      options.onEnded?.();
    };
    track.addEventListener("ended", onEnded, { once: true });
    const handle: CaptureStreamHandle = {
      source,
      stream,
      stop: () => {
        if (stopped) {
          return;
        }
        stopped = true;
        track.removeEventListener("ended", onEnded);
        for (const item of stream.getTracks()) {
          item.stop();
        }
        if (this.#active === handle) {
          this.#active = null;
        }
      }
    };
    this.#active = handle;
    return handle;
  }

  stop(): void {
    this.#active?.stop();
    this.#active = null;
  }
}
