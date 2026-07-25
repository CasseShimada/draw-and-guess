import path from "node:path";

import { MakerDeb } from "@electron-forge/maker-deb";
import { MakerDMG } from "@electron-forge/maker-dmg";
import { MakerRpm } from "@electron-forge/maker-rpm";
import { MakerSquirrel } from "@electron-forge/maker-squirrel";
import { MakerZIP } from "@electron-forge/maker-zip";
import { FusesPlugin } from "@electron-forge/plugin-fuses";
import type { ForgeConfig } from "@electron-forge/shared-types";
import { FuseV1Options, FuseVersion } from "@electron/fuses";

const assets = path.resolve(import.meta.dirname, "assets");
const windowsCertificateFile = process.env.WINDOWS_CERTIFICATE_FILE;
const windowsCertificatePassword = process.env.WINDOWS_CERTIFICATE_PASSWORD;
const appleId = process.env.APPLE_ID;
const appleIdPassword = process.env.APPLE_APP_SPECIFIC_PASSWORD;
const appleTeamId = process.env.APPLE_TEAM_ID;

const config: ForgeConfig = {
  packagerConfig: {
    asar: {
      unpack: "**/node_modules/@img/sharp-*/**/*"
    },
    executableName: "draw-guess",
    icon: path.join(assets, "icon"),
    appBundleId: "com.drawguess.desktop",
    appCategoryType: "public.app-category.games",
    extendInfo: {
      NSScreenCaptureUsageDescription:
        "画猜现场需要在你明确选择后预览并采集外部绘图窗口或屏幕区域。"
    },
    ignore: [
      /^\/node_modules(?:\/|$)/,
      /^\/e2e(?:\/|$)/,
      /^\/src(?:\/|$)/,
      /^\/scripts(?:\/|$)/,
      /^\/out(?:\/|$)/,
      /^\/(?:forge|tsup\.main|tsup\.preload|vite)\.config\.ts$/,
      /^\/tsconfig\.json$/,
      /^\/index\.html$/
    ],
    win32metadata: {
      CompanyName: "Draw Guess Contributors",
      FileDescription: "画猜现场",
      InternalName: "draw-guess",
      OriginalFilename: "draw-guess.exe",
      ProductName: "画猜现场"
    },
    ...(process.env.APPLE_SIGN_IDENTITY
      ? {
          osxSign: {
            identity: process.env.APPLE_SIGN_IDENTITY
          }
        }
      : {}),
    ...(appleId && appleIdPassword && appleTeamId
      ? {
          osxNotarize: {
            appleId,
            appleIdPassword,
            teamId: appleTeamId
          }
        }
      : {})
  },
  rebuildConfig: {},
  makers: [
    new MakerSquirrel({
      name: "draw_guess",
      setupExe: "DrawGuessSetup.exe",
      setupIcon: path.join(assets, "icon.ico"),
      ...(windowsCertificateFile && windowsCertificatePassword
        ? {
            certificateFile: windowsCertificateFile,
            certificatePassword: windowsCertificatePassword
          }
        : {})
    }),
    new MakerZIP({}, ["darwin", "linux", "win32"]),
    new MakerDMG({
      icon: path.join(assets, "icon.icns"),
      format: "ULFO"
    }),
    new MakerDeb({
      options: {
        name: "draw-guess",
        productName: "画猜现场",
        genericName: "Drawing Guessing Game",
        description: "自带窗口采集和房主服务的跨平台你画我猜桌面应用",
        productDescription:
          "选择外部绘图窗口，裁切画布，并与本机、局域网或远程房间中的玩家一起游戏。",
        section: "games",
        priority: "optional",
        maintainer: "Draw Guess Contributors",
        bin: "draw-guess",
        icon: path.join(assets, "icon.png"),
        categories: ["Game"]
      }
    }),
    new MakerRpm({
      options: {
        name: "draw-guess",
        productName: "画猜现场",
        genericName: "Drawing Guessing Game",
        description: "自带窗口采集和房主服务的跨平台你画我猜桌面应用",
        productDescription:
          "选择外部绘图窗口，裁切画布，并与本机、局域网或远程房间中的玩家一起游戏。",
        license: "Proprietary",
        group: "Amusements/Games",
        bin: "draw-guess",
        icon: path.join(assets, "icon.png"),
        categories: ["Game"]
      }
    })
  ],
  plugins: [
    new FusesPlugin({
      version: FuseVersion.V1,
      [FuseV1Options.RunAsNode]: false,
      [FuseV1Options.EnableCookieEncryption]: true,
      [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
      [FuseV1Options.EnableNodeCliInspectArguments]: false,
      [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
      [FuseV1Options.OnlyLoadAppFromAsar]: true,
      [FuseV1Options.GrantFileProtocolExtraPrivileges]: false
    })
  ]
};

export default config;
