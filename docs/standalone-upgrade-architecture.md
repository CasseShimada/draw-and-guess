# 独立桌面版升级架构

状态：`0.5.9` 实施架构，游戏协议版本仍为 `5`，主题 API 版本为 `1`。本文描述当前独立桌面版、三模式框架、实际
主机控制和内容安全边界；OBS/Capture Agent 与协议 v1–v3 仅是历史版本。

## 产品边界

画手继续使用 Photoshop、Clip Studio Paint、Krita、浏览器画板或其它外部绘图
软件。应用负责来源选择、预览、裁切、编码、服务器展示预览和游戏交互，不提供
画板、画笔、笔画同步或音频。

经典与临摹帧只在房间内存中 latest-only 保存。绘画接龙在所有玩家确认后，可以把
服务器实际接受的帧写入实际主机受配额保护的临时 job，并压制为本地 MP4。应用不
捆绑或下载 FFmpeg，也不自动分发回放。

最终用户只安装一个 Electron 应用。应用可以在固定单端口上启动本机/局域网 Fastify
服务，也可以按主机/IP、端口和 HTTP(S) 安全性连接远程入口。SakuraFrp 等工具只在
应用之外转发这个 TCP 端口；NAT 穿透、路由器映射和云中继不是应用能凭空提供的能力。

## 进程与信任边界

```text
外部绘图窗口
  │ OS / Chromium 屏幕采集（用户明确选择）
  ▼
沙箱 Renderer
  ├─ 实时预览、归一化裁切和 Canvas 编码
  ├─ mode registry 渲染三种玩法
  ├─ 不持有会话 token、文件系统能力、主机密钥或 FFmpeg 路径
  └─ 只通过 preload 的窄接口提交已编码图片和固定命令
        │ Zod 校验的 contextBridge API
        ▼
Electron Main（实际主机边界）
  ├─ safeStorage 会话、设置与脱敏日志
  ├─ HTTP/WebSocket transport、自动重连和桌面身份
  ├─ desktopCapturer、权限、托盘、快捷键与固定通知
  ├─ 原生文件/目录选择器和本地回放文件打开
  ├─ 不可远程伪造的 pause/resume hostControlKey
  └─ 可选进程内 Fastify 服务
        │ 所有远端消息仍不可信
        ▼
中心服务器
  ├─ 房间、玩家、会话、聊天、头像与逻辑房主
  ├─ mode registry/controller、权威 scheduler 与 Pass coordinator
  ├─ grant、finalization、latest frame 和私密资产接口
  └─ 实际主机本地 ReplayService → FFmpeg 子进程 → 本地 MP4
```

“逻辑房主”可以转移并负责游戏设置、代 Pass 和模式切换；“实际主机”是启动内嵌服务
的 Electron main。只有后者持有暂停/恢复、FFmpeg 设置和本地回放文件能力。

所有 BrowserWindow 使用：

```ts
{
  nodeIntegration: false,
  contextIsolation: true,
  sandbox: true,
  webSecurity: true
}
```

应用在创建窗口前调用 `app.enableSandbox()`。生产 Renderer 只从
`drawguess-app://app/` 加载打包资源。主进程拒绝任意导航、新窗口、`webview` 与
不可信 IPC sender；外部链接只允许显式 HTTPS allowlist。

## 工作区模块

```text
apps/
  server/
    src/modes/                game-mode 接口、registry 与三个 controller
    src/services/             scheduler、grant、Pass、frame、finalization、replay
    src/game-service.ts       房间/会话/连接与公共服务编排
    src/server.ts             buildServer/startServer 可编程入口
  web/
    src/modes/                mode registry、共用组件与三个模式视图
  desktop/
    src/main/                 Electron 生命周期、实际主机控制和有权限服务
    src/preload/              最小、具名、校验后的 contextBridge
    src/renderer/             桌面壳、采集工作台与共享游戏 UI
    src/shared/               IPC schema、连接目标解析和无秘密连接信息 DTO
packages/
  content/                    词库/头像 schema、规范化、deck 与存储接口
  capture-core/               裁切、编码、busy/epoch 和 latest-only 队列
  protocol/                   v4 JSON/binary schema、426 与图片魔数
  shared-types/               模式/phase/settings/快照判别联合
  game-rules/                 公共时长、计分、匹配与纯规则函数
```

