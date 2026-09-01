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
| 内置运行时 | Node.js v22.19.0 LTS（Windows x64，zip 包形式内置到 `resources/node/`） |
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
│   ├── generate-icon.js
│   └── png-to-ico.ps1
├── src/
│   ├── main/                    ← 主进程
│   │   ├── index.ts             ← 应用入口、窗口（WCO 标题栏 + 内容子视图）、IPC 路由、帮助菜单、模态框注入
│   │   ├── dsh-manager.ts       ← DSH 进程生命周期（启动/停止/健康检查/端口/依赖完整性）
│   │   ├── dsh-repair.ts        ← DSH 在线修复（两阶段：prepare staging / activate）
│   │   ├── dsh-version.ts       ← DSH 版本检查、semver 比较、packument integrity 查询
│   │   ├── app-update.ts        ← 客户端更新 GitHub 检测（Release 页面引导、遗留安装包清理）
│   │   ├── changelog.ts         ← 更新日志获取（上/本项目 GitHub Releases）+ 安全 markdown 渲染
│   │   └── node-binary.ts       ← 内置 Node 二进制路径解析
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
└── .trae/
    └── specs/
        └── wrap-dsh-web-as-desktop-client/   ← 历史需求规格（参考用，不维护）
            ├── spec.md
            ├── checklist.md
            └── tasks.md
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
│  │   ├── 主 webContents ──► titlebar.html（拖拽区+帮助按钮） │
│  │   └── dshView (WebContentsView 子视图，标题栏以下全部区域)│
│  │        └─► loading.html → error.html → loadURL(dsh URL)  │
│  ├── IPC 路由  ──► 'status' / 'retry' / 'repair-dsh' / 'install-dsh-update'   │
│  │                'install-update' / 'check-update' / 'get-app-version'      │
│  │                'get-installed-version' / 'open-external' / 'show-help-menu'│
│  ├── 帮助菜单  ──► 标题栏按钮触发 Menu.popup：检查更新 /      │
│  │                更新日志（DSH 运行包 / 客户端）/ 关于       │
│  ├── 客户端更新  ──► GitHub releases API 检测 → 引导打开 Release 页面手动下载 │
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
│  })                                                         │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│  渲染层 (titlebar.html / loading.html / error.html)         │
│  通过 window.dsh.* 与主进程通信；DSH Web UI 直接由           │
│  dshView.webContents.loadURL() 加载（不经 Vite bundle）     │
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

### 5.3 关闭流程

- `window-all-closed` 事件 → `stopDsh()` → Windows 上用 `taskkill /f /t` 杀整棵进程树（普通 `child.kill()` 杀不掉 npx 派生的子进程）。
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
| `install-dsh-update` | renderer → main (send) | DSH 更新横幅「更新 DSH」按钮   | 调用 `performUpdate()`；受 `isUpdating` 互斥锁 + 来源白名单保护                      |
| `install-update`  | renderer → main (send) | 客户端更新横幅「前往下载」按钮       | 弹出确认框后 `shell.openExternal` 打开 GitHub Release 页面；受 `isTrustedSender` 与 `pendingAppUpdateReleaseUrl` 守卫 |
| `open-external`   | renderer → main (invoke) | 关于模态框 GitHub 按钮 | 在系统默认浏览器打开 URL；受 `isTrustedSender` 守卫，仅允许 `http(s)` 协议              |
| `show-help-menu`  | renderer → main (send) | 标题栏「帮助」按钮       | 校验 sender 为主窗口 webContents 后，以按钮页内坐标（窗口相对坐标，见 §12.2 第 23 条）`Menu.popup` 弹出原生菜单（检查更新 / 更新日志子菜单 / 关于）|
| `help-menu-closed`| main → renderer        | 主进程 `menu-will-close` | 通知 titlebar.html 复位「帮助」按钮的 hover/active 类，防止原生菜单弹出期间鼠标事件被屏蔽导致的交互态颜色残留（见 §12.1 第 24 条）|
| `get-app-icon`    | renderer → main (invoke) | titlebar.html        | 返回应用图标 32×32 PNG data URL（nativeImage 读取 icon.ico）；受 `isTrustedSender` 守卫，失败返回空串（页面侧隐藏图标） |

