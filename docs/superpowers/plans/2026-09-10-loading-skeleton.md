# 启动等待页骨架屏化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 DSH Desktop 的启动等待页（loading.html）从居中 spinner 样式替换为模仿 DSH 主界面轮廓的骨架屏（抽象色块 + 微光动画 + 一行实时状态文字）。

**Architecture:** 单文件原地重写 `src/renderer/loading.html`（纯 HTML/CSS/内联脚本，无框架、无构建依赖）；完整保留现有主题机制（preload `document_start` 打 `data-theme` 标 + `onThemeChanged` 订阅）与 `onStatus` 状态订阅；主进程 / preload / error.html / titlebar.html 零改动，启动与 DSH 更新两条 `loadLoadingPage()` 调用路径自动复用新页面。

**Tech Stack:** Electron 33 渲染层静态 HTML、CSS 变量 + `::after` 微光动画、`prefers-reduced-motion` 降级。

**Spec:** `docs/superpowers/specs/2026-09-10-loading-skeleton-design.md`

---

### Task 1: 提交 .gitignore 卫生改动

**Files:**
- 已修改（待提交）: `.gitignore`（新增 `.superpowers/` 忽略段）

- [ ] **Step 1: 确认改动内容**

Run: `git diff .gitignore`
Expected: 仅新增 `# superpowers brainstorm 视觉伴侣产物...` 注释与 `.superpowers/` 一行

- [ ] **Step 2: 提交**

```bash
git add .gitignore
git commit -m "chore: gitignore 忽略 .superpowers brainstorm 产物"
```

Expected: commit 成功，`git status` 中 `.superpowers/` 不再出现在未跟踪列表

- [ ] **Step 3: 提交本实施计划文档**

```bash
git add docs/superpowers/plans/2026-09-10-loading-skeleton.md
git commit -m "docs: 启动等待页骨架屏化实施计划"
```

---

### Task 2: 重写 loading.html 为骨架屏

**Files:**
- Modify: `src/renderer/loading.html`（整文件重写）

- [ ] **Step 1: 用以下完整内容覆盖 `src/renderer/loading.html`**

