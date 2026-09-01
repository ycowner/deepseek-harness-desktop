# 标题栏「帮助」菜单左移 & GitHub 图标移入「关于」 Spec

## Why
标题栏「帮助」按钮当前位于窗口右上角、紧贴系统三键，与 Windows 桌面应用常规习惯（功能入口靠左）不符；DSH 页面右上角的 GitHub 浮动图标遮挡页面内容，且需要与更新横幅联动调整位置（横幅注入代码中多处引用 `[data-dsh-github-link]`），维护成本高。将「帮助」移到左侧、GitHub 入口收敛到「关于」模态框，既符合常规布局习惯，也简化注入逻辑。

## What Changes
- 标题栏「帮助」按钮从右侧（`right: 146px` fallback + WCO 环境变量定位）改为左侧定位，位于应用图标与标题文字「DSH Desktop」之后，即布局：`[应用图标] DSH Desktop [帮助]`
- 移除 DSH 页面右上角 GitHub 浮动图标的注入逻辑（`injectGitHubLink()`）及其全部调用点（`startDshAndLoad()` / `performUpdate()`）
- 「关于」模态框的「GitHub 仓库」文字按钮叠加 GitHub octocat 图标 SVG（白底蓝色按钮内联图标 + 文字）
- 清理随之产生的死代码：`adjustFloatingIconsPosition()` 函数及其调用点、两处更新横幅注入代码中对 `[data-dsh-github-link]` 的位置联动调整

## Impact
- Affected code:
  - `src/renderer/titlebar.html`：`.help-btn` 样式定位方式调整（右侧 → 左侧），删除 WCO `@supports` 定位块
  - `src/main/index.ts`：删除 `injectGitHubLink()`、`adjustFloatingIconsPosition()` 及调用点；`injectDshUpdateBanner()` / `injectAppUpdateBanner()` 中删除 GitHub 图标位置联动；`showAboutModal()` 按钮叠加图标
  - `AGENTS.md`：同步 `open-external` IPC 触发方描述（删除「DSH UI 中的 GitHub 图标」表述）
- 不涉及 preload API、IPC 通道的增删（`open-external` 保留，仅剩「关于」模态框按钮一个触发方）
- 不涉及打包配置、图标资源变更

## ADDED Requirements

### Requirement: 标题栏帮助按钮左侧定位
标题栏「帮助」按钮 SHALL 位于左侧区域，紧随应用图标与标题文字「DSH Desktop」之后。

#### Scenario: 布局正确
- **WHEN** 窗口显示（窗口化或最大化）
- **THEN** 标题栏布局为 `[应用图标] DSH Desktop [帮助]`，按钮可点击、不与标题文字重叠

#### Scenario: 菜单跟随按钮
- **WHEN** 用户点击「帮助」按钮
- **THEN** 原生帮助菜单在按钮正下方弹出（复用现有 `getBoundingClientRect()` 坐标传递，主进程逻辑不变）

### Requirement: 关于模态框 GitHub 图标按钮
「关于」模态框的「GitHub 仓库」按钮 SHALL 叠加 GitHub octocat 图标 SVG，点击后在系统默认浏览器打开仓库地址（复用现有 `window.dsh.openExternal` 链路）。

#### Scenario: 点击跳转
- **WHEN** 用户在「关于」模态框中点击带图标的「GitHub 仓库」按钮
- **THEN** 系统默认浏览器打开 `https://github.com/ycowner/deepseek-harness-desktop`，应用窗口不关闭

## REMOVED Requirements

### Requirement: DSH 页面右上角 GitHub 浮动图标
**Reason**: 浮动图标遮挡 DSH 页面内容；与更新横幅存在位置联动（横幅出现/关闭时需下移/复位），增加注入代码复杂度；GitHub 入口收敛到「关于」模态框后功能等价。
**Migration**: 「关于」模态框的「GitHub 仓库」按钮叠加 GitHub 图标，作为唯一 GitHub 仓库跳转入口；删除 `injectGitHubLink()`、`adjustFloatingIconsPosition()` 及横幅注入代码中全部 `[data-dsh-github-link]` 位置联动逻辑。

## 已确认的技术决策
- 帮助按钮位置：应用图标和标题之后（用户已确认）；标题文字「DSH Desktop」宽度在 12px Segoe UI 下约 70-80px，按钮采用固定 `left` 定位（约 130px），与标题保持安全间距；标题本身 `white-space: nowrap`，最小窗口宽 800px 下无重叠风险。
- 移除右侧定位后，WCO 环境变量 `@supports` 定位块一并删除（不再需要紧贴系统三键）。
- 「关于」按钮图标：GitHub 官方 octocat 内联 SVG（与原浮动图标同源，白色填充），按钮保持现有蓝色底白字样式，图标置于文字左侧。
- 菜单弹出坐标：继续直接传按钮在标题栏页面内的 CSS 像素坐标（`rect.left` / `rect.bottom`），不叠加任何窗口偏移（AGENTS.md §12.2 第 23 条）。