所有敏感通道（`install-update` / `install-dsh-update` / `repair-dsh` / `open-external`）的 IPC handler 入口都过 `isTrustedSender(event)`：
仅允许 `file:`（本地 loading/error 页）或 loopback `http(s)`（DSH 页面）的 senderFrame。防止外部页面或被劫持的 webContents 触发高危操作。
`show-help-menu` 则直接比对 `event.sender === mainWindow.webContents`（更严格：只有标题栏页面能触发）。

**帮助菜单结构**（标题栏「帮助」按钮 → 原生菜单）：
- 检查更新... → 弹 dialog 选择检查项（DSH 运行包 / 客户端 / 全部，原 show-update-menu 逻辑迁移至此）
- 更新日志 → 子菜单：DSH 运行包日志（上游 `deepseek-ai/deepseek-harness` Releases，tag 前缀 `dsh-v`）/ DSH Desktop 客户端日志（本项目 Releases，tag 前缀 `v`）
- 关于 DSH Desktop → 模态框（客户端版本号 + DSH 运行包版本号 + GitHub 仓库链接按钮）

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
| `installUpdate()`      | `void`                                   | 触发客户端更新引导（确认后打开 GitHub Release 页面）|
| `installDshUpdate()`   | `void`                                   | 触发 DSH 运行包更新（切 loading 页执行）  |
| `openExternal(url)`    | `Promise<{success, error?}>`            | 在系统默认浏览器打开 URL               |
| `showHelpMenu(position)` | `void`                                 | 标题栏「帮助」按钮触发；把按钮坐标发给主进程，在按钮下方弹出原生帮助菜单（检查更新 / 更新日志 / 关于）|
| `onHelpMenuClosed(cb)` | `void`                               | 订阅帮助菜单关闭通知（主进程 `menu-will-close` 时发送）；titlebar.html 据此复位按钮交互态类名 |
| `getAppIcon()`     | `Promise<string>`                        | 读取应用图标 data URL（标题栏左侧图标显示用，失败返回空串）|

---

## 6. 内置 Node.js 与 DSH 包

### 6.1 内置 Node.js

- 版本：**v22.19.0 Windows x64**（写在 `scripts/download-node.js` 顶部 `NODE_VERSION`）。
- 下载源：先 `https://npmmirror.com/mirrors/node/...` 国内镜像，失败回退 `https://nodejs.org/dist/...`。
- 解压用 PowerShell 的 `Expand-Archive`。
- **打包后**保留 `node.exe` + **完整内置 npm**（`node_modules/npm`，含其 bundle 的全部依赖，体积约 +11MB）。npm 用于 **dsh 在线更新时给下载的包补装运行时依赖**（dsh-repair 的 `installPackageDependencies`）。`extraResources` 仅排除 corepack、`dist-types/**`、`.d.ts`、`.md`、`docs/`、`man/`，详见 `electron-builder.yml`。

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
| 更新源   | 仅 GitHub（`https://github.com/ycowner/deepseek-harness-desktop/releases`）                                  |
| 检测方式  | `src/main/app-update.ts` 手写 GitHub releases/latest API（`fetchGitHubLatest` → `checkForGitHubAppUpdate`）      |
| 更新方式  | **不自动下载安装**：检测到新版本后主进程弹确认框，`shell.openExternal` 打开 GitHub Release 页面，由用户手动下载安装包完成更新          |
| 守卫    | 版本号经 `isValidVersion` 校验；Release URL 白名单校验必须为 `https://github.com/` 前缀；`install-update` IPC 过 `isTrustedSender` |
| 遗留清理  | `cleanupLegacyInstallers()` 启动时一次性清理历史版本下载到安装目录的安装包                                                      |

自 1.0.3 起移除 electron-updater 与 Gitee 回退源（原自动下载 + sha512 校验 + spawn 安装链路全部下线）。`electron-builder.yml` 不再配置 `publish` 段，打包不再生成 `resources/app-update.yml`。

发布流程配套要求：GitHub 每个 release 的 **tag 必须以 `v` 开头**（如 `v1.0.3`，与 `app-update.ts` 的 `tag_name` 解析规则一致），并上传 `DSH-Desktop-Setup-<version>.exe` 安装包。

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
  - `dsh-bundled/`（预装 DSH 包，已排除 d.ts）
  - `icon.ico`（窗口图标，主进程通过 `process.resourcesPath/icon.ico` 读取）
