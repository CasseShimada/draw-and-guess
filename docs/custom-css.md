# 本地 CSS 主题系统

主题 API 版本：`1`

Electron 桌面客户端可以在本机替换或覆盖普通产品界面的完整视觉样式。主题不会上传到
游戏服务器、写入房间快照、广播给玩家或强制其他客户端使用；浏览器客户端和桌面端
默认外观来自同一份 Web 模板。

主题系统保证必要操作可恢复，不保证任意 CSS 修改后仍保持原有布局或视觉效果。

## 三层样式和加载顺序

样式分为三个职责明确的层：

1. `core-safety.css` 只保留 box sizing、最低渲染条件、焦点、`[hidden]`、
   屏幕阅读器辅助类和失败提示等最低安全规则。
2. `default-template.css` 与 `desktop-template.css` 是当前默认外观的唯一视觉来源。
   构建脚本把它们确定性合并为 `drawguess-theme-template.css`。
3. `compiled.css` 是当前客户端的用户主题，经过作用域、名称和本地素材重写后才加载。

实际顺序如下：

```text
默认：Core Safety → Default Template
覆盖：Core Safety → Default Template → Compiled User CSS
替换：Core Safety → Compiled User CSS
```

“完整替换”不会加载默认模板，可以导入完整模板，也可以从空文件开始。“覆盖”保留默认
模板，适合只修改颜色、字体、圆角或少量布局。导入时必须明确选择，应用不会根据规则
数量猜测模式。切换或重新加载样式不会重建游戏组件、重连 WebSocket、清空绘画或改变
服务器游戏状态。

## 创建、导出和直接编辑

设置 → 本地自定义 CSS 提供：

- 从默认模板创建；
- 导入完整主题；
- 导入覆盖 CSS；
- 导出默认模板；
- 打开主题文件夹；
- 重新载入 CSS；
- 启用、恢复默认主题和删除自定义主题。

“从默认模板创建”把完整单文件模板安装为 `replace` 主题。也可以先“导出默认模板”，
复制到任意目录修改，再选择“导入完整主题”。

工作目录位于 Electron `userData` 下：

```text
themes/
  active/
    source.css
    compiled.css
    manifest.json
    assets/
      <content-hash>-asset.png
    <source.css 使用的相对素材路径>
```

`source.css` 保留注释和可读格式，可使用外部编辑器直接修改。保存后点击“重新载入
CSS”：主进程先解析、校验并写入临时目录，验证 `compiled.css` 和 manifest 后再原子
替换。失败时上一份编译结果继续生效，工作目录和设置不会被清空，错误会显示 CSS
位置或具体素材原因。

`manifest.json` schema 2 保存应用模式、主题 API 版本、源文件和编译文件哈希、时间及
素材清单。应用重启时会验证编译文件；若只发现 `source.css` 被外部修改，会继续使用
上一份 `compiled.css` 并提示重新载入。

仓库构建命令：

```bash
corepack pnpm theme:build-template
corepack pnpm theme:validate-template
```

生成文件为 `apps/desktop/assets/drawguess-theme-template.css`，会随 Electron 安装包
分发。CI 会验证生成内容与两个唯一源文件一致。

## 稳定选择器 API

公开主题接口使用语义属性，而不是内部 class 名：

- `data-ui`：稳定组件或区域名；
- `data-screen`：`home`、`lobby`、`game`、`room-settings` 等当前页面；
- `data-mode`：`classic`、`reference-copy` 或 `draw-relay`；
- `data-phase`：小写的当前游戏阶段；
- `data-state`：`connected`、`urgent`、`selected`、`error` 等状态；
- `data-role`：`host`、`player` 等角色；
- `data-action`：稳定操作名。

根节点示例：

```html
<div
  data-ui="theme-root"
  data-platform="desktop"
  data-screen="game"
  data-mode="classic"
  data-phase="drawing"
  data-connection="connected"
  data-theme-mode="override"
>
```

主要公开 `data-ui`：

```text
theme-root, app-root, home-screen, home-intro, room-entry
create-room-form, join-room-form, text-input, password-input, room-code-input
topbar, connection-status, room-code-copy, local-profile, avatar-control
game-screen, room-settings-screen, mode-selection-cards, word-pool-settings
player-list, player-card, player-avatar, chat-panel, chat-log, chat-input
drawing-board, drawing-finalization-prompt, timer, result-card, loading-state
classic-lobby, classic-settings, classic-word-selection, classic-drawing
classic-turn-result, classic-game-result
reference-lobby, reference-settings, reference-preparing, reference-image
reference-drawing, reference-blind-voting, ballot-image, reference-gallery
relay-lobby, relay-settings, relay-preparing, private-task-image
relay-drawing, relay-guessing, relay-replay-status, relay-result
desktop-toolbar, connection-panel, capture-studio, settings-panel
diagnostics-panel, theme-preview, primary-button, secondary-button, danger-button
```

主要稳定 `data-action` 包括 `create-room`、`join-room`、`start-game`、
`select-word`、`finish-drawing`、`submit-chat`、`submit-relay-guess`、
`finish-voting`、`return-to-lobby`、`open-room-settings` 和
`confirm-room-closure`。完整模板及设置中的组件预览页会同时显示常见状态和对应
`data-ui` 名称。

