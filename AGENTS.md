# AGENTS.md — dsh-web-desktop

> 面向 AI 编码代理（Claude Code / OpenCode / Codex / Cursor / Aider / Devin / Gemini CLI 等）的项目指南。
> 本文档描述仓库结构、构建命令、架构决策、禁区与踩坑点。修改前请通读一遍。

---

## 1. 项目身份

| 项     | 值                                                                |
| ----- | ---------------------------------------------------------------- |
| 包名    | `dsh-web-desktop`                                                |
| 中文名   | DSH Desktop / DeepSeek Harness Web 桌面客户端                         |
| AppId | `com.dsh.desktop`                                                |
| 产品名   | `DSH Desktop`                                                    |
| 版本    | `1.0.0`                                                          |
| 协议    | MIT                                                              |
| 目标平台  | **仅 Windows x64**（`win: { target: nsis, arch: x64 }`）            |
| 权限模型  | 安装包以**管理员权限**运行（`requestedExecutionLevel: requireAdministrator`） |

**项目定位**：把 `npx @deepseek-ai/dsh web` 这个 CLI 命令封装成一个 Windows 桌面应用。终端用户双击图标即可启动 DSH Web 服务并加载其界面，无需接触终端或浏览器。

DSH 包本体（`@deepseek-ai/dsh`）不在本仓库源码中，而是由构建脚本预下载、内置进安装包。**本仓库只负责"外壳"**。

---

## 2. 技术栈

| 层     | 选型                                                             |
| ----- | -------------------------------------------------------------- |
| 运行时   | Electron `^33.0.0`                                             |
| 构建    | electron-vite `^2.3.0` + Vite `^5.4.0`                         |
| 语言    | TypeScript `^5.5.0`（`strict: true`，`target: ES2022`）           |
| 打包    | electron-builder `^25.0.0`（NSIS 安装包）                           |
| 内置运行时 | Node.js v24.21.0 LTS（Windows x64，zip 包形式内置到 `resources/node/`） |
| 子进程   | `child_process.spawn`（DSH 跑在独立子进程，与 Electron 主进程隔离）            |

**架构形态**：经典 Electron 三段式（main / preload / renderer），渲染层是**多页面**（`titlebar.html` + `loading.html` + `error.html`）；窗口为自定义标题栏（WCO，`titleBarStyle: 'hidden'` + `titleBarOverlay`，标题栏页面加载于主 webContents，内容页加载于 `dshView` WebContentsView 子视图）；DSH Web UI 通过 `dshView.webContents.loadURL()` 直接加载远程 127.0.0.1 服务，不经过 Vite bundle。

---

## 3. 仓库结构

```
.
├── AGENTS.md                    ← 你正在看的文件
├── package.json                 ← npm 脚本与依赖
├── electron.vite.config.ts      ← 三段式 Vite 构建配置
├── electron-builder.yml         ← NSIS 打包配置
├── tsconfig.json                ← 渲染层 TS 配置
├── tsconfig.node.json           ← 主进程/Preload TS 配置（含 composite）
├── .gitignore
├── build/                       ← 构建期静态资源（图标等）
│   ├── icon.ico                 ← 主进程运行时窗口图标
│   ├── whale-icon-source.jpg    ← 图标源文件（PNG 转换用）
│   └── whale-icon-v2.jpg
├── scripts/                     ← 构建辅助脚本（CommonJS）
│   ├── download-node.js         ← 下载内置 Node.js（npmmirror → nodejs.org 双源）
│   ├── preinstall-dsh.js        ← 预下载 DSH 包到 resources/dsh-bundled/
│   ├── archive-dist-exe.js      ← 把 dist-exe 归档到 dist-exe-archives/<时间戳>/
│   ├── patch-latest-yml-size.js ← 补齐 latest.yml 缺失的 files[].size（differentialPackage: false 的副作用）
│   ├── verify-release.js        ← 上传前校验：sha512 / size / version 一致性，打印有序上传步骤
│   ├── generate-icon.js
│   └── png-to-ico.ps1
├── src/
│   ├── main/                    ← 主进程
│   │   ├── index.ts             ← 应用入口、窗口（WCO 标题栏 + 内容子视图）、IPC 路由、帮助菜单、模态框注入
│   │   ├── dsh-manager.ts       ← DSH 进程生命周期（启动/停止/健康检查/端口/依赖完整性）
│   │   ├── dsh-repair.ts        ← DSH 在线修复（两阶段：prepare staging / activate）
│   │   ├── dsh-version.ts       ← DSH 版本检查、semver 比较、packument integrity 查询、npm 双源并行取最大、GitHub 上游版本信息查询（仅手动检查告知）
│   │   ├── app-update.ts        ← 客户端更新元数据检查（拉 {publish.url}/latest.yml、版本比较、清单文件名净化）+ 遗留安装包清理
│   │   ├── auto-updater.ts      ← 客户端自动下载/安装（electron-updater 单例封装、状态机、进度节流、提示后安装决策）
│   │   ├── changelog.ts         ← 更新日志获取（上/本项目 GitHub Releases）+ 安全 markdown 渲染
│   │   ├── injected-theme.ts    ← 注入式 UI 共享资产（--dsh-* 令牌 + ICONS + FONT_STACK）
│   │   ├── injected-modal.ts    ← 注入式模态框层（关于 / 两个更新日志，720px 大卡，见 §6.7）
│   │   ├── notice.ts            ← 公告拉取/校验/已读状态（notifications.json，见 §6.8）
│   │   ├── notice-banner.ts     ← 公告横幅注入层（DSH 页顶部堆叠，见 §6.8）
│   │   ├── dsh-dialog.ts        ← 自绘对话框层（Shadow DOM + 队列 + 原生兜底，见 §6.7）
│   │   ├── node-binary.ts       ← 内置 Node 二进制路径解析
│   │   └── deepseek-balance.ts  ← DeepSeek 余额查询（DSH 凭据解析 + /user/balance + 轮询订阅，见 §6.6）
│   ├── preload/
│   │   └── index.ts             ← contextBridge 暴露的 window.dsh.* API
│   └── renderer/                ← 渲染层（纯 HTML，不走框架）
│       ├── titlebar.html        ← 自定义标题栏（深色 #202020、应用图标 + 标题文字 + 「帮助」文字按钮，加载于主窗口 webContents）
│       ├── loading.html         ← 启动等待页（CSS 动画 + status 文本）
│       ├── error.html           ← 错误页（重试 + 在线修复按钮）
│       └── renderer.ts          ← 仅 console.log 占位
├── resources/                   ← 运行时资源（被 .gitignore，产物）
│   ├── node/                    ← 内置 Node.js（由 download-node.js 生成）
│   └── dsh-bundled/             ← 预装 DSH 包（由 preinstall-dsh.js 生成）
```

> 根目录有 `dist/`、`dist-electron/`、`dist-exe*/`、`msi/`、`.eb-cache/` 等大量历史构建产物目录，**全部是构建或归档产物，不要当作源码修改**。

---

## 4. npm 脚本

| 脚本               | 命令                                                                            | 用途                                                 |
| ---------------- | ----------------------------------------------------------------------------- | -------------------------------------------------- |
| `dev`            | `electron-vite dev`                                                           | 开发模式：起 Vite + Electron，自动加载 loading.html           |
| `build`          | `electron-vite build`                                                         | 仅编译到 `dist/`，不打安装包                                 |
| `start`          | `electron-vite preview`                                                       | 用生产模式跑已构建产物（不打包）                                   |
| `download-node`  | `node scripts/download-node.js`                                               | 下载内置 Node.js 到 `resources/node/`；`--force` 强制重下    |
| `preinstall-dsh` | `node scripts/preinstall-dsh.js`                                              | 预下载 DSH 包到 `resources/dsh-bundled/`                |
| `package`        | `electron-vite build && electron-builder && node scripts/archive-dist-exe.js` | 完整发布：编译 → 打包 NSIS → 归档到 `dist-exe-archives/<时间戳>/` |
| `postinstall`    | `node scripts/download-node.js`                                               | `npm install` 后自动跑，确保开发期 `resources/node/` 存在      |
| `prepackage`     | `node scripts/download-node.js && node scripts/preinstall-dsh.js`             | `npm run package` 前自动跑，确保打包资源就绪                    |

**典型工作流**：

- 日常开发：`npm install`（自动下载 Node）→ `npm run dev`
- 改完代码验证：`npm run build`（不打包，纯编译检查）
- 发版：`npm run package`（产物在 `dist-exe/<版本号>/`，归档在 `dist-exe-archives/<时间戳>/`）

---

## 5. 架构

### 5.1 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 主进程 (src/main/index.ts)                        │
│  ├── BrowserWindow (titleBarStyle: hidden + WCO)            │
│  │   ├── 主 webContents ──► titlebar.html（拖拽区+设置/帮助 │
│  │   │                      +余额徽章+更新/更新DSH 按钮）   │
│  │   └── dshView (WebContentsView 子视图，标题栏以下全部区域)│
│  │        └─► loading.html → error.html → loadURL(dsh URL)  │
│  ├── IPC 路由  ──► 'status' / 'retry' / 'repair-dsh' / 'repair-progress'  │
│  │                'check-update' / 'get-app-version' / 'get-installed-version'│
│  │                'open-external' / 'show-help-menu' / 'get-app-icon'     │
│  │                'get-balance' / 'refresh-balance' / 'balance-tooltip'   │
│  │                'get-titlebar-update-state' / 'titlebar-client-update'  │
│  │                'titlebar-dsh-update'                                   │
│  ├── 帮助菜单  ──► 标题栏按钮触发 Menu.popup：检查更新 /      │
│  │                更新日志（DSH 运行包 / 客户端）/ 关于       │
│  ├── 客户端更新  ──► R2 latest.yml 检测 → 点亮标题栏「更新」按钮 →   │
│  │                用户确认后下载 251MB（DSH 页顶部显示进度横幅）    │
│  └── 子进程管理 ──► spawn(内置 node.exe + 缓存的 DSH 入口)   │
│                                                             │
│       ┌──────────────────────────────────────────┐           │
│       │  DSH 子进程 (独立进程, 跑内置 Node)      │           │
│       │  node resources/dsh-bundled/... web      │           │
│       │  监听 127.0.0.1:<port>  (默认 3080)      │           │
│       └──────────────────────────────────────────┘           │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  Preload (src/preload/index.ts)                             │
│  contextBridge.exposeInMainWorld('dsh', {                   │
│    retry, getErrorInfo, onStatus, repairDsh, onRepairProgress│
│    getTitlebarUpdateState, onTitlebarUpdateState,            │
│    clientUpdateClicked, dshUpdateClicked                     │
│  })                                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  渲染层 (titlebar.html / loading.html / error.html)         │
│  通过 window.dsh.* 与主进程通信；DSH Web UI 直接由           │
│  dshView.webContents.loadURL() 加载（不经 Vite bundle）     │
│  （状态提示在标题栏；下载进度横幅仅在 downloading 阶段注入 DSH 页）│
└─────────────────────────────────────────────────────────────┘
```

> **窗口结构关键约束**：`titlebar.html` 必须加载在 BrowserWindow **自身的 webContents** 上，`dshView` 是覆盖标题栏以下区域的 WebContentsView 子视图。Window Controls Overlay 的 `env(titlebar-area-*)` CSS 环境变量**只在主 webContents 中生效**，在 WebContentsView 子视图中恒为 0（实测踩坑，见 §12.2 第 21 条）。

### 5.2 启动流程（`src/main/index.ts` 的 `startDshAndLoad()`）

1. 发送状态文字到 loading 页面（IPC `status`）。
2. 调 `startDsh()`（`dsh-manager.ts`）：
   1. 校验 `resources/node/node.exe` 存在。
   2. 检查默认端口 3080：若被占且**已是 DSH** → 复用（不启新进程）；若被占且**非 DSH** → 递增端口找可用（最多 20 次）。
   3. 按优先级找 DSH 入口（详见 §6.2）。
   4. `spawn(内置 node.exe, [入口脚本, 'web', '--port', <port>])`，监听 stdout/stderr 解析出 `http://127.0.0.1:<port>`。
3. `waitForDshReady(url, 60_000)`：每 500ms HTTP GET 探测一次。
4. 就绪后 `mainWindow.loadURL(dshUrl)`；超时则 `loadErrorPage(...)`。
5. 抛错时若 `err.name === DSH_PACKAGE_MISSING` → 在错误信息末尾追加 `[CODE:DSH_PACKAGE_MISSING]`，错误页面据此显示"在线修复"按钮。

### 5.3 系统托盘与关闭流程

- **系统托盘**（1.0.8 起）：启动后 `createTray()` 创建常驻托盘图标（复用 `getWindowIconPath()`，tooltip "DSH Desktop"，图标加载失败时仅记日志跳过），右键菜单含四项：「打开主界面」（`showMainWindow()`：恢复/显示/聚焦，窗口已销毁时兜底重建）/ DeepSeek 余额（只读项，随查询结果由 `updateTrayMenu()` 重建，原生菜单无法逐项着色，警示态用 ⚠ 符号 + 文案）/「刷新余额」（`refreshBalance('tray')`）/「退出」（`confirmAndQuit()`）。详见 §6.6。
- **退出确认**：窗口关闭（WCO 关闭按钮 / Alt+F4，由 `mainWindow.on('close')` 拦截 `preventDefault`）与托盘「退出」复用同一 `confirmAndQuit()`：先弹确认框（`isQuitting` 互斥锁防重复弹框），取消则复位锁继续运行；确认后先 `tray.destroy()`（防 Windows 托盘幽灵图标）再 `app.quit()`，第二次 close 事件因 `isQuitting=true` 放行。
  - 踩坑：渲染层 JS 的 `window.close()`（如 CDP 触发）会绕过 BrowserWindow 的 `close` 事件，无法被拦截；真实用户操作（X 按钮 / Alt+F4）走 WM_CLOSE → `close` 事件，可正常拦截。
- `window-all-closed` 事件 → 兜底 `tray.destroy()` → `stopDsh()` → Windows 上用 `taskkill /f /t` 杀整棵进程树（普通 `child.kill()` 杀不掉 npx 派生的子进程）。
- macOS 分支不退出（保留 dock 行为），但当前**未配置 macOS 打包目标**（见 §9）。

### 5.4 IPC 通道

