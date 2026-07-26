# 0.5.8 CSS 主题系统验证记录

验证时间：2026-07-26（Asia/Shanghai）

验证分支：`develop`

应用版本：`0.5.8`

游戏协议版本：`5`（本次未升级）

主题 API 版本：`1`

主题 manifest schema：`2`

## 实现边界

1. 普通 Web 游戏页面与 Electron 普通设置页面均位于
   `[data-ui="theme-root"]`，可由用户主题修改布局、尺寸、颜色、字体、动画、伪元素、
   透明度、定位、点击行为和响应式规则。
2. 默认视觉由 `default-template.css` 和 `desktop-template.css` 两个唯一源文件提供；
   构建脚本确定性生成随安装包分发的单文件
   `drawguess-theme-template.css`。旧 `styles.css` 只加载最低 Core Safety 层。
3. `override` 按 Core → 默认模板 → 用户编译 CSS 加载；`replace` 按 Core → 用户编译
   CSS 加载。切换只更新样式层，不重新挂载游戏、重连 WebSocket 或修改房间状态。
4. 工作目录使用 `source.css`、`compiled.css`、`manifest.json` 和本地素材。导入及
   重载先在随机 staging 目录完整编译、校验和复制，再以目录 rename 原子替换；
   失败保留上一份可用编译结果。
5. PostCSS 编译器负责选择器根作用域、`:root` 映射、字体和关键帧命名空间、本地素材
   URL 重写、realpath/symlink 边界、类型/大小限制及脚本、网络资源和 `@import`
   拒绝。普通设计属性和 `!important` 不使用黑名单限制。
6. 公开接口使用 `data-ui`、`data-screen`、`data-mode`、`data-phase`、
   `data-state`、`data-role` 和 `data-action`。首页、大厅、房间设置、Classic、
   Reference Copy、Draw Relay、桌面面板和预览组件均有稳定 hooks。
7. 主题安全中心在主题根外的 Shadow DOM 中，样式和点击不受用户 CSS 影响。共享停止
   按钮在不注入用户主题的独立置顶 BrowserWindow 中。
8. 关键 UI 检查结合声明式 `data-critical-ui`、MutationObserver、ResizeObserver、
   两个动画帧、debounce 和周期复检。普通隐藏按钮使用同一 DOM/React 回调作为备用
   操作；画布、参考图、任务内容或整页失效会只暂停本客户端主题并恢复默认模板。

## 自动化测试

`corepack pnpm test`：

- 51 个测试文件通过；
- 218 项测试通过；
- 包含默认模板完整编译、确定性生成检查、replace/override、空白替换主题、素材与
  字体、动画命名空间、作用域逃逸、网络 URL、`@import`、traversal、symlink、
  API 版本、manifest 迁移、重启恢复、原子重载失败保留、稳定前端 hooks 和健康判定。

主题专项：

```text
4 个测试文件通过
25 项测试通过
```

健康规则覆盖 `display:none`、visibility、透明度、`pointer-events:none`、零尺寸、
父级裁剪和视口外；action 失败可备用，input/canvas/content 失败要求暂停主题。

## 构建与打包应用冒烟

已成功执行：

```text
corepack pnpm theme:build-template
corepack pnpm theme:validate-template
corepack pnpm check
corepack pnpm desktop:package
corepack pnpm desktop:smoke
corepack pnpm desktop:make
```

`pnpm check` 中模板一致性、ESLint、Prettier、全部 workspace TypeScript、全部测试和
Web/Server/Electron production build 均成功。唯一构建提示为 Renderer minified
chunk 超过 Vite 默认 500 KiB 警告，不影响产物。

Windows x64 打包应用通过实际进程启动，不是仅检查文件：

- `drawguess-app:` 页面加载，Renderer 中 `process`/`require` 不可用，preload bridge
  可用；
- 内嵌服务器、健康端点、connection-info、浏览器入口、桌面房间与协议 v5 正常；
- 打包应用报告版本 `0.5.8`；
- 安装包中的默认主题模板为 66,864 字节，包含 API/replace 头、Web 与桌面 hooks，
  且不包含安全宿主选择器；
- 相对 PNG 素材经 `drawguess-theme:` 实际加载，CSS 变量实际生效；
- 房间在线且连接状态为 `connected` 时热切换覆盖主题，房间码、服务器实例和默认模板
  层保持，窗口未刷新；
- 隐藏全部关键 action 时自定义主题保持启用，Shadow DOM 安全中心显示可点击备用
  “创建并进入房间”操作；
- 注入 `display:none !important`、`opacity:0 !important` 和
  `pointer-events:none !important` 后，系统自动进入安全模式；
- 自动暂停后安全警告、默认模板、“保持禁用并恢复默认”按钮和主题根均真实可见；
- 点击安全恢复后 `safeMode=false`、用户 CSS 持久禁用，服务器实例 ID 不变；
- 既有房间码、顶部工具栏、加入错误诊断、密码轮换、唯一昵称、关闭房间确认和采集
  按钮对比度冒烟继续通过。

## 本机产物

Windows x64 生成 Squirrel Setup、full nupkg 和 ZIP。当前本机构建未提供代码签名证书，
因此为明确标记的 unsigned 测试构建；最终 GitHub Actions 会按仓库 secrets 是否配置
决定签名。

本机最终产物 SHA-256：

```text
873d03a2c96823cfe58e8ac55bb409e296ad66c31ef396e0e2b6def1f3708546  DrawGuessSetup.exe
8ef19301dbfef2dacd9df66eb353f4ad2c2acc80800d52d4f0814fd2516b1d47  draw_guess-0.5.8-full.nupkg
0bafa060740f8c2e032acf9fa307bcf639226ce9657fea125786ce248a785b51  画猜现场-win32-x64-0.5.8.zip
```

GitHub Actions 会在各平台重新构建，因此发布页最终 SHA-256 以 Release 随附清单为准。

## 仍需人工或其它平台验证

以下项目没有用本机自动化结果冒充已验证：

1. macOS arm64、macOS x64 和 Linux x64 的打包启动、系统字体及窗口行为，交由标签触发
   的四平台 GitHub Actions 矩阵验证。
2. 320px 真机逐页视觉检查、超宽屏逐页视觉对比，以及所有三模式每个阶段的人工审美
   验收；自动测试只验证稳定 hooks、默认模板编译和关键可用性。
3. 用户实际使用外部编辑器、复杂本地字体文件和多层素材目录的体验；单元测试已覆盖
   WOFF2/PNG 重写、哈希和边界，但未声明所有第三方字体都能正确渲染。
4. 桌面采集进行中手动点击独立置顶“立即停止”的 OS 级交互；架构和既有打包冒烟确认
   该窗口不接收用户主题，仍需在各平台真实屏幕权限环境复核。
5. 双机局域网与公网隧道矩阵不属于本地主题变更，继续按网络验证文档单独执行。

主题系统保证必要操作可恢复，不保证任意 CSS 修改后仍保持原有布局或视觉效果。
