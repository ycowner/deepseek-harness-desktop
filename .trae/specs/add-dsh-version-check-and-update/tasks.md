# Tasks

- [x] Task 1: 创建 `dsh-version.ts` 版本检测模块
  - [x] SubTask 1.1: 从 `dsh-manager.ts` 提取 `getInstalledDshVersion()` 函数,读取已找到的 DSH 包 package.json 的 version 字段
  - [x] SubTask 1.2: 从 `dsh-repair.ts` 提取 `fetchLatestVersion()` 函数到 `dsh-version.ts` 作为公共导出
  - [x] SubTask 1.3: 新增 `checkForUpdate()` 函数,比对本地版本与 registry 最新版本,返回 `{ hasUpdate, currentVersion, latestVersion }`

- [x] Task 2: 修改 `dsh-repair.ts` 和 `dsh-manager.ts` 适配模块重构
  - [x] SubTask 2.1: `dsh-repair.ts` 中的 `fetchLatestVersion()` 改为从 `dsh-version.ts` 导入
  - [x] SubTask 2.2: `dsh-manager.ts` 导出 `findCachedDshEntry()` 供 `dsh-version.ts` 调用读取版本号

- [x] Task 3: 修改 `src/preload/index.ts` 暴露新 API
  - [x] SubTask 3.1: 新增 `checkUpdate()` 方法,通过 `ipcRenderer.invoke('check-update')` 调用主进程
  - [x] SubTask 3.2: 新增 `getInstalledVersion()` 方法,通过 `ipcRenderer.invoke('get-installed-version')` 调用主进程

- [x] Task 4: 修改 `src/main/index.ts` 实现自动检查与更新流程
  - [x] SubTask 4.1: 注册 IPC 通道 `check-update` 和 `get-installed-version`
  - [x] SubTask 4.2: 在 `startDshAndLoad()` 中 DSH Web UI 加载完成后异步触发版本检查
  - [x] SubTask 4.3: 检测到新版本时用 `dialog.showMessageBox()` 弹窗,提供"立即更新"和"稍后"按钮
  - [x] SubTask 4.4: 用户点击"立即更新"时调用 `repairDsh()` → `stopDsh()` → `startDsh()` → `loadURL()` 完成更新
  - [x] SubTask 4.5: DSH 就绪后更新窗口标题为 `DSH Desktop - v{版本号}`

- [x] Task 5: 修改 `src/renderer/loading.html` 显示版本号
  - [x] SubTask 5.1: 页面底部新增版本号显示元素
  - [x] SubTask 5.2: 页面加载时调用 `window.dsh.getInstalledVersion()` 获取并显示版本号

- [x] Task 6: 编译验证
  - [x] SubTask 6.1: 运行 `npm run build` 进行 TypeScript 编译检查
  - [x] SubTask 6.2: 运行 `npm run dev` 验证启动流程和版本检查功能

# Task Dependencies

- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 1]
- [Task 4] depends on [Task 1] 和 [Task 3]
- [Task 5] depends on [Task 3]
- [Task 6] depends on [Task 1] 到 [Task 5] 全部完成