| 通道                | 方向                       | 触发方                  | 说明                                                                    |
| ----------------- | ------------------------ | -------------------- | --------------------------------------------------------------------- |
| `status`          | main → renderer          | 主进程任意时刻              | 启动进度文字                                                                |
| `retry`           | renderer → main          | error.html "重试" 按钮   | 主进程 stop → 重新加载 loading → 重新启动                                     |
| `repair-dsh`      | renderer → main (invoke) | error.html "在线修复" 按钮 | 返回 `{ success, cachePath?, error? }`；受 `isRepairing` 互斥锁保护            |
| `repair-progress` | main → renderer          | repairDsh 进度回调       | 步骤文字（"正在下载..." / "解压完成" 等）                                        |
| `check-update`    | renderer → main (invoke) | 性能检测 / 调试            | 返回 `{ hasUpdate, currentVersion, latestVersion, error? }`                |
| `get-app-version` | renderer → main (invoke) | loading.html          | 返回 `app.getVersion()`                                                |
| `get-installed-version` | renderer → main (invoke) | loading.html       | 返回已安装的 DSH 版本号                                                       |
| `get-titlebar-update-state` | renderer → main (invoke) | titlebar.html 首帧 | 返回 `TitlebarUpdateState`（client 含 `show`/`phase`/`percent`/`version` + dsh）；仅 `event.sender === mainWindow.webContents` 放行 |
| `titlebar-update-state` | main → renderer        | `pushTitlebarUpdateState()` | 状态变化即推送单条合并快照，驱动标题栏两个更新按钮显隐与 title 提示 |
| `titlebar-client-update` | renderer → main (send) | titlebar.html「更新」按钮 | 按 `phase` 走四条互斥分支：`available` → [下载并更新]/[取消]；`downloading` → [取消下载]/[继续下载]（`defaultId` 与 `cancelId` 都给「继续」，误按回车不会丢掉已下的一半）；`downloaded` → [立即重启安装]/[下次启动时安装]/[取消]；`error` → [重试下载]/[浏览器下载]/[取消]。仅标题栏页可触发 |
| `titlebar-dsh-update` | renderer → main (send) | titlebar.html「更新DSH」按钮 | 弹「vX → vY」确认框（`defaultId: 1` 默认焦点给「取消」，因为更新会停服务、装 518 个包）；确认后走 `performUpdate()`（`isUpdating` 互斥锁保护）。仅标题栏页可触发 |
| `open-external`   | renderer → main (invoke) | 关于模态框 GitHub 按钮 | 在系统默认浏览器打开 URL；受 `isTrustedSender` 守卫，仅允许 `http(s)` 协议              |
| `show-help-menu`  | renderer → main (send) | 标题栏「帮助」按钮       | 校验 sender 为主窗口 webContents 后，以按钮页内坐标（窗口相对坐标，见 §12.2 第 23 条）`Menu.popup` 弹出原生菜单（检查更新 / 更新日志子菜单 / 关于）|
| `help-menu-closed`| main → renderer        | 主进程 `menu-will-close` | 通知 titlebar.html 复位「帮助」按钮的 hover/active 类，防止原生菜单弹出期间鼠标事件被屏蔽导致的交互态颜色残留（见 §12.1 第 24 条）|
| `get-app-icon`    | renderer → main (invoke) | titlebar.html        | 返回应用图标 32×32 PNG data URL（nativeImage 读取 icon.ico）；受 `isTrustedSender` 守卫，失败返回空串（页面侧隐藏图标） |
| `get-balance`     | renderer → main (invoke) | titlebar.html 徽章初始化 | 返回当前 DeepSeek 余额快照 `BalanceSnapshot`（只含状态与数字，绝不含 API Key）；受 `isTrustedSender` 守卫，不受信任时返回 net 态占位 |
| `refresh-balance` | renderer → main (send) | titlebar.html 徽章点击 / 托盘「刷新余额」 | 触发一次余额查询（`refreshBalance('manual' \| 'tray')`）；结果经 `balance-update` 推送。受 `isTrustedSender` 守卫 |
| `balance-update`  | main → renderer        | 主进程 `onBalanceUpdate` 订阅回调 | 每次查询完成后推送最新快照，驱动标题栏徽章渲染与托盘菜单重建 |
| `balance-tooltip` | renderer → main (send) | titlebar.html 徽章悬停/离开 | 参数 `(open, html?)`：主进程将 tooltip 面板（内容 HTML 由标题栏页构建）注入 DSH 内容页 `#dsb-tooltip` 展示/关闭。受 `isTrustedSender` 守卫 |
| `dsh-dialog-response` | renderer → main (send) | 内容页内自绘对话框的按钮 | 参数 `(id, index)`：用户点选后回传按钮下标。守卫比 `isTrustedSender` 更严——直接比对 `event.sender === dshView.webContents`（只有被注入宿主的那个页面能回传），且 `id` 与当前活动对话框不符的过期点击一律丢弃。详见 §6.7 |
| `notice-read` | renderer → main (send) | 公告横幅的「× 关闭」 | 参数 `id`：回传已读。`markNoticeRead` 内部按 `^[A-Za-z0-9._-]{1,64}$` 校验，非法值只记日志不落盘。见 §6.8 |
| `get-notice-state` | renderer → main (invoke) | titlebar.html 铃铛首帧 | 返回 `{ unread, hasBanner }`，避免早于/晚于推送导致红点状态错位。仅主窗口 webContents 可调 |
| `notice-refresh` | renderer → main (send) | titlebar.html 铃铛点击 | 立即拉一次公告并展示。任何环境都执行（含开发期），是验证公告 UI 的主要入口。见 §6.8 |
| `notice-state` | main → renderer | `pushNoticeState()` | 公告摘要推送，驱动铃铛红点（用户关掉一条横幅后未读数会变） |

所有敏感通道（`install-update` / `repair-dsh` / `open-external` / `get-balance` / `refresh-balance` / `balance-tooltip`）的 IPC handler 入口都过 `isTrustedSender(event)`：
仅允许 `file:`（本地 loading/error 页）或 loopback `http(s)`（DSH 页面）的 senderFrame。防止外部页面或被劫持的 webContents 触发高危操作。
`show-help-menu` 与三条标题栏更新通道（`get-titlebar-update-state` / `titlebar-client-update` / `titlebar-dsh-update`）则直接比对 `event.sender === mainWindow.webContents`（更严格：只有标题栏页面能触发）。

**帮助菜单结构**（标题栏「帮助」按钮 → 原生菜单）：
- 检查更新... → 弹 dialog 选择检查项（DSH 运行包 / 客户端 / 全部，原 show-update-menu 逻辑迁移至此）。手动检查 DSH 时 `fetchLatestVersion` 并行查 npmmirror 与 npmjs 的 dist-tags 取版本最大者，并附加查询上游 GitHub Releases（`dsh-v*` tag）：若 GitHub 有新版而 npm 未发布，对话框附加「尚未发布到 npm」告知；自动检查/轮询只认 npm 可安装版本
- 更新日志 → 子菜单：DSH 运行包日志（上游 `deepseek-ai/deepseek-harness` Releases，tag 前缀 `dsh-v`）/ DSH Desktop 客户端日志（本项目 Releases，tag 前缀 `v`）
- 关于 DSH Desktop → 模态框（客户端版本号 + DSH 运行包版本号 + 内置 Node 运行时（版本 + ABI，走 `getBundledRuntimeInfo()`，查询失败时整行不渲染）+ GitHub 仓库链接按钮）

更新日志与关于模态框均通过 `dshView.webContents.executeJavaScript` 注入内容区（`[data-dsh-modal]`），单一实例互斥（`window.__dshModalCleanup`），Esc / 遮罩 / × 三种关闭方式；release notes 渲染走 `changelog.ts` 的 `renderMarkdownToHtml`（全文 HTML 转义 + 受限标签白名单，链接仅 `http(s)`）。

### 5.5 Preload API（`window.dsh`）

| 方法                     | 返回                                       | 说明                              |
| ---------------------- | ---------------------------------------- | ------------------------------- |
| `retry()`              | `void`                                   | 通知主进程重试                         |
| `getErrorInfo()`       | `string`                                 | 读取错误信息（优先 IPC，否则 URL query）   |
| `onStatus(cb)`         | `void`                                   | 订阅状态更新                          |
| `repairDsh()`          | `Promise<{success, cachePath?, error?}>` | 触发在线修复                          |
| `onRepairProgress(cb)` | `void`                                   | 订阅修复进度                          |
| `checkUpdate()`        | `Promise<UpdateCheckResult>`             | 主动检查 DSH 更新                    |
| `getInstalledVersion()`| `Promise<string>`                        | 读取 DSH 版本号                    |
| `getAppVersion()`      | `Promise<string>`                        | 读取桌面应用自身版本号                |
| `getTitlebarUpdateState()` | `Promise<TitlebarUpdateState>`     | 读取当前更新状态快照（不触发任何动作）；titlebar.html 首帧主动拉一次，避免早于/晚于推送导致按钮状态错位 |
| `onTitlebarUpdateState(cb)` | `void`                             | 订阅 `titlebar-update-state` 推送；回调收到 `{ client: {show, version, installOnNextLaunch}, dsh: {show, version} }`，按 `show` 控制两个按钮显隐 |
| `clientUpdateClicked()` | `void`                                | 标题栏「更新」按钮点击上报（意图上报，确认框与安装动作全在主进程）|
| `dshUpdateClicked()`   | `void`                                   | 标题栏「更新DSH」按钮点击上报（同上）|
| `openExternal(url)`    | `Promise<{success, error?}>`            | 在系统默认浏览器打开 URL               |
| `showHelpMenu(position)` | `void`                                 | 标题栏「帮助」按钮触发；把按钮坐标发给主进程，在按钮下方弹出原生帮助菜单（检查更新 / 更新日志 / 关于）|
| `onHelpMenuClosed(cb)` | `void`                               | 订阅帮助菜单关闭通知（主进程 `menu-will-close` 时发送）；titlebar.html 据此复位按钮交互态类名 |
| `getAppIcon()`     | `Promise<string>`                        | 读取应用图标 data URL（标题栏左侧图标显示用，失败返回空串）|
| `getBalance()`     | `Promise<BalanceSnapshot>`               | 读取当前 DeepSeek 余额快照（不触发查询；徽章初始化用）。快照只含状态与数字，绝不含 API Key |
| `refreshBalance()` | `void`                                   | 触发一次余额刷新（徽章点击；结果经 `onBalanceUpdate` 推送）|
| `onBalanceUpdate(cb)` | `void`                                | 订阅余额更新推送（启动 / 聚焦 / 5 分钟轮询 / 手动刷新均会推送）|
| `setBalanceTooltip(open, html?)` | `void`                        | 通知主进程余额明细 tooltip 开合；展开时附内容 HTML（标题栏页构建），主进程将其注入 DSH 内容页展示|
| `dialogResult(id, index)` | `void`                              | 自绘对话框的按钮回传（`id` 供主进程丢弃过期点击，`index` 为按钮下标）。由 dsh-dialog 注入内容页的 Shadow DOM 脚本调用，详见 §6.7 |
| `noticeRead(id)` | `void`                                    | 公告横幅「× 关闭」回传已读。由 notice-banner 注入内容页的 Shadow DOM 脚本调用，见 §6.8 |
| `getNoticeState()` | `Promise<{unread, hasBanner}>`           | 读取公告摘要（铃铛首帧用） |
| `onNoticeState(cb)` | `void`                                   | 订阅公告摘要推送（未读数变化时驱动红点） |
| `noticeRefresh()` | `void`                                    | 点铃铛：立即拉一次并展示（任何环境都执行） |

> 注：上表未收录 `showSettingsMenu` / `onSettingsMenuClosed` / `onThemeChanged` 等更晚间新增的方法，以 [src/preload/index.ts](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/preload/index.ts) 的 api 对象为准。

---

## 6. 内置 Node.js 与 DSH 包

### 6.1 内置 Node.js

- 版本：**v24.21.0 Windows x64**（写在 `scripts/download-node.js` 顶部 `NODE_VERSION`），ABI `process.versions.modules` = **137**，内置 npm 11.19.0（含 node-gyp 12.4.0）。
- **压缩包完整性：`NODE_ZIP_SHA256` 钉值校验**。下载后、解压前用流式 SHA256 与钉值比对，不匹配则删临时包并 `exit(1)`；钉值取自官方 `https://nodejs.org/dist/v<版本>/SHASUMS256.txt` 里 `node-v<版本>-win-x64.zip` 那行。**升级 `NODE_VERSION` 时必须同步更新 `NODE_ZIP_SHA256`**，否则 `npm install` / `npm run package` 会直接失败。旧的 `resources/node/` 清理已下移到校验通过之后，校验失败不会破坏现有可用二进制。
- 下载源：先 `https://npmmirror.com/mirrors/node/...` 国内镜像（302 到 `cdn.npmmirror.com/binaries/node/...`），失败回退 `https://nodejs.org/dist/...`。
- 解压用 PowerShell 的 `Expand-Archive`。脚本末尾会校验落地 `node -v` 与 `NODE_VERSION` 一致，不一致直接退出（防 `--force` 未生效或残留旧目录）。
- **打包后**保留 `node.exe` + **完整内置 npm**（`node_modules/npm`，含其 bundle 的全部依赖，体积约 +11MB）。npm 用于 **dsh 在线更新时给下载的包补装运行时依赖**（dsh-repair 的 `installPackageDependencies`）。`extraResources` 仅排除 corepack、`dist-types/**`、`.d.ts`、`.md`、`docs/`、`man/`，详见 `electron-builder.yml`。
- **升级内置 Node 的 major 属于破坏性变更**：必须按 `download-node --force` → `preinstall-dsh`（重建 `resources/dsh-bundled/` 与 `resources/node/.npm-cache/`，使源码编译型原生模块按新 ABI 产出）→ 完整 `npm run package` 的顺序执行，并留意用户侧 `%LOCALAPPDATA%/DSH Desktop/dsh-cache/` 里按旧 ABI 编译的缓存——该情形由 `dsh-manager.ts` 的启动自愈（失效缓存 aside + 回退 `dsh-bundled`）兜底，见 §12.1 第 25 条。
- **内置 npm 会随内置 Node 一起跳 major**（v22 → npm 10.9.3，v24 → npm 11.19.0），npm 的大版本行为漂移会直接落到 dsh-repair 的 `npm install <tgz>` 链路上，升级后必须实测确认，见 §12.1 第 26 条。

