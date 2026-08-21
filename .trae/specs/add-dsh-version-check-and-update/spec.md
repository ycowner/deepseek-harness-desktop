# DSH 版本检测与更新提醒 Spec

## Why

当前 DSH Desktop 封装的 `@deepseek-ai/dsh` 包在打包时预装,用户无法得知上游是否发布了新版本。同时用户也无法查看当前安装的 DSH 版本号。需要增加版本检测和展示功能,让用户及时了解版本状态并可一键更新。

## What Changes

- 新增主进程模块 `dsh-version.ts`:读取已安装 DSH 版本号 + 查询 npm registry 最新版本号
- 新增 IPC 通道 `check-update`:主进程异步检查更新,返回 `{ hasUpdate, currentVersion, latestVersion, error? }`
- 修改 `src/main/index.ts`:DSH 服务就绪后自动触发版本检查,有更新则弹原生对话框
- 修改 `src/main/index.ts`:窗口标题追加当前 DSH 版本号
- 修改 `src/renderer/loading.html`:底部显示当前安装的 DSH 版本号
- 修改 `src/preload/index.ts`:暴露 `checkUpdate`、`getInstalledVersion`、`onVersionUpdate` API
- 新增 IPC 通道 `get-installed-version`:返回当前安装的 DSH 版本号
- 更新触发时复用 `dsh-repair.ts` 的 `repairDsh()` 流程下载最新版,完成后重启 DSH 进程

## Impact

- Affected specs: 无(新功能,不修改现有规格约束)
- Affected code:
  - `src/main/dsh-version.ts` — 新增模块
  - `src/main/index.ts` — 新增自动检查逻辑、窗口标题更新、更新弹窗、IPC 注册
  - `src/preload/index.ts` — 新增 API 暴露
  - `src/renderer/loading.html` — 底部显示版本号

## 技术方案

### 版本信息读取

已安装的 DSH 版本号通过读取 `findCachedDshEntry()` 找到的 DSH 包目录下的 `package.json` 中的 `version` 字段获取。`dsh-manager.ts` 中的 `resolveDshBin()` 已经在读取 `package.json`,需要将其提取为可复用的导出函数 `getInstalledDshVersion()`。

### 最新版本查询

复用 `dsh-repair.ts` 中已有的 `fetchLatestVersion()` 逻辑(请求 `https://registry.npmjs.org/@deepseek-ai/dsh/latest`),将其提取到 `dsh-version.ts` 作为公共函数,`dsh-repair.ts` 改为从 `dsh-version.ts` 导入。

### 自动检查时机

在 `startDshAndLoad()` 中,DSH Web UI 加载完成后(`mainWindow.loadURL(dshProcess.url)` 之后),异步触发版本检查。检查为异步操作,不阻塞用户使用。若检测到有新版本,使用 `dialog.showMessageBox()` 弹出原生 Windows 对话窗,提供"立即更新"和"稍后"两个按钮。

### 更新执行流程

用户点击"立即更新"后:
1. 复用 `repairDsh()` 下载最新版 DSH 包到用户缓存目录
2. 下载完成后调用 `stopDsh()` 停止当前 DSH 进程
3. 调用 `startDsh()` 重新启动(此时 `findCachedDshEntry()` 会优先找到新下载的版本)
4. `mainWindow.loadURL()` 重新加载 DSH Web UI
5. 更新窗口标题中的版本号

### 版本展示

- **窗口标题**: DSH 加载就绪后,窗口标题设为 `DSH Desktop - v{版本号}`
- **加载页面**: loading.html 底部追加一行显示 `当前版本: v{版本号}`,通过新增 IPC 通道 `get-installed-version` 在加载页面渲染时获取

### 网络容错

- 版本检查失败(网络超时、registry 不可达)时静默忽略,不影响应用正常使用
- 不在 loading 阶段阻塞,仅在 DSH 就绪后异步检查
- 弹窗仅在检测到确有新版本时出现

## ADDED Requirements

### Requirement: DSH 版本检测

系统 SHALL 在 DSH 服务就绪后自动检查 `@deepseek-ai/dsh` 的 npm registry 最新版本,并与本地安装版本比对。

#### Scenario: 检测到新版本

- **WHEN** DSH 服务就绪且 npm registry 返回的最新版本号大于本地安装版本
- **THEN** 弹出原生对话框显示当前版本、最新版本
- **AND** 提供"立即更新"和"稍后"两个选项

#### Scenario: 已是最新版本

- **WHEN** 本地版本等于或大于 registry 最新版本
- **THEN** 不弹出任何提示,静默处理

#### Scenario: 网络检查失败

- **WHEN** npm registry 不可达或请求超时
- **THEN** 静默忽略错误,不影响应用正常使用

### Requirement: 一键更新 DSH

系统 SHALL 在用户点击"立即更新"后,自动下载最新版 DSH 包并重启服务。

#### Scenario: 用户选择立即更新

- **WHEN** 用户在更新对话框中点击"立即更新"
- **THEN** 系统下载最新版 DSH 包到用户缓存目录
- **AND** 停止当前 DSH 进程
- **AND** 重新启动 DSH 服务(使用新下载的版本)
- **AND** 重新加载 DSH Web UI 到主窗口

#### Scenario: 更新失败

- **WHEN** 下载或解压过程中出错
- **THEN** 弹出错误对话框显示失败原因
- **AND** 保持当前版本继续运行,不影响使用

### Requirement: 已安装版本展示

系统 SHALL 在应用界面中展示当前安装的 DSH 版本号。

#### Scenario: 窗口标题显示版本

- **WHEN** DSH 服务加载就绪
- **THEN** 主窗口标题栏显示 `DSH Desktop - v{版本号}`

#### Scenario: 加载页面显示版本

- **WHEN** loading.html 渲染时
- **THEN** 页面底部显示 `当前版本: v{版本号}`
- **AND** 若无法获取版本号则显示 `当前版本: 未知`

## MODIFIED Requirements

### Requirement: Preload API 扩展

`window.dsh` API SHALL 新增以下方法:

| 方法 | 返回 | 说明 |
|------|------|------|
| `checkUpdate()` | `Promise<{hasUpdate: boolean, currentVersion: string, latestVersion: string, error?: string}>` | 触发版本检查 |
| `getInstalledVersion()` | `Promise<string>` | 获取当前安装的 DSH 版本号 |

#### Scenario: 渲染进程调用版本检查

- **WHEN** 渲染进程调用 `window.dsh.checkUpdate()`
- **THEN** 主进程查询 npm registry 并比对本地版本
- **AND** 返回检查结果对象

### Requirement: IPC 通道扩展

系统 SHALL 新增以下 IPC 通道:

| 通道 | 方向 | 说明 |
|------|------|------|
| `check-update` | renderer → main (invoke) | 触发版本检查 |
| `get-installed-version` | renderer → main (invoke) | 获取已安装版本号 |
