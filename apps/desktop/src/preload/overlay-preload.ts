import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { z } from "zod";

import { IPC_CHANNELS, SharingStateSchema, type SharingState } from "../shared/ipc.js";

const sharing = Object.freeze({
  stop: async (): Promise<void> => {
    const result = (await ipcRenderer.invoke(
      IPC_CHANNELS.sharingStop,
      undefined
    )) as unknown;
    z.void().parse(result);
  },
  onState: (listener: (state: SharingState) => void): (() => void) => {
    const handler = (_event: IpcRendererEvent, raw: unknown) => {
      const parsed = SharingStateSchema.safeParse(raw);
      if (parsed.success) {
        listener(parsed.data);
      }
    };
    ipcRenderer.on(IPC_CHANNELS.sharingState, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.sharingState, handler);
  }
});

contextBridge.exposeInMainWorld("drawGuessDesktop", Object.freeze({ sharing }));