### 6.2 DSH 包查找优先级（`dsh-manager.ts` 的 `findCachedDshEntry()`）

1. **`%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/`**（在线修复/更新下载的缓存）—— **首选**，用户显式更新的版本应优先于出厂预装，否则更新永远不生效
2. **`resources/dsh-bundled/`**（打包时预装的独立目录，出厂版本；缓存不存在或无效时回退到此）
3. **`resources/node/.npm-cache/_npx/`**（打包预装的 npx 缓存，仅开发环境）
4. **`%LOCALAPPDATA%/DSH Desktop/npm-cache/_npx/`**（用户运行时 npx 缓存）

> 关键点：DSH 包**必须独立存放**到 `resources/dsh-bundled/`，**不能**塞进 `resources/node/node_modules/`，否则会被 `extraResources` 的 `!**/node_modules/**` 排除掉。

### 6.3 启动命令

```text
<内置 node.exe> <DSH 入口脚本> web --port <port> --no-open
```

- 通过 `--port` 显式传端口（DSH 实际不读 `PORT` 环境变量，这条坑在 `dsh-manager.ts` 注释里有写）。
- **必须传 `--no-open`**。DSH web 启动器（`@deepseek-ai/dsh-web-app` 0.1.1-rc.2 起）默认会在服务 ready 后通过 `open` npm 包打开系统默认浏览器。这条调用链发生在 DSH 子进程自己 fork 的进程里，完全不走 Electron webContents，主进程现有的 `setWindowOpenHandler` 拦不到。`--no-open` 由 web 启动器的 commander 解析，把 `webStartup.openBrowser` 设为 `false`，子进程就不会调 `open` 包，系统浏览器不会被自动打开，UI 由 `BrowserWindow.loadURL` 加载。
- 设置独立的 `npm_config_cache` / `npm_config_prefix` 到 `%LOCALAPPDATA%/DSH Desktop/npm-cache/`，避免继承系统全局配置触发 EPERM。

### 6.4 用户可写缓存目录

| 路径                                      | 用途                                                               |
| --------------------------------------- | ---------------------------------------------------------------- |
| `%LOCALAPPDATA%/DSH Desktop/dsh-cache/` | 在线修复下载的 DSH 包                                                    |
| `%LOCALAPPDATA%/DSH Desktop/npm-cache/` | 运行时 npm/npx 缓存（必须可写，因为 `resources/node/` 在 `Program Files` 下是只读） |

两个目录都在用户级，跨应用启动复用，卸载应用不自动删除。

### 6.5 桌面应用客户端更新架构

| 项     | 说明                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 更新源   | Cloudflare R2，经自持域名 `https://download.dsh.392700.xyz` 分发（`electron-builder.yml` 的 `publish` 段）      |
| 检测方式  | `src/main/app-update.ts` 拉 `GET {publish.url}/latest.yml`（`fetchLatestUpdateInfo` → `checkForAppUpdate`）      |
| 更新方式  | **按需下载 + 可见进度**：检测到新版本只点亮标题栏「更新」按钮，**不自动下载**。用户点按钮 → 确认框 [下载并更新]/[取消] → 才开始下载 251MB，期间 DSH 页顶部显示进度横幅（百分比 + 已下载量 + 速度），标题栏按钮同步呈「下载中 N%」进度态、点击可取消。**下完自动弹** [立即重启安装]/[下次启动时安装]/[取消]（同一版本只自动弹一次，错过可点标题栏「更新」按钮补弹）；失败时按钮仍在，点开是 [重试下载]/[浏览器下载]/[取消] |
| 展示位置  | 状态提示在标题栏 `titlebar.html` 的 `.tb-actions` flex 容器（余额徽章右侧）；**下载进度**在 DSH 页顶部横幅（`#dsh-ub`，纯展示零 IPC 面，取消入口只在标题栏按钮上）。二者由 `pushTitlebarUpdateState()` + `syncAppUpdateBanner()` 分别投影，同一次状态变化里成对更新 |
| 降级语义  | **标题栏按钮是进度的权威载体，横幅只是可降级副本**。两者走不同通道——按钮走 `mainWindow.webContents.send()`（无任何 guard），横幅走 `dshView.webContents.executeJavaScript()`（有准入判定 + 异常路径）。因此横幅挂掉时进度不丢，连续 3 次注入失败即 `console.error` 醒目降级并停止空打 CDP，本次下载的进度改由标题栏独占承载 |
| 守卫    | 版本号经 `isValidVersion` 校验；清单文件名做路径分隔符净化（禁协议前缀与 `/`、`\`）；三条标题栏更新 IPC 均比对 `event.sender === mainWindow.webContents` |
| 遗留清理  | `cleanupLegacyInstallers()` 启动时一次性清理历史版本下载到安装目录的安装包                                                      |

自 1.0.3 至 1.0.16 期间走的是「检测 → 引导打开 GitHub Release 页面手动下载」，`electron-builder.yml` 不配 `publish` 段。自 1.0.17 起改回应用内一键更新，重新引入 `electron-updater@^6.8.9` 并配置 `publish` 段。

> **历史误区更正**：1.0.3 的记录曾写「打包不再生成 `resources/app-update.yml`」——**这是错的**。electron-builder 只要能推断出发布目标就会生成该文件：1.0.16 的实际产物 `win-unpacked/resources/app-update.yml` 内容为 `provider: github` + `updaterCacheDirName: dsh-web-desktop-updater`，来源是 `package.json` 的 `repository` 字段，与 `publish` 段无关。该文件必须存在——`AppUpdater.getOrCreateDownloadHelper()` 会读它拿 `updaterCacheDirName`（决定下载中转目录 `%LOCALAPPDATA%\dsh-web-desktop-updater\pending\`），缺失则下载阶段直接报错。

以下实现约束（详见 `auto-updater.ts` 文件头注释）都是踩过坑之后定下来的，不要凭直觉「简化」掉：

- **`autoDownload = false`**：刻意关掉 electron-updater 自带的「一发现就自动下」。它的触发时机是 `checkForUpdates()` 成功那一刻，而我们的检测走 `app-update.ts` 拉 `latest.yml`（有完整的错误处理与三态返回），两条链路要各跑一次才能对齐。现在由 `index.ts` 在**用户点了「下载并更新」之后**才显式调 `downloadAppUpdate()`，符合「不点不下载」的交互约定。
- **`autoInstallOnAppQuit = false`**：electron-updater v6 该字段**默认为 `true`**，且 `BaseUpdater.executeDownload` 在下载完成的回调里就注册 `app.on('quit')` 处理器。保持默认 `true` 会导致用户点了「稍后」也在下次退出时被静默安装，违背「提示后安装」的交互约定。
- **重开应用不会白下第二遍**：`DownloadedUpdateHelper.validateDownloadedPath` 在真正下载前会核对缓存目录（`%LOCALAPPDATA%\dsh web desktop-updater\pending\`，目录名取自 `app-update.yml` 的 `updaterCacheDirName`）里的 `update-info.json` 与安装包 sha512，命中就完全跳过下载、直接派发 `update-downloaded`。这条缓存路径同时覆盖两种场景：静默期遗留的半成品，以及用户「下次启动时安装」后没装成。**不要绕过它自己另存一份「已下载」状态**。
- **取消下载必须显式持有 `CancellationToken`**：`AppUpdater.downloadUpdate(token)` 接受外部 token 并透传到 `electronHttpExecutor`（其 `createPromise` 在 cancel 时 reject `CancellationError`），且 `doDownloadUpdate` 的 catch 会先 `removeFileIfAny()` 删掉半截文件。不传 token 就只能等它自己下完。
- **判断「被取消」用标志位，不要用 `instanceof CancellationError`**：本项目 `builder-util-runtime` 有两份副本——运行时（electron-updater）9.7.0、构建工具链（electron-builder）9.2.10，是不同的类对象，跨副本 `instanceof` 恒为 false（`tsc` 会在这一步直接报 TS2345）。已把 `package.json` 依赖声明成 `^9.7.0` 让运行时收敛成一份，但只要依赖解析再分叉就会静默失效——把用户主动取消误判成下载失败并弹「重试下载」。统一用 `cancelRequested` 标志位。
- **按钮除 idle 外全部显示**：`buildTitlebarUpdateState()` 令 `show = phase !== 'idle'`。`available`（等你点）、`downloading`（可取消）、`downloaded`（可安装）、`error`（可重试）四个阶段对用户都是「有事等你处理」，藏起来反而让人以为没检测到。`pushTitlebarUpdateState()` + `syncAppUpdateBanner()` 在同一次 `onAppUpdateState` 回调里成对触发。
- **进度横幅只在 downloading 阶段出现**：其余阶段由标题栏按钮承载，横幅留着只会重复。横幅纯展示、**零 IPC 面**（无点击事件），所以取消入口只在标题栏按钮上，不必再开一条受信任 sender 才能触发的通道。
- **标题栏按钮配色与对比度**（已实测）：客户端天蓝 `#0369A1` on `rgba(14,165,233,.14)` ≈ 4.69:1；运行包 DeepSeek 官方蓝系 `#3A56D8` on `rgba(77,107,254,.12)` ≈ 4.65:1（直接用官方色 `#4D6BFE` 只有 4.38:1，**不达 4.5:1，不要改回去**）。深色主题另有浅色字版本。
- **按钮用 flex 不用固定 `left`**：余额徽章宽度是动态的（¥ 符号、金额位数、万/亿单位都会改变宽度），固定像素排更新按钮必须先知道徽章实际宽度，不可靠。`.tb-actions` 是 `left:242px` 起的 flex 容器。实测坐标：设置 130–178 / 帮助 186–234 / 徽章 242–321 / 更新 329–373 / 更新DSH 381–450；下载中态按钮变宽到 329–415，更新DSH 顺移到 423–492，距 WCO 边界（800−138=662）最紧时仍余 170px。
- **横幅投影的任何一次失败都必须留痕，绝不静默 `return`**：真机 61% 冻结事故里，`isDshPageLoaded()` 的布尔准入判定和 `.catch(() => {})` 两个失效点**都不会让主进程报错**，所以「按钮在动、页面正常、横幅不动」是可以同时成立的。现在的规则是：准入失败记下 `getURL()` 的具体原因（同一原因只打一次，避免导航抖动刷屏）、注入失败计数并在 `BANNER_FAIL_DEGRADE_AT = 3` 时打 `console.error` 降级。**把 catch 重新写回空的 `() => {}` 等于把 61% 冻结的根因装回去。**
- **进度是变化驱动的，必须配周期性重投影兜底**：`syncDownloadPeriodicReprojection()` 在 downloading 期间每 3 秒无条件再投影一次。它不依赖进度事件——没有新进度就没有事件，一旦某次投影丢了，页面恢复了也不会有下一次变化来触发它。定时器仅在 downloading 期间存在，离开时清 timer 并重置全部诊断状态（`bannerFailureStreak` / `bannerLastError` / `bannerDegradedLogged` / `bannerSkipUrl`），否则一次降级会永久影响后续每一轮下载。
- **横幅注入脚本宁可少更新一个字段也不要抛异常**：`executeJavaScript` 一旦 reject 就是横幅冻结（异常被吞）。所以内部是判空后逐个 `setText()`，任何一个子节点缺失只跳过它；元素被 SPA 摘除（`el.isConnected === false`）时先 `remove()` 再重建，否则 `getElementById` 会一直返回游离节点、后续赋值全部无效。
- **下载完成后自动弹安装确认框**：`onClientUpdatePhaseChange()` 做「非 downloaded → downloaded」跃迁检测，命中才调 `promptInstallTiming()`。`lastPromptedDownloadVersion` 保证同一版本只自动弹一次，**且在 `phase === 'downloading'` 时清空**——否则「下载完 → 取消 → 重新下载 → 完成」会被永久压制。自动弹窗与用户点按钮共用 `promptInstallTiming()`，靠 `installPromptOpen` 互斥锁防两个框叠加。当前不判窗口前台（最小化也会弹），要改成「仅前台」在函数开头加一行 `if (!mainWindow.isFocused()) return` 即可。
- **停滞看门狗只提示、不自动重试**：`startDownloadStallWatchdog()` 每 2 秒比对 `Date.now() - progressAt`，超过 `DOWNLOAD_STALL_THRESHOLD_MS = 8000` 就置 `stalled`，横幅与按钮改显「速度为 0，已等待 N 秒」。8 秒的依据是上游 1 秒一次 + 我方 2 秒节流，连续 4 次缺失才算真卡住。**不要加自动重试**——会引入并发下载与半截文件风险。定时器都调了 `unref()`，退出路径（`quitAndInstallAppUpdate` / `window-all-closed`）必须 `stopDownloadStallWatchdog()` + `stopDownloadPeriodicReprojection()`。
- **`dshView` 必须监听渲染进程健康**：`createWindow()` 里 `unresponsive` / `responsive` / `render-process-gone` / `did-fail-load` / `did-navigate-in-page` 五个都要挂。`dshView` 崩了或卡住时横幅会静默停在旧值，而这些事件是唯一能拿到原因的入口；`did-navigate-in-page` 还要顺带触发一次重投影（页面换路由后 DOM 里没有横幅节点了）。

发布流程配套要求：安装包与 `latest.yml` 传到 R2 桶 `dsh-desktop`，**先传 exe、最后传 latest.yml**（反序会出现客户端拉到新元数据却下不到包的窗口期）。上传前跑 `node scripts/verify-release.js` 核对 sha512/size。GitHub Release 仍需保留（更新日志入口 + 人工兜底下载），每个 release 的 **tag 必须以 `v` 开头**。`notifications.json` 与 `latest.yml` 同源，**但没有版本号语义**，可随时覆盖上传（注意 CDN 缓存，必要时加时间戳）。

> **同版本号重推收不到**：`app-update.ts` 的判定是 `compareVersions(current, latest) >= 0 → up-to-date`。已装 X 的用户拉不到同为 X 的新包。1.0.17 因 R2 上已有同名包被判定作废重来（用户确认无人下载）。若将来要作废某一版，必须先确认 R2 控制台无该版下载记录。

### 6.6 DeepSeek 余额查询（`src/main/deepseek-balance.ts`）

