# 在桌面客户端添加 GitHub 仓库跳转链接 Spec

## Why
用户在 DSH Desktop 主界面需要一个直达应用源码仓库的入口，便于查看文档、提交 Issue、了解更新，而无需手动打开浏览器输入地址。

## What Changes
- 在 DSH 主界面右上角注入一个 GitHub 官方 octocat 图标链接（复用现有 `injectUpdateBadge()` 的 `executeJavaScript` 注入机制）。
- 点击图标后通过系统默认浏览器打开应用自有仓库：`https://github.com/ycowner/deepseek-harness-desktop`。
- 新增预加载 API `window.dsh.openExternal(url)` 与 IPC 通道 `open-external`，由主进程调用 `shell.openExternal` 完成跳转（与现有 `install-update` 模式一致，相比直接 `window.open` 更可控、不被 CSP 阻塞）。

> 注：`createWindow()` 里的 `setWindowOpenHandler` 已把外部新窗口链接交给 `shell.openExternal`。本实现走独立 IPC 通道，路径可控且不依赖远程 DSH 页面的 CSP 行为。

## Impact
- Affected specs:
  - `wrap-dsh-web-as-desktop-client`：本仓库 IPC / preload / 主进程窗口生态。
  - `add-desktop-app-version-update`：右上角"应用有更新"徽标与 GitHub 图标需避免重叠（位置协调）。
- Affected code:
  - `src/main/index.ts`：新增仓库 URL 常量、`injectGitHubLink()` 注入函数、`open-external` IPC 通道；在 DSH 就绪加载后调用注入。
  - `src/preload/index.ts`：新增 `openExternal(url)`。
  - `src/renderer/`：无需改动（注入目标是远程 DSH 主界面，不涉及 loading/error 页面）。

## ADDED Requirements

### Requirement: GitHub 仓库跳转链接
系统 SHALL 在 DSH 主界面右上角注入一个 GitHub octocat 图标链接，点击后在系统默认浏览器中打开应用仓库，且应用窗口保持打开。

#### Scenario: 成功跳转
- **WHEN** 用户点击主界面右上角的 GitHub 图标
- **THEN** 系统默认浏览器打开 `https://github.com/ycowner/deepseek-harness-desktop`，当前应用窗口不关闭、不跳转

#### Scenario: 与"应用有更新"徽标共存
- **WHEN** GitHub 图标与右上角"应用有更新"徽标同时存在
- **THEN** 两者在右上角垂直堆叠、互不遮挡（GitHub 图标固定 `top: 16px right: 16px`，更新徽标下移至其下方）

#### Scenario: 重复注入防护
- **WHEN** 启动流程或更新流程多次触发注入
- **THEN** 已注入的 GitHub 图标不会重复出现（以 `data-dsh-github-link` 属性判重）

## 已确认的技术决策
- 图标样式：GitHub 官方 octocat（内联 SVG），半透明深色底、圆角、悬停提示"查看 GitHub 仓库"。
- 打开方式：`mainWindow.webContents` 外置调用主进程 `shell.openExternal`。
- 目标地址：`https://github.com/ycowner/deepseek-harness-desktop`（应用自有仓库）。
- 注入节点：`document.body.appendChild`，优先级层级与更新徽标一致（`z-index: 2147483647`）。