```html
<!DOCTYPE html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta
      http-equiv="Content-Security-Policy"
      content="default-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'"
    />
    <title>DSH Desktop - 加载中</title>
    <style>
      /* 主题变量：默认浅色；<html data-theme="dark"> 时覆盖为深色（即出厂配色）。
         data-theme 由 preload 在 document_start 同步打标（首屏无闪烁），
         运行中切换由页面脚本订阅 theme-changed 更新 */
      :root {
        --bg: #ffffff;
        --status: #8a8a94;
        --sk-block: rgba(0, 0, 0, 0.05);
        --sk-strong: rgba(0, 0, 0, 0.1);
        --sk-card: rgba(0, 0, 0, 0.04);
        --sk-border: rgba(0, 0, 0, 0.06);
        --sk-shine: rgba(0, 0, 0, 0.06);
      }

      :root[data-theme='dark'] {
        --bg: #1a1a2e;
        --status: #707080;
        --sk-block: rgba(255, 255, 255, 0.06);
        --sk-strong: rgba(255, 255, 255, 0.12);
        --sk-card: rgba(255, 255, 255, 0.05);
        --sk-border: rgba(255, 255, 255, 0.06);
        --sk-shine: rgba(255, 255, 255, 0.05);
      }

      /* 全局重置 */
      * {
        margin: 0;
        padding: 0;
        box-sizing: border-box;
      }

      html,
      body {
        height: 100%;
      }

      body {
        background: var(--bg);
        font-family: system-ui, -apple-system, sans-serif;
        display: flex;
        overflow: hidden;
      }

      /* 侧栏骨架：新会话按钮 / 工作区标签 / 会话列表 / 底部设置 的轮廓 */
      .sk-sidebar {
        width: 260px;
        flex: none;
        border-right: 1px solid var(--sk-border);
        padding: 12px;
        display: flex;
        flex-direction: column;
        gap: 12px;
      }

      .sk-sidebar .sk-newchat {
        height: 40px;
        border-radius: 8px;
      }

      /* 标签块与上方按钮块视觉间距 24px（容器 gap 12 + margin 12） */
      .sk-sidebar .sk-label {
        width: 64px;
        height: 12px;
        border-radius: 4px;
        margin-top: 12px;
      }

      .sk-sidebar .sk-item {
        height: 32px;
        border-radius: 6px;
      }

      .sk-sidebar .sk-spacer {
        flex: 1;
      }

      .sk-sidebar .sk-settings {
        width: 60%;
        height: 28px;
        border-radius: 6px;
      }

      /* 主区骨架：hero 行 / 选择器行 / 输入卡片，整体垂直居中；
         选择器行与 hero 行视觉间距 28px（容器 gap 16 + margin 12） */
      .sk-main {
        flex: 1;
        position: relative;
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        gap: 16px;
        padding: 0 24px;
      }

      .sk-hero {
        display: flex;
        align-items: center;
        gap: 10px;
      }

      .sk-hero .sk-logo {
        width: 36px;
        height: 36px;
        border-radius: 10px;
      }

      .sk-hero .sk-title {
        width: 200px;
        height: 24px;
        border-radius: 6px;
      }

      .sk-hero .sk-badge {
        width: 52px;
        height: 18px;
        border-radius: 9px;
      }

      .sk-selectors {
        display: flex;
        gap: 8px;
        margin-top: 12px;
      }

      .sk-selectors .sk-pill-a {
        width: 150px;
        height: 20px;
        border-radius: 6px;
      }

      .sk-selectors .sk-pill-b {
        width: 110px;
        height: 20px;
        border-radius: 6px;
      }

      .sk-inputcard {
        width: min(720px, 86%);
        height: 116px;
        border-radius: 12px;
        padding: 16px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
      }

      .sk-inputcard .sk-card-line {
        width: 38%;
        height: 12px;
        border-radius: 4px;
      }

      .sk-inputcard .sk-card-tools {
        display: flex;
        align-items: center;
        gap: 8px;
      }

      .sk-inputcard .sk-tool-circle {
        width: 28px;
        height: 28px;
        border-radius: 50%;
      }

      .sk-inputcard .sk-tool-bar {
        width: 120px;
        height: 12px;
        border-radius: 4px;
      }

      .sk-inputcard .sk-tool-spacer {
        flex: 1;
      }

      .sk-inputcard .sk-model-bar {
        width: 180px;
        height: 12px;
        border-radius: 4px;
      }

      .sk-inputcard .sk-send {
        width: 32px;
        height: 32px;
        border-radius: 50%;
      }

      /* 色块基类：普通 / 强调 / 输入卡片底覆写；全部承载微光动画 */
      .sk {
        position: relative;
        overflow: hidden;
        background: var(--sk-block);
      }

      .sk-strong {
        background: var(--sk-strong);
      }

      .sk-card {
        background: var(--sk-card);
      }

      /* 微光扫过：::after 渐变循环平移 */
      .sk::after {
        content: '';
        position: absolute;
        inset: 0;
        transform: translateX(-100%);
        background: linear-gradient(90deg, transparent, var(--sk-shine), transparent);
        animation: shimmer 1.8s linear infinite;
      }

      @keyframes shimmer {
        to {
          transform: translateX(100%);
        }
      }

      /* 系统关闭动画效果时降级为静态骨架 */
      @media (prefers-reduced-motion: reduce) {
        .sk::after {
          animation: none;
        }
      }

      /* 状态文字：唯一文字信息，主区底部居中，由 onStatus 实时更新 */
      .status {
        position: absolute;
        bottom: 20px;
        left: 0;
        right: 0;
        text-align: center;
        font-size: 12px;
        color: var(--status);
        word-break: break-word;
      }
    </style>
  </head>
  <body>
    <div class="sk-sidebar">
      <div class="sk sk-strong sk-newchat"></div>
      <div class="sk sk-label"></div>
      <div class="sk sk-item"></div>
      <div class="sk sk-strong sk-item"></div>
      <div class="sk sk-item"></div>
      <div class="sk-spacer"></div>
      <div class="sk sk-settings"></div>
    </div>
    <div class="sk-main">
      <div class="sk-hero">
        <div class="sk sk-strong sk-logo"></div>
        <div class="sk sk-title"></div>
        <div class="sk sk-badge"></div>
      </div>
      <div class="sk-selectors">
        <div class="sk sk-pill-a"></div>
        <div class="sk sk-pill-b"></div>
      </div>
      <div class="sk sk-card sk-inputcard">
        <div class="sk sk-card-line"></div>
        <div class="sk-card-tools">
          <div class="sk sk-tool-circle"></div>
          <div class="sk sk-tool-bar"></div>
          <div class="sk-tool-spacer"></div>
          <div class="sk sk-model-bar"></div>
          <div class="sk sk-strong sk-send"></div>
        </div>
      </div>
      <div class="status" id="status">正在启动 DSH 服务...</div>
    </div>
    <script>
      // 订阅主题变化：更新 <html> 的 data-theme 切换 CSS 变量色板
      // （首屏打标由 preload 在 document_start 同步完成，此处仅处理运行中切换）
      ;(function () {
        if (window.dsh && typeof window.dsh.onThemeChanged === 'function') {
          window.dsh.onThemeChanged(function (info) {
            document.documentElement.dataset.theme = info.effective
          })
        }
      })()

      // 订阅主进程发送的状态更新（由 preload 暴露的 window.dsh.onStatus）
      ;(function () {
        if (window.dsh && typeof window.dsh.onStatus === 'function') {
          window.dsh.onStatus(function (status) {
            var el = document.getElementById('status')
            if (el) el.textContent = status
          })
        }
      })()
    </script>
  </body>
</html>
```

