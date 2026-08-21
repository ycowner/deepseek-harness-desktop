# Checklist

- [x] IPC 通道 `open-external` 在 `src/main/index.ts` 中实现，并通过 `shell.openExternal` 打开外链
- [x] preload 暴露 `window.dsh.openExternal(url)`，映射到 `open-external` IPC
- [x] `injectGitHubLink()` 在 DSH 主界面右上角注入 GitHub octocat 内联 SVG 图标，并用 `data-dsh-github-link` 判重
- [x] 点击 GitHub 图标即以系统默认浏览器打开 `https://github.com/ycowner/deepseek-harness-desktop`，应用窗口保持打开
- [x] GitHub 图标与"应用有更新"徽标共存时右上角垂直堆叠、互不遮挡
- [x] `startDshAndLoad()` 与 `performUpdate()` 成功加载 DSH 后均触发 GitHub 图标注入
- [x] `npm run build` 通过 TypeScript 编译检查，无类型错误