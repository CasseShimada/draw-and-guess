# 0.5.0 发布验证记录

验证时间：2026-07-26 04:30:43 +08:00
验证分支：`develop`
协议版本：`4`
应用版本：`0.5.0`
桌面设置 schema：`5`

## 验证环境

| 项目 | 值 |
| --- | --- |
| 操作系统 | Microsoft Windows 11 Pro 64-bit |
| 系统版本 | 10.0.26200（Build 26200） |
| Node.js | v24.18.0 |
| pnpm | 11.17.0（经 Corepack） |
| 桌面目标 | Windows x64 |
| 签名状态 | 未签名开发构建 |

本记录只把 Windows x64 上的自动化检查、构建和打包应用 smoke 标记为已验证。
macOS、Linux、Windows arm64、真实双设备局域网、真实跨公网隧道以及各平台签名/
公证流程没有在本轮环境中执行，不能从本记录推断为已通过。

## 自动化与构建结果

| 命令 | 结果 | 覆盖内容 |
| --- | --- | --- |
| `corepack pnpm check` | 通过 | Prettier、ESLint、8 个工作区类型检查、42 个测试文件中的 164 个测试、完整构建 |
| `corepack pnpm desktop:package` | 通过 | Forge Windows x64 未安装应用目录；产品和文件版本均为 0.5.0 |
| `corepack pnpm desktop:make` | 通过 | Squirrel 安装器、NUPKG、RELEASES、ZIP 和 SHA-256 清单 |
| `corepack pnpm desktop:smoke` | 通过 | 实际启动打包后的 Electron 应用，检查 Renderer、连接信息端点、网络入口、资源和内嵌服务 |

打包应用 smoke 使用的实际可执行文件为
`apps/desktop/out/画猜现场-win32-x64/draw-guess.exe`。它确认：

- Renderer 中 `process` 和 `require` 均为 `undefined`，预加载 bridge 可用；
- `drawguess-app:` 只读应用资源协议仍可用；
- 内嵌服务按请求在 `127.0.0.1:32100` 精确启动，没有端口回退；
- `/api/connection-info` 返回应用版本 `0.5.0`、协议版本 `4` 和本次服务实例 ID；
- IPC 状态、预检端点和连接信息中的服务实例 ID 一致；
- 浏览器入口返回 200，桌面创建房间返回 201 并签发独立 session；
- 地址是普通文本输入，端口是数字输入，安全性和两种绑定模式控件存在；
- 外部邀请 bridge 不存在；
- 本地主题资源在打包运行时可加载。

## 网络自动化覆盖

| 场景 | 结果 | 说明 |
| --- | --- | --- |
| 连接目标解析 | 通过 | 覆盖 IPv4、DNS、`.local`、裸主机、端口、HTTP(S)、冲突、非法路径/凭据和 IPv6 明确拒绝 |
| 设置迁移 | 通过 | schema 4 到 5 确定性迁移，保留非网络设置，凭据按 origin 隔离 |
| 精确端口与绑定 | 通过 | 端口占用明确失败；loopback 与 `0.0.0.0` LAN bind；运行中修改要求显式重启 |
| 无凭据预检 | 通过 | 4 秒超时、16 KiB 上限、禁止重定向、严格 schema、错误分类、协议不匹配和 TLS 不降级 |
| 切换服务器隔离 | 通过 | 旧 REST、WebSocket、定时器和 token 被主动取消或清除，旧响应不能污染新目标 |
| LAN Origin | 通过 | 浏览器同源连接与桌面 Bearer WebSocket 路径均由自动化覆盖 |
| 单端口 TCP 转发模拟 | 通过 | 外部端口与本地端口不同；创建/加入、浏览器和桌面 WebSocket、聊天、二进制采集帧均通过 |
| 可信 HTTPS 终止代理模拟 | 通过 | 只接受精确可信代理来源和精确允许 Origin；Secure/HttpOnly Cookie 与 WebSocket 升级通过 |
| 邀请入口移除 | 通过 | 当前源码、运行时包和 99 个 `app.asar` 文本文件中均未发现外部邀请 URI、房间查询邀请或协议注册 |

上表中的 TCP 转发和 HTTPS 终止是受控的本机集成测试，用于验证应用边界；它们不等同
于真实 SakuraFrp 节点、运营商网络、路由器、防火墙或不同物理设备的实机验证。

## 实机网络矩阵

