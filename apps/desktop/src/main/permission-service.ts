import { systemPreferences } from "electron";

import {
  CapturePermissionStatusSchema,
  type CapturePermissionStatus
} from "../shared/ipc.js";

function supportedPlatform(): CapturePermissionStatus["platform"] {
  if (process.platform === "darwin" || process.platform === "linux") {
    return process.platform;
  }
  return "win32";
}

export class PermissionService {
  status(): CapturePermissionStatus {
    const platform = supportedPlatform();
    if (platform === "darwin") {
      const raw = systemPreferences.getMediaAccessStatus("screen");
      const status =
        raw === "granted" ||
        raw === "denied" ||
        raw === "restricted" ||
        raw === "not-determined"
          ? raw
          : "unavailable";
      return CapturePermissionStatusSchema.parse({
        platform,
        status,
        message:
          status === "granted"
            ? "屏幕录制权限已授予"
            : status === "not-determined"
              ? "选择来源时 macOS 会请求屏幕录制权限"
              : status === "denied" || status === "restricted"
                ? "请在“系统设置 → 隐私与安全性 → 屏幕与系统音频录制”中允许画猜现场"
                : "无法读取 macOS 屏幕录制权限",
        restartRequired: status === "denied" || status === "restricted"
      });
    }
    if (platform === "linux") {
      const wayland =
        process.env.XDG_SESSION_TYPE?.toLowerCase() === "wayland" ||
        Boolean(process.env.WAYLAND_DISPLAY);
      return CapturePermissionStatusSchema.parse({
        platform,
        status: wayland ? "portal" : "granted",
        message: wayland
          ? "Wayland 将使用系统门户选择器；取消门户会停止共享"
          : "X11 窗口与屏幕采集可用",
        restartRequired: false
      });
    }
    return CapturePermissionStatusSchema.parse({
      platform,
      status: "granted",
      message: "Windows 窗口与屏幕采集可用",
      restartRequired: false
    });
  }
}
