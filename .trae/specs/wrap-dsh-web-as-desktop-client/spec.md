# DSH Web 桌面客户端封装 Spec

## Why

用户每次使用 DeepSeek Harness (DSH) Web 界面时，需要手动打开终端、输入 `npx @deepseek-ai/dsh web`、保持终端窗口不关闭、再手动用浏览器打开 `http://127.0.0.1:3080`。这个流程对非技术用户不友好，且容易因误关终端导致服务中断。将其封装为桌面客户端后，用户双击图标即可直接使用 DSH Web 界面，无需接触终端。

## What Changes

- 新建一个 Electron 桌面应用项目，将 `npx @deepseek-ai/dsh web` 命令封装为桌面客户端
- 内置独立的 Node.js 二进制文件（v22.19+ LTS），用于在独立进程中启动 DSH 服务
- 应用启动时自动在后台 spawn DSH Web 服务进程，并在应用窗口中加载 Web 界面
- 首次启动时自动通过 npx 下载 `@deepseek-ai/dsh` 包，后续复用 npx 缓存
- 应用关闭时自动终止 DSH 服务进程，确保资源释放
- 提供加载等待界面（DSH 服务启动期间显示）
- 提供错误处理界面（DSH 服务启动失败时显示）
- 端口冲突自动处理（3080 被占用时自动递增寻找可用端口）
- 仅打包 Windows 平台（.exe 安装包）

## Impact

- Affected specs: 无（全新项目）
- Affected code: 全新项目，无现有代码影响
  - `package.json` - Electron 应用配置
  - `src/main/` - Electron 主进程代码（进程管理、窗口管理）
  - `src/renderer/` - 渲染进程代码（加载界面、错误界面）
  - `resources/node/` - 内置 Node.js 二进制文件
  - `electron-builder.yml` - 打包配置

## 技术架构

### 整体架构

```
┌──────────────────────────────────────────────────┐
│              Electron 桌面应用                    │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │            主进程 (Main Process)          │    │
│  │                                          │    │
│  │  1. 检查 Node.js 二进制是否存在           │    │
│  │  2. spawn: <node-binary> npx dsh web     │    │
│  │  3. 解析 stdout 获取服务地址/端口          │    │
│  │  4. 健康检查：轮询 HTTP 端口就绪          │    │
│  │  5. 创建 BrowserWindow 加载 URL          │    │
│  │  6. 窗口关闭时 kill DSH 进程              │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │        渲染进程 (Renderer Process)       │    │
│  │                                          │    │
│  │  - 加载中界面（Loading）                  │    │
│  │  - 错误界面（启动失败提示 + 重试按钮）     │    │
│  │  - DSH Web UI（通过 loadURL 加载）        │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  ┌──────────────────────────────────────────┐    │
│  │            应用资源 (Resources)           │    │
│  │                                          │    │
│  │  - resources/node/node.exe  (Node 22.19+) │    │
│  │  - npx 缓存目录（用户级，跨启动复用）      │    │
│  └──────────────────────────────────────────┘    │
└──────────────────────────────────────────────────┘
```

### 启动流程

1. 用户双击应用图标启动 Electron 应用
2. 主进程创建 BrowserWindow，显示加载中界面
3. 主进程使用内置 Node.js 二进制 spawn 子进程：`<node.exe> <npx.js> @deepseek-ai/dsh web`
4. 监听子进程 stdout，解析出服务地址（如 `http://127.0.0.1:3080`）
5. 轮询该地址，直到 HTTP 响应正常（健康检查）
6. BrowserWindow 加载该 URL，显示 DSH Web 界面
7. 用户开始使用 DSH

### 关闭流程

1. 用户关闭应用窗口
2. 主进程监听 `window-all-closed` 事件
3. 终止 DSH 子进程（`process.kill()`）
4. 应用退出

### 关键技术决策

#### 为什么用独立 Node.js 二进制而非 Electron 内置的？

- Electron 内置的 Node.js 版本由 Electron 版本决定，可能不满足 DSH 要求的 22.19+
- DSH 在独立进程中运行，进程崩溃不会影响 Electron 主进程
- 版本可控，避免 Electron 升级导致 Node.js 版本变化引发兼容问题

#### 为什么用 npx 而非直接打包 DSH 包？

- DSH 处于开发者预览阶段，版本频繁更新，npx 可获取最新版
- 首次下载后 npx 会缓存包，后续启动速度不受影响
- 应用包体更小（不包含 DSH 源码）

## ADDED Requirements

### Requirement: 桌面客户端一键启动

系统 SHALL 提供一个 Windows 桌面应用，用户双击图标即可启动 DSH Web 服务并显示其界面，无需手动操作终端或浏览器。

#### Scenario: 正常启动

- **WHEN** 用户双击应用图标
- **THEN** 应用窗口打开并显示加载中界面
- **AND** 后台自动启动 DSH Web 服务
- **AND** 服务就绪后窗口自动加载 DSH Web 界面
- **AND** 用户可以直接在应用窗口中使用 DSH 的所有功能

#### Scenario: 首次启动（需下载 DSH 包）

- **WHEN** 用户首次启动应用（本地无 DSH 缓存）
- **THEN** 加载界面显示"正在下载 DSH 程序包..."
- **AND** npx 自动下载 `@deepseek-ai/dsh` 包
- **AND** 下载完成后启动服务并加载界面

#### Scenario: 关闭应用

- **WHEN** 用户关闭应用窗口
- **THEN** 后台 DSH 服务进程被自动终止
- **AND** 应用完全退出，无残留进程

### Requirement: 内置 Node.js 运行时

系统 SHALL 在应用资源中内置 Node.js 二进制文件（v22.19+ LTS），无需用户预装 Node.js。

#### Scenario: 用户未安装 Node.js

- **WHEN** 用户系统未安装 Node.js
- **AND** 用户启动应用
- **THEN** 应用使用内置 Node.js 二进制启动 DSH 服务
- **AND** 不报任何依赖缺失错误

### Requirement: 端口冲突自动处理

系统 SHALL 在默认端口 3080 被占用时，自动寻找可用端口启动 DSH 服务。

#### Scenario: 默认端口被占用

- **WHEN** 端口 3080 已被其他程序占用
- **THEN** 系统自动尝试下一个端口（3081, 3082...）
- **AND** 找到可用端口后启动服务
- **AND** 应用窗口加载正确的端口地址

### Requirement: 加载与错误状态展示

系统 SHALL 在 DSH 服务启动期间显示加载界面，在启动失败时显示错误界面并提供重试选项。

#### Scenario: 服务启动中

- **WHEN** DSH 服务正在启动（下载包、初始化中）
- **THEN** 应用窗口显示加载动画和状态提示文字

#### Scenario: 服务启动失败

- **WHEN** DSH 服务进程异常退出或启动超时
- **THEN** 应用窗口显示错误信息和"重试"按钮
- **WHEN** 用户点击"重试"
- **THEN** 重新尝试启动 DSH 服务

### Requirement: DSH Web 界面完整嵌入

系统 SHALL 在 Electron 窗口中完整加载 DSH Web 界面，用户在桌面客户端中的操作体验与浏览器中完全一致。

#### Scenario: 正常使用

- **WHEN** DSH Web 界面加载完成
- **THEN** 用户可以在应用窗口中完成所有 DSH 操作
- **INCLUDING** 配置 API Key、选择工作区、切换运行模式、发送指令、查看 Trajectory 等
- **AND** 所有功能行为与浏览器访问 `http://127.0.0.1:3080` 完全一致
