# 0.5.9 昵称与经典选词修复验证记录

验证时间：2026-07-26（Asia/Shanghai）

验证分支：`develop`

应用版本：`0.5.9`

游戏协议版本：`5`（本次未升级）

主题 API 版本：`1`（本次未升级）

## 本次范围

1. 创建房间与加入房间的昵称输入允许为空。服务端为空输入生成带
   `#四位数字` 后缀的随机身份，并优先避开房间内及最近生成的昵称主体。
2. 手动昵称经统一规范化后持久保存在浏览器 IndexedDB 或 Electron 用户数据目录；
   随机昵称不会覆盖已记住的手动昵称。
3. 经典模式先广播当前选词/绘画快照，再向当前画手发送私密候选词或最终题目。
   客户端分别校验 mode session、逻辑回合和新的 drawing actor step。
4. 私密候选词状态不再参与 WebSocket 订阅回调依赖，避免收到候选词后主动断线重连。

## 自动化验证

已执行：

```text
corepack pnpm check
corepack pnpm desktop:package
corepack pnpm desktop:smoke
```

结果：

- 主题模板一致性、ESLint 与 Prettier 通过；
- 全部 workspace TypeScript 类型检查通过；
- 53 个测试文件通过；
- 228 项测试通过，1 项跳过；
- Web、Server 与 Electron production build 通过。
- Windows x64 打包应用实际启动通过，报告应用版本 `0.5.9`、协议版本 `5`；
- 打包 Renderer 保持 Node 隔离，内嵌服务器、浏览器入口、桌面会话、房间关闭、
  加入失败诊断、顶部工具栏、采集按钮对比度和主题安全恢复冒烟通过。

新增回归覆盖：

- 空昵称的 HTTP、桌面 IPC 与协议 schema；
- 随机昵称跨房间轮换、房间内主体避重及唯一数字后缀；
- 浏览器与 Electron 手动昵称持久化；
- Web 创建/加入表单允许空昵称并回填已记住的手动昵称；
- 服务端保证选词快照先于私密候选词、绘画快照先于私密最终题目；
- 客户端拒绝过期 mode session、错误回合与错误 drawing actor step。

## 打包与平台验证

本地 Windows x64 打包应用已通过实际进程启动冒烟。安装器和便携包将由标签触发的
GitHub Actions 在 Windows x64、macOS arm64、macOS x64 与 Linux x64 上重新构建。
发布页最终文件名、平台覆盖和 SHA-256 以 `v0.5.9` 工作流生成的 Release 为准。

## 尚未冒充完成的人工验证

1. 两台物理设备之间的局域网与公网隧道实际联机；
2. macOS arm64、macOS x64 与 Linux x64 的人工视觉和系统权限交互；
3. 所有外部绘图软件、屏幕缩放比例及主题组合下的逐页人工审美检查。

这些项目不由本机单元测试替代；发布工作流只会在相应平台构建与打包启动成功后生成
预发布 Release。