| 项     | 说明                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------- |
| API Key 来源 | 复用 DSH 的凭据规则：**进程环境变量 `DEEPSEEK_API_KEY` 优先**，其次 `$DSH_HOME/.credentials.yaml` 的 `refs.DEEPSEEK_API_KEY`（`DSH_HOME` 未设时为 `~/.dsh`）。该文件由 DSH 进程自行读写，本模块**只读**，行解析（不引 YAML 依赖），解析失败降级为 `nocfg` 状态 |
| 查询接口   | `GET https://api.deepseek.com/user/balance`（官方公开接口），`Authorization: Bearer <key>`，走 Electron `net.fetch`（遵循 §12.1 第 18 条），10s 超时 `AbortController` |
| 刷新时机   | DSH 就绪后首次（`refreshBalance('startup')`）→ 每 5 分钟轮询（`startBalancePolling`）→ 窗口聚焦（30s 防抖）→ 徽章点击 / 托盘「刷新余额」 |
| 状态机     | `ok` / `low`（余额不足：`is_available=false` 或余额 ≤ 0）/ `auth`（401）/ `nocfg`（无 Key）/ `net`（网络或 HTTP 错误）/ `relay`（`DEEPSEEK_BASE_URL` 指向非官方域名）/ `loading` |
| 展示形态   | 标题栏 `titlebar.html` 常驻徽章（状态圆点 + `¥金额`，悬停出明细 tooltip：总余额/充值/赠送/更新时间——面板经主进程注入 DSH 内容页展示，见 §12.1 第 27 条）；托盘菜单第二项同步展示（原生菜单无逐项着色，警示态用 ⚠ 符号 + 文案） |
| 安全约束   | API Key 只存在于主进程模块内：日志仅打掩码（前 6 位 + 长度）、绝不进渲染层快照、绝不注入 dshView；相关 IPC 全部过 `isTrustedSender` |
| 并发保护   | `inFlight` 互斥（无并发请求）；`pollTimer.unref()` 不拖住进程；退出路径 `stopBalancePolling()` |

### 6.7 自绘对话框层（`src/main/dsh-dialog.ts`）

替换系统 `dialog.showMessageBox` / `showErrorBox` 的自绘对话框。**19 处调用点已全部迁移**（原 18 个 `showMessageBox` + 1 个 `showErrorBox`），`index.ts` 里已不再直接引用 `dialog`；系统弹窗仅作为对话框层内部的兜底路径存在。

| 项     | 说明                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 为什么自绘 | `dialog.showMessageBox` 是**系统原生窗口**，`MessageBoxOptions` 只暴露 `type`/`message`/`detail`/`buttons`/`defaultId`/`cancelId`/`noLink` 等语义参数，**没有任何颜色/字体/圆角/按钮形态钩子**。不做自绘就没有"现代化"这条路。原生弹窗也没有可套用的组件库（它们作用在 DOM 上，碰不到系统窗口） |
| 承载位置 | 注入 `dshView`（`did-finish-load` 调 `ensureDialogHost`）。dshView 叠在主 webContents **之上**，标题栏页的 DOM 在被覆盖区域永远不可见，因此全屏遮罩只能活在 dshView 内。**此钩子刻意不加 `isDshPageLoaded` 守卫**：退出确认最常发生在 error 页（DSH 起不来时用户点关闭），loading/error/DSH 三种页面都要能弹 |
| 样式隔离 | 挂在 **Shadow DOM**（`attachShadow`）里，样式与宿主页面（DSH 自己的 UI，可能带 Tailwind 预处理）完全隔离，不受其全局 reset / 基础样式影响。`:host { all: initial }` 挡页面侧的通用选择器 |
| 视觉   | **磨砂玻璃卡片 + 大圆角**：卡片 24px，遮罩另叠 `blur(6px)` 让整屏背景先"化开"，半透明卡片才有东西可折射（两层 blur 是刻意叠加，不是重复）。`--dsh-dlg-*` 令牌是唯一色源 |
| 文字层级 | 三段各一风格、**每级各带一个内联 SVG 图标**（无 emoji）：① `message` 13.5px 正文色 + 中性横杠 `bullet`；② `detailTone: 'notice'` 风险/错误类 —— 3px 琥珀竖条 + 淡琥珀底 + 警示三角 + 13px 正文色；③ `detail` 缺省即 `'meta'` 版本信息类 —— 淡中性底 + tag 标签 + 12.5px 次级色。19 处调用点：7 处显式 `notice`、9 处 `meta`、3 处无 detail |
| 按钮尺寸 | `lead`（主，13px / 34px / `min-width: 112px` 填色）、`minor`（次级，12px / 30px 描边）、`ghost`（取消，12px 纯文字）。**`lead` 的 `min-width` 不是凑数**：4 汉字的「全部检查」按内容排版会比 5 汉字+拉丁的「检查DSH运行包」更窄，不撑开就谈不上"主按钮最大" |
| 按钮排布 | `.foot` 默认 `flex-wrap: wrap`；**按钮数 ≥ 4 时 `buildDialogSpec` 置 `tight: true`**，切 `flex-wrap: nowrap` + 8px 间距作为硬保护（宁可横向压缩也不退回两行按钮） |
| 预览   | `node scripts/preview-dialog.js` → `docs/dialog-preview.html`。**两层都被覆盖**：对话框侧 spec 走真实的 `buildDialogSpec()`（生成时跑 `assertDerivation()`），模态框侧注入代码由真实的 `buildModalHostScript()` / `buildModalUpdateScript()` 生成（生成时跑 `assertModalStructure()`）。任一自检不过直接抛错、中止生成。深链：`#sample` / `#meta` / `#failed` / `#picker` / `#quit` / `#modal-about` / `#modal-changelog`，任意形态加 `-dark` 后缀切深色 |
| 交互 | Esc → `cancelId`；回车 → `defaultId`（初始焦点）；点遮罩 → `cancelId`；Tab 在按钮间闭环（模态必须锁焦点）；`role="dialog"` + `aria-modal`；动画 140/160ms 且尊重 `prefers-reduced-motion` |
| 队列   | 同一时刻只显示一个，多余请求 FIFO 排队（原生弹窗是系统层叠放，用队列复刻"逐个确认"，避免两个遮罩互相踩） |
| 兜底   | `dshView` 不可用 / 页面导航中 / 注入失败 → 回落 `dialog.showMessageBox`，返回值形状与语义完全一致。导航打断时按 `cancelId` 主动收敛并丢弃积压队列——否则注入节点随文档销毁，等待中的 Promise 会永久挂起 |
| 先后顺序 | `loadErrorPage()` 是 fire-and-forget，要实现「先切错误页、再弹对话框」必须 `loadErrorPage(...)` 后紧跟 `await waitForNextDialogHost()` 把两步串起来。反过来（先弹后导航）注入节点会随文档销毁，弹窗被当「被中断」收敛，用户根本看不到。`waitForNextDialogHost` 内部会**立刻**作废上一页的 `hostReady`——导航事件 `did-start-loading` 是异步派发的，晚于当前调用栈 |
| 守卫   | `dsh-dialog-response` 直接比对 `event.sender === dshView.webContents`，且 `id` 与当前活动对话框不符的过期点击一律丢弃 |
| 按钮排布 | `.foot` 是 `flex-wrap: wrap`，`.btn` 为 `flex: none` + `white-space: nowrap`。中英混排文案（如「检查 DSH Desktop 客户端」）估算单行放不下时**整体换行**，而不是把单个按钮挤成两行 |

**迁移时最容易丢的三件事**：

1. **`defaultId` 是键盘语义，不是视觉强调。** 现有代码有四处刻意把 `defaultId` 给「取消 / 继续下载」——运行包更新会打断会话、下载中误按回车会丢掉已下的 251MB。自绘层把两者拆开：`defaultId` 管初始焦点与回车，`primaryId` 管主按钮填色。样板那处就是 `defaultId: 1, cancelId: 1, primaryId: 0`。
2. **`primaryId` 缺省推导为「第一个非 cancelId 的按钮」**，多数场景正确，但当主操作恰好就是 `cancelId` 时会推导反。两处必须显式传值：`index.ts` 的客户端更新「下载中」框（`['取消下载','继续下载'] + cancelId: 1`，不覆盖会把破坏性的「取消下载」画成主按钮）与「检查更新」四按钮选择框（按钮顺序即优先级：全部检查 / 检查DSH运行包 / 检查客户端 / 取消，`defaultId` 与 `primaryId` 都是 0；**改按钮文案顺序时必须同步改下面的 `response` 分支**）。
3. **按钮顺序不翻转**，保持与原生一致的数组顺序，不改用户肌肉记忆。

`injectModalShell` 已抽到 **`src/main/injected-modal.ts`**，与 `dsh-dialog.ts` 对称：各自自带 CSS + 宿主脚本 + 构建器，共用 `injected-theme.ts` 的 `--dsh-dlg-*` 令牌、`ICONS`（含新增的 `doc`）、`FONT_STACK`。与对话框层的差别只有形态：

| | 对话框（`dsh-dialog`） | 模态框（`injected-modal`） |
|---|---|---|
| 卡片 | 460px 小卡 | 720px 大卡，`max-height: 80vh` |
| 玻璃 | `blur(20px)` / 0.72 | `blur(12px)` / 0.82（**有意降一档**：面积大 + 装长文档，两层大面积模糊叠加时弱显卡开销明显；降档后 muted 对比度反而从 4.78:1 升到 5.7:1） |
| 头部 | 类型图标 + 标题 | 类型图标（`info` / `doc`）+ 标题 + × |
| 正文 | 三段文字层级 | 可滚动 markdown（`h3/h4/h5` / 列表 / 行内代码 / 代码块 / 链接） |

两层**不合并**——模态框装的是文档，按钮行与三段层级对它没有意义。

**★ 结构铁律：`card` 必须在 `backdrop` 内部**（`backdrop.appendChild(card)`）。`backdrop` 才是那个负责 `flex` 居中的容器；卡片若与它平级，会同时出两个症状——顶到左上角不居中，且被带 `z-index` + 半透明 + `backdrop-filter` 的 `backdrop` 盖住，内容糊成一片。2026-09 踩过一次，图 3/4/5 三个入口全坏、而走对话框层的「检查更新…」正常。

Shadow DOM 迁移的代价：**外部选择器全部失效**，唯一入口是 `window.__dshModal = { shadow, update, cleanup }` ——
- `updateModalBody(wc, html)` 必须走 `__dshModal.update(html)`；
- 关于框的 GitHub 按钮绑定必须走 `__dshModal.shadow.querySelector('.about-repo')`；
- 锚点滚动目标必须用 `root.getElementById()` 而非 `document.getElementById()`。

`updateModalBody` 的 `catch` 保留了 `warn` 日志（不要改回空 catch）：它静默失败的表现是"更新日志一直转圈"，没有日志就只能靠猜。

余额 tooltip（`BALANCE_TOOLTIP_CSS`）也已玻璃化，`blur(14px)` + 16px 圆角（比卡片小，配 264px 宽面板）。它的 11–12px 小字是全应用对比度最紧的一处；`injectBalanceTooltipShell` 补了一次幂等的令牌写入，避免首次悬停早于 `syncInjectedTheme` 时令牌缺失。

### 6.8 公告（`src/main/notice.ts` + `notice-banner.ts`）

从**与安装包同一分发源**拉 `{UPDATE_FEED_URL}/notifications.json`。与 `latest.yml` 同源是刻意的：发布链路已跑通，**改公告内容不需要发版**。配置格式、字段表、硬限制与安全约束见 [docs/notifications.schema.md](docs/notifications.schema.md)，可直接上传的示例见 `docs/notifications.example.json`。

| 项     | 说明                                                                                                    |
| ----- | ----------------------------------------------------------------------------------------------------- |
| 分层   | 数据侧 `notice.ts`（拉取/校验/已读/展示决策）／渲染侧 `notice-banner.ts`（横幅注入）／编排侧 `index.ts`（何时拉、投影到哪、何时弹） |
| 展示决策 | `planNotices()` 是**纯函数**（不碰网络与 DOM）：生效窗口过滤 → 未读过滤 → 按 error→warning→info 排序 → 横幅截断 3 条 → 模态全收。可在预览/自检里直接断言 |
| 形态   | `banner` 贴 DSH 页顶部堆叠（Shadow DOM，`[data-dsh-notice]`）；`modal` 走 `showDshMessageBox`，**延迟 10 秒**在 DSH 页就绪后弹（用户刚开应用通常正要干活，立刻拦体感差） |
| 与更新横幅错开 | 两条横幅都贴顶。公告横幅的 `top` 运行时读 `#dsh-ub` 的 `offsetHeight`（可见时用其高度，否则 0）。两套注入**不共享状态**，靠读对方实际布局避让 |
| 已读   | `%APPDATA%\dsh-web-desktop\notice-read.json`，形状 `{ read: { id: ISO 时间 } }`，上限 200 条按时间升序淘汰。读写策略照抄 `theme-store.ts`：读失败当空、写失败只记日志 |
| 拉取时机 | 启动（DSH 就绪后，不阻塞）／每 6 小时／点标题栏铃铛。**仅打包环境执行**，但 `manual`（点铃铛）任何环境都跑——开发期据此验证 UI |
| 失败语义 | 拉取失败在启动/周期路径**静默**（网络不通是常态）；只有点铃铛才弹「拉取失败」。`fetchNotices` 把 **404 视为「没有公告」**返回 `[]`——发布顺序上客户端可能先于 json 上线 |
| 编排互斥 | `noticeFetching` 防并发拉取；紧急通知经 `showDshMessageBox` 的 FIFO 队列，不会与更新确认框叠加；定时器全部 `unref()` |

**安全基线（远端内容要渲染进页面，这几条是硬约束，有生成期断言守着）**

1. `body` / `title` **永不 innerHTML**：页面侧只 `textContent` + `white-space: pre-wrap`。
2. `link.url` **只允许 `https:`**，`javascript:` / `data:` / `http:` 全部在解析期拒绝；页面侧走**既有的** `window.dsh.openExternal`（受 `isTrustedSender` 守卫 + 协议白名单），不新开 `shell.openExternal`。
3. **任一条字段非法 → 整份清单丢弃**，不做部分渲染（半截公告比没有公告更糟）。
4. 注入脚本里唯一的 `innerHTML` 是图标路径（`ICONS` 常量，非远端内容）。
5. 条数 ≤ 20、响应体 ≤ 256KB、已读 ≤ 200 条。`id` 白名单 `^[A-Za-z0-9._-]{1,64}$` 且不参与任何路径拼接。

