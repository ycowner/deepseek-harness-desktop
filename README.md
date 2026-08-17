# DSH Desktop

> DeepSeek Harness 的非官方 Electron 桌面客户端 — 零物实验室 出品

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)
[![Electron](https://img.shields.io/badge/Electron-33-47848F?logo=electron&logoColor=white)](https://www.electronjs.org/)
[![Node](https://img.shields.io/badge/Node.js-22.19.0-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![Platform](https://img.shields.io/badge/Platform-Windows%20x64-0078D6?logo=windows&logoColor=white)](#系统要求)
[![DSH](https://img.shields.io/badge/DSH-@deepseek--ai/dsh-blue)](https://github.com/deepseek-ai/deepseek-harness)

[English](./README.en.md) | 简体中文

---

## 关于本项目

**DSH Desktop** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（以下简称 DSH，DeepSeek AI 出品的开源 AI agent 框架）的**第三方非官方**桌面客户端。它通过 Electron 把 DSH 的 Web UI（默认 `http://127.0.0.1:3080`）包装成一个独立的 Windows 桌面应用，让用户无需手动安装 Node.js 与 DSH CLI，即可开箱即用。

> ⚠️ **免责声明**：本项目由零物实验室维护，与 DeepSeek AI 官方无任何隶属、赞助或背书关系。DSH 本身的功能、版本、许可证以 [上游仓库](https://github.com/deepseek-ai/deepseek-harness) 为准。本桌面客户端按 MIT 协议开源。

### 核心目标

- **零依赖开箱即用**：内置 Node.js v22.19.0 与预安装的 `@deepseek-ai/dsh` 包，**完全离线**也能跑。
- **包体验问题兜底**：DSH 包损坏/缺失时，可在错误页面一键"在线修复"，自动从 npm registry 重新下载。
- **进程生命周期托管**：自动启动 DSH 子进程、健康检查、端口冲突处理、退出时回收进程树。
- **桌面 UX 增强**：自定义 loading / error 页面、IPC 状态推送、外部链接跳系统浏览器。

---

## 截图

<!-- TODO: 启动 loading 界面 -->
![Loading](./docs/screenshots/loading.png)

<!-- TODO: DSH Web 主界面（加载完成） -->
![Main](./docs/screenshots/main.png)

<!-- TODO: 错误页 + 在线修复按钮 -->
![Error](./docs/screenshots/error.png)

---

## 技术特性

| 类别 | 说明 |
| --- | --- |
| **运行时隔离** | 打包内置 Node.js v22.19.0（win-x64），不依赖系统全局 Node，规避版本/路径冲突 |
| **首启离线** | 预打包 DSH 包到 `resources/dsh-bundled/`，首次启动**无需联网下载** |
| **进程管理** | 启动后通过 stdout/stderr 正则解析出 DSH 服务 URL，500ms 轮询健康检查，60s 超时快速失败 |
| **端口处理** | 默认 3080，被占用时检测是否已有 DSH 运行（复用）→ 否则自动顺延到下一个可用端口（最多 20 次） |
| **进程回收** | Windows 下 `taskkill /f /t` 强杀整棵进程树，关闭应用时自动清理 npx 派生的子进程 |
| **在线修复** | DSH 包损坏时通过内置 `node.exe` 直接 `https` 请求 npm registry 下载 tgz，调用系统 `tar.exe` 解压到用户可写目录（`%LOCALAPPDATA%/DSH Desktop/dsh-cache/`） |
| **缓存隔离** | 运行时 npm 缓存写入 `%LOCALAPPDATA%/DSH Desktop/npm-cache/`，避开 Program Files 下只读问题 |
| **加载体验** | 自定义 `loading.html`（旋转动画 + 状态文字）+ `error.html`（错误详情 + 重试/在线修复按钮），通过 IPC `status` 通道实时刷新状态 |
| **安全基线** | 渲染进程 `contextIsolation: true` + `nodeIntegration: false`，preload 注入受限 API |
| **CSP** | 加载/错误页都声明 `Content-Security-Policy`，禁外域脚本/样式 |
| **打包** | `electron-builder` NSIS 安装包（`perMachine`、`requestedExecutionLevel: requireAdministrator`，解决 DSH 创建符号链接的 EPERM 问题） |
| **体积优化** | 通过 `extraResources` filter 排除 `node_modules/**`、`.d.ts`、`docs/`、`.md` 等无关文件，**只打包 `node.exe`** |

---

## 系统要求

| 项 | 要求 |
| --- | --- |
| 操作系统 | Windows 10 / 11（x64） |
| 权限 | 管理员（DSH 内部会创建符号链接，需 `requireAdministrator`） |
| 端口 | 3080（默认）；被占用时自动顺延 |
| 磁盘 | 约 200 MB（含内置 Node.js + DSH 包） |
| 内存 | ≥ 512 MB 可用 |
| 网络 | 仅在以下场景需要：① 在线修复 DSH 包 ② DSH 自身访问 DeepSeek API |

> 当前仅发布 Windows x64 平台。macOS / Linux 的 `dsh-manager` 进程清理逻辑已写好但未配置 `electron-builder` target，需要时自行添加。

---

## 用户使用（安装包用户）

下载 NSIS 安装包 → 右键 → **以管理员身份运行** → 选择安装目录 → 完成。

启动 DSH Desktop 后会自动：

1. 检测内置 Node.js 与 DSH 包
2. 启动 DSH 服务（默认 `http://127.0.0.1:3080`）
3. 服务就绪后加载 Web UI

如果 DSH 包损坏，会弹出错误页，可点 **"在线修复"** 一键重新下载。

---

## 开发指南

### 环境要求

- Node.js ≥ 18（仅用于本机构建与运行 electron-vite）
- npm ≥ 9
- Windows 10/11 x64（构建目标是 win-x64）
- PowerShell（运行 `pnpm` / `npm` 等命令）

### 克隆与安装

```powershell
git clone https://github.com/ycowner/deepseek-harness-desktop.git
cd deepseek-harness-desktop
npm install
```

`postinstall` 钩子会自动调用 `scripts/download-node.js` 下载内置 Node.js v22.19.0（约 30 MB）到 `resources/node/`。国内网络不通时脚本会自动 fallback 到 `nodejs.org` 官方源。如需强制重下：

```powershell
npm run download-node -- --force
```

### 启动开发模式

```powershell
npm run dev
```

`electron-vite` 会：

- 起 Vite dev server 给渲染进程
- 监听 `src/main` / `src/preload` / `src/renderer` 改动并热更新
- 自动拉起 Electron 加载 loading 页面并启动 DSH

> 提示：开发模式下同样会调用 `resources/node/node.exe` 与 `resources/dsh-bundled/`，首次开发前请确保已 `npm install`（已自动下载 node）；DSH 包若未预装会触发"在线修复"流程。

### 预安装 DSH 包（可选）

`package` 时会自动执行，开发态下若要预热 DSH 包到 `resources/dsh-bundled/`：

```powershell
npm run preinstall-dsh
```

### 目录结构

```
deepseek-harness-desktop/
├─ src/
│  ├─ main/              # Electron 主进程
│  │  ├─ index.ts        # 应用入口、窗口管理、IPC 事件
│  │  ├─ dsh-manager.ts  # DSH 子进程生命周期（启动/停止/重启/URL 解析/端口探测）
│  │  ├─ dsh-repair.ts   # 在线修复：下载 tgz + 系统 tar 解压
│  │  └─ node-binary.ts  # 内置 Node.js 路径解析（dev / packaged 区分）
│  ├─ preload/           # 渲染进程桥接
│  │  └─ index.ts
│  └─ renderer/          # 自定义 HTML 页面
│     ├─ loading.html    # 启动 loading（CSS 旋转 + 状态文字）
│     ├─ error.html      # 错误页（详情 + 重试/在线修复）
│     └─ renderer.ts
├─ resources/            # 运行时资源（gitignore）
│  ├─ node/              # 内置 Node.js v22.19.0（build 时下载）
│  └─ dsh-bundled/       # 预安装的 DSH 包（build 时下载）
├─ build/                # electron-builder 资源
│  ├─ icon.ico
│  └─ *.jpg              # 应用图标源文件
├─ scripts/              # 构建脚本
│  ├─ download-node.js       # 下载内置 Node.js
│  ├─ preinstall-dsh.js      # 预安装 DSH 包到 resources/dsh-bundled
│  ├─ generate-icon.js       # 由源图生成 icon.ico
│  ├─ png-to-ico.ps1         # PowerShell 图标转换
│  └─ archive-dist-exe.js    # 打包后归档 dist-exe
├─ electron-builder.yml  # NSIS 打包配置
├─ electron.vite.config.ts
├─ package.json
├─ tsconfig.json
├─ tsconfig.node.json
└─ README.md / README.en.md
```

---

## 构建与发布

### 打 NSIS 安装包

```powershell
npm run package
```

执行链：

1. `scripts/download-node.js`：缺失则下载 Node.js 到 `resources/node/`
2. `scripts/preinstall-dsh.js`：缺失则预安装 DSH 包到 `resources/dsh-bundled/`
3. `electron-vite build`：编译主进程、preload、渲染进程到 `dist/`
4. `electron-builder`：按 `electron-builder.yml` 打 NSIS 安装包到 `dist-exe/`
5. `scripts/archive-dist-exe.js`：把 `dist-exe` 内容压缩归档

> **注意**：构建需要管理员权限（`electron-builder` 会请求 UAC 以创建符号链接）。若不想提权，可临时把 `electron-builder.yml` 中的 `requestedExecutionLevel` 改为 `asInvoker` 并自行承担运行期 EPERM 风险。

### 仅构建不打包

```powershell
npm run build   # 仅产出 dist/
npm run start   # 用本地 Electron 预览 dist/
```

---

## IPC 通道

主进程（`src/main/index.ts`）暴露以下 IPC：

| Channel | 方向 | 触发 | 说明 |
| --- | --- | --- | --- |
| `status` | main → renderer | DSH 启动各阶段 | 状态文字（"正在启动 DSH 服务..." / "服务已启动，正在等待就绪..." 等） |
| `retry` | renderer → main | 错误页"重试"按钮 | 停止旧 DSH → 重新加载 loading → 重新启动 |
| `repair-dsh` | renderer → main (invoke) | 错误页"在线修复"按钮 | 下载 DSH tgz 并解压，返回 `{ success, cachePath \| error }` |
| `repair-progress` | main → renderer | 修复流程各阶段 | 进度文字推送到错误页 |

---

## 运行时目录

| 路径 | 用途 |
| --- | --- |
| `<install>/resources/node/` | 内置 Node.js（只读） |
| `<install>/resources/dsh-bundled/` | 预安装 DSH 包（只读） |
| `%LOCALAPPDATA%/DSH Desktop/npm-cache/` | 运行时 npm 缓存（可写） |
| `%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/` | 在线修复下载的 DSH 包（可写） |

DSH 包查找优先级（`dsh-manager.ts#findCachedDshEntry`）：

1. `resources/dsh-bundled/`（打包预装，只读）
2. `%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/`（在线修复缓存，可写）
3. npx 缓存兜底（仅 dev 环境生效，打包后 node_modules 已被排除）

---

## 常见问题

### 启动报 "DSH 包未预装或已损坏"

点错误页 **"在线修复"** 按钮，工具会从 npm registry 重新下载最新 `@deepseek-ai/dsh` 到 `%LOCALAPPDATA%/DSH Desktop/dsh-cache/`，完成后点 **"重试"** 即可。

### 启动报 "在端口 3080-3300 范围内未找到可用端口"

执行：

```powershell
netsh int ipv4 show excludedportrange protocol=tcp
```

查看是否有大段端口被系统保留，关闭占用这些端口的程序后重试，或修改源码的 `DEFAULT_DSH_PORT` 与 `MAX_PORT_RETRIES`（`src/main/dsh-manager.ts`）。

### 启动报 "内置 Node.js 不存在"

通常是 `resources/node/` 被清理。重新跑：

```powershell
npm run download-node
```

### DSH 服务起来了但 UI 加载很慢

首次运行 DSH 自身可能要加载插件、做 JIT 等，几十秒内仍属正常。如持续超过 60s 会触发超时并显示错误页，可直接重试。

### 关闭应用后 DSH 进程残留

理论上 Windows 下 `taskkill /f /t` 会清理整棵进程树。如发现残留，可手动：

```powershell
tasklist | findstr node
taskkill /pid <pid> /f /t
```

---

## 路线图

- [ ] macOS / Linux 打包（当前仅 win-x64）
- [ ] 自动更新（`electron-updater`）
- [ ] DSH 服务端口在主窗口标题显示
- [ ] 多语言 UI（中/英）
- [ ] 应用内 DSH 日志查看器

---

## 贡献

欢迎 PR / Issue。在动手前请：

1. 同步 `main` 最新
2. 在 `src/main` 改动前先跑 `npm run build` 确认 TS 无错
3. 提交信息遵循 `feat:` / `fix:` / `refactor:` / `docs:` / `chore:` 规范

---

## 许可证

本项目以 [MIT](./LICENSE) 协议开源。© 零物实验室。

内置的 `@deepseek-ai/dsh` 包遵循其上游许可证（见 `THIRD_PARTY_NOTICES.md`，如有）。

---

## 致谢

- [DeepSeek AI](https://deepseek.com/) — 出品 DeepSeek Harness 上游
- [Electron](https://www.electronjs.org/) / [Vite](https://vitejs.dev/) / [electron-vite](https://electron-vite.org/)
- 所有贡献者

## 相关链接

- 上游 DSH 仓库：<https://github.com/deepseek-ai/deepseek-harness>
- 上游 DSH 中文 README：<https://github.com/deepseek-ai/deepseek-harness/blob/master/README.zh.md>
- DSH 项目主页：<https://deepseekdsh.com/>
- 本仓库：<https://github.com/ycowner/deepseek-harness-desktop>
- 团队：零物实验室
