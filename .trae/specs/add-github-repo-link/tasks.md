# Tasks

- [x] Task 1: 主进程新增 GitHub 仓库跳转能力
  - [x] SubTask 1.1: 在 `src/main/index.ts` 新增仓库 URL 常量 `GITHUB_REPO_URL = 'https://github.com/ycowner/deepseek-harness-desktop'`
  - [x] SubTask 1.2: 新增 `open-external` IPC 通道（`ipcMain.handle`），校验 url 后调用 `shell.openExternal` 并尽量捕获异常返回结果
- [x] Task 2: preload 暴露 `window.dsh.openExternal`
  - [x] SubTask 2.1: 在 `src/preload/index.ts` 新增 `openExternal: (url: string) => ipcRenderer.invoke('open-external', url)`
- [x] Task 3: 注入 GitHub 图标到 DSH 主界面右上角
  - [x] SubTask 3.1: 在 `src/main/index.ts` 新增 `injectGitHubLink()`（参考 `injectUpdateBadge()`），以 `data-dsh-github-link` 判重，注入 GitHub octocat 内联 SVG 图标，固定在 `top:16px; right:16px`
  - [x] SubTask 3.2: 图标 `click` 时调用 `window.dsh.openExternal(GITHUB_REPO_URL)`
  - [x] SubTask 3.3: 在 `startDshAndLoad()` 与 `performUpdate()` 的 DSH 就绪加载后，与更新徽标并列调用 `injectGitHubLink()`
  - [x] SubTask 3.4: 调整 `injectUpdateBadge()` 的垂直位置（下移到 GitHub 图标下方），保证两者共存时不重叠
- [x] Task 4: 编译验证
  - [x] SubTask 4.1: 运行 `npm run build` 通过 TypeScript 编译检查

# Task Dependencies
- [Task 3] 依赖 [Task 1] 与 [Task 2]（注入需先有 IPC 与 preload API）
- [Task 4] 依赖 [Task 1][Task 2][Task 3]