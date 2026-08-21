# Tasks

## 前置说明
- 新功能不修改既有 `add-dsh-version-check-and-update` 的 dsh 上游更新逻辑，仅复用其 `compareVersions`（本次导出）
- 开发模式（`app.isPackaged === false`）跳过全部桌面应用更新逻辑
- 安装包命名约定：`DSH-Desktop-Setup-{version}.exe`（连字符格式，匹配时宽松归一化空格为连字符）；发布 tag：`v{version}`

## Task 列表

- [x] Task 1: 导出 `dsh-version.ts` 的 `compareVersions()` 供复用
  - [x] SubTask 1.1: 将 `dsh-version.ts` 中私有 `function compareVersions` 改为 `export function compareVersions`
  - [x] SubTask 1.2: `npm run build` 编译通过（无改动报错）

- [x] Task 2: 新增 `src/main/app-update.ts` 桌面应用版本检测模块
  - [x] SubTask 2.1: 定义常量：GitHub/Gitee 仓库、`releases/latest` API URL、下载 URL 模板、安装包命名模板
  - [x] SubTask 2.2: 实现 `getInstalledAppVersion()`：返回 `app.getVersion()`
  - [x] SubTask 2.3: 实现 `fetchGithubLatest()`：请求 GitHub `releases/latest`，解析 `tag_name` 与匹配 `DSH Desktop Setup {version}.exe` 的 asset（`name` + `browser_download_url`）
  - [x] SubTask 2.4: 实现 `fetchGiteeLatest()`：请求 Gitee `releases/latest`，解析 `tag_name` 与匹配 exe 的 asset（`name` + `browser_download_url`）
  - [x] SubTask 2.5: 实现 `checkForAppUpdate()`：先 GitHub 后 Gitee 双源回退，复用 `compareVersions` 比对，返回 `{ hasUpdate, currentVersion, latestVersion, assetName, downloadUrl, source, error? }`
  - [x] SubTask 2.6: 实现 `getInstallDir()`：`path.dirname(app.getPath('exe'))`
  - [x] SubTask 2.7: 实现 `downloadAppUpdate(downloadUrl, destPath, onProgress)`：Node `https` 流式下载、跟随重定向、边下边写、进度回调
  - [x] SubTask 2.8: 实现 `getDownloadedAppPath(version)`：`安装目录/DSH-Desktop-Setup-{version}.exe`；目标文件已存在则跳过下载

- [x] Task 3: 修改 `src/preload/index.ts` 暴露新 API
  - [x] SubTask 3.1: 新增 `getAppVersion()`：`ipcRenderer.invoke('get-app-version')`
  - [x] SubTask 3.2: 新增 `installUpdate()`：`ipcRenderer.send('install-update')`

- [x] Task 4: 修改 `src/main/index.ts` 实现桌面应用更新全流程
  - [x] SubTask 4.1: 注册 IPC `get-app-version`（返回 `app.getVersion()`）与 `install-update`（弹「立即更新/稍后更新」对话框，立即更新走安装流程）
  - [x] SubTask 4.2: 窗口标题改为 `DSH Desktop v{appVersion} - DSH v{dshVersion}`（DSH 就绪后）
  - [x] SubTask 4.3: DSH 就绪后异步调用 `checkForAppUpdate()`；有更新则后台 `downloadAppUpdate()` 到安装目录
  - [x] SubTask 4.4: 下载完成后调用 `injectUpdateBadge()`：`executeJavaScript` 向 DSH UI 注入右上角悬浮按钮「应用 v{版本} · 有更新」，`addEventListener` 绑定点击 → `window.dsh.installUpdate()`，带防重标记
  - [x] SubTask 4.5: 实现安装流程 `performAppUpdate()`：校验安装包存在 → `stopDsh()` → 提示用户 → `spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()` 打开安装向导 → `app.quit()`
  - [x] SubTask 4.6: 开发模式（`!app.isPackaged`）跳过更新检查与安装流程

- [x] Task 5: 修改 `src/renderer/loading.html` 显示应用版本
  - [x] SubTask 5.1: 页面底部增加「应用版本: v{版本号}」显示元素
  - [x] SubTask 5.2: 页面加载时调用 `window.dsh.getAppVersion()` 获取并显示，失败显示「未知」

- [x] Task 6: 编译与流程验证
  - [x] SubTask 6.1: `npm run build` TypeScript 编译通过
  - [x] SubTask 6.2: `npm run dev` 验证：启动流程正常、开发模式不触发更新检查、loading 页显示应用版本
  - [x] SubTask 6.3: 复查不触碰既有 dsh 更新逻辑、`DSH_PACKAGE_MISSING_ERROR_NAME`、`requestedExecutionLevel`

# Task Dependencies

- [Task 2] depends on [Task 1]（复用 `compareVersions`）
- [Task 3] 无依赖
- [Task 4] depends on [Task 2] 和 [Task 3]
- [Task 5] depends on [Task 3]
- [Task 6] depends on [Task 1] 到 [Task 5] 全部完成
