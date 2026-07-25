import { describe, expect, it, vi } from "vitest";

import { CaptureLoop } from "./capture-loop.js";
import type { CaptureSource } from "./capture-provider.js";
import {
  DEFAULT_ENCODING_OPTIONS,
  encodeAdaptiveFrame,
  type CanvasFactory
} from "./encoder.js";
import {
  DesktopMediaProvider,
  type DesktopCaptureBridge,
  type DisplayMediaDevices
} from "./providers/desktop-media-provider.js";

const SOURCE: CaptureSource = {
  id: "window:paint",
  name: "External paint window",
  type: "window",
  thumbnailDataUrl: "data:image/png;base64,",
  appIconDataUrl: null,
  displayId: null,
  isOwnApp: false
};

const WEBP = Uint8Array.from([
  0x52, 0x49, 0x46, 0x46, 0x04, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50
]);

describe("fake desktop capture pipeline", () => {
  it("selects, previews, crops, encodes, and uploads an external window frame", async () => {
    const stopTrack = vi.fn();
    const track = {
      stop: stopTrack,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn()
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track]
    } as unknown as MediaStream;
    const selectSource = vi.fn(async () => undefined);
    const bridge: DesktopCaptureBridge = {
      listSources: async () => [SOURCE],
      selectSource
    };
    const mediaDevices: DisplayMediaDevices = {
      getDisplayMedia: async () => stream
    };
    const provider = new DesktopMediaProvider(bridge, mediaDevices);
    const preview = await provider.start(SOURCE);
    expect(preview.stream).toBe(stream);

    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const canvasFactory: CanvasFactory = (width, height) => {
      const canvas = {
        width,
        height,
        toBlob: (callback: BlobCallback, mimeType?: string, _quality?: number) =>
          callback(new Blob([WEBP], { type: mimeType }))
      } as unknown as HTMLCanvasElement;
      const context = {
        imageSmoothingEnabled: false,
        imageSmoothingQuality: "low",
        drawImage,
        clearRect
      } as unknown as CanvasRenderingContext2D;
      return { canvas, context };
    };
    const uploads: Uint8Array[] = [];
    const loop = new CaptureLoop({
      minimumIntervalMs: 60_000,
      capture: () =>
        encodeAdaptiveFrame(
          {} as CanvasImageSource,
          1920,
          1080,
          { x: 0.25, y: 0.2, width: 0.5, height: 0.6 },
          DEFAULT_ENCODING_OPTIONS,
          canvasFactory
        ),
      upload: ({ frame }) => {
        uploads.push(frame.bytes);
      }
    });

    loop.start(42, 60_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    await loop.whenUploadsIdle();

    expect(selectSource).toHaveBeenCalledWith(SOURCE.id);
    expect(drawImage).toHaveBeenCalledWith(
      expect.anything(),
      480,
      216,
      960,
      648,
      0,
      0,
      960,
      648
    );
    expect(clearRect).toHaveBeenCalled();
    expect(uploads).toHaveLength(1);
    expect([...uploads[0]!]).toEqual([...WEBP]);

    loop.dispose();
    provider.stop();
    expect(stopTrack).toHaveBeenCalledTimes(1);
  });
});
