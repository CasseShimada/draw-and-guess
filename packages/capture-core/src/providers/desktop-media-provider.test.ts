import { describe, expect, it, vi } from "vitest";

import type { CaptureSource } from "../capture-provider.js";
import {
  DesktopMediaProvider,
  type DesktopCaptureBridge,
  type DisplayMediaDevices
} from "./desktop-media-provider.js";

const SOURCE: CaptureSource = {
  id: "window:1",
  name: "Krita",
  type: "window",
  thumbnailDataUrl: "data:image/png;base64,",
  appIconDataUrl: null,
  displayId: null,
  isOwnApp: false
};

describe("desktop media provider", () => {
  it("selects through the bridge, hides the cursor, and stops every media track", async () => {
    const videoStop = vi.fn();
    const auxiliaryStop = vi.fn();
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const track = { stop: videoStop, addEventListener, removeEventListener };
    const auxiliaryTrack = { stop: auxiliaryStop };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track, auxiliaryTrack]
    } as unknown as MediaStream;
    const selectSource = vi.fn(async () => undefined);
    const getDisplayMedia = vi.fn(async () => stream);
    const bridge: DesktopCaptureBridge = {
      listSources: async () => [SOURCE],
      selectSource
    };
    const mediaDevices: DisplayMediaDevices = {
      getDisplayMedia
    };
    const provider = new DesktopMediaProvider(bridge, mediaDevices);
    const handle = await provider.start(SOURCE);
    expect(selectSource).toHaveBeenCalledWith(SOURCE.id);
    expect(getDisplayMedia).toHaveBeenCalledWith({
      audio: false,
      video: {
        frameRate: { ideal: 5, max: 5 },
        cursor: "never"
      }
    });
    handle.stop();
    handle.stop();
    expect(videoStop).toHaveBeenCalledTimes(1);
    expect(auxiliaryStop).toHaveBeenCalledTimes(1);
  });

  it("stops all tracks and reports when the selected source ends", async () => {
    const endedRef: { current: (() => void) | null } = { current: null };
    const videoStop = vi.fn();
    const auxiliaryStop = vi.fn();
    const track = {
      stop: videoStop,
      addEventListener: vi.fn(
        (_name: string, listener: EventListenerOrEventListenerObject) => {
          endedRef.current =
            typeof listener === "function"
              ? () => listener(new Event("ended"))
              : () => listener.handleEvent(new Event("ended"));
        }
      ),
      removeEventListener: vi.fn()
    };
    const stream = {
      getVideoTracks: () => [track],
      getTracks: () => [track, { stop: auxiliaryStop }]
    } as unknown as MediaStream;
    const onEnded = vi.fn();
    const provider = new DesktopMediaProvider(
      {
        listSources: async () => [SOURCE],
        selectSource: async () => undefined
      },
      { getDisplayMedia: async () => stream }
    );

    await provider.start(SOURCE, { onEnded });
    const fireEnded = endedRef.current;
    if (!fireEnded) {
      throw new Error("ended listener was not registered");
    }
    fireEnded();
    provider.stop();

    expect(videoStop).toHaveBeenCalledTimes(1);
    expect(auxiliaryStop).toHaveBeenCalledTimes(1);
    expect(onEnded).toHaveBeenCalledTimes(1);
  });

  it("blocks this application's own window", async () => {
    const provider = new DesktopMediaProvider(
      {
        listSources: async () => [],
        selectSource: async () => undefined
      },
      { getDisplayMedia: vi.fn() }
    );
    await expect(provider.start({ ...SOURCE, isOwnApp: true })).rejects.toThrow(
      "无限镜像"
    );
  });
});