- 安装包：NSIS、`perMachine: true`、`oneClick: false`、`allowToChangeInstallationDirectory: true`
- 安装包命名：`DSH-Desktop-Setup-<version>.exe`（`artifactName` 连字符格式，避免上传平台对空格的处理）
- 发布配置：不再使用 `publish` 段（原 electron-updater 自动更新已移除，不生成 `app-update.yml`）；GitHub Release 是用户手动下载的唯一渠道，每个 release 上传 `DSH-Desktop-Setup-<version>.exe` 即可。
- 体积说明：`extraResources` 缓存了核心 `node/` 内 npm（约 11MB）以满足 dsh 在线更新补依赖；排除了 corepack、文档、类型声明等无用文件（详见 `electron-builder.yml` 注释）。安装包约 146MB。

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
    - 共享 staging / target 目录的并发调用会互踩（`rmSync`/`renameSync` 互相干扰），造成缓存损坏。双击更新横幅、错误页重复点修复按钮都可能产生并发。
15. **不要将远端版本号直接拼入文件路径 / URL / JS 模板**。
    - 远端 `tag_name` 拼接前必须过 `isValidVersion()` 白名单（`/^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$/`）。这是纵深防御，git 标签命名规则是第一道防线；手动检查不要跳过。
16. **不要让 IPC handler 脱离 `isTrustedSender(event)` 校验**。
    - 敏感通道（`install-update` / `install-dsh-update` / `repair-dsh` / `open-external`）必须限制 senderFrame 为 `file:` 或 loopback `http(s)`，防止被劫持的 webContents 或外部页面触发高危操作。
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

### 12.2 改之前要确认

- 修改 `electron-builder.yml` 的 `extraResources` filter → 会显著影响安装包体积和首次启动行为，必须跑完整 `npm run package` 验证。
- 修改 `dsh-manager.ts` 的 `findCachedDshEntry()` 查找顺序 → 改了顺序会让某些环境找不到 DSH 包。
- 修改 `tsconfig.json` / `tsconfig.node.json` 的 `lib` / `types` → 三段式各自的类型会受影响，编译可能过不了。
- 修改渲染层 HTML 的 CSP 头 → 当前 `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`，DSH Web UI 通过 `loadURL` 加载不受这个 CSP 影响（每个 webContents 独立），但 loading/error 页的 inline 脚本依赖 `'unsafe-inline'`，不要直接删。titlebar.html 额外有 `img-src 'self' data:`（应用图标走 data URL），删掉图标会消失。
- 修改标题栏配色 → 必须同步两处：`titleBarOverlay`（系统三键区域颜色）与 `titlebar.html` 的 body 背景，漏一处会出现色差断层；当前为深色（#202020 / 符号 #e6e6e6）。
- 修改 Preload 暴露的 `window.dsh.*` API 名或形状 → 错误页 JS 强耦合，改完必须同步改 `error.html`。

---

## 13. 相关参考文档

- `.trae/specs/wrap-dsh-web-as-desktop-client/spec.md` — 原始需求规格（Why / What / Impact / 启动流程 / 关键技术决策 / Requirements & Scenarios）
- `.trae/specs/wrap-dsh-web-as-desktop-client/checklist.md` — 验收清单
- `.trae/specs/wrap-dsh-web-as-desktop-client/tasks.md` — 任务分解

> 这三个文件是历史规格，**不维护**，新需求请直接更新本 AGENTS.md 或在 issue 中讨论。

---

## 14. 修改本文档的时机

请在以下情况发生后**同步更新 AGENTS.md**：

- `package.json` 的 scripts 或 dependencies 变化
- `electron-builder.yml` 打包配置变化
- 新增/删除主进程模块、Preload API、IPC 通道
- 新增端口、缓存、文件路径相关的硬编码常量
- 新增"踩坑点"被验证为稳定规律
- macOS / Linux 支持状态变化
- 引入或废弃任何测试 / lint / CI 工具

如果发现 AGENTS.md 与代码不一致，**以代码为准**并在 PR 中修正 AGENTS.md。
