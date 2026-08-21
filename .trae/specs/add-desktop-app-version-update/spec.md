# DSH Desktop 桌面应用自身版本更新 Spec

## Why

现有 `add-dsh-version-check-and-update` 规格实现了 **dsh 上游包**（`@deepseek-ai/dsh`）的版本检测与更新提醒。但**桌面应用本体**（`dsh-web-desktop`，Electron 打包的 NSIS 安装包，当前 v1.0.0）没有任何版本检测与更新机制：用户无法得知桌面端是否发布了新版本，也无法便捷地升级。本次新增桌面应用自身的版本检测、自动下载与更新安装流程。

## What Changes

- 新增主进程模块 `src/main/app-update.ts`：桌面应用版本检测（GitHub Releases 双源回退 Gitee Releases）+ 安装包下载 + 安装编排
- 修改 `src/main/dsh-version.ts`：将私有 `compareVersions()` 导出，供 `app-update.ts` 复用（避免重复实现）
- 修改 `src/main/index.ts`：
  - 窗口标题改为 `DSH Desktop v{应用版本} - DSH v{dsh版本}`
  - DSH 服务就绪后异步触发桌面应用更新检查；有更新则后台下载安装包到安装目录
  - 下载完成后向 DSH Web UI 注入「有更新」悬浮角标
  - 注册 IPC 通道 `get-app-version`、`install-update`
  - 实现安装流程：停止 DSH → 打开安装向导 → 退出应用
- 修改 `src/preload/index.ts`：新增 `getAppVersion()`、`installUpdate()` API
- 修改 `src/renderer/loading.html`：底部增加「应用版本: v1.0.0」显示
- 新增发布运维要求：每次发版需将安装包上传到 GitHub Releases 与 Gitee Releases

## Impact

- Affected specs: 无（新功能，不修改 `add-dsh-version-check-and-update` 既有规格；仅复用其代码）
- Affected code:
  - `src/main/app-update.ts` — 新增模块
  - `src/main/dsh-version.ts` — 导出 `compareVersions`（最小改动）
  - `src/main/index.ts` — 标题、启动检查、下载、角标注入、IPC 注册、安装流程
  - `src/preload/index.ts` — 新增 API
  - `src/renderer/loading.html` — 应用版本显示
- 不改动：`dsh-manager.ts`、`dsh-repair.ts`、`electron-builder.yml`、打包配置

## 技术方案

### 版本源与发布资源约定

| 项 | 值 |
|---|---|
| GitHub 仓库 | `ycowner/deepseek-harness-desktop`（与 package.json repository 一致） |
| Gitee 仓库 | `yuchao668/deepseek-harness-desktop`（用户提供） |
| 最新版本 API | GitHub: `https://api.github.com/repos/{owner}/{repo}/releases/latest`；Gitee: `https://gitee.com/api/v5/repos/{owner}/{repo}/releases/latest` |
| 安装包下载 URL | GitHub: `https://github.com/{owner}/{repo}/releases/download/{tag}/{asset}`；Gitee: `https://gitee.com/{owner}/{repo}/releases/download/{tag}/{asset}` |
| 安装包命名 | `DSH-Desktop-Setup-{version}.exe`（连字符格式；匹配时宽松归一化空格为连字符，兼容 `DSH Desktop Setup {version}.exe`） |
| 发布 tag | `v{version}`（版本号取 tag_name 去掉前缀 `v`） |

### 版本检测（`app-update.ts` 的 `checkForAppUpdate()`）

1. 当前版本：`app.getVersion()`（打包后读取安装版 package.json）
2. 先请求 GitHub `releases/latest` API：
   - 解析 `tag_name` → 去 `v` 前缀得到 `latestVersion`
   - 从 `assets[]` 中找到命名匹配 `DSH-Desktop-Setup-{version}.exe`（宽松归一化空格为连字符后比较）的资源，取其 `name` 与 `browser_download_url`
3. 若 GitHub 失败（网络错误 / 超时 / 非 200 / 无匹配 asset）→ 请求 Gitee `releases/latest` API（解析 `tag_name` 与 `assets[]` 中匹配的 exe）
4. 若双源均失败 → 返回 `{ hasUpdate: false, error }`，调用方静默处理
5. 用 `compareVersions(currentVersion, latestVersion) < 0` 判断是否有更新
6. 返回 `{ hasUpdate, currentVersion, latestVersion, assetName, downloadUrl, source, error? }`

### 版本比较复用

`dsh-version.ts` 中已实现私有 `compareVersions()`（支持 semver + 预发布标签），本次仅将其 `export`，`app-update.ts` 从 `dsh-version.ts` 导入，不重复实现。