浏览器与桌面复用相同 React 模式组件，但由两种 transport 驱动：

- `BrowserTransport` 使用同源 fetch、HttpOnly Cookie 与浏览器 WebSocket；
- `DesktopMainTransport` 通过 preload 调用 main，Bearer 会话和重连状态不进入
  Renderer。

桌面 Renderer 不加载远程 HTML/JavaScript。加入页把地址、端口和安全模式作为严格
IPC DTO 交给 main；REST origin 与 WebSocket origin 由同一个规范化目标派生。

## 模式运行时

房间玩法状态和公开快照均为判别联合：

```ts
type RoomModeRuntime =
  | { mode: "classic"; state: ClassicModeState }
  | { mode: "reference-copy"; state: ReferenceCopyModeState }
  | { mode: "draw-relay"; state: DrawRelayModeState };
```

每个 controller 负责自己的设置、phase、私密数据、公开快照、帧接收、Pass 归约和
清理。`GameService` 不承载具体玩法状态机。新增模式必须静态注册；未知模式在 schema
边界和 registry 启动时失败。

每次模式切换递增 `modeSessionId`。每个可行动步骤有随机 `actorStepId`；每次允许
上传的绘制或收尾有新的 UInt32 `captureSessionId`。命令 envelope 和资源接口绑定
这些标识，旧 timer、命令、资产 URL 和帧不能跨模式或跨步骤复用。

逻辑房主可以在任意 phase 发起切换。服务器在一个提交边界内：

1. 撤销全部上传 grant 并停止 drain；
2. 冻结旧模式，取消所有 scheduler timer；
3. 按房主选择保存或丢弃未完成接龙回放；
4. 幂等 dispose controller 并释放私密状态；
5. 递增 mode session，创建目标模式 lobby；
6. 只广播目标模式快照。

玩家、房间密码、头像、聊天、会话和逻辑房主保留；题目、猜词、参考图、作品、
ballot、ready、帧和授权全部失效。

## Scheduler、暂停与恢复

每个房间拥有一个 `ModeScheduler`。timer 以稳定 key 注册，回调执行前再次验证房间、
mode、mode session、actor step 与 phase。暂停保存精确剩余毫秒而不是创建新 phase：

```text
runControl: running → paused → running
```

暂停 IPC 由 Electron main 使用内嵌服务启动时生成的 `hostControlKey` 调用；WebSocket
协议不存在远程 pause/resume 命令。暂停原子撤销 grant、清空 pending drain、发送
`capture:stop-upload` 并冻结所有 timer。

恢复把 deadline 按暂停墙钟时间平移。需要采集的 phase 先执行统一三秒恢复期，再
生成新的 capture session；暂停前的帧即使延迟到达也会拒绝。暂停期间普通玩家 Pass
拒绝，逻辑房主可以代当前 actor Pass；新建步骤仍保持冻结到实际主机恢复。

## 公共绘制与 Pass

所有绘制步骤共享：

```text
DRAWING
  ├─ deadline
  └─ drawing:finish
        ↓
FINALIZING（固定 10 秒，新 captureSessionId）
        ↓
冻结 latest accepted frame
```

进入收尾时保留最后 accepted frame 作为 baseline，收尾新帧可以覆盖；没有新帧就
采用 baseline。上传者收到服务器实际接受的相同 bytes、sequence 和 revision。
经典可以向观众转发；临摹与接龙只回送本人。

所有 `turn:pass` 由公共 coordinator 检查 command ID、mode session、actor step、
target、本人/房主权限和暂停规则，再交给 controller：

- 经典选词/绘制 Pass 保持候选、答案和已结算猜词集合不变地交接；
- 临摹主绘制 Pass 只退出本人投稿，盲选 Pass 保留已有点赞；
- 接龙主阶段 Pass 把收到的不可变输入原样交给下一人，绝不提交草稿或未完成画；
- 任意模式收尾 Pass 立即采用当前 accepted baseline。

命令 ID 在房间内做有界 TTL 去重。连续 Pass 单向推进，每个 actor step 最多一次，
最后一人/全员 Pass 必须到达确定结果。

## 协议 v5 与内容所有权

