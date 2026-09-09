# DSH Desktop 启动等待页骨架屏化设计

日期：2026-09-10
状态：已评审待实施
范围：`src/renderer/loading.html` 单文件重写

## 1. 背景与目标

当前启动等待页（loading.html）为居中 spinner + 状态文字 + 提示 + 两行版本号，
视觉与 DSH 主界面割裂感强。本次将其替换为**模仿 DSH 主界面布局轮廓的骨架屏**：
窗口仍立即显示，等待期内容区展示抽象色块骨架 + 微光动画 + 一行实时状态文字，
DSH 就绪后原地切换为真实 UI，降低跳变感。

### 决策记录（brainstorm 确认）

| 决策点 | 结论 |
| --- | --- |
| 启动页去留 | 保留等待页（窗口立即显示），仅替换内容样式 |
| 视觉方向 | B 骨架屏（模仿 DSH 主界面布局轮廓，抽象色块，非像素级复刻） |
| 等待期信息 | 仅一行实时状态文字；不要版本号、不要静态 hint |
| 实现方案 | 方案 1：loading.html 原地重写为纯 HTML/CSS；主进程/preload 零改动 |

## 2. 视觉与布局规格

布局参照真实 DSH 主界面轮廓：左侧栏 + 居中主区。全部为抽象圆角色块，
不含任何文字占位（唯一文字为底部状态行）。

### 2.1 结构

```
body (flex row, height 100%)
├── .sk-sidebar (width 260px, border-right 1px var(--sk-border), padding 12px, flex column)
│   ├── 新会话按钮块   h40 r8  strong
│   ├── (gap 24) 工作区标签块 w64 h12 r4
│   ├── (gap 12) 会话块 ×3   h32 r6（第 2 条 strong，模拟 active）
│   ├── flex spacer
│   └── 底部设置块     w60% h28 r6
└── .sk-main (flex 1, position relative, 垂直水平居中 column)
    ├── hero 行 (gap 10): logo 36×36 r10 strong + 标题条 w200 h24 r6 + 徽标 pill w52 h18 r9
    ├── (gap 28) 选择器行 (gap 8): pill w150 h20 r6 + pill w110 h20 r6
    ├── (gap 16) 输入卡片 width min(720px, 86%), h116, r12, bg var(--sk-card), padding 16
    │   ├── 顶部占位条 w38% h12 r4
    │   └── 底部工具行: 圆 28 + 条 w120 h12 + spacer + 条 w180 h12 + 发送圆 32 strong
    └── #status (absolute, bottom 20px, 全宽居中, 12px, var(--status))
```

### 2.2 主题色板（CSS 变量，沿用 data-theme 机制）

| 变量 | 浅色 `:root` | 深色 `:root[data-theme='dark']` | 用途 |
| --- | --- | --- | --- |
| `--bg` | `#ffffff` | `#1a1a2e` | 页面背景 |
| `--status` | `#8a8a94` | `#707080` | 状态文字 |
| `--sk-block` | `rgba(0,0,0,.05)` | `rgba(255,255,255,.06)` | 普通色块 |
| `--sk-strong` | `rgba(0,0,0,.10)` | `rgba(255,255,255,.12)` | 强调色块（按钮/active/发送） |
| `--sk-card` | `rgba(0,0,0,.04)` | `rgba(255,255,255,.05)` | 输入卡片底 |
| `--sk-border` | `rgba(0,0,0,.06)` | `rgba(255,255,255,.06)` | 侧栏分割线 |
| `--sk-shine` | `rgba(0,0,0,.06)` | `rgba(255,255,255,.05)` | 微光渐变峰值 |

### 2.3 色块类名约定

- `.sk`：普通色块，`background: var(--sk-block)`
- `.sk-strong`：强调色块（新会话按钮/active 会话/发送圆/logo），`background: var(--sk-strong)`
- 输入卡片容器为 `.sk.sk-card`（`.sk-card` 覆写 `background: var(--sk-card)`），其内部占位条/圆仍用 `.sk` / `.sk-strong`
- 以上所有色块均因携带 `.sk` 类而自动承载 2.4 的微光动画

### 2.4 微光动画

- 每个 `.sk` 色块 `position:relative; overflow:hidden`，`::after` 承载
  `linear-gradient(90deg, transparent, var(--sk-shine), transparent)`，
  `transform: translateX(-100%) → translateX(100%)`，`animation: shimmer 1.8s linear infinite`
- `@media (prefers-reduced-motion: reduce)` 下 `.sk::after { animation: none }`，仅留静态骨架

## 3. 行为与集成

### 3.1 保留（页面侧照旧接线）

- CSP meta 原样保留（`default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`）
- `<title>DSH Desktop - 加载中</title>` 不变
- preload `document_start` 同步打 `data-theme` 标 → 首屏零闪烁（页面继续用
  `:root[data-theme='dark']` 选择器覆盖变量）
- `window.dsh.onThemeChanged` 订阅 → 运行中切主题色板即时跟随
- `window.dsh.onStatus` 订阅 → 更新 `#status` 文本；DOM 默认文本「正在启动 DSH 服务...」

### 3.2 删除

- spinner DOM 与 `@keyframes spin` 样式
- 静态 hint 行（「首次启动可能需要 1-3 分钟下载组件」）
- `getInstalledVersion` / `getAppVersion` 两段取版本脚本及 `#version` / `#app-version` DOM

### 3.3 自动复用的调用点（零代码改动）

- 启动路径：`createWindow() → loadLoadingPage()`
- DSH 更新路径：`performUpdate() → loadLoadingPage()`；期间状态文字随主进程
  `sendStatus` 实时更新（「正在下载最新版本 DSH 包...」「下载完成，正在切换 DSH 版本...」等）
- 失败路径：`showError()` 照常导航 error.html，错误页不受影响

### 3.4 已知边界（现状保持，不在本次扩展）

首次启动若走 npx 下载组件（1-3 分钟），主进程无中间状态推送，状态文字停留
「正在启动 DSH 服务...」。补下载进度推送属主进程改动，另议。

## 4. 验收计划

1. `npm run build` 编译检查通过
2. `npm run dev`：窗口立即显示深色骨架屏 + 「正在启动 DSH 服务...」，就绪后切 DSH 主界面
3. 浅色主题两条路径（运行中切换 / 重启后首屏）色板跟随、无闪烁
4. Windows 关闭动画效果（prefers-reduced-motion）→ 静态骨架无微光
5. 更新流程复用同一 `loadLoadingPage()`，代码路径与启动一致，不单独造场景
6. 错误路径抽查：制造启动失败确认 error.html 正常接管
7. 实现后截深色/浅色骨架屏截图各一张，与 brainstorm mockup
   （`.superpowers/brainstorm/20260910-loading-page/content/skeleton-preview.html`）对照

## 5. 非目标

- 就绪淡入过渡（原方案 3，留作后续增强）
- 像素级复刻 DSH 主界面（原方案 2）
- 首次下载进度状态推送（主进程改动）
- error.html / titlebar.html / 主进程 / preload 的任何修改