- [ ] **Step 2: 构建检查**

Run: `npm run build`
Expected: 退出码 0，无报错（渲染层 HTML 原样拷贝进 dist/）

- [ ] **Step 3: 提交**

```bash
git add src/renderer/loading.html
git commit -m "feat: 启动等待页替换为模仿 DSH 主界面轮廓的骨架屏"
```

---

### Task 3: 独立页面视觉验证（浅色/深色/动画）

页面所有 `window.dsh.*` 调用均有守卫，可脱离 Electron 直接在浏览器打开验证色板与动画。

**Files:** 无修改（仅验证）

- [ ] **Step 1: 派 Browser 子代理打开独立页面并取证**

任务描述要点（传给 Browser 子代理）：
1. 打开 `file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/renderer/loading.html`
2. 截图保存为 `.qoder-screenshots/skeleton-light-standalone.png`（默认无 data-theme = 浅色色板）
3. 在控制台执行 `document.documentElement.dataset.theme = 'dark'`，截图保存为 `.qoder-screenshots/skeleton-dark-standalone.png`
4. 在控制台执行 `getComputedStyle(document.querySelector('.sk'), '::after').animationName`，记录返回值
5. 在控制台执行 `document.getElementById('status').textContent`，记录返回值
6. 返回：两张截图路径 + 两个控制台返回值

Expected: 动画名 `shimmer`；状态文本 `正在启动 DSH 服务...`

- [ ] **Step 2: 对照 mockup 目检截图**

用 Read 工具查看两张截图，对照 spec §2 规格（侧栏 260px 结构、hero/选择器/输入卡片、底部状态行、深浅色板）目检；差异仅允许为 mockup 缩比误差，不允许结构缺失或色板反向。

Expected: 结构齐全、浅色白底灰块 / 深色 #1a1a2e 底白透块

---

### Task 4: 真实应用启动路径验证（深色首屏 + 就绪切换）

**Files:** 无修改（仅验证）

- [ ] **Step 1: 后台启动 dev 模式**

Run（background）: `npm run dev`
等待 Electron 窗口出现（约 5-10 秒）。

- [ ] **Step 2: 抢占启动窗口期截图**

窗口出现后立刻执行全屏截图（骨架屏仅存在于 DSH 就绪前的 3-5 秒；若截到的是 DSH 主界面，关闭应用重跑本步并缩短等待）：

```pwsh
Add-Type -AssemblyName System.Windows.Forms,System.Drawing
$bounds = [System.Windows.Forms.SystemInformation]::VirtualScreen
$bmp = New-Object System.Drawing.Bitmap $bounds.Width, $bounds.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
$bmp.Save('e:\MyProject\IdeaProject\lingwulab-all\deepseek-harness-desktop\.qoder-screenshots\skeleton-dark-app.png')
$g.Dispose(); $bmp.Dispose()
```

- [ ] **Step 3: 目检截图并确认就绪切换**

Read 截图：应为深色骨架屏（侧栏 + 居中占位 + 底部「正在启动 DSH 服务...」或「服务已启动，正在等待就绪...」）。再等 10 秒后重复 Step 2 截图为 `skeleton-after-ready.png`，Read 确认已切换为 DSH 主界面（无骨架残留）。

- [ ] **Step 4: 关闭 dev 应用**

