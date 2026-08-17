# Tasks

- [x] Task 1: 初始化 Electron 项目结构
  - [x] SubTask 1.1: 创建 `package.json`，配置 Electron 依赖和脚本
  - [x] SubTask 1.2: 创建项目目录结构（`src/main/`, `src/renderer/`, `resources/`）
  - [x] SubTask 1.3: 创建基础 Electron 入口文件（`src/main/index.ts`），实现打开一个空白 BrowserWindow
  - [x] SubTask 1.4: 配置 TypeScript 和构建工具（electron-vite 或 electron-forge）
  - [x] SubTask 1.5: 验证 `npm run dev` 可以启动 Electron 空窗口

- [x] Task 2: 实现内置 Node.js 二进制管理
  - [x] SubTask 2.1: 编写构建脚本，在打包前自动下载 Node.js v22 LTS Windows 二进制到 `resources/node/`
  - [x] SubTask 2.2: 实现运行时获取 Node.js 二进制路径的工具函数（区分开发环境和打包环境）
  - [x] SubTask 2.3: 验证可通过内置 Node.js 执行简单 Node 脚本

- [x] Task 3: 实现 DSH 服务进程管理
  - [x] SubTask 3.1: 实现 spawn DSH 进程函数（使用内置 Node.js 运行 `npx @deepseek-ai/dsh web`）
  - [x] SubTask 3.2: 实现 stdout 监听，解析 DSH 服务地址和端口
  - [x] SubTask 3.3: 实现端口冲突检测和自动递增逻辑
  - [x] SubTask 3.4: 实现健康检查（轮询 HTTP 端口直到就绪或超时）
  - [x] SubTask 3.5: 实现进程生命周期管理（启动、停止、异常退出处理）
  - [x] SubTask 3.6: 验证 DSH 服务可以正常启动并被 HTTP 访问到

- [x] Task 4: 实现窗口和界面流程
  - [x] SubTask 4.1: 创建加载中界面 HTML（显示加载动画和状态文字）
  - [x] SubTask 4.2: 创建错误界面 HTML（显示错误信息和重试按钮）
  - [x] SubTask 4.3: 实现主流程：加载界面 → spawn DSH → 健康检查 → loadURL 加载 DSH Web 界面
  - [x] SubTask 4.4: 实现错误流程：启动失败时切换到错误界面，重试按钮触发重新启动
  - [x] SubTask 4.5: 实现 `window-all-closed` 时终止 DSH 进程并退出应用
  - [x] SubTask 4.6: 验证完整启动→使用→关闭流程正常工作

- [x] Task 5: 配置打包构建
  - [x] SubTask 5.1: 配置 electron-builder 打包参数（应用名称、图标、Windows 目标格式）
  - [x] SubTask 5.2: 配置 `extraResources` 将 Node.js 二进制打包进应用资源
  - [x] SubTask 5.3: 实现打包前自动下载 Node.js 二进制的钩子脚本
  - [x] SubTask 5.4: 执行打包，生成 Windows 安装包（.exe / .nsis）
  - [x] SubTask 5.5: 在干净环境（无 Node.js）安装并验证应用可正常启动和使用

# Task Dependencies
- [Task 2] depends on [Task 1]
- [Task 3] depends on [Task 2]
- [Task 4] depends on [Task 3]
- [Task 5] depends on [Task 4]
