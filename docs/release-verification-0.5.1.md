# 0.5.1 热修复验证记录

验证时间：2026-07-26 05:27:30 +08:00
验证分支：`develop`
应用版本：`0.5.1`
协议版本：`4`
桌面设置 schema：`5`

## 修复内容

0.5.0 在桌面应用重启后不会自动恢复内嵌服务，但首页仍默认显示“创建房间”。点击创建
时，Renderer 把上次保存的客户端目标直接交给连接预检，因而会把本机未监听端口错误
描述为“目标机器可达，但该端口没有服务监听”。

0.5.1 将创建本机房间收敛为主进程原子流程：

1. `game:create-room` 不再接收 Renderer 指定的服务器目标或公网明文确认；
2. 主进程检查权威内嵌服务状态；
3. 服务未运行时，按保存的固定端口和绑定模式启动；
4. 只使用实际 `127.0.0.1:<监听端口>` 创建房间；
5. 成功结果同时返回权威服务状态和本机目标，Renderer 据此更新状态；
6. 端口占用等监听失败直接报告“无法启动本机房间服务”及具体原因；
7. Preload 移除 Electron 的 remote-method 技术前缀，只向用户显示可操作的错误。

加入远程房间仍执行原有的无凭据预检、HTTP 风险确认、TLS 和协议检查。

## 自动化与打包验证

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `corepack pnpm check` | 通过 | 格式、ESLint、类型检查、43 个测试文件中的 169 个测试和完整构建 |
| `corepack pnpm desktop:package` | 通过 | Windows x64 未安装应用目录，文件和产品版本均为 0.5.1 |
| `corepack pnpm desktop:make` | 通过 | Windows x64 Squirrel、NUPKG、RELEASES、ZIP 和校验和 |
| `corepack pnpm desktop:smoke` | 通过 | 实际启动打包应用并覆盖服务停止后直接创建房间 |

新增单元测试覆盖：

- 服务停止时，创建房间先按保存配置启动监听；
- 服务已运行时，不重启并使用权威实际端口；
- 监听失败显示本机服务错误，不套用远程连接诊断；
- 创建房间 IPC 拒绝 Renderer 注入远程目标。
- Electron IPC 错误前缀不会泄漏到用户提示。

打包应用 smoke 明确执行：

1. 在 `127.0.0.1:32100` 启动服务并验证连接信息；
2. 停止该服务；
3. 直接调用“创建房间”流程；
4. 确认服务以新的实例 ID 在同一固定端口重新启动；
5. 确认成功生成房间码；
6. 确认运行目标和持久化目标均为 `http://127.0.0.1:32100`。

## Windows 本地产物

| 产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `make/squirrel.windows/x64/DrawGuessSetup.exe` | 149,349,888 | `0fd787eb6bccfeb8d5620b670744feb2f7489755df7d88a45e8c8435435e7c3f` |
| `make/squirrel.windows/x64/draw_guess-0.5.1-full.nupkg` | 148,579,534 | `5cec017f8db59805b0c86dc97512e7513b8aae79dec7630f1221f6e01c2f884a` |
| `make/zip/win32/x64/画猜现场-win32-x64-0.5.1.zip` | 154,070,062 | `fd99b8c15acba5d2a7e222356934a4db7bb8bc2d6c103310ea3bc02c3c5cd530` |

未安装目录中的 `draw-guess.exe` 为 225,613,824 字节，SHA-256 为
`0280a210a3c6f6363d0b2391c35ef8dbfaf09b325ecf587a24c62bd97ac448c2`。

## 验证边界

本热修复没有改变网络协议、局域网绑定、可信代理或三种游戏模式。0.5.0 记录中标为
未执行的真实双设备 LAN、真实 SakuraFrp/HTTPS 和 macOS/Linux 人工实机测试仍然是
外部验证项，不能由本机 smoke 替代。

标签触发的 GitHub Actions 会分别在 Windows x64、Linux x64、macOS arm64 和 macOS
x64 上重新执行完整检查、打包与 packaged smoke。远端最终状态以对应 Actions run 和
GitHub Release 页面为准。