终止后台 dev 进程（Electron 窗口关闭 + 任务树清理，参考仓库 `dsh_kill.ps1` 的 taskkill 方式）。

---

### Task 5: 浅色主题首屏路径验证

**Files:** 无修改（仅验证；改用户配置后需还原）

- [ ] **Step 1: 备份并将主题配置改为 light**

设置文件确切路径：`%APPDATA%\dsh-web-desktop\settings.json`（theme-store.ts 的 `join(app.getPath('userData'), 'settings.json')`）。

```pwsh
$p = "$env:APPDATA\dsh-web-desktop\settings.json"
if (Test-Path $p) { Copy-Item $p "$p.bak" -Force; $j = Get-Content $p -Raw | ConvertFrom-Json } else { $j = [pscustomobject]@{} }
$j | Add-Member -Name theme -Value 'light' -MemberType NoteProperty -Force
$j | ConvertTo-Json | Set-Content $p -Encoding UTF8
```

- [ ] **Step 2: 重启 dev 并截图首屏**

重复 Task 4 Step 1-2，截图保存为 `.qoder-screenshots/skeleton-light-app.png`。
Expected: 白底 + 黑透色块骨架屏，无深色闪烁。

- [ ] **Step 3: 还原配置**

```pwsh
$p = "$env:APPDATA\dsh-web-desktop\settings.json"
if (Test-Path "$p.bak") { Move-Item "$p.bak" $p -Force } else { Remove-Item $p -ErrorAction SilentlyContinue }
```

---

### Task 6: reduced-motion 降级验证

**Files:** 无修改（仅验证）

- [ ] **Step 1: 验证媒体查询分支**

优先用 ComputerUse 子代理：Windows 设置 → 辅助功能 → 视觉特效 → 关闭「动画效果」，对 dev 应用启动窗口期截图 `.qoder-screenshots/skeleton-reduced-motion.png`，再恢复开关。
若 ComputerUse 不可用：人工切换后截图，或降级为代码审查确认 `@media (prefers-reduced-motion: reduce) { .sk::after { animation: none } }` 存在且选择器覆盖 `.sk`（所有色块均携带该类）。

Expected: 关闭动画效果时骨架静态显示（截图中色块无扫光梯度），或代码审查通过

---

### Task 7: 错误路径抽查

**Files:** 无修改（仅验证；涉及临时改名，必须还原）

- [ ] **Step 1: 临时移走 DSH 包触发 DSH_PACKAGE_MISSING**

```pwsh
Rename-Item "$env:LOCALAPPDATA\DSH Desktop\dsh-cache" dsh-cache.bak -ErrorAction SilentlyContinue
Rename-Item "e:\MyProject\IdeaProject\lingwulab-all\deepseek-harness-desktop\resources\dsh-bundled" dsh-bundled.bak
```

- [ ] **Step 2: 启动 dev 确认错误页接管**

Run（background）: `npm run dev`；等待窗口显示。
Expected: 骨架屏短暂显示后导航到 error.html，页面含「在线修复」按钮（error.html 未改动，表现应与改版前一致）。

- [ ] **Step 3: 关闭应用并还原目录**

```pwsh
Rename-Item "e:\MyProject\IdeaProject\lingwulab-all\deepseek-harness-desktop\resources\dsh-bundled.bak" dsh-bundled
Rename-Item "$env:LOCALAPPDATA\DSH Desktop\dsh-cache.bak" dsh-cache -ErrorAction SilentlyContinue
```

- [ ] **Step 4: 复核 git 状态干净**

Run: `git status --short`
Expected: 无未提交改动（截图目录与 .superpowers 均被忽略）

---

## 验收对照（spec §4）

| spec 验收项 | 对应 Task |
| --- | --- |
| 1 构建检查 | Task 2 Step 2 |
| 2 dev 深色骨架屏 + 就绪切换 | Task 4 |
| 3 浅色两路径 | Task 3（色板）+ Task 5（首屏）；运行中切换订阅代码与 titlebar/error 页同构，Task 3 Step 1 控制台切 data-theme 已覆盖同一 CSS 路径 |
| 4 reduced-motion | Task 6 |
| 5 更新流程复用 | 代码路径同 `loadLoadingPage()`，无需单独造场景（spec 已声明） |
| 6 错误路径 | Task 7 |
| 7 mockup 对照 | Task 3 Step 2 |