HTTP 与 WebSocket 都要求协议版本 5。不匹配的 upgrade 返回 HTTP 426、当前版本 header
和结构化错误；旧 v4 payload 不做含糊兼容。v5 的 `game:restart` 把同模式设置更新、
旧局清理、`modeSessionId` 轮换和新局启动收敛为一个带 `commandId` 的原子命令。

二进制帧保持四/八字节头宽，但字段从经典专用 `turnId` 提升为通用 session：

```text
上行：UInt32BE captureSessionId + encoded JPEG/WebP
下行：UInt32BE captureSessionId + UInt32BE sequence + encoded JPEG/WebP
```

授权联合绑定：

```text
roomCode
+ playerId
+ authenticated socket identity
+ clientKind === desktop
+ captureReady
+ mode
+ modeSessionId
+ actorStepId
+ captureSessionId
+ grant expiry
+ frame rate / byte limit / image magic / monotonic sequence
```

任一项变化都会撤销或拒绝。浏览器 schema 不接受 `capture:ready`，也不能发送二进制
采集帧。连接握手中的客户端类型只是一项约束，服务端仍验证所有字段和内容。

词库、头像、参考图、匿名 ballot、接龙任务和结果画面使用各自认证接口：

- 完整词池、别名与 deck 不在普通快照中；
- 头像按玩家/revision/ETag 读取；
- 临摹大厅只有房主可读参考图 revision，开局后只对冻结参与者开放；
- ballot item ID 对每位 voter 随机化，作者到画廊才公开；
- 接龙私密任务绑定 viewer/actor step，结果前不公开历史；
- 最终 MP4 没有 HTTP 路由。

普通 WebSocket JSON 上限仍为 16 KiB；图片不编码成 JSON Base64。

## 参考图与回放资产

参考图仅接受静态 PNG/JPEG/WebP。客户端做初步检查，服务器再验证 MIME/魔数、动画、
尺寸、像素与字节限制，经 Sharp 修正方向、剥离元数据并规范化。资产只在当前临摹
runtime 的内存中，替换/删除/切换/销毁都释放。

ReplayService 只记录 accepted JPEG/WebP。临时 job 有 UUID 根、manifest、有界写队列、
单 job/全局/磁盘三层配额和扣除暂停的 active timeline。所有路径操作验证 realpath、
普通文件类型与直接子目录边界，拒绝 symlink/junction。

FFmpeg 通过配置路径或 PATH 探测，`shell: false`，优先 libx264、回退 mpeg4。输出先
写随机 `.partial.mp4`，成功校验后原子改名；失败删除 partial 并保留可重试 job。
启动时只恢复 schema 合法且仍位于临时根内的 manifest。

## 网络目标、监听和预检

桌面设置 schema 为 `5`，把原先混杂的 URL 拆成房主期望端口、绑定模式、首选分享
网卡、当前客户端目标、最多八条最近成功连接、可选公网展示入口和 endpoint 绑定的
公网明文确认。schema 4 的 `hostPort`、`allowLan` 和合法 `serverUrl` 确定性迁移；
裁切、通知、主题、头像、FFmpeg 和回放设置保持不变。会话继续按规范化 origin 加密
隔离。

房主选择：

```text
loopback-only → 127.0.0.1:<固定端口>
lan           → 0.0.0.0:<固定端口>
```

桌面房主流程不搜索后续端口。端口占用会失败；运行中修改表单只形成草稿，必须确认
“重启服务以应用”，主进程状态才改变。权威状态包含实际 bind host/port、随机
`serverInstanceId`、loopback origin，以及网卡名称、IPv4、netmask/CIDR 和推荐标签。
房主自身始终经 `127.0.0.1:<实际端口>` 连接。

`GET /api/connection-info` 与游戏共用端口，只返回应用版本、协议版本、实例 ID、时间、
WebSocket 路径和桌面/浏览器能力。桌面 main 在 4 秒限制内无凭据请求该端点，拒绝
redirect，限制 16 KiB，校验 JSON content type/schema，并分类 DNS、连接拒绝、超时、
TLS、错误服务、协议不匹配和未确认公网明文。目标 epoch 改变会主动中止旧请求、
WebSocket、heartbeat 和重连 timer，旧响应不能进入新目标状态。