| 场景 | 状态 | 本轮结论 |
| --- | --- | --- |
| Windows 本机 loopback、打包应用 | 已执行，通过 | `127.0.0.1:32100`、连接信息、创建房间和浏览器入口通过 |
| 两台物理设备，同一局域网 | 未执行 | 待在真实网卡、系统防火墙和第二台设备上验证 |
| 不同网络，经真实 SakuraFrp TCP 隧道 | 未执行 | 待用真实外部主机名/端口及远端客户端验证 |
| 真实受信任证书的 HTTPS/WSS 终止 | 未执行 | 本轮仅完成受控反向代理模拟 |
| Windows 防火墙设置入口 | 未人工执行 | 自动化只验证 Renderer 不能传入任意 shell 目标 |
| macOS / Linux | 未执行 | 待对应平台构建、权限、绑定和网络实机矩阵 |

因此，本轮没有声称“真实双机 LAN”或“真实公网 SakuraFrp”已经通过。发布前应至少补做
一次双设备局域网创建/加入/重连，以及一次不同网络下的公网 TCP 或 HTTPS/WSS 全流程。

## 产物与校验和

| 产物 | 字节 | MiB | SHA-256 |
| --- | ---: | ---: | --- |
| `make/UNSIGNED-BUILD.txt` | 199 | <0.01 | `82006b019d3eab68799faa7ee5824f6c3591d453191923d457c75acca107dd8d` |
| `make/squirrel.windows/x64/DrawGuessSetup.exe` | 149,349,376 | 142.43 | `6927aa12635b56ab24f4f4ee7df60f1f15410fe3301e5b39526fc7acbd7da604` |
| `make/squirrel.windows/x64/draw_guess-0.5.0-full.nupkg` | 148,578,652 | 141.70 | `d68ca8727de2a7649e1790ebf2a22f7a0a5854595f7676b9aac046148143b3b2` |
| `make/squirrel.windows/x64/RELEASES` | 81 | <0.01 | `9b2b5d9ed832841c8ec28f2415866676b248e3eb73062d72d9dc377c2d481da6` |
| `make/zip/win32/x64/画猜现场-win32-x64-0.5.0.zip` | 154,068,998 | 146.93 | `77a4d38935407b621e50be33871a26c94b32540f89501ebe30d5e4997b6ac7bb` |

未安装应用目录中的 `draw-guess.exe` 为 225,613,824 字节（215.16 MiB），
SHA-256 为
`c587315af0d006d980b5438cb15945ba4b399be8001e0e3e9156851210a99551`。
`resources/app.asar` 为 8,197,311 字节（7.82 MiB），SHA-256 为
`05dd661867d4f47b96605a2de41f1a53da4a34e2f9dda2990bb0d01dadda16d1`。

## 归档和遗留入口审计

最终 NUPKG 包含 102 个 ZIP entry，最终便携 ZIP 包含 82 个 entry。两者均未发现：

- `.env`、PEM/P12/PFX 签名材料；
- 测试、e2e、源码目录或 `.partial.mp4`；
- 独立 `ffmpeg`/`ffprobe` 可执行文件、下载器或临时回放输出。

两个归档各包含一份 Electron/Chromium 预期的 `ffmpeg.dll`。它不是应用用于接龙压制的
外部 FFmpeg 程序；应用仍只调用房主明确配置或 PATH 中探测到的外部 FFmpeg。

`app.asar` 共 141 个 entry，未发现源码目录、测试/spec 或 `deep-link` 文件。对其中
99 个 JS/JSON/HTML/CSS 文件的文本审计未发现：

- 已删除的外部自定义邀请 URI；
- 已删除的房间查询参数邀请；
- 操作系统邀请协议注册 API、旧邀请 DTO 字段或旧邀请事件字段。

内部 `drawguess-app:` 资源协议按设计保留，它只用于加载本地应用资源，不是外部邀请或
操作系统 URL scheme。当前源码的 Forge 配置和主进程同样没有外部协议注册。

## 发布限制

这些文件是明确标记的未签名构建。正式发布前仍需：

1. 使用受控 CI secret 完成 Windows 代码签名；
2. 在 macOS 完成签名与 notarization，在 Linux 完成目标发行版打包验证；
3. 补做真实双设备 LAN、真实跨公网隧道和真实 HTTPS/WSS 证书链测试；
4. 验证 Windows/macOS/Linux 防火墙与网络权限提示；
5. 不把本记录中的本机代理模拟外推为任意第三方隧道服务已经通过。
