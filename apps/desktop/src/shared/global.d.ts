import type { DesktopBridge } from "./ipc.js";

declare global {
  interface Window {
    drawGuessDesktop: DesktopBridge;
  }
}

export {};
