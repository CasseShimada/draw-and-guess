export interface CaptureSource {
  id: string;
  name: string;
  type: "window" | "screen";
  thumbnailDataUrl: string;
  appIconDataUrl: string | null;
  displayId: string | null;
  isOwnApp: boolean;
}

export interface CaptureStreamHandle {
  source: CaptureSource;
  stream: MediaStream;
  stop(): void;
}

export interface CaptureStartOptions {
  onEnded?(): void;
}

export interface CaptureProvider {
  listSources(): Promise<CaptureSource[]>;
  start(
    source: CaptureSource,
    options?: CaptureStartOptions
  ): Promise<CaptureStreamHandle>;
  stop(): void;
}