默认变量：

```css
:root {
  --ink: #22211f;
  --paper: #f5efe3;
  --paper-light: #fffaf0;
  --coral: #f15b47;
  --coral-dark: #cb3e2f;
  --teal: #167d78;
  --yellow: #f4c84b;
  --line: #242320;
  --muted: #777168;
  --shadow: 5px 5px 0 var(--line);
}
```

导入器把 `:root` 映射为本地 `[data-ui="theme-root"]`。例如一个覆盖主题：

```css
/*
 * Theme API Version: 1
 * Apply Mode: override
 */
:root {
  --coral: #7c5cff;
}

[data-ui="primary-button"] {
  border-radius: 999px;
}

[data-ui="theme-root"][data-mode="classic"][data-phase="drawing"]
  [data-ui="timer"][data-state="urgent"] {
  transform: scale(1.08);
}
```

完整主题从“导出默认模板”得到；不要手工复制构建产物的哈希 class。接口版本改变时会在
本文和发布说明中记录。没有版本头的简单旧 CSS 按主题 API 1 处理；声明了不受支持的
版本会拒绝启用并保留源文件。

## CSS 能力与本地素材

普通主题区域允许 `display`、`position`、`z-index`、Grid、Flexbox、transform、
filter、opacity、pointer-events、媒体查询、容器查询、伪类、伪元素、自定义属性、
关键帧、本地字体和 `!important`。Canvas 内绘画像素不由 CSS 修改，但画布容器、
尺寸、背景、边框和外围工具栏可主题化。

允许 `.png`、`.jpg`、`.jpeg`、`.webp`、`.gif`、`.woff` 和 `.woff2`。素材必须在
所选 CSS 同目录或子目录中，以无查询参数的相对路径引用：

```css
[data-ui="home-intro"] {
  background-image: url("./assets/paper.png");
}
```

导入器用 realpath 验证边界，只复制实际引用的文件，并把 URL 改为只读
`drawguess-theme://active/assets/<hash>-paper.png`。协议只返回 manifest 中列出的
文件，校验大小与 SHA-256，并设置准确 MIME、`nosniff` 和限制性 CSP。

限制：

| 项目 | 限制 |
| --- | ---: |
| CSS | 512 KiB |
| 单素材 | 5 MiB |
| 素材总量 | 25 MiB |
| 素材文件数 | 200 |

网络 URL、`data:`、`file:`、绝对路径、`..` traversal、查询参数、fragment、
`@import`、脚本片段、浏览器 binding、未知 at-rule、越界符号链接和不支持的素材类型
会拒绝整次编译。关键帧与自定义字体自动加主题命名空间。所有普通选择器通过 AST
限制在主题根中；试图从根选择相邻节点或直接选择安全宿主会被拒绝。

## 独立安全宿主和自动降级

只有最小恢复层不可主题化：

- Shadow DOM 中的主题安全中心；
- 禁用主题、恢复默认、重新加载和打开设置；
- 自动降级与解析错误提示；
- 当前隐藏关键按钮的备用操作；
- 独立置顶共享窗口中的“立即停止”按钮；
- 应用初始化失败提示。

安全宿主位于主题根外，使用独立 Shadow DOM 样式；用户 CSS 只会注入主题根，因此
通用选择器、极端 `z-index`、透明度或 `pointer-events` 都不能隐藏它。屏幕共享停止
窗口是单独的 BrowserWindow，用户主题不会注入其中。

启用主题后，客户端在页面、模式、阶段、角色和窗口变化时检查当前声明为关键的区域，
并结合 MutationObserver、ResizeObserver、连续两个动画帧、debounce 和周期复检判断
`display:none`、隐藏、接近透明、禁止点击、零尺寸、视口外、严重裁剪和超大溢出。

隐藏普通按钮时，安全中心显示调用同一 React 业务回调的备用按钮；它不会复制游戏
命令逻辑。绘画画面、参考图、私密任务或整个页面等不可替代区域失效时，只在当前
客户端临时暂停用户 CSS并立即恢复默认模板，不暂停服务器或其他玩家。安全中心可选择
保持禁用、重新载入或再次尝试启用，也不会显示当前玩家无权查看的答案。

系统托盘的“禁用自定义 CSS（安全恢复）”、`--safe-mode` 和
`--disable-custom-css` 仍是额外恢复入口。

## 常见错误

- “主题接口版本不兼容”：从当前版本重新导出模板，迁移规则后重新导入。
- “不允许 @import / 网络 URL”：把允许类型的素材下载到主题目录并改用相对路径。
- “素材路径越界 / 符号链接逃逸”：把普通文件复制到 CSS 同目录或子目录。
- “source.css 已在外部修改”：点击“重新载入 CSS”生成新的编译结果。
- CSS 行列解析错误：修正 `source.css`；上一份 `compiled.css` 仍继续生效。
- “关键组件不可用”：先保持默认样式，修正隐藏、透明、零尺寸或极端偏移规则，再
  点击“再次尝试启用”。

局部覆盖示例见
[`examples/custom-theme/style.css`](../examples/custom-theme/style.css)。
