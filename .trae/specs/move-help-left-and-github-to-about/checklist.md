# Checklist

- [x] 标题栏布局为 `[应用图标] DSH Desktop [帮助]`，按钮在窗口化/最大化下均不与标题重叠、可点击
- [x] 点击「帮助」按钮，原生菜单在按钮正下方弹出（左侧坐标下验证窗口化与最大化两种场景）
- [x] `.help-btn` 的 WCO `@supports` 定位块已删除，无残留 CSS
- [x] DSH 页面右上角不再出现 GitHub 浮动图标
- [x] 更新横幅出现/关闭时无 JS 报错（`[data-dsh-github-link]` 联动代码已全部清除，无残留引用）
- [x] `injectGitHubLink()`、`adjustFloatingIconsPosition()` 函数及全部调用点已删除
- [x] 「关于」模态框的「GitHub 仓库」按钮带 GitHub octocat 图标（图标 + 文字），点击在系统默认浏览器打开仓库、应用窗口不关闭
- [x] `GITHUB_REPO_URL` 注释已更新，`open-external` IPC 通道保留且受 `isTrustedSender` 守卫不变
- [x] AGENTS.md §5.4 `open-external` 触发方描述已同步（无「DSH UI 中的 GitHub 图标」表述）
- [x] `npm run build` 编译通过
- [x] `npm run dev` 启动流程正常（loading → DSH UI 加载无异常日志）

> 验证说明：`npm run build` 三段构建全部通过；`npm run dev` 主进程启动正常、titlebar 页面加载无 JS 报错、无未定义函数错误。DSH 子进程在 TRAE 沙箱内因 EPERM（写用户目录 `~/.dsh/` 被沙箱拦截）无法完整拉起，属环境限制（应用正常以管理员权限运行），与本次改动无关；建议用户在本地非沙箱环境跑一次 `npm run dev` 做最终视觉确认。
