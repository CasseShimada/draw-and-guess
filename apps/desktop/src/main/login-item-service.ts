import { existsSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { app } from "electron";

const LOGIN_ARGUMENT = "--launch-at-login";

export function quoteDesktopEntryExec(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("`", "\\`")
    .replaceAll("$", "\\$")
    .replaceAll("%", "%%")}"`;
}

export function linuxAutostartEntry(executablePath: string): string {
  return [
    "[Desktop Entry]",
    "Type=Application",
    "Version=1.0",
    "Name=画猜现场",
    "Comment=跨平台在线你画我猜",
    `Exec=${quoteDesktopEntryExec(executablePath)} ${LOGIN_ARGUMENT}`,
    "Terminal=false",
    "X-GNOME-Autostart-enabled=true",
    ""
  ].join("\n");
}

export class LoginItemService {
  wasOpenedAtLogin(): boolean {
    return (
      process.argv.includes(LOGIN_ARGUMENT) ||
      (process.platform === "darwin" && app.getLoginItemSettings().wasOpenedAtLogin)
    );
  }

  async apply(enabled: boolean, startHidden: boolean): Promise<void> {
    if (enabled && !app.isPackaged) {
      throw new Error("开发模式不注册开机启动；请在安装版中启用");
    }
    if (process.platform === "linux") {
      await this.#applyLinux(enabled);
      return;
    }
    if (process.platform === "win32") {
      const executableName = path.basename(process.execPath);
      const squirrelStub = path.resolve(
        path.dirname(process.execPath),
        "..",
        executableName
      );
      app.setLoginItemSettings({
        openAtLogin: enabled,
        openAsHidden: startHidden,
        path: existsSync(squirrelStub) ? squirrelStub : process.execPath,
        args: [LOGIN_ARGUMENT]
      });
      return;
    }
    app.setLoginItemSettings({
      openAtLogin: enabled,
      type: "mainAppService"
    });
  }

  async #applyLinux(enabled: boolean): Promise<void> {
    const directory = path.join(app.getPath("appData"), "autostart");
    const target = path.join(directory, "draw-guess.desktop");
    if (!enabled) {
      await rm(target, { force: true });
      return;
    }
    await mkdir(directory, { recursive: true });
    const temporary = `${target}.${String(process.pid)}.tmp`;
    await writeFile(temporary, linuxAutostartEntry(process.execPath), {
      encoding: "utf8",
      mode: 0o600
    });
    try {
      await rename(temporary, target);
    } catch {
      await rm(target, { force: true });
      await rename(temporary, target);
    }
  }
}