### 自动下载（`app-update.ts` 的 `downloadAppUpdate()`）

- 下载目的地：**安装目录** `path.dirname(app.getPath('exe'))`（打包后为 `C:\Program Files\DSH Desktop\`；应用以管理员权限运行，可写）
- 目标文件名：`DSH-Desktop-Setup-{latestVersion}.exe`
- 实现：Node `https` 流式下载，跟随重定向（GitHub 资产会 302 到 objects.githubusercontent.com），边下边写文件，通过进度回调上报
- 若目标文件已存在且是完整下载 → 跳过重复下载（防止启动多次重复拉取）
- 开发模式（`app.isPackaged === false`）跳过全部更新逻辑

### 「有更新」悬浮角标注入

- 下载完成后，通过 `mainWindow.webContents.executeJavaScript()` 向 DSH Web UI 注入一个 `position: fixed` 右上角悬浮按钮
- 按钮文本：`应用 v{当前版本} · 有更新`
- 点击事件用 `addEventListener('click', ...)` 绑定（避免页面 CSP 对内联属性限制；`executeJavaScript` 本身不受页面 CSP 约束）
- 点击回调调用 `window.dsh.installUpdate()`（注意：BrowserWindow 的 preload 对该窗口加载的所有页面生效，包括 loadURL 加载的外部 DSH UI，因此 `window.dsh` 在 DSH UI 内可用）
- 需要注入防重标记（如 `data-dsh-update-badge` 属性）避免重复注入

### 安装流程（index.ts 编排）

1. 用户点击「有更新」角标 → `window.dsh.installUpdate()` → IPC `install-update`
2. 主进程弹原生对话框：「立即更新」/「稍后更新」
3. 用户点「立即更新」：
   1. 校验安装目录下安装包存在，缺失则提示并结束
   2. `await stopDsh()` 停止 DSH 子进程
   3. 弹提示「应用即将关闭，请在安装向导中完成安装」
   4. `spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()` 打开安装向导（**不带 `/S`，显示安装向导界面**）
   5. `app.quit()` 退出当前应用（触发 `window-all-closed` → `stopDsh()` 清理）
4. NSIS 向导完成后默认自动启动新版本（electron-builder NSIS 默认 `runAfterFinish`）

### 应用版本展示

- **窗口标题**：DSH 就绪后 `DSH Desktop v{appVersion} - DSH v{dshVersion}`
- **loading.html 底部**：新增一行「应用版本: v1.0.0」，通过新 IPC `get-app-version` 获取，失败显示「未知」

### 网络容错

- 版本检测失败 → 静默忽略，不影响使用
- 下载失败 → 静默忽略（不注入角标），下次启动或用户操作可重新检查
- 双源任一可达即可完成检测与下载

## ADDED Requirements

### Requirement: 桌面应用版本检测

系统 SHALL 在 DSH 服务就绪后异步检测桌面应用自身是否有新版本，检测源为 GitHub Releases，GitHub 不可达时回退 Gitee Releases。

#### Scenario: GitHub 有新版
- **WHEN** GitHub API 返回的最新版本号大于当前应用版本
- **THEN** 后台自动下载安装包到安装目录
- **AND** 下载完成后在 DSH UI 右上角注入「应用 vX.Y.Z · 有更新」悬浮角标

#### Scenario: GitHub 不可达但 Gitee 有新版
- **WHEN** GitHub 检测失败且 Gitee API 返回的新版本号大于当前版本
- **THEN** 从 Gitee 下载安装包并展示「有更新」角标

#### Scenario: 已是最新版本
- **WHEN** 当前版本等于或大于双源最新版本
- **THEN** 静默处理，不注入角标、不弹窗

#### Scenario: 双源均失败
- **WHEN** GitHub 与 Gitee 均不可达或请求超时
- **THEN** 静默忽略错误，不影响应用正常使用

### Requirement: 下载安装包到安装目录

系统 SHALL 在检测到新版本后自动下载安装包到本地安装目录（`path.dirname(app.getPath('exe'))`）。

#### Scenario: 下载成功
- **WHEN** 下载完成且文件完整
- **THEN** 安装包保存为 `安装目录/DSH-Desktop-Setup-{version}.exe`
- **AND** 触发「有更新」角标注入

#### Scenario: 安装包已存在
- **WHEN** 安装目录已存在同名完整安装包
- **THEN** 跳过重复下载，直接触发「有更新」角标

#### Scenario: 下载失败
- **WHEN** 网络中断、超时或下载出错
- **THEN** 静默忽略，不注入角标，不影响使用

### Requirement: 「有更新」悬浮角标与更新触发

系统 SHALL 在下载完成后，于 DSH Web UI 右上角显示可点击的「有更新」悬浮角标。

#### Scenario: 用户点击「有更新」
- **WHEN** 用户点击悬浮角标
- **THEN** 弹出原生对话框显示当前版本与最新版本
- **AND** 提供「立即更新」和「稍后更新」两个按钮

#### Scenario: 用户选择稍后更新
- **WHEN** 用户在对话框中点击「稍后更新」
- **THEN** 关闭对话框，角标保留，不执行任何安装动作

### Requirement: 安装向导式升级

系统 SHALL 在用户点击「立即更新」后，停止 DSH 服务、打开下载好的安装包安装向导并退出当前应用。

#### Scenario: 用户选择立即更新
- **WHEN** 用户在对话框中点击「立即更新」且安装包存在
- **THEN** 停止 DSH 子进程
- **AND** 打开安装包安装向导（显示向导界面，非静默）
- **AND** 提示用户后退出当前应用
- **AND** 安装向导完成后自动启动新版本

#### Scenario: 安装包缺失
- **WHEN** 用户在对话框中点击「立即更新」但安装目录下找不到安装包
- **THEN** 弹出错误提示，不退出应用

### Requirement: 桌面应用版本展示

系统 SHALL 在应用界面中展示桌面应用自身版本号。

#### Scenario: 窗口标题显示双版本
- **WHEN** DSH 服务加载就绪
- **THEN** 主窗口标题栏显示 `DSH Desktop v{应用版本} - DSH v{dsh版本}`

#### Scenario: 加载页面显示应用版本
- **WHEN** loading.html 渲染时
- **THEN** 页面底部显示「应用版本: v{版本号}」
- **AND** 获取失败时显示「应用版本: 未知」

## MODIFIED Requirements

### Requirement: Preload API 扩展

`window.dsh` API SHALL 新增以下方法（与既有 `checkUpdate` / `getInstalledVersion` 并存）：

| 方法 | 返回 | 说明 |
|---|---|---|
| `getAppVersion()` | `Promise<string>` | 获取桌面应用自身版本号 |
| `installUpdate()` | `void` | 通知主进程触发桌面应用更新安装流程 |

#### Scenario: 渲染进程获取应用版本
- **WHEN** loading.html 调用 `window.dsh.getAppVersion()`
- **THEN** 主进程返回 `app.getVersion()`

#### Scenario: DSH UI 角标触发安装
- **WHEN** DSH UI 中注入的角标被点击并调用 `window.dsh.installUpdate()`
- **THEN** 主进程收到 `install-update` 事件并弹更新对话框

### Requirement: IPC 通道扩展

系统 SHALL 新增以下 IPC 通道：

| 通道 | 方向 | 说明 |
|---|---|---|
| `get-app-version` | renderer → main (invoke) | 获取桌面应用版本号 |
| `install-update` | renderer → main (send) | 触发桌面应用安装流程 |

## 发布运维要求（新增）

每次发布新桌面版本时，维护者需执行：

1. `npm run package` 生成安装包（产物在 `dist-exe/`）
2. 将 `DSH-Desktop-Setup-{version}.exe` 上传到：
   - GitHub Releases（tag `v{version}`）：`github.com/ycowner/deepseek-harness-desktop/releases`
   - Gitee Releases（tag `v{version}`）：`gitee.com/yuchao668/deepseek-harness-desktop/releases`
3. 安装包命名建议使用连字符格式 `DSH-Desktop-Setup-{version}.exe`（检测逻辑会将空格归一化为连字符后匹配，因此 electron-builder 默认的 `DSH Desktop Setup {version}.exe` 也能识别）

## 风险与注意

- **写入安装目录**：安装目录位于 `Program Files` 下（perMachine），应用以管理员权限运行可写；个别杀软可能对写入安装目录的 exe 提示风险，属预期行为
- **GitHub API 限速**：未认证的 GitHub API 约 60 次/小时/IP，失败自动回退 Gitee，可接受
- **DSH UI 注入**：`executeJavaScript` 不受页面 CSP 限制；点击绑定用 `addEventListener` 而非内联属性
- **preload 覆盖**：BrowserWindow 的 preload 对 `loadURL` 加载的外部 DSH UI 同样生效，`window.dsh.installUpdate()` 在 DSH UI 内可调用（需在实现时验证）
- **开发模式**：`app.isPackaged === false` 时跳过全部桌面应用更新逻辑，避免 dev 误触发
- **不改动**：不修改 `DSH_PACKAGE_MISSING_ERROR_NAME` 常量、`requestedExecutionLevel`、打包配置
