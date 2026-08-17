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

**架构形态**：经典 Electron 三段式（main / preload / renderer），渲染层是**多页面**（`loading.html` + `error.html`），DSH Web UI 通过 `BrowserWindow.loadURL()` 直接加载远程 127.0.0.1 服务，不经过 Vite bundle。

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
│   │   ├── index.ts             ← 应用入口、窗口、IPC 路由
│   │   ├── dsh-manager.ts       ← DSH 进程生命周期（启动/停止/健康检查/端口）
│   │   ├── dsh-repair.ts        ← 在线修复 DSH 包（npm registry → tar.exe 解压）
│   │   └── node-binary.ts       ← 内置 Node 二进制路径解析
│   ├── preload/
│   │   └── index.ts             ← contextBridge 暴露的 window.dsh.* API
│   └── renderer/                ← 渲染层（纯 HTML，不走框架）
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
- 发版：`npm run package`（产物在 `dist-exe/`，归档在 `dist-exe-archives/<时间戳>/`）

---

## 5. 架构

### 5.1 进程拓扑

```
┌─────────────────────────────────────────────────────────────┐
│  Electron 主进程 (src/main/index.ts)                        │
│  ├── BrowserWindow  ──► 加载 loading.html → 加载 error.html  │
│  │                       → 服务就绪后 loadURL(dsh URL)      │
│  ├── IPC 路由  ──► 'status' / 'retry' / 'repair-dsh'        │
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
│  渲染层 (loading.html / error.html)                         │
│  通过 window.dsh.* 与主进程通信；DSH Web UI 直接由           │
│  BrowserWindow.loadURL() 加载（不经 Vite bundle）           │
└─────────────────────────────────────────────────────────────┘
```

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

| 通道                | 方向                       | 触发方                  | 说明                                   |
| ----------------- | ------------------------ | -------------------- | ------------------------------------ |
| `status`          | main → renderer          | 主进程任意时刻              | 启动进度文字                               |
| `retry`           | renderer → main          | error.html "重试" 按钮   | 主进程 stop → 重新加载 loading → 重新启动       |
| `repair-dsh`      | renderer → main (invoke) | error.html "在线修复" 按钮 | 返回 `{ success, cachePath?, error? }` |
| `repair-progress` | main → renderer          | repairDsh 进度回调       | 步骤文字（"正在下载..." / "解压完成" 等）           |

### 5.5 Preload API（`window.dsh`）

| 方法                     | 返回                                       | 说明                          |
| ---------------------- | ---------------------------------------- | --------------------------- |
| `retry()`              | `void`                                   | 通知主进程重试                     |
| `getErrorInfo()`       | `string`                                 | 读取错误信息（优先 IPC，否则 URL query） |
| `onStatus(cb)`         | `void`                                   | 订阅状态更新                      |
| `repairDsh()`          | `Promise<{success, cachePath?, error?}>` | 触发在线修复                      |
| `onRepairProgress(cb)` | `void`                                   | 订阅修复进度                      |

---

## 6. 内置 Node.js 与 DSH 包

### 6.1 内置 Node.js

- 版本：**v22.19.0 Windows x64**（写在 `scripts/download-node.js` 顶部 `NODE_VERSION`）。
- 下载源：先 `https://npmmirror.com/mirrors/node/...` 国内镜像，失败回退 `https://nodejs.org/dist/...`。
- 解压用 PowerShell 的 `Expand-Archive`。
- **打包后**只保留 `node.exe` + 必要的 `node_modules/npm`（`extraResources` 配置显式排除了 npm/corepack 的 `node_modules/**`、`dist-types/**`、`.d.ts`、`.md`、`docs/`、`man/`，详见 `electron-builder.yml`）。

### 6.2 DSH 包查找优先级（`dsh-manager.ts` 的 `findCachedDshEntry()`）

1. **`resources/dsh-bundled/`**（打包时预装的独立目录）—— **首选**
2. **`%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/`**（在线修复下载的缓存）
3. **`resources/node/.npm-cache/_npx/`**（打包预装的 npx 缓存，仅开发环境）
4. **`%LOCALAPPDATA%/DSH Desktop/npm-cache/_npx/`**（用户运行时 npx 缓存）

> 关键点：DSH 包**必须独立存放**到 `resources/dsh-bundled/`，**不能**塞进 `resources/node/node_modules/`，否则会被 `extraResources` 的 `!**/node_modules/**` 排除掉。

### 6.3 启动命令

```text
<内置 node.exe> <DSH 入口脚本> web --port <port>
```

- 通过 `--port` 显式传端口（DSH 实际不读 `PORT` 环境变量，这条坑在 `dsh-manager.ts:367-369` 注释里有写）。
- 设置独立的 `npm_config_cache` / `npm_config_prefix` 到 `%LOCALAPPDATA%/DSH Desktop/npm-cache/`，避免继承系统全局配置触发 EPERM。

### 6.4 用户可写缓存目录

| 路径                                      | 用途                                                               |
| --------------------------------------- | ---------------------------------------------------------------- |
| `%LOCALAPPDATA%/DSH Desktop/dsh-cache/` | 在线修复下载的 DSH 包                                                    |
| `%LOCALAPPDATA%/DSH Desktop/npm-cache/` | 运行时 npm/npx 缓存（必须可写，因为 `resources/node/` 在 `Program Files` 下是只读） |

两个目录都在用户级，跨应用启动复用，卸载应用不自动删除。

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

- 输出目录：`dist-exe/`
- 归档目录：`dist-exe-archives/<YYYYMMDD_HHMMSS>/`（`scripts/archive-dist-exe.js`）
- 主进程代码 → `dist/` → 打包进 `asar`
- 运行时资源 → `extraResources`：
  - `node/`（内置 Node，已排除 npm 的 node_modules / 文档 / 类型声明）
  - `dsh-bundled/`（预装 DSH 包，已排除 d.ts）
  - `icon.ico`（窗口图标，主进程通过 `process.resourcesPath/icon.ico` 读取）
- 安装包：NSIS、`perMachine: true`、`oneClick: false`、`allowToChangeInstallationDirectory: true`
- 体积优化关键：`extraResources` 的 `filter` 排除项减少了约 12MB 和 2300+ 小文件（详见 `electron-builder.yml` 注释）

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

### 12.2 改之前要确认

- 修改 `electron-builder.yml` 的 `extraResources` filter → 会显著影响安装包体积和首次启动行为，必须跑完整 `npm run package` 验证。
- 修改 `dsh-manager.ts` 的 `findCachedDshEntry()` 查找顺序 → 改了顺序会让某些环境找不到 DSH 包。
- 修改 `tsconfig.json` / `tsconfig.node.json` 的 `lib` / `types` → 三段式各自的类型会受影响，编译可能过不了。
- 修改渲染层 HTML 的 CSP 头 → 当前 `default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'`，DSH Web UI 通过 `loadURL` 加载不受这个 CSP 影响（每个 webContents 独立），但 loading/error 页的 inline 脚本依赖 `'unsafe-inline'`，不要直接删。
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
