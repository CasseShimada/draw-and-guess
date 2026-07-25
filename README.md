# 画猜现场

“画猜现场”是一个自带窗口/屏幕采集与房主服务的跨平台桌面派对游戏。0.5.0 提供
三种玩法：

- 经典你画我猜：轮流画、猜词、计分；
- 参考图临摹：全员同时根据参考图绘制，结束后匿名点赞并展示作品；
- 绘画接龙：按随机顺序看图猜词再绘制，结束后回看完整传递过程。

玩家仍在 Photoshop、Clip Studio Paint、Krita 或其它外部绘图软件中作画。应用负责
选择来源、裁切、编码、服务器权威计时与展示，不提供内置画板。

```text
外部绘图软件
  → 桌面应用中的来源选择、实时预览与归一化裁切
  → WebP/JPEG 自适应编码（网络上传最多 1 FPS）
  → 协议 v4 WSS 二进制帧
  → 服务器验收、latest-only 保存与本人展示预览
  → 按当前模式决定观看、匿名投票、私密交接或主机本地回放
```

## 安装与启动

从发布页下载当前系统的安装包：

- Windows：`DrawGuessSetup.exe`；
- macOS：`.dmg` 或 `.zip`；
- Linux：`.deb`、`.rpm` 或 `.zip`。

安装后从系统应用列表启动“画猜现场”。无签名开发构建可能触发 Windows SmartScreen、
macOS Gatekeeper 或 Linux 软件源提示；正式发布应使用项目方的签名/notarization
凭据。最终玩家不需要安装 Node.js、pnpm、OBS 或采集代理，也不需要打开终端。

首次启动：

1. 房主选择固定端口和“仅本机”或“局域网 / 可做端口转发”后启动房间服务；
2. 玩家在加入页填写服务器地址 / IP、端口、安全性、房间码、昵称和密码；
3. 打开“采集”，选择外部绘图窗口，调整裁切框并确认；
4. 在大厅选择玩法，并按页面提示完成参考图、词库或回放设置。

## 三种玩法

### 经典你画我猜

画手从三个词中选择一个，其他玩家观看服务器验收后的最新画面并猜词。计分、回合数
和最终排行保持经典规则。浏览器玩家可以猜词，但只有已确认采集来源的桌面玩家会
进入画手队列。

### 参考图临摹

房主上传静态 PNG/JPEG/WebP 并设置 1–10,800 秒的精确绘制时间。所有桌面参与者
预加载同一参考图、同步开始并各自上传私密作品。主动完成或到时后有固定 10 秒展示
收尾；所有人结束后进入匿名多选点赞，最高票作品共同获胜。参考图和作品只在房间
内存中，切换模式或清理房间即释放。

详见 [参考图临摹模式](docs/reference-copy-mode.md)。

### 绘画接龙

服务器冻结随机玩家顺序。第一人看起始词作画，下一人只看画面猜词，再依据自己的
猜词作画；最后一人只猜不画。进行中不会把起始词、猜词或未授权画面泄漏给后续
玩家，结果阶段才公开完整链。

接龙必须由实际主机在本机配置 FFmpeg 和可写目录，并由所有参与者确认本地记录。
最终 MP4 只留在主机文件夹，不经 HTTP、局域网或隧道自动分发。应用不捆绑、下载或
安装 FFmpeg。详见 [绘画接龙模式](docs/draw-relay-mode.md) 和
[主机回放与 FFmpeg](docs/replay-ffmpeg.md)。

## 暂停、Pass 与展示收尾

只有启动内嵌服务的 Electron 实际主机可以暂停/恢复；转移后的逻辑房主或远程客户端
无法伪造这个能力。暂停会冻结权威计时、撤销全部上传授权并停止图片离开客户端。
恢复时先经过三秒采集准备期，再以新的 capture session 继续精确剩余时间。

逻辑房主可以在任何 phase 切换模式，也可代当前 actor Pass。模式切换会取消旧 timer、
授权、帧和私密状态；接龙未完成时必须明确选择保存部分回放、丢弃或取消切换。

所有绘制步骤在主计时结束或点击完成后进入固定 10 秒展示收尾。画手继续调整外部
软件并查看服务器实际接受的本人画面；收尾 Pass 会立即采用最后 accepted frame。
详见 [游戏模式架构](docs/game-modes.md) 与
[服务器展示预览和收尾](docs/drawing-finalization.md)。

## 联机与采集

### 本机、局域网和远程房间