浏览器 WebSocket 继续只接受同源 Origin 或明确配置的精确公网 origin。可信代理地址
需要显式边界；Fastify `trustProxy` 仍为 `false`。只有可信代理提供 HTTPS
`X-Forwarded-*` 且外部 origin 明确允许时才签发 Secure Cookie。

## 本地内容、设置与生命周期

浏览器内容存 IndexedDB。Electron 只通过具名 IPC 操作 `userData/content/v1`、
`userData/profile`、`userData/themes/active` 和版本 6 设置；Renderer 没有任意路径
API。写入采用同目录临时文件与原子替换，旧设置迁移后补齐 FFmpeg、目录、配额和
通知默认值。

默认视觉拆为 Core Safety、Web 默认模板和桌面默认模板；构建时确定性生成可导出的
单文件模板。CSS 导入区分完整替换与覆盖模式，使用 PostCSS AST、selector/value
parser、素材 allowlist 与 realpath 边界，并自动限制到
`[data-ui="theme-root"]`。工作目录保留可编辑 `source.css`、校验后的
`compiled.css`、manifest 和本地素材；重新加载通过临时目录原子替换，失败继续使用
上一份编译结果。

普通游戏和桌面设置 UI 通过稳定 `data-ui` 及页面、模式、阶段、状态、角色和操作属性
开放主题接口。主题根外的 Shadow DOM 安全宿主始终提供禁用、恢复、重新加载和备用
操作；运行时健康检查发现不可替代的画布、参考图或整页失效时，只暂停本客户端 CSS。
共享停止按钮继续位于不注入用户 CSS 的独立置顶窗口。托盘恢复、
`--safe-mode` 与 `--disable-custom-css` 是额外启动前恢复入口。

日志在写入前遮盖密码、Authorization、Cookie、token、题目和 URL 查询秘密；不记录
图片、参考图、回放 manifest 或本地路径。系统通知只接受固定 schema 事件，并按
room/mode session/actor step 去重；焦点窗口中不重复通知。

应用单实例运行。第二次启动只聚焦既有窗口，不注册或处理外部加入协议。内部只读
`drawguess-app:` 资源协议继续服务安装包资源。托盘、悬浮条和快捷键调用同一幂等
停止动作。

## 打包策略

Electron Forge 使用 asar：

- Windows x64：Squirrel Setup + ZIP；
- macOS arm64/x64：DMG + ZIP；
- Linux x64：deb + rpm + ZIP。

主进程/preload 由 tsup 打包，Renderer/Web 由 Vite 打包。Forge 只包含运行时 bundle、
静态资源、元数据与图标；不包含源码、测试、真实 `.env`、回放 job、MP4、FFmpeg/
ffprobe、下载脚本、构建缓存或旧安装产物。签名/notarization 只读取 CI secrets；
无凭据时产物明确标记为 unsigned 测试构建。

## 验证层次

- 纯单元：v5 schema/二进制、设置迁移、规则、裁切/编码、存储、CSS、IPC、日志。
- 模式测试：经典 characterization、临摹并发/匿名投票、接龙私密交接/Pass/超时、
  精确十秒收尾、模式切换与 fake-clock 暂停。
- 服务集成：桌面能力、浏览器伪造拒绝、426、grant/session 失效、图片认证/ETag/
  限流和重连。
- 网络集成：地址解析/迁移、精确 bind、connection-info、错误分类、LAN Origin、
  原始 TCP 单端口代理、可信 HTTPS 终止代理、外部/本地端口不同和图片二进制帧。
- 回放测试：fake process runner、编码器选择、配额、单调时间线、partial 原子保存、
  失败重试、重启恢复与 symlink/junction 越界拒绝。
- Electron 冒烟：实际启动已打包应用，验证本地协议、沙箱、Renderer 无 Node 全局、
  IPC 最小面和内嵌服务健康状态。
- 当前平台发布：`pnpm check`、`pnpm desktop:package`、`pnpm desktop:make`、
  安装包内容审计和实际启动。其它平台只记录 CI/人工矩阵中真正执行的结果。
- 双机 LAN 与不同网络公网隧道必须单独记录；本机回环或进程内代理不能冒充跨设备
  实测。