**自检**：`node scripts/preview-notice.js` → `docs/notice-preview.html`。生成时跑三组断言，任一不过**直接抛错中止生成**：

- `assertValidation()`：12 类非法输入必须被拒（`javascript:`/`data:`/`http:` 链接、非法 id、id 超长、坏 type/level、坏时间窗、id 重复、条数超限、标题/正文超长、缺字段、非法 JSON、坏根节点），1 类合法输入必须通过
- `assertPlan()`：严重度排序 / 3 条截断 / 已读过滤 / 生效窗口
- `assertBannerSafety()`：正文必须 `textContent` 赋值、`innerHTML` 只出现 1 次（图标）、外链走 `openExternal`、关闭回传 `noticeRead`

---

## 7. 端口与进程管理

| 项            | 默认值                      | 行为                                                                                 |
| ------------ | ------------------------ | ---------------------------------------------------------------------------------- |
| 默认端口         | 3080                     | `DEFAULT_DSH_PORT`                                                                 |
| 端口递增上限       | +20                      | `MAX_PORT_RETRIES`，全部不可用则抛错提示 `netsh int ipv4 show excludedportrange protocol=tcp` |
| 端口已被 DSH 占用  | 复用                       | 不启新进程，`currentDshProcess.child` 为 `null` 占位                                        |
| 端口被非 DSH 占用  | 递增                       | 尝试 3081、3082...                                                                    |
| 健康检查超时       | 60 秒                     | `startDshAndLoad()` 中硬编码（DSH 已预装时通常 3-5 秒就绪）                                       |
| 健康检查轮询间隔     | 500ms                    | `HEALTH_CHECK_INTERVAL`                                                            |
| 单次 HTTP 探测超时 | 2s                       | `HTTP_PROBE_TIMEOUT`                                                               |
| 进程终止         | Windows `taskkill /f /t` | 必须杀整棵进程树，否则 npx 派生的子进程会残留                                                          |

> 端口检测显式绑 `127.0.0.1`（IPv4）而不是默认 `::`（IPv6），避免 Windows 上 IPv4/IPv6 端口排除范围分开导致的误判。

---

## 8. 打包（electron-builder）

- 输出目录：`dist-exe/<version>/`（`electron-builder.yml` 中 `output: dist-exe/${version}` 按版本号展开，每版本独立子目录互不覆盖）
- 归档目录：`dist-exe-archives/<YYYYMMDD_HHMMSS>/`（`scripts/archive-dist-exe.js` 仅归档本次版本子目录）
- 主进程代码 → `dist/` → 打包进 `asar`
- 运行时资源 → `extraResources`：
  - `node/`（内置 Node + 完整 npm；已排除 corepack / 文档 / 类型声明）
  - `dsh-bundled/`（预装 DSH 包；已排除类型声明，以及第三方包内的 sourcemap / 文档 / 测试目录 / lint 配置 / node-pty 非 win32-x64 预编译产物，见 §8.2.3）
  - `icon.ico`（窗口图标，主进程通过 `process.resourcesPath/icon.ico` 读取）
- 安装包：NSIS、`perMachine: true`、`oneClick: false`、`allowToChangeInstallationDirectory: true`
- 安装载荷：`nsis.useZip: true` + `nsis.differentialPackage: false`，安装时由 `nsisunz::Unzip` 直接解压到安装目录（见 §8.2.1，两者必须同时设置）
- Chromium 语言包：`win.electronLanguages` 只保留 `zh-CN` / `zh-TW` / `en-US`（默认 55 个 `.pak` / 41MB → 3 个 / 1.5MB）。只影响 Chromium 原生 UI 文案（网页右键菜单、内置错误页），DSH Web UI 自身 i18n 与此无关；`en-US` 是 Electron 兜底语言，不可删。
- 安装包命名：`DSH-Desktop-Setup-<version>.exe`（`artifactName` 连字符格式，避免上传平台对空格的处理）
- 发布配置：`publish` 段为 `provider: generic` + `url: https://download.dsh.392700.xyz`（electron-updater 每次检查只 `GET {url}/latest.yml`，换源只改这一个字符串）。**url 必须是自定义域名**，不能填 `r2.dev`（官方标注非生产用途，有可变速率限制且带宽同样被限速）。产物未签名故**不设 `win.publisherName`**——该字段一旦写入而产物无有效签名，electron-updater 会判定签名校验失败并直接拒绝安装。
- 体积说明：`extraResources` 缓存了核心 `node/` 内 npm（约 11MB）以满足 dsh 在线更新补依赖；排除了 corepack、文档、类型声明等无用文件（详见 `electron-builder.yml` 注释）。安装包约 **170MB**（zip 载荷，比 7z 时期的 145MB 大，换来安装耗时从 360s 降到 24s，见 §8.2）。

### 8.1 任务栏固定图标保留（NSIS 跨升级）

升级时务必保留 Start Menu 快捷方式与 AppUserModelID 注册表项，否则 Windows 任务栏上已被用户“固定”的 DSH Desktop 图标会被当作失效条目清理掉。机制由 **electron-builder 25 NSIS 模板自带**的三段逻辑提供，本仓库负责「为它供能量」：

1. **首次安装**时，electron-builder NSIS 模板会在 `installer.nsh` 的 `registryAddInstallInfo` 宏中执行 `WriteRegStr SHELL_CONTEXT "${INSTALL_REGISTRY_KEY}" "KeepShortcuts" "true"`，给本机抢下跨升级追踪凭证（历史 1.0.x 安装均已写入）。
2. **升级**时，新安装器读上一版本写入的 `KeepShortcuts=true`，并在调旧 `Uninstaller.exe` 时追附 `--keep-shortcuts`。隐藏前提是模板里的 ${isUpdated} 为真，否则 `setIsTryToKeepShortcuts` 会把 $isTryToKeepShortcuts 置回 false。
3. **旧 Uninstaller.exe** 在收到 `--keep-shortcuts` 后，会跳过 `Delete "$SMPROGRAMS\DSH Desktop.lnk"` 与 `WinShell::UninstAppUserModelId "${APP_ID}"` 两条，Start Menu 与 HKLM\SOFTWARE\Classes\AppUserModelID\com.dsh.desktop 双锚点都保留。

#### 8.1.1 ${isUpdated} 的编译期重定义（方案 B'，自 1.0.5 起）

自 1.0.3 起应用内不再自动安装（原 electron-updater 与 Gitee 回退源均移除，安装器失去 `--updated` 传递路径），手动双击升级时 keep-shortcuts 链路断裂、固定图标丢失。**修复**：`build/installer.nsh` 在编译期重定义了 `${isUpdated}` 的语义（强耦合 electron-builder 25 模板实现，升级 electron-builder 必须重新验证）：

- 新语义 = 「CLI 带 `--updated`」或「存在旧安装（HKLM `Software\<APP_GUID>\InstallLocation`）且已进入安装执行阶段」。
- 阶段分界：页面阶段（目录选择页 `skipPageIfUpdated`）拿到 false → 目录页正常显示且预填旧安装目录（可改目录，支持 `/D`）；安装执行阶段（`setIsTryToKeepShortcuts` / `uninstallOldVersion` / `CHECK_APP_RUNNING`）拿到 true → keep-shortcuts 激活，升级时自动结束运行中的应用（与 electron-updater 行为一致）。
- 阶段标记：非静默由 `customPageAfterChangeDir` 注入的空页面（目录页后、instfiles 前，`Abort` 跳过无 UI）置位；静默 `/S` 由 `customInit` 的 `${Silent}` 分支置位。
- 卸载器 pass 中两个标记 Var 为空串，`${isUpdated}` 退化为纯 CLI 检测，手动卸载行为与默认模板一致。
- 伴随行为（已确认接受）：升级后不重建用户已手动删除的桌面快捷方式。

> **1.0.17 补充**：应用内自动更新恢复后，`electron-updater` 的 `NsisUpdater.doInstall` 会再次向安装器传 `--updated`（见其源码 `const args = ["--updated"]`）。这条路径与方案 B' 的重定义语义一致，两者不冲突；手动双击升级仍不依赖任何 CLI 参数。
- 注意：旧文件中的 `NSIS_HOOK_PREINSTALL/POSTINSTALL/PREUNINSTALL` 是从未生效的死代码（electron-builder 25 无任何引用点）已删除；模板真正支持的钩子是 `customInit` / `customInstall` / `customUnInstall` / `customPageAfterChangeDir` / `preInit` 等。

附加护栏（与本机制互绑）：

- `electron-builder.yml` 的 `nsis.deleteAppDataOnUninstall: false`：本项目默认即为 false，显式写出来避免被误调为 true。
- `build/installer.nsh`：承载 §8.1.1 的 `${isUpdated}` 重定义与阶段标记机制（方案 B'），是固定图标保留链路的能量来源，不是纯文档文件。
- `src/main/index.ts` 的 `app.setAppUserModelId('com.dsh.desktop')` **必须在 `app.whenReady().then(...)` resolve 之前**调用，符合 Electron 官方契约，为运行时提供稳定的 AppUserModelID 关联。

调试时验证点（仅 Windows 用户机进行）：

1. 首次安装 1.0.x，启动后手动“固定到任务栏”。
2. 双击新版本安装包手动升级（无需任何 CLI 参数，方案 B' 会自动识别升级场景），若 DSH Desktop 正在运行会被自动结束。
3. 升级后重启期望：任务栏上原有图标仍在原位、能点开成功；升级过程中目录选择页正常显示且预填旧目录。

#### 8.1.2 应用图标变更发版阻断

`build/icon.ico` 是用户任务栏固定图标的二进制唯一底层资源（`electron-builder` 据此生成 `.exe` 的 Win32 资源、`installerIcon` / `uninstallerIcon`、以及快捷方式 `.lnk` 的嵌入图标 Hash）。**更换此文件仅作为发版阻断项处理**，不在常规 PR 范围中：

- `build/icon.ico` 在补 PR 范围内严禁替换；需要换图标必须独立发版分支，可能将触发用户任务栏固定图标的视觉刷新（但仍以一致身份刷新，不会丢失固定位置）。
- `scripts/generate-icon.js` 是该文件的唯一生成入口，仅限于专为发布而启用的脚本调用。
- `resources/icon.ico` 是打包后运行时被 `BrowserWindow.icon` 读取的窗口图标，由 `electron-builder.yml` 的 `extraResources` 从 `build/icon.ico` 打包而来，同时与该入口保持同步，不要独立修改。