内置服务默认以固定端口只监听 `127.0.0.1`。房主选择“局域网 / 可做端口转发”后，
实际 socket 才监听 `0.0.0.0:<端口>`；界面显示带网卡名称、IPv4 和 CIDR 的地址列表，
由房主明确选择分享哪一个。`0.0.0.0` 只是监听诊断地址，不能发给玩家。

桌面玩家像连接 Minecraft 服务器一样，在加入页直接填写“服务器地址 / IP + 端口 +
HTTP/WS 或 HTTPS/WSS”，并可先做无凭据连接预检。浏览器玩家手动打开房主提供的
`http(s)://主机:端口`，再输入房间码、昵称和密码。应用不使用外部自定义协议、
房间 query 或包含密码的链接。

跨公网时，SakuraFrp 或其它隧道只需把一个公网 TCP 入口转发到房主同一个本地端口；
HTTP API、网页、WebSocket、控制消息和图片帧全部复用该端口。外部端口可以与本地
端口不同。公网优先使用 HTTPS/WSS；原始 TCP 的公网 HTTP/WS 必须由玩家明确确认
明文风险，应用不会忽略证书错误或从 HTTPS 静默降级。

应用不会下载、启动、登录或管理 SakuraFrp，也不会保存隧道 token。它同样不会自动
修改防火墙、配置路由器、执行 UPnP/NAT-PMP 或承诺公网可达。完整拓扑、操作步骤和
排障见 [网络联机与端口转发](docs/network-connectivity.md)。

### 选择、裁切与停止共享

- 预览流在确认前不会上传；
- 裁切框使用 `0..1` 归一化坐标，适配 DPI 和窗口尺寸变化；
- 裁切预设只保存不可逆来源指纹和坐标，不保存截图；
- 只有服务器发放当前 session grant 后才开始最多 1 FPS 的上传；
- 暂停使用 `capture:stop-upload`，可以保留来源和纯本地预览；
- 回合结束、断线、来源关闭或点击停止会释放编码/上传循环；
- 悬浮条、托盘与 `CommandOrControl+Shift+S` 共享同一个幂等停止动作；
- 应用重启后始终为“未共享”，绝不自动恢复屏幕采集。

## 平台权限

| 系统          | 行为 |
| ------------- | ---- |
| Windows       | 使用 Chromium/Electron 的窗口与显示器采集，通常没有独立权限页。 |
| macOS         | 首次选择来源会请求屏幕录制权限；拒绝后需在系统设置授权并重启。 |
| Linux X11     | 枚举窗口与显示器来源。 |
| Linux Wayland | 使用 xdg-desktop-portal/PipeWire；取消门户会停止共享。 |

设置页可重新检查权限，并提供默认关闭的开机启动、最小化到托盘和固定事件通知选项。

## 词库、头像与本地主题

词库按“包 → 分类 → 词条”组织，支持别名、难度、启用状态、批量粘贴和
`.drawguess-words.json` 导入/导出。房主在大厅选择词池；开局时服务器冻结规范化
deck。普通快照只公开包名、分类名和数量。详见 [词库包](docs/word-packs.md)。

头像源文件及规范化 256×256 RGBA PNG 长期只存当前客户端；房间服务器只在内存中
暂存规范化副本，并按 revision/ETag 提供认证读取。详见 [头像](docs/avatars.md)。

Electron 可以导入本地 `.css` 及 allowlist 中的相对 PNG/字体素材。导入器使用 AST
校验、realpath 边界与只读 `drawguess-theme:` 协议；安全控件不受主题影响。
浏览器版始终使用默认主题。详见 [自定义 CSS](docs/custom-css.md)。

## 隐私与安全

- Renderer 只加载安装包内资源；所有窗口启用 sandbox、`contextIsolation` 并禁用
  Node integration。
- IPC 双向使用严格 schema；主进程验证 sender。会话 token 留在 main，安全存储
  可用时使用 Electron `safeStorage`。
- 浏览器入口使用 `HttpOnly; SameSite=Lax` Cookie；协议版本不匹配在 HTTP/
  WebSocket upgrade 边界以 426 明确拒绝。
- `/api/connection-info` 是固定大小、`no-store`、不含房间状态的无凭据预检端点；
  桌面主进程限制响应大小、拒绝重定向并区分 DNS、拒绝连接、超时、TLS、错误服务和
  协议不兼容。
- 服务端联合验证房间、玩家、socket、客户端类型、mode、`modeSessionId`、
  `actorStepId`、`captureSessionId`、授权期限、sequence、图片魔数、2 MiB 与帧频。