社区背景：electron-builder issue [#2514](https://github.com/electron-userland/electron-builder/issues/2514) 、[#926](https://github.com/electron-userland/electron-builder/issues/926) 与 PR [#5312](https://github.com/electron-userland/electron-builder/pull/5312) 说明该问题在上游仅覆盖了桌面快捷方式的边缘场景；历史上本仓库是通过「传 `--updated`」走出一条未必经上游显式支持的路径，在跨升级下仍能保留任务栏固定图标。自 1.0.3 起应用内自动更新移除后，`--updated` 传递路径断裂；1.0.5 起改由 §8.1.1 的编译期重定义方案在安装器内部重建该链路，手动双击升级不再依赖任何 CLI 参数。

**修改打包配置后必须验证**：

1. `npm run package` 全流程能跑通
2. 生成的安装包能在干净 Windows 上首次启动成功（首次会用到在线修复 / 缓存查找）
3. 窗口图标（`build/icon.ico`）和打包后 `resources/icon.ico` 同步更新

### 8.2 安装耗时优化（zip 直解 + 产物裁剪 + 跳过 atomicRMDir）

1.0.14 之前全新安装需 **360s**、升级需 **349s**；而同机 `robocopy /MT:1` 复制同一棵落地树只要 24.7s（Defender 实时保护关闭、NVMe SSD），即九成时间耗在安装管线自身而非磁盘 I/O。三处改动后：全新安装 **24.4s**、稳态升级 **34.8s**、卸载 9.5s。

#### 8.2.1 安装载荷：zip 直解（`nsis.useZip` + `nsis.differentialPackage: false`）

electron-builder 25 的 `NsisTarget.js` 里 `USE_NSIS_BUILT_IN_COMPRESSOR = false` 是硬编码常量，常规 `nsis` target 必然走「把 win-unpacked 打成单个归档内嵌进安装器」的路径。默认归档是 7z，模板 `extractAppPackage.nsh` 的 `extractUsing7za` 会：

1. `File /oname=$PLUGINSDIR\app-64.7z` —— 归档写到 **%TEMP%**
2. `Nsis7z::Extract` 解压到 `$PLUGINSDIR\7z-out` —— 全部文件在 %TEMP% 落地一遍
3. `CopyFiles /SILENT "$PLUGINSDIR\7z-out\*" $OUTDIR` —— 再用 SHFileOperation 单线程复制到安装目录
4. 安装器退出时 NSIS 清理 `$PLUGINSDIR` —— 把 %TEMP% 那份全删掉

即**同一份产物落盘三趟**（1.0.14 的 18,888 个文件 → 约 5.7 万次文件操作、1.3GB 写盘），且要求 %TEMP% 预留约 750MB。改用 zip 后模板走 `decompress` 的另一分支 `nsisunz::Unzip "$PLUGINSDIR\app-64.zip" "$INSTDIR"`，**直接解压到安装目录**，中转与复制两趟消失。代价是 deflate 压缩率低于 LZMA2，安装包变大（145MB → 170MB，已被 §8.2.3 的裁剪部分抵消）。绑定约束见 §12.1 第 31 条。

`differentialPackage: false` 的副作用：不再生成 `.blockmap`（`latest.yml` 仍生成，但缺 `size` 字段，且自 1.0.3 起无消费方）。

#### 8.2.2 升级 / 卸载：`customRemoveFiles` 跳过 atomicRMDir

`uninstaller.nsh` 在 `${isUpdated}` 为真时调 `un.atomicRMDir`：把安装目录内**每个文件逐个 Rename 到 `$PLUGINSDIR\old-install\`** 并为每个目录建镜像，再 `RMDir /r`，退出时删 %TEMP% 镜像。本项目 §8.1.1 的方案 B' 让 `${isUpdated}` 升级时恒为真，因此每次升级多付约 5.8 万次文件系统操作；更严重的隐患是 `$PLUGINSDIR` 在系统盘 %TEMP%，而安装器允许改安装目录，装到非系统盘时跨卷 `Rename` 会退化成「整份复制 + 删除」。

`build/installer.nsh` 用官方钩子 `customRemoveFiles` 替换为一句 `RMDir /r "$INSTDIR"`。详见 §12.1 第 32 条。该宏与 §8.1.1 的 keep-shortcuts 链路互不干涉：`${ifNot} ${isKeepShortcuts}` 分支在文件删除块之后，未被触碰；实测新安装器仍正确写入 `KeepShortcuts=true` 与 `InstallLocation`，开始菜单 `.lnk` 的 `System.AppUserModel.ID` 仍为 `com.dsh.desktop`。

#### 8.2.3 产物裁剪

| 裁剪项 | 位置 | 省掉 |
| --- | --- | --- |
| `*.map` | `dsh-bundled` filter | 4,627 个 |
| 第三方包 `*.md` | `dsh-bundled` filter | 467 个 |
| `test/` `tests/` `__tests__/` | `dsh-bundled` filter | 1,243 个 |
| `.github/`、`.eslintrc*`、`.nycrc*`、`.editorconfig` | `dsh-bundled` filter | 73 个 |
| node-pty 非 win32-x64 prebuilds | `dsh-bundled` filter | 12 个 / 约 19MB |
| Chromium 语言包（`win.electronLanguages` 只留 zh-CN / zh-TW / en-US） | Electron 层 | 52 个 / 约 39MB |

落地文件 18,888 → **12,414**，落地体积 543.7MB → **446MB**。两条硬约束见 §12.1 第 33、34 条。

#### 8.2.4 实测数据与验证方法

| 场景 | 1.0.14 基线 | 优化后 | 变化 |
| --- | --- | --- | --- |
| 全新安装 | 360.3s | **24.4s** | -93.2% |
| 升级（从 1.0.14 升上来，含旧卸载器 atomicRMDir） | 348.7s | 67.3s | -80.7% |
| 升级（稳态，新→新） | 348.7s | **34.8s** | -90.0% |
| 卸载 | — | 9.5s | — |
| 安装包体积 | 152,276,049 B | 178,697,035 B | +17.4% |
| 落地文件数 / 体积 | 18,888 / 543.7MB | 12,414 / 446MB | -34.2% / -18.0% |

计时方法：管理员 PowerShell 里用 `Stopwatch` 包住 `Start-Process <Setup.exe> -ArgumentList '/S',"/D=<目标目录>" -Wait -PassThru`；测完调用安装目录内 `Uninstall DSH Desktop.exe /S _?=<目标目录>` 清理（`_?=` 就地运行会留下卸载器自身，属该模式固有行为，控制面板正常卸载不留残留）。

改 `extraResources` filter 后必须重跑的三项裁剪安全性验证：

1. **模块解析差分**：用内置 node 对基线树与裁剪树的每个包分别 `require.resolve`，只允许出现「两边都失败」（1.0.14 实测 486 个包、0 回归、19 个两边都失败属上游既有，如 `@modelcontextprotocol/sdk` 的 exports 指向不存在的 `dist/cjs/index.js`）。
2. **文件级差分审计**：列出「基线有、裁剪后无」的全部文件并按规则归类，`UNEXPLAINED` 必须为 0；同时「裁剪后新增」必须为 0（非 0 说明豁免 pattern 把本该排除的东西放回来了）。
3. **真实启动裁剪后的 dsh-bundled**：`<内置 node> resources/dsh-bundled/lib/bin.js web --port <端口> --no-open`，用日志里打出的 `?token=` URL 请求首页应 200，且页面引用的 js/css/favicon 全部 200。

---

## 9. macOS / Linux 支持

**当前状态：仅 Windows 打包。** 但主进程代码已写好 macOS 兼容分支：

- `app.on('activate')` 处理 dock 图标重创建窗口
- `process.platform !== 'darwin'` 控制 `window-all-closed` 时是否退出
- `stopDsh()` 的 `taskkill` 仅在 `win32` 平台使用，其他平台走 `SIGTERM`

**未来若要加 macOS target**：

- 需补 `mac:` 段到 `electron-builder.yml`（含 `target: dmg` / `category`、`hardenedRuntime`、`gatekeeper-assess`、`identity`）
- 需补代码签名 + 公证（notarization）配置
- 需新增 macOS runner 和 `requestedExecutionLevel`（macOS 上不适用）相关清理
- 建议先在 issue / spec 里写明签名方案和时间窗，AGENTS.md 同步更新

**当前任务请不要做 macOS 打包尝试**，会缺签名/公证导致无法分发。

---

## 10. 测试 / Lint / CI 现状

> **本仓库当前未配置任何自动化测试、代码检查工具和 CI 流程。**

| 能力              | 状态                                                                                       |
| --------------- | ---------------------------------------------------------------------------------------- |
| 单元测试            | ❌ 无（无 `*.test.ts`、无测试目录、无测试框架依赖）                                                         |
| Lint            | ❌ 无（无 ESLint / Prettier / Biome 等）                                                       |
| 格式化             | ❌ 无（请参照现有 TS 风格手写：`'use strict'` 隐式、`function () {}` 不写箭头、4 空格缩进、`@type` JSDoc 用于 JS 脚本） |
| TypeScript 类型检查 | ✅ 隐含在 `electron-vite build`（`noEmit: true`，但 Vite 编译时仍会校验）                               |
| CI              | ❌ 无（`.github/`、`.gitlab-ci.yml` 等都未配置）                                                   |
| 端到端验证           | 手动：`npm run dev` 看启动流程 + `npm run package` 看完整打包                                         |

**Agent 注意事项**：

- **不要主动新增**测试、ESLint、Prettier、CI 配置文件，除非用户明确要求。本节是事实陈述，不是 TODO。
- 修改主进程后，**必须** `npm run build` 至少做一次 TS 编译检查。
- 修改打包配置后，**必须** `npm run package` 跑一次完整流程。
- 涉及内置 Node / DSH 包目录变更时，**必须**手动验证 `npm install` → `npm run download-node` → `npm run preinstall-dsh` → `npm run dev` 完整链路。

---

## 11. 调试 / 故障排查

| 现象                                 | 排查方向                                                                                              |
| ---------------------------------- | ------------------------------------------------------------------------------------------------- |
| 启动卡在 loading 1-3 分钟                | 首次启动正在通过 npx 下载 DSH 包，看 `resources/node/.npm-cache/` 是否有写入                                        |
| 错误页提示 `[CODE:DSH_PACKAGE_MISSING]` | DSH 包未找到，点击"在线修复"走 `dsh-repair.ts` 流程                                                             |
| 错误页提示端口相关错误                        | 跑 `netsh int ipv4 show excludedportrange protocol=tcp` 看是否落在 Windows 排除端口范围                       |
| 主进程启动时立刻报 "内置 Node.js 不存在"         | 跑 `npm run download-node`（开发环境）                                                                   |
| 打包后应用启动报 node.exe 找不到              | 确认 `electron-builder.yml` 的 `extraResources.node` filter 没误排除 `node.exe`                          |
| 关闭应用后 DSH 进程残留                     | 检查 `stopDsh()` 在 `window-all-closed` 路径有被调用；Windows 上必须走 `taskkill /f /t`                         |
| `dist-exe/` 体积异常大                  | 检查 `extraResources` filter 中的 `!**/node_modules/**` 是否被误删；DSH 包 `dsh-bundled` 不能进 `node_modules/` |

主进程日志前缀：`[DSH]`、`[DSH stdout]`、`[DSH stderr]`、`[DSH Repair]`，开发模式下都在终端直接可见。

---

## 12. 关键禁区 / 踩坑点

> 这些是改代码时容易踩的坑，已经在源码注释里有解释，这里集中列出。

### 12.1 不要做

1. **不要把 DSH 包放到 `resources/node/node_modules/` 下**。
   - electron-builder 的 `extraResources` filter 用 `!**/node_modules/**` 排除，运行时会找不到。
   - 必须放 `resources/dsh-bundled/`（独立目录）。
2. **不要去掉 `requestedExecutionLevel: requireAdministrator`**。
   - DSH 内部需要创建符号链接，没有管理员权限会触发 EPERM。
3. **不要修改 `DSH_PACKAGE_MISSING_ERROR_NAME` 字符串常量**。
   - 错误页 JS 用 `errorText.indexOf('[CODE:DSH_PACKAGE_MISSING]')` 判断是否显示"在线修复"按钮，改了字符串会断裂。
4. **不要在 `window-all-closed` 路径里只调 `child.kill()`**。
   - Windows 上 npx 派生的子进程不会随父进程退出，必须 `taskkill /f /t` 杀进程树。
5. **不要改端口检测为 IPv6 默认绑定**（即不要去掉 `server.listen(port, '127.0.0.1')`）。
   - Windows IPv4/IPv6 端口排除范围分开，IPv6 测试通过不代表 IPv4 可用。
6. **不要把 `--port` 参数去掉只留 `PORT` 环境变量**。
   - DSH 实际不读 `PORT` 环境变量，必须用 `--port` 命令行参数。
7. **不要让 `startDshAndLoad()` 的健康检查超时超过 60 秒**。
   - 60 秒是产品决策（DSH 预装时通常 3-5 秒就绪），延长会掩盖真实问题。180 秒的超时只用于"含首次下载"的代码路径。
8. **不要删 `app.on('window-all-closed')` 里的 `await stopDsh()`**。
   - 否则 DSH 子进程会残留，端口被占用导致下次启动失败。
9. **不要在 `preinstall-dsh.js` 中删除 `npm_cache` 参数**。
   - 独立 `npm_config_cache` 是为了避免继承系统全局配置触发 EPERM，去掉会让 Windows 上下载失败。
10. **不要直接修改 `dist/`、`dist-exe/`、`dist-exe-archives/`、`msi/`、`dist-electron/`、`.eb-cache/`、`dist-msi*`、`.eb-cache*`**。
    - 都是构建产物，源码在 `src/` 和 `scripts/`。
11. **不要把缓存目录从 `%LOCALAPPDATA%/DSH Desktop/` 改成系统级路径**。
    - `resources/node/` 装在 `Program Files` 下是只读，运行时缓存必须用户可写。
12. **不要去掉 `dsh-manager.ts` spawn 参数里的 `--no-open`**。
    - DSH web 启动器默认会在服务 ready 后通过 `open` npm 包打开系统默认浏览器。这条调用链发生在 DSH 子进程自己 fork 的进程里，完全不走 Electron webContents，主进程现有的 `setWindowOpenHandler` 拦不到。
    - 去掉 `--no-open` 会导致用户启动桌面应用时同时弹出系统默认浏览器，破坏"只开 Electron 窗口"的产品行为。
    - 加回非常容易（`grep '\\-\\-no-open' src/main/dsh-manager.ts`），但回退前先确认用户体验影响。
13. **不要在 `performUpdate()` 里先 `stopDsh` 再 `prepareDshPackage`**。
    - 顺序约束：`prepare`（下载+完整性校验+安装到 staging）→ `stopDsh`（释放缓存目录锁）→ `activate`（rm 旧缓存 + rename staging，毫秒级窗口）→ `startDsh`。颠倒顺序会导致 Windows 下 `rmSync(targetDir)` 遇到运行中的 native 模块（node-pty 等 .node 文件）抛 EPERM，更新必然失败。
    - 同样，`repairDsh`（错误页流程）只能用于 DSH 未运行的场景；运行中版本更新必须手动调用 `prepare` + `activate`。
14. **不要绕过 `isUpdating` / `isRepairing` 互斥锁直接调用更新/修复流程**。
    - 共享 staging / target 目录的并发调用会互踩（`rmSync`/`renameSync` 互相干扰），造成缓存损坏。双击标题栏「更新DSH」按钮、错误页重复点修复按钮都可能产生并发。
15. **不要将远端版本号直接拼入文件路径 / URL / JS 模板**。
    - 远端 `tag_name` 拼接前必须过 `isValidVersion()` 白名单（`/^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$/`）。这是纵深防御，git 标签命名规则是第一道防线；手动检查不要跳过。
16. **不要让 IPC handler 脱离 `isTrustedSender(event)` 校验**。
    - 敏感通道（`install-update` / `repair-dsh` / `open-external`）必须限制 senderFrame 为 `file:` 或 loopback `http(s)`，防止被劫持的 webContents 或外部页面触发高危操作。标题栏专属通道（`show-help-menu` / `titlebar-client-update` / `titlebar-dsh-update`）更进一步，直接比对 `event.sender === mainWindow.webContents`。
17. **不要拆掉 `dsh-repair.ts` 的两阶段函数导出**。
    - `prepareDshPackage` / `activateDshPackage` / `repairDsh` 是有约束的三件套。`performUpdate`（DSH 运行中场景）必须分别调用前两者，错误页场景才能调用 `repairDsh`（一步到位）。
18. **不要将远程请求改回 Node `https.get`**。
    - 所有远程请求（registry / tgz 下载 / latest.yml / 安装包）已统一改用 Electron `net.fetch`：自动遵循系统代理、自动跟随重定向。回退到 Node `https.get` 会失去代理支持并要手写重定向状态机。loopback 健康探测（`dsh-manager.checkUrl`）是例外，必须用 Node `http.get`，避免 127.0.0.1 被代理规则劫持。
19. **不要拆掉 `build/installer.nsh` 里的 `${isUpdated}` 重定义与阶段标记机制**。
    - 任务栏固定图标跨升级保留（[§8.1.1](AGENTS.md)）依赖 electron-builder 25 NSIS 模板的两条条件同时成立：
      a) 注册表里上一版本写入的 `KeepShortcuts=true`（模板 `registryAddInstallInfo` 自动写入）；
      b) 新安装器内 `${isUpdated}` 为真，使 `setIsTryToKeepShortcuts` 保持 `$isTryToKeepShortcuts=true`，进而在调旧 `Uninstaller.exe` 时追加 `--keep-shortcuts`。
    - 条件 b) 原本靠「安装器收到 `--updated` CLI 参数」满足；1.0.3 移除自动更新后该路径断裂，1.0.5 起改由 `build/installer.nsh` 的方案 B'（`_isDshUpdated` 宏 + `customInit` + `customPageAfterChangeDir` 空页面）在编译期重建。
    - 拆掉该机制会让 `${isUpdated}` 回退为纯 CLI 检测：手动双击升级时 `$isTryToKeepShortcuts` 被置回 false，旧 `Uninstaller.exe` 收不到 `--keep-shortcuts`，`Delete "$SMPROGRAMS\DSH Desktop.lnk"` 与 `WinShell::UninstAppUserModelId` 会依次执行，任务栏上用户“固定”的图标丢失。
    - 该机制与 electron-builder 25 模板实现（flags() 生成、LogicLib 测试宏协议、customPageAfterChangeDir 钩子）强耦合：升级 electron-builder 版本后必须重新核对并实机验证。
    - `electron-builder.yml` 中 `nsis.uninstallBeforeInstall` 不是合法选项（不在 electron-builder 25 `NsisOptions` 中）。不要“补”这个选项。
20. **不要在补 PR 中替换 `build/icon.ico`**。
    - `build/icon.ico` 是 .exe 的 Win32 资源、`installerIcon`/`uninstallerIcon`、以及任务栏固定图标嵌入资源的唯一底层来源。替换它会冻结 [§8.1.2](AGENTS.md) 描述的三处同步点。
    - 需要换图标必须独立发版分支。同一发版周期内 `build/icon.ico` 与 `resources/icon.ico` 保持双向同步；不要只改 `build/icon.ico`，也不要手动改 `resources/icon.ico`。
21. **不要把 `titlebar.html` 加载到 WebContentsView 子视图中**。
    - Window Controls Overlay 的 `env(titlebar-area-x/width/height)` CSS 环境变量**只在 BrowserWindow 自身 webContents 的页面里生效**，在 WebContentsView 子视图中恒为 0（实测：帮助按钮因此错位到窗口左边缘）。
    - `@supports (width: env(titlebar-area-width))` 语法检查恒为真（Electron 永远支持 env() 语法），不能作为「值已填充」的判据，CSS fallback 分支永远不会生效。
    - 正确结构：主 webContents 加载 `titlebar.html`（占满窗口、视觉上仅顶部 36px），`dshView` 子视图 `setBounds({ y: 36, ... })` 覆盖以下全部区域；窗口 resize/最大化/还原时统一走 `layoutViews()` 重排。
    - `titleBarOverlay.height` 必须与 `TITLEBAR_HEIGHT`（36）一致，`titlebar.html` 的 body 高度同理。
22. **更新日志（changelog.ts）的两个 tag 前缀不要弄混**。
    - 上游 `deepseek-ai/deepseek-harness` 是 monorepo，DSH CLI 的 release tag 前缀是 `dsh-v`（过滤其他包的 release）；本项目 release tag 前缀是 `v`（与 `app-update.ts` 的解析约定一致）。
    - 前缀剥掉后必须过 `isValidVersion()` 白名单，不合法条目直接跳过（曾因客户端日志漏剥 `v` 前缀导致 0 条目）。
    - release body 是不可信远端文本：渲染前先 `escapeHtml` 全文转义再做受限标签转换（`renderMarkdownToHtml`），链接仅允许 `http(s)`；改渲染逻辑前先想清楚 XSS 面。
23. **不要给 `Menu.popup` 的 x/y 叠加窗口屏幕坐标（`getContentBounds()`）偏移**。
    - 官方文档声称 x/y 是屏幕坐标，但实测（Electron 33 / Windows / 200% DPI）传入坐标被按「窗口客户区相对坐标」解释：叠加偏移后最大化时碰巧正确（窗口原点≈屏幕原点），窗口化时菜单向右下偏移恰好等于窗口自身的屏幕位置。
    - 正确做法：直接传按钮在标题栏页面内的 CSS 像素坐标（`rect.left` / `rect.bottom`），不要加任何 bounds。
    - 若升级 Electron 后菜单位置异常，先怀疑此处坐标系行为变化；兜底方案是不传 x/y（菜单在鼠标点击处弹出）。
    - 同页注意：titlebar.html 内绝对定位元素的 `top:50%` 参照的是整页（主 webContents 占满窗口高）而非 36px 标题栏——曾把标题文字打到窗口中部、被内容视图遮挡；垂直居中请用 `top:0; height:36px; line-height:36px`。
24. **标题栏按钮的交互态不要用 `:hover` / `:active` 伪类，用 JS 管理的类名**（`titlebar.html` 的 `is-hover` / `is-active`）。
    - 原生 `Menu.popup`（以及随后弹出的对话框）运行模态循环期间渲染进程收不到任何鼠标事件；菜单关闭后若鼠标已移出按钮，伪类状态永久滞留。
    - 放大因素：标题栏仅 36px 高，下方内容区是独立 webContents（`dshView`），鼠标移入内容区不会触发标题栏页面的鼠标离开，`:hover` 永远不会自动清除。
    - 类名的三个复位时机：`mouseenter/leave/down/up` 驱动、窗口 `blur`/`focus` 强制清除、主进程 `menu-will-close` 发 `help-menu-closed` 通知清除（覆盖 Esc / 点击外部 / 选中项全部关闭路径）。
    - 新增标题栏交互元素时沿用同一模式，不要引入新的伪类交互态。
25. **不要只改 `NODE_VERSION` 就发布内置 Node major 升级**。
    - 原生模块 ABI 随 major 变化（v22 = 127，v24 = 137）。改完常量必须依次跑 `node scripts/download-node.js --force`（会先校验 `NODE_ZIP_SHA256`，通过后连 `resources/node/.npm-cache/` 一起删旧目录）与 `node scripts/preinstall-dsh.js` 重建 `resources/dsh-bundled/`，否则出厂包内按源码编译的 `.node` 仍是旧 ABI，首启即 `ERR_DLOPEN_FAILED`。
    - N-API / 平台预编译模块（sharp、koffi、node-pty 1.2 的 `prebuilds/`、node-addon-require-builtin 的 `napi-v9`）跨 ABI 可用，`nan` 源码编译型（fs-ext）不可——因此校验器 `assertNativeModulesLoadable` 只扫 `build/Release/*.node` 是有意为之，不要扩到 `prebuilds/`，否则正常的 N-API 模块会被误判。
    - 老用户 `%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/` 可能是旧 ABI 编译产物：不要指望用户清缓存，启动路径已有自愈（`dsh-manager.ts` 的 `abiMismatch && retryOnAbiMismatch && launchedFromRepairCache` → `invalidateRepairCacheDir()` + 回退 `dsh-bundled`），拆掉它会把升级变成崩溃循环。
    - 本机系统 Node 与内置 Node 同 major 时，ABI 错配无法自然复现，验证该链路要靠显式探针（手工放入异 ABI 的 `.node`）而不是靠观察启动成功。
    - 代码里不要重新写死内置 Node 的版本号：运行时查询走 `getBundledNodeVersion()`（`execFileSync(node.exe, ['-p','process.versions.node'])`），注释描述 ABI 时优先用"内置 Node"而非具体版本。注意：在 npm 11 / node-gyp 12 下该版本号已不再能钉住编译目标（见第 26 条），它现在的价值在于日志与诊断。
26. **升级内置 Node 后不要假设 npm 行为不变（npm 10 → 11 实测差异）**。
    - dsh-repair 的 `npm install <tgz>` 跑的是**内置 npm**（`resources/node/node_modules/npm`），它跟内置 Node 同批次升级，npm 的大版本策略变化会静默影响修复/更新产物：
      a) **install 脚本白名单**：npm 11.19 默认不执行未放行的生命周期脚本，输出 `npm warn install-scripts ... not yet covered by allowScripts`（实测 DSH 0.1.5-rc.1 / rc.2 的 node-pty / koffi / protobufjs / @deepseek-ai/dsh-subprocess-local 全部被延后）。当前依赖集下无功能影响（原生绑定都由 tarball 自带的 prebuild 提供，已用客户端内真实「更新 DSH」流程实测：rc.1 → rc.2 下载 / 完整性校验 / npm install 518 包 / ABI 校验 / 激活 / 重启全部通过），但若上游引入需要 install 脚本产物的模块，修复出的缓存会缺产物。
      b) **`--target` / `npm_config_target` 不再决定编译目标**：npm 11.19 对 `target` / `arch` / `disturl` 三个环境变量报 `npm warn Unknown env config "..."`；实测 node-gyp 12.4.0 **完全忽略 `--target`**（分别传 `--target=22.19.0` 与 `--target=24.16.0`，生成的 `build/config.gypi` 里 `"target"` 仍是运行 node-gyp 的 `24.21.0`、`node_module_version` 仍为 137，也不会去下载对应版本的头文件），编译目标始终等于**运行它的那个 Node**。结论：`PATH` 前置 `getNodeDir()` 不再是“双保险”，而是**唯一的 ABI 对齐机制，绝对不能删**；`npm_config_target` 继续保留无害，但不要依赖它做对齐，ABI 兜底只靠 `assertNativeModulesLoadable` 与启动自愈。探针附带结论：内置 Node 升到 v24 后，nan 源码编译型模块（实测 fs-ext）能正常按 ABI 137 编译并在内置 Node 下 `require` 成功。
    - 改动 dsh-repair 安装 env / 参数后，至少跑一次等价复跑验证（空目录 cwd + 同款 env + 拉起临时安装的 DSH），不要只看 `npm run build` 通过。实测踩坑：在仓库根目录误跑该验证会因 `--omit=dev` 把项目 devDependencies 从 `node_modules` 里抽掉（需 `npm install` 恢复）——验证必须在临时空目录里跑。

27. **余额 tooltip 必须注入 DSH 内容页，不能放在标题栏页**。
    - `dshView` 子视图绘制在主 webContents **之上**：标题栏页（titlebar.html）内任何下探到内容区的面板都会被 DSH 内容完全盖住。
    - 历史方案「展开期间主进程 `dshView.setVisible(false)`、关闭后恢复」已废弃：隐藏后露出主 webContents 48px 以下无背景区域 → 内容区整片黑屏，实测不可接受（用户视效反馈）。
    - 现行方案：标题栏页只构建 tooltip 内容 HTML（`buildTooltip`，本地数字与固定文案无远端文本），经 `balance-tooltip` IPC（`(open, html)`）发主进程；主进程 `showBalanceTooltip` 把面板注入 DSH 页（`#dsb-tooltip`：`position:fixed; top:56px; left:242px; z-index:2147483646; pointer-events:none`）。`left` 与 titlebar.html 的 `.bb-wrap` 硬编码同源（徽章位置），调徽章位置两处必须同步。
    - `did-finish-load`（内容视图每次文档加载完成）预注入外壳保证首次悬停零延迟；`showBalanceTooltip` 内也有外壳缺失补建兜底（SPA 路由替换 body 的极端场景）。
    - 面板主题走 `prefers-color-scheme` 媒体查询（DSH 页已由 `applyEmulateMedia` 按生效主题模拟），无需单独同步变量；CSS 选择器全部加 `#dsb-tooltip` 前缀，防与 DSH 页自身样式（`.k`/`.v` 等通用类名）碰撞。
    - 关闭策略为「离开徽章即关」（与原生 tooltip 一致，用户确认方案①）：面板在 DSH 页（独立 webContents），鼠标无法从徽章移入面板。若未来要做「可移入面板」，需增加跨 webContents 悬停 IPC 协议。
    - 不要再把 titlebar.html 的 `html, body` 改回 `overflow: visible`：tooltip 已不在本页下探，48px 内内容不会溢出。
    - 徽章金额不要走 `fmtCNY`（自带 ¥ 前缀）：徽章的 ¥ 由独立符号位 `.bb-symbol` 提供（窄窗口 ≤540px 可单独隐藏），格式化必须走 `fmtNum`（无前缀），否则叠加成双 ¥（实测踩坑）。
28. **余额功能的 API Key 不要出主进程、不要进日志**。
    - `deepseek-balance.ts` 解析的 Key 仅本地用于请求；日志只打掩码（前 6 位 + 长度）。
    - IPC 快照（`BalanceSnapshot`）只含状态与数字；绝不注入 dshView（DSH 页面是第三方内容，有 XSS 面）。
    - `DEEPSEEK_BASE_URL` 指向非官方域名时走 `relay` 静默降级，不要对中转站 Key 强行查官方接口刷 401 打扰用户。
29. **不要给托盘原生菜单的余额项上色，也不要做成可点击项**。
    - `Menu.buildFromTemplate` 无逐项颜色 API：警示态用 `⚠` / `●` 符号 + 文案表达（红/橙等醒目色只存在于标题栏徽章 CSS）。
    - 余额项 `enabled: false` 防误点；刷新动作单独放「刷新余额」项；菜单/tooltip 由 `onBalanceUpdate` 订阅回调里的 `updateTrayMenu()` 重建。
30. **不要依赖 `ready-to-show` 单独完成窗口显示**。
    - `show: false` + `ready-to-show` 组合存在**时序竞争**（事件在监听挂载前触发或丢失），窗口将永远停在不可见状态：现象为进程、托盘、DSH 服务全部正常，但屏幕上没有窗口（实测 dev 模式多次复现，本机概率很高，非偶发）。
    - `createWindow()` 内 `ready-to-show` 处理器之后已挂 3s 延迟兜底：未 `isQuitting`、未最小化、未销毁且不可见则强制 `show()` 并打 warn 日志（`[DSH] ready-to-show 未按时触发，已兜底显示窗口`）。删掉它就是把 competition 变成用户可见 bug。
    - 兜底 timer 必须 `unref()`（避免拖住事件循环）；守卫里的 `isMinimized()` 不能省——用户 3s 内手动最小化时兜底不得把窗口再拉出来。
31. **不要只开 `nsis.useZip` 而不开 `nsis.differentialPackage: false`**。
    - `NsisTarget.js` 的归档格式判定是 `format = !isBuildDifferentialAware && options.useZip ? "zip" : "7z"`，而 `ZIP_COMPRESSION` 的定义只看 `options.useZip`。两者不同步的后果：实际内嵌的是 7z，模板却走 `nsisunz::Unzip` 去解它 —— 安装必然失败。
    - 也不要把 `useZip` 单独关掉而留着 `differentialPackage: false`：那会退回 7z 三趟落盘管线（§8.2.1），全新安装从 24s 退回 360s。
    - 验证方法（不需要真装）：扫安装包二进制的载荷签名，zip 是 `50 4B 03 04`、7z 是 `37 7A BC AF 27 1C`，出现在 NSIS stub 之后（实测偏移约 515,600）。
32. **不要删掉 `build/installer.nsh` 里的 `customRemoveFiles` 宏**。
    - 删掉后模板的 `!else` 分支恢复生效：升级时旧卸载器会走 `un.atomicRMDir`，把安装目录内每个文件逐个 `Rename` 到系统盘 %TEMP% 的镜像目录再删，1.0.14 实测约 5.8 万次额外文件系统操作；装到非系统盘时跨卷 Rename 还会退化成整份复制。
    - 该宏必须写在 `!ifndef BUILD_UNINSTALLER` **之外**：它只被卸载器 pass 展开，而 `sharedHeader`（含本文件）在两个 pass 都会注入。
    - 模板中 `customRemoveFiles` 一旦定义，`!else` 分支（atomicRMDir **和** `RMDir /r $INSTDIR`）整体不展开，所以宏内必须自己补 `RMDir /r "$INSTDIR"`，漏掉就等于不删文件。
    - 与 §8.1.1 的 keep-shortcuts 链路互不干涉（`${ifNot} ${isKeepShortcuts}` 分支在文件删除块之后）；改完仍需实机验证任务栏固定图标跨升级保留。
33. **不要把 `dsh-bundled` 的裁剪 filter 从 `**/node_modules/**` 作用域放开到全局，也不要动末尾的豁免顺序**。
    - 裁剪规则全部限定在 `**/node_modules/**` 内：DSH 自身只有 `lib/` 下 5 个 `.js` 与根目录 `README.md` / `README.zh.md` / `README.i18n.yaml`，放开作用域会把这些一起删掉（上游 231 个 `README.i18n.yaml` 配合 `dsh-host-plugin-inventory`、`dsh-client-ui-sidebar-documentpreview` 判断，这些 README 很可能被运行时读取）。
    - filter 语义是「按数组顺序、最后一次匹配生效」（`app-builder-lib/out/util/filter.js` 的 `minimatchAll`：已命中时只再用负向 pattern 复测，未命中时只再用正向 pattern 复测）。因此豁免 pattern `**/node_modules/@deepseek-ai/**` 必须排在所有裁剪规则之后，而 `!**/*.d.ts` / `!**/dist-types/**` 又必须**再声明一次在豁免之后** —— 否则豁免会把类型声明放回包里（实测回流 1,340 个 `.d.ts`）。
    - 改完必须跑 §8.2.4 的三项验证（模块解析差分 / 文件级差分审计 / 真实启动 dsh-bundled），不能只看 `npm run build` 通过。
34. **不要给 `extraResources` 加按目录名裁剪的规则（`doc` / `docs` / `man` / `example` / `examples`）**。
    - 实测踩坑：`yaml` 包把**运行时代码**放在 `dist/doc/` 下（`dist/compose/composer.js` 里 `require('../doc/directives.js')`），加上 `!**/node_modules/**/doc/**` 后 `require('yaml')` 直接 `MODULE_NOT_FOUND`。
    - 这类规则总共只省 77 个文件（占总裁剪量 1.2%），风险与收益完全不对等。`test` / `tests` / `__tests__` 已实测安全（1,243 个文件、486 个包 0 解析回归），但新增任何目录名规则前都必须重跑差分验证。
35. **不要把「UI 停在旧值」的成因当成 bug 去查网络**。真机上出现过「主进程进度一直在发、DSH 页面也能正常操作，但横幅永远停在 61%」。逐条排除的顺序是：源站/网络停滞（curl 持续下载采样，看速率是否稳定）→ 节流逻辑卡死（用真实进度参数跑一遍放行序列）→ 主进程没收到（看标题栏按钮百分比是否在变）→ 渲染进程卡死（看页面是否可操作）→ 模块重复实例化（grep 确认单一 import / 单一订阅）。**这五项都排除后，问题一定在投影通道上，而投影通道的错误恰好是不抛异常的**——`getURL()` 布尔守卫与 `.catch(() => {})` 是两个静默失效点。所以修复方向不是「更努力地重试」，而是**让失败可见 + 到阈值就降级到另一条通道**。
36. **不要假设「渲染进程健康 = webContents 能响应 `executeJavaScript`」**。`src/main` 原本完全没有 `unresponsive` / `render-process-gone` 监听，导致 `dshView` 出问题时主进程毫无察觉。`createWindow()` 里五个监听（`unresponsive` / `responsive` / `render-process-gone` / `did-fail-load` / `did-navigate-in-page`）是横幅可诊断的前提，删掉任何一个都会让下一次同类问题重新变成无头案。
37. **不要试图给 `dialog.showMessageBox` 做样式**。它是系统原生窗口，`MessageBoxOptions` 只有 `type`/`message`/`detail`/`buttons`/`defaultId`/`cancelId`/`noLink` 这几个语义参数，没有颜色/字体/圆角/按钮形态钩子——这不是"难做"，是接口层面不存在。同理也没有能改它的组件库（组件库作用在 DOM 上，碰不到系统窗口）。要做现代化只有自绘一条路，见 §6.7。
38. **不要把 `defaultId` 当成"主按钮"**。它是初始焦点与回车触发的按钮，现有代码有四处刻意把它给「取消 / 继续下载」。自绘对话框层把键盘语义（`defaultId`）与视觉强调（`primaryId`）拆成两个参数，迁移时照抄会悄悄改掉产品决策。另外 `primaryId` 的缺省推导在"主操作恰好就是 cancelId"时会推反，那类调用点必须显式传值。
39. **不要给自绘对话框省掉 `did-start-loading` 的收敛逻辑**。注入的 DOM 随文档一起销毁，页面一导航，还挂着的对话框永远不会回传 `dsh-dialog-response`，调用方 `await` 的 Promise 会永久挂起（界面表现是"点了没反应"，且不会抛错）。`initDshDialog` 里的 `did-start-loading` 钩子按 `cancelId` 主动收敛并清空队列，是这条链路的唯一保险。
40. **不要把玻璃透明度当纯视觉参数随便调**。卡片底色与文字色是一组耦合约束，调任何一个都要重算另一个：
    - 0.72 白叠在 0.35 深色遮罩上，合成后的实际底色约 `#f0f0f2`，**不是白色**；
    - 实心卡片时代用的 `--dsh-dlg-muted: #6b7280` 落到这个底色上只有 **4.31:1**，而 detail 是 12.5px 小字（AA 门槛 4.5:1），不达标。现值 `#5b6570` 是 5.16:1；
    - 提高透明度（如 0.72 → 0.55）会进一步吃掉对比度，饱和背景（彩色图片、深色代码块）上正文最先崩。`docs/dialog-preview.html` 里刻意放了一块高饱和渐变与深色代码块作为最坏情况，`node scripts/preview-dialog.js` 重新生成。
    - 往上调到 0.80 可以在保住玻璃感的同时多留一点对比度余量。
41. **不要让预览页绕过 `buildDialogSpec()`**。真实事故：`pickIndex` 的 `maxIndex` 被硬写成 `0`，任何大于 0 的 `defaultId` / `primaryId` 都被判越界丢弃、悄悄退回 0 ——「退出确认」与「更新运行包」回车即执行、「客户端下载中」的破坏性「取消下载」被画成主按钮。之所以一直没发现，是因为预览页的 spec **手写 `variant` 字段**，只验证了 CSS 与 DOM，**从未验证过下标推导**。现在 `buildDialogSpec` 已导出、预览走真实推导，且生成时会跑 `assertDerivation()` 断言 5 个用例的 `defaultId` / `primaryId` / `detailTone` / `tight`。加新调用点时也要把对应 spec 补进 `scripts/preview-dialog.js` 的 `CASES`。
42. **不要在 Shadow DOM 迁移后还用 `document.querySelector` 找模态框内部节点**。`injected-modal` 挂 Shadow DOM 后，正文、GitHub 按钮、锚点目标都查不到（症状：更新日志永远"加载中"、关于框按钮点了没反应、目录链接点了不跳）。唯一入口是 `window.__dshModal.{shadow, update, cleanup}`，见 §6.7。
43. **不要把模态框的 `card` 挂到 `root` 上**。它必须在 `backdrop` 内部——`backdrop` 才是负责 flex 居中的那个容器，且带 `z-index` + 半透明 + `backdrop-filter`，会把平级的卡片盖住糊掉。真机踩过：关于框 + 两个更新日志三个入口全废，走 `showDshMessageBox` 的「检查更新…」却正常，正是这个差异让人定位到。`assertModalStructure()` 会在预览生成期把这类错炸出来，改注入代码后务必重跑 `node scripts/preview-dialog.js`。
44. **不要把 `--dsh-modal-*` 顺手玻璃化**。这套旧实色令牌是**客户端更新下载进度横幅 `#dsh-ub` 唯一在用的**（`APP_UPDATE_BANNER_CSS`）。模态框已改用 `--dsh-dlg-*`，`--dsh-modal-*` 只剩横幅一个消费者；改它会连带把横幅也变成玻璃，而横幅是通栏贴顶的、玻璃化并不合适。
45. **不要把注入式 UI 的实现留在 `index.ts` 里**。`index.ts` 一旦被 import 就会拉进 electron 副作用，预览脚本在沙箱里根本加载不了它——这正是模态框曾长期零覆盖、只能靠真机发现问题的原因。注入式 UI 的 CSS / 宿主脚本 / 构建器一律放独立模块（`dsh-dialog.ts` / `injected-modal.ts` / `injected-theme.ts`），预览脚本用 esbuild + require 打桩加载，与生产同源。
46. **不要放松 `notice.ts` 的校验，也不要改成"部分渲染"**。公告内容来自远端、会渲染进页面，`parseNotices` 的任一条拒绝都是**整批丢弃**的——这是刻意的（半截公告比没有公告更糟），不是 bug。`javascript:` / `data:` 链接被挡、外链只走 `open-external`、正文只 `textContent`，三条都由 `scripts/preview-notice.js` 的生成期断言守着；改校验必须同步改断言，并确认新断言真的会拒（拿一个反例喂给它）。
47. **不要给公告横幅写死 `top`**。它必须运行时读 `#dsh-ub` 的 `offsetHeight`：客户端更新下载中时更新横幅占据顶部，公告要下移避让。写死 0 会让两条横幅重叠。两条注入刻意不共享状态——靠读对方实际布局避让，加一个共享变量就多了一处可能失配的地方。
48. **不要把公告拉取失败当成错误弹给用户**。启动与周期路径必须静默（网络不通是常态，每次开应用弹窗报错是灾难）；只有用户主动点标题栏铃铛才弹。另外 `fetchNotices` 把 404 当成「没有公告」——发布顺序上客户端完全可能先于 `notifications.json` 上线，那不是错误。

### 12.2 改之前要确认

- 修改 `electron-builder.yml` 的 `extraResources` filter → 会显著影响安装包体积、安装耗时和首次启动行为，必须跑完整 `npm run package`，并补齐 §8.2.4 的三项裁剪安全性验证（模块解析差分 / 文件级差分审计 / 真实启动 dsh-bundled）。
- 修改 `nsis.useZip` / `nsis.differentialPackage` / `build/installer.nsh` 的 `customRemoveFiles` → 直接决定安装耗时（§8.2），改完必须实机计时对比，不能只看构建成功；两者绑定约束见 §12.1 第 31 条。
- 修改 `dsh-manager.ts` 的 `findCachedDshEntry()` 查找顺序 → 改了顺序会让某些环境找不到 DSH 包。
- 修改 `tsconfig.json` / `tsconfig.node.json` 的 `lib` / `types` → 三段式各自的类型会受影响，编译可能过不了。
- 修改渲染层 HTML 的 CSP 头 → 当前 `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`，DSH Web UI 通过 `loadURL` 加载不受这个 CSP 影响（每个 webContents 独立），但 loading/error 页的 inline 脚本依赖 `'unsafe-inline'`，不要直接删。titlebar.html 额外有 `img-src 'self' data:`（应用图标走 data URL），删掉图标会消失。
- 修改标题栏配色 → 必须同步两处：`titleBarOverlay`（系统三键区域颜色）与 `titlebar.html` 的 body 背景，漏一处会出现色差断层；当前为深色（#202020 / 符号 #e6e6e6）。
- 修改 Preload 暴露的 `window.dsh.*` API 名或形状 → 错误页 JS 强耦合，改完必须同步改 `error.html`。
- 把 `dsh-dialog.ts` 的 `showDshMessageBox` 铺开到更多调用点 → 19 处已全部迁移，这是新增弹窗的默认入口；不要再写 `dialog.showMessageBox`。每处都要先确认 `defaultId` / `cancelId` 是刻意的产品决策还是随手写的，并逐个核对 `primaryId`（推导在「主操作 = cancelId」时会反）。样式改动后跑 `node scripts/preview-dialog.js` 看 `docs/dialog-preview.html`（含 1/2/3/4 按钮态与最坏情况背景）。
- 需要「先切页面、再弹对话框」→ 必须 `loadXxxPage()` 后紧跟 `await waitForNextDialogHost()`，见 §6.7「先后顺序」行。
- 新增 `showDshMessageBox` 调用点 → 显式判断该 `detail` 属于风险类（传 `detailTone: 'notice'`）还是版本信息类（缺省 `meta`），并把对应 spec 补进 `scripts/preview-dialog.js` 的 `CASES`（见 §12.1 第 41 条）。
- 修改 `injected-theme.ts` 的 `--dsh-dlg-*` 令牌 → 同时影响自绘对话框的明暗两套；`--dsh-modal-*` 还被更新日志/关于模态框共用，误改会波及那两个。**玻璃透明度与文字色是耦合的**，单改一个会让对比度不达标，见 §12.1 第 40 条。改完跑 `node scripts/preview-dialog.js` 看 `docs/dialog-preview.html`（含高饱和渐变与深色代码块的最坏情况背景）。

---

## 13. 修改本文档的时机

请在以下情况发生后**同步更新 AGENTS.md**：

- `package.json` 的 scripts 或 dependencies 变化
- `electron-builder.yml` 打包配置变化
- 新增/删除主进程模块、Preload API、IPC 通道
- 新增端口、缓存、文件路径相关的硬编码常量
- 新增"踩坑点"被验证为稳定规律
- macOS / Linux 支持状态变化
- 引入或废弃任何测试 / lint / CI 工具

如果发现 AGENTS.md 与代码不一致，**以代码为准**并在 PR 中修正 AGENTS.md。