- 经典/临摹只在内存中保存 latest accepted frame。接龙仅在所有玩家确认后，把
  accepted frame 写入实际主机受配额保护的临时 job。
- 私密题目、猜词、参考图 revision、匿名 ballot 映射、图片 bytes、回放 manifest
  和本地路径不进入无权查看者的普通快照。
- 日志轮转并遮盖 Authorization、Cookie、密码、token、答案和 URL 查询秘密，不
  记录图片、manifest、参考图或题目内容。

协议版本为 `4`。图片二进制头沿用固定宽度，但字段语义统一为 capture session：

```text
上行：captureSessionId UInt32BE + encoded JPEG/WebP
下行：captureSessionId UInt32BE + frameSequence UInt32BE + encoded JPEG/WebP
```

## 浏览器兼容入口

内置和独立服务器都提供 React 浏览器页面。浏览器玩家可以创建/加入房间、担任逻辑
房主、管理大厅、聊天和参与经典猜词，但不能宣称桌面采集能力。参考图临摹要求所有
参与者具备桌面采集；绘画接龙还要求实际主机 FFmpeg 回放能力，因此完整玩法推荐
所有玩家安装桌面版。

## 开发与验证

开发要求 Node.js 24+；仓库固定 pnpm 11 并通过 Corepack 调用：

```powershell
corepack pnpm install
corepack pnpm check
corepack pnpm desktop:dev
```

常用命令：

```text
pnpm dev              构建共享包并启动 Electron 开发模式
pnpm dev:web          开发浏览器入口与独立服务器
pnpm build            构建共享包、Web、服务器和桌面资源
pnpm check            lint + 类型检查 + 自动化测试 + 完整构建
pnpm desktop:package  生成当前平台的未安装应用目录
pnpm desktop:make     生成安装包并写出 SHA-256 校验和
pnpm desktop:smoke    实际启动打包应用并验证本地资源和内置服务
```

Windows 产物位于 `apps/desktop/out/make/`。`out/`、临时回放、MP4、FFmpeg
二进制、签名文件和环境秘密均被 gitignore。无签名构建会包含
`UNSIGNED-BUILD.txt`。签名/公证只从 CI secret 注入。

独立公网服务：

```powershell
corepack pnpm build
corepack pnpm --filter @draw-guess/server start
```

生产部署应设置实际 `ALLOWED_ORIGINS` 与 `COOKIE_SECURE=true`。需要信任代理转发头
时还必须把精确来源 IP 写入 `TRUSTED_PROXY_ADDRESSES`，不得信任任意远程来源。
接龙只有在部署者显式配置本地 FFmpeg、临时目录和输出目录时可用。

## 仓库结构

```text
apps/
  desktop/       Electron main/preload/Renderer、内嵌服务控制、Forge 与冒烟测试
  server/        Fastify/ws、模式 registry/controller、scheduler、回放服务
  web/           浏览器兼容客户端与 mode registry
packages/
  capture-core/  来源、裁切、自适应编码、latest-only 队列与采集循环
  content/       词库、头像 schema、规范化和本地存储接口
  protocol/      协议 v4 schema、消息与二进制帧编解码
  shared-types/  判别式公开快照、模式/phase/运行控制类型
  game-rules/    公共计时常量、计分和纯规则函数
docs/
  game-modes.md                       三模式 registry、状态图、Pass 与清理
  reference-copy-mode.md              临摹、收尾、匿名盲选与并列获胜
  draw-relay-mode.md                  接龙私密流程、Pass、结果与部分回放
  replay-ffmpeg.md                    FFmpeg 探测、目录、配额、压制与隐私
  drawing-finalization.md             服务器展示预览、十秒收尾与通知
  network-connectivity.md             地址/端口加入、局域网、防火墙与公网转发
  standalone-upgrade-architecture.md  当前桌面架构与信任边界
```

自动化测试覆盖 v4 schema/426、连接目标解析、设置 v5 迁移、精确端口绑定、连接预检、
单端口 TCP/反向代理、三模式状态机、模式切换、Pass、fake-clock 暂停、
新 capture session、并发 latest frame、参考图规范化/隐私、匿名 ballot、接龙私密
交接、FFmpeg fake runner、回放配额/时间线/路径边界/恢复、设置迁移、IPC、采集、
内容存储和 Electron 安全边界。发布证据记录在
`docs/release-verification-0.5.0.md`；没有实机运行的平台或双机网络矩阵不会标记为
已验证。
