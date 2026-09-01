import { app, BrowserWindow, WebContentsView, Menu, shell, ipcMain, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { startDsh, stopDsh, waitForDshReady, DSH_PACKAGE_MISSING_ERROR_NAME } from './dsh-manager'
import { prepareDshPackage, activateDshPackage, repairDsh } from './dsh-repair'
import { checkForUpdate, getInstalledDshVersion, isValidVersion } from './dsh-version'
import { checkForGitHubAppUpdate, getInstalledAppVersion, cleanupLegacyInstallers, fetchGitHubLatest } from './app-update'
import { fetchDshChangelogs, fetchAppChangelogs, renderMarkdownToHtml, escapeHtml, ChangelogEntry } from './changelog'
import { getThemeSetting, setThemeSetting, getEffectiveTheme, getOverlayColors, registerThemeHooks, registerNativeThemeListener, applyEmulateMedia } from './theme-manager'
import type { EffectiveTheme } from './theme-manager'

// 自定义标题栏高度（与 BrowserWindow 的 titleBarOverlay.height 保持一致）
const TITLEBAR_HEIGHT = 48

// 主窗口引用（其 webContents 加载标题栏页面 titlebar.html）
let mainWindow: BrowserWindow | null = null

// 内容视图（loading / error / DSH Web UI 全部加载于此，覆盖标题栏以下全部区域）
let dshView: WebContentsView | null = null

// 设置菜单浮层视图（自定义多级菜单，需要时叠加到内容区上方，标题栏仅 48px 高
// 无法在其页面内向下弹出，故用独立透明视图承载）
let menuView: WebContentsView | null = null

// 设置菜单浮层的视图尺寸（与 menu.html 三级面板的展开布局一致，勿单独改动）
const SETTINGS_MENU_WIDTH = 626
const SETTINGS_MENU_HEIGHT = 160

// 标记是否正在执行启动流程（防止重试重复触发）
let isStarting = false

// DSH 运行包更新互斥锁（performUpdate 与 install-dsh-update 入口检查）
let isUpdating = false

// DSH 修复互斥锁（repair-dsh IPC 重入保护）
let isRepairing = false

// 手动检查更新互斥锁（防止快速点击重复弹 dialog）
let isCheckingUpdate = false

// 更新日志展示互斥锁（防止重复触发并发拉取与模态框互踩）
let isShowingChangelog = false

// 待更新的桌面应用版本号与 GitHub Release 页面地址（由 checkForGitHubAppUpdateAndPrompt 赋值，install-update IPC 读取）
let pendingAppUpdateVersion: string | null = null
let pendingAppUpdateReleaseUrl: string | null = null

// 待安装的 DSH 运行包版本号（由 checkDshUpdateAndPrompt 赋值，install-dsh-update IPC 与 performUpdate 读取）
let pendingDshUpdateVersion: string | null = null

// 最近一次已提示过更新的 DSH 最新版本（用于抑制同一版本的重复弹窗/横幅）
let lastPromptedDshVersion: string | null = null

// GitHub 仓库地址（关于模态框 GitHub 按钮点击后在系统默认浏览器打开）
const GITHUB_REPO_URL = 'https://github.com/ycowner/deepseek-harness-desktop'

/**
 * 获取开发环境渲染进程的 URL 基础（去掉末尾斜杠）
 */
function getRendererBaseUrl(): string | null {
  const url = process.env.ELECTRON_RENDERER_URL
  if (!url) return null
  return url.replace(/\/$/, '')
}

/**
 * 同步内容视图布局
 *
 * 主窗口 webContents 自身加载标题栏页面（占满窗口，视觉上仅顶部 48px 高），
 * dshView 子视图覆盖标题栏以下的全部区域。
 * 窗口 resize / 最大化 / 还原均会触发 resize 事件，统一在此重排。
 */
function layoutViews(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!dshView) return
  const [width, height] = mainWindow.getContentSize()
  dshView.setBounds({ x: 0, y: TITLEBAR_HEIGHT, width, height: Math.max(0, height - TITLEBAR_HEIGHT) })
}

/**
 * 加载标题栏页面到主窗口 webContents（开发环境用 URL，生产环境用文件）
 *
 * 必须加载在主窗口自身的 webContents 上：Window Controls Overlay 的
 * env(titlebar-area-*) 环境变量只在主 webContents 中生效，
 * WebContentsView 子视图中恒为 0（实测踩坑），帮助按钮会因此错位到左边缘。
 */
function loadTitlebarPage(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const base = getRendererBaseUrl()
  if (base) {
    void mainWindow.webContents.loadURL(`${base}/titlebar.html`)
  } else {
    void mainWindow.webContents.loadFile(join(__dirname, '../renderer/titlebar.html'))
  }
}

/**
 * 加载 loading.html 到内容视图（开发环境用 URL，生产环境用文件）
 */
function loadLoadingPage(): void {
  if (!dshView) return
  const base = getRendererBaseUrl()
  if (base) {
    void dshView.webContents.loadURL(`${base}/loading.html`)
  } else {
    void dshView.webContents.loadFile(join(__dirname, '../renderer/loading.html'))
  }
}

/**
 * 加载 error.html 到内容视图并通过 query 参数传递错误信息
 */
function loadErrorPage(message: string): void {
  if (!dshView) return
  const base = getRendererBaseUrl()
  if (base) {
    void dshView.webContents.loadURL(`${base}/error.html?error=${encodeURIComponent(message)}`)
  } else {
    void dshView.webContents.loadFile(join(__dirname, '../renderer/error.html'), {
      query: { error: message }
    })
  }
}

/**
 * 向加载界面发送状态更新（通过 IPC channel 'status'）
 */
function sendStatus(status: string): void {
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send('status', status)
  }
}

/**
 * 显示错误页面
 *
 * 当错误为 DSH_PACKAGE_MISSING 时，在消息末尾追加特定标记，
 * 错误页面据此显示"在线修复"按钮
 */
function showError(message: string, isPackageMissing: boolean = false): void {
  const finalMessage = isPackageMissing
    ? `${message} [CODE:${DSH_PACKAGE_MISSING_ERROR_NAME}]`
    : message
  loadErrorPage(finalMessage)
}

/**
 * 获取窗口图标路径
 *
 * 开发环境使用项目根目录的 build/icon.ico；
 * 生产环境通过 electron-builder 的 extraResources 打包到 resources/icon.ico。
 */
function getWindowIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'icon.ico')
    : join(__dirname, '../../build/icon.ico')
}

/**
 * 校验 IPC 调用方来源是否可信
 *
 * 仅允许本地 file:// 协议（loading/error 页）或 loopback http(s)（DSH 页面），
 * 防止外部页面或被劫持的 webContents 触发高危通道（更新/修复/外链打开）。
 */
function isTrustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
  try {
    const frame = event.senderFrame
    if (!frame) return false
    const url = new URL(frame.url)
    if (url.protocol === 'file:') return true
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
    }
    return false
  } catch {
    return false
  }
}

/**
 * 判断内容视图当前是否加载着 DSH Web UI（loopback 页面）
 *
 * 横幅/图标仅在 DSH 页面注入，避免污染 loading/error 页（这些页面结构简单，
 * 注入 banner 可能造成 UI 错位）；也避免在 DSH UI 尚未加载时执行 JS 抛错。
 */
function isDshPageLoaded(): boolean {
  if (!dshView) return false
  try {
    const url = new URL(dshView.webContents.getURL())
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  } catch {
    return false
  }
}

/**
 * 注入组件（更新横幅 / 模态框）的 CSS 变量色板：浅色 / 深色两套。
 *
 * 注入代码统一引用变量而非硬编码色值，主题切换时由 syncInjectedTheme
 * 更新 :root 上的变量值；新注入的组件在注入时即按当前主题设置变量。
 */
const INJECTED_THEME_VARS: Record<EffectiveTheme, Record<string, string>> = {
  light: {
    '--dsh-modal-bg': '#ffffff',
    '--dsh-modal-text': '#374151',
    '--dsh-modal-heading': '#111827',
    '--dsh-modal-subtext': '#374151',
    '--dsh-modal-muted': '#6b7280',
    '--dsh-modal-border': '#e5e7eb',
    '--dsh-modal-hover': '#f3f4f6',
    '--dsh-modal-code-bg': '#f3f4f6',
    '--dsh-modal-link': '#2563eb',
    '--dsh-banner-btn-bg': '#ffffff'
  },
  dark: {
    '--dsh-modal-bg': '#1f2937',
    '--dsh-modal-text': '#d1d5db',
    '--dsh-modal-heading': '#f9fafb',
    '--dsh-modal-subtext': '#d1d5db',
    '--dsh-modal-muted': '#9ca3af',
    '--dsh-modal-border': '#374151',
    '--dsh-modal-hover': '#374151',
    '--dsh-modal-code-bg': '#111827',
    '--dsh-modal-link': '#60a5fa',
    '--dsh-banner-btn-bg': '#ffffff'
  }
}

/**
 * 同步 DSH 页内已注入组件的主题变量（横幅 / 模态框共用同一套变量）
 *
 * 仅在 DSH 页已加载时执行（横幅/模态框只注入在 DSH 页）。两个调用路径：
 * ① 主题切换时由 theme-manager 的同步回调触发；② 页面导航到 DSH 后主动设置，
 * 保证后续注入的横幅/模态框变量已就位。
 */
function syncInjectedTheme(): void {
  if (!dshView) return
  if (!isDshPageLoaded()) return
  const vars = INJECTED_THEME_VARS[getEffectiveTheme()]
  const code = `
    (function () {
      var vars = ${JSON.stringify(vars)}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])
    })()
  `
  dshView.webContents.executeJavaScript(code).catch(() => {
    /* 页面导航中静默忽略 */
  })
}

/**
 * 手动检查 DSH 运行包更新（绕过 lastPromptedDshVersion 抑制）
 *
 * 发现更新 → 注入蓝色横幅 + 弹 dialog 告知；
 * 已是最新 → 弹 dialog 显示版本；
 * 失败 → 弹 dialog 显示错误。
 */
async function manualCheckDshUpdate(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    const result = await checkForUpdate()
    if (result.error) {
      await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: '检查失败',
        message: 'DSH 运行包版本检查失败',
        detail: result.error,
        buttons: ['确定'],
        defaultId: 0
      })
      return
    }
    if (result.hasUpdate) {
      pendingDshUpdateVersion = result.latestVersion
      await injectDshUpdateBanner()
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: 'DSH 运行包有新版本可用',
        detail: `当前版本: v${result.currentVersion}\n最新版本: v${result.latestVersion}\n\n顶部蓝色横幅已显示，点击横幅中的「更新 DSH」即可执行更新。`,
        buttons: ['确定'],
        defaultId: 0
      })
    } else {
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '已是最新版本',
        message: 'DSH 运行包已是最新版本',
        detail: `当前版本: v${result.currentVersion}\n最新版本: v${result.latestVersion}`,
        buttons: ['确定'],
        defaultId: 0
      })
    }
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'error',
      title: '检查失败',
      message: 'DSH 运行包版本检查异常',
      detail: (err as Error).message,
      buttons: ['确定'],
      defaultId: 0
    })
  }
}

/**
 * 手动检查 DSH Desktop 客户端更新（仅打包环境允许）
 *
 * 发现更新 → 注入紫色横幅 + 弹 dialog 告知；
 * 已是最新 → 弹 dialog 显示版本（需额外调用 fetchGitHubLatest 获取最新版本号）；
 * 失败 → 弹 dialog 显示错误；
 * 开发环境 → 弹 dialog 提示不支持。
 */
async function manualCheckAppUpdate(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!app.isPackaged) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '开发环境提示',
      message: '客户端更新检查仅在打包环境生效',
      detail: `当前应用版本: v${getInstalledAppVersion()}\n开发环境无法检测 GitHub Release 最新版本，请打包后验证。`,
      buttons: ['确定'],
      defaultId: 0
    })
    return
  }
  try {
    const info = await checkForGitHubAppUpdate()
    if (info) {
      pendingAppUpdateVersion = info.version
      pendingAppUpdateReleaseUrl = info.releaseUrl
      await injectAppUpdateBanner()
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '发现新版本',
        message: 'DSH Desktop 客户端有新版本可用',
        detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${info.version}\n\n顶部紫色横幅已显示，点击横幅中的「前往下载」将打开 GitHub Release 页面。`,
        buttons: ['确定'],
        defaultId: 0
      })
    } else {
      // 已是最新版本，额外请求一次拿到最新版本号展示
      let latestVersion = '未知'
      try {
        const latest = await fetchGitHubLatest()
        latestVersion = latest.version
      } catch { /* 忽略获取失败 */ }
      await dialog.showMessageBox(mainWindow, {
        type: 'info',
        title: '已是最新版本',
        message: 'DSH Desktop 客户端已是最新版本',
        detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${latestVersion}`,
        buttons: ['确定'],
        defaultId: 0
      })
    }
  } catch (err) {
    await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      title: '检查失败',
      message: 'DSH Desktop 客户端版本检查失败',
      detail: (err as Error).message,
      buttons: ['确定'],
      defaultId: 0
    })
  }
}

/**
 * 帮助菜单「检查更新...」入口：弹 dialog 让用户选择检查项
 *
 * 沿用原有 show-update-menu 的检查逻辑（DSH 运行包 / 客户端 / 全部），
 * 受 isCheckingUpdate 互斥锁保护，防止重复弹 dialog。
 */
async function showUpdateCheckChoiceDialog(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isCheckingUpdate) return
  isCheckingUpdate = true
  try {
    const choice = await dialog.showMessageBox(mainWindow, {
      type: 'question',
      title: '检查更新',
      message: '请选择要检查的项目',
      buttons: ['检查 DSH 运行包', '检查 DSH Desktop 客户端', '全部检查', '取消'],
      defaultId: 2,
      cancelId: 3
    })
    if (choice.response === 3) return // 取消

    if (choice.response === 0) {
      await manualCheckDshUpdate()
    } else if (choice.response === 1) {
      await manualCheckAppUpdate()
    } else if (choice.response === 2) {
      // 全部检查：串行执行，第一个 dialog 关闭后再弹第二个
      await manualCheckDshUpdate()
      if (!mainWindow || mainWindow.isDestroyed()) return
      await manualCheckAppUpdate()
    }
  } finally {
    isCheckingUpdate = false
  }
}

/**
 * 向内容视图注入模态框外壳（标题 + 初始内容），并接管 Esc / 遮罩 / × 关闭
 *
 * 同一时间只允许一个模态框：注入前先清理旧模态框（含其 keydown 监听）。
 * 内容区通过 [data-dsh-modal-body] 标记，后续用 updateModalBody 替换。
 * 所有拼入 HTML 的变量均经 JSON.stringify / escapeHtml 处理，防注入断裂。
 */
async function injectModalShell(title: string, bodyHtml: string): Promise<void> {
  if (!dshView) return
  const modalCode = `
    (function () {
      // 清理旧模态框与其全局清理函数（跨多次注入保持单一实例）
      if (window.__dshModalCleanup) { try { window.__dshModalCleanup() } catch (e) {} }
      var prev = document.querySelector('[data-dsh-modal]')
      if (prev) prev.remove()

      var style = document.createElement('style')
      style.setAttribute('data-dsh-modal-style', '')
      style.textContent = '[data-dsh-modal]{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;font-family:system-ui,-apple-system,sans-serif;}' +
        '[data-dsh-modal] .dsh-backdrop{position:absolute;inset:0;background:rgba(0,0,0,.5);}' +
        '[data-dsh-modal] .dsh-card{position:relative;width:min(720px,92vw);max-height:80vh;display:flex;flex-direction:column;background:var(--dsh-modal-bg);color:var(--dsh-modal-text);border-radius:10px;box-shadow:0 12px 40px rgba(0,0,0,.35);overflow:hidden;}' +
        '[data-dsh-modal] .dsh-head{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--dsh-modal-border);flex:none;}' +
        '[data-dsh-modal] .dsh-title{font-size:15px;font-weight:600;color:var(--dsh-modal-heading);}' +
        '[data-dsh-modal] .dsh-close{width:28px;height:28px;border:none;border-radius:6px;background:transparent;color:var(--dsh-modal-muted);font-size:18px;line-height:1;cursor:pointer;}' +
        '[data-dsh-modal] .dsh-close:hover{background:var(--dsh-modal-hover);color:var(--dsh-modal-heading);}' +
        '[data-dsh-modal] .dsh-body{padding:16px 20px 20px;overflow-y:auto;font-size:13px;line-height:1.65;}' +
        '[data-dsh-modal] .dsh-body h3{font-size:15px;margin:14px 0 6px;color:var(--dsh-modal-heading);}' +
        '[data-dsh-modal] .dsh-body h4{font-size:14px;margin:12px 0 5px;color:var(--dsh-modal-heading);}' +
        '[data-dsh-modal] .dsh-body h5{font-size:13px;margin:10px 0 4px;color:var(--dsh-modal-subtext);}' +
        '[data-dsh-modal] .dsh-body p{margin:6px 0;}' +
        '[data-dsh-modal] .dsh-body ul{margin:6px 0;padding-left:22px;}' +
        '[data-dsh-modal] .dsh-body li{margin:3px 0;}' +
        '[data-dsh-modal] .dsh-body pre{background:var(--dsh-modal-code-bg);border-radius:6px;padding:10px 12px;overflow-x:auto;margin:8px 0;font-size:12px;}' +
        '[data-dsh-modal] .dsh-body code{background:var(--dsh-modal-code-bg);border-radius:4px;padding:1px 5px;font-family:ui-monospace,Consolas,monospace;font-size:12px;}' +
        '[data-dsh-modal] .dsh-body pre code{background:transparent;padding:0;}' +
        '[data-dsh-modal] .dsh-body a{color:var(--dsh-modal-link);}' +
        '[data-dsh-modal] .dsh-body hr{border:none;border-top:1px solid var(--dsh-modal-border);margin:12px 0;}' +
        '[data-dsh-modal] .dsh-body .dsh-log-entry{margin:0 0 14px;}' +
        '[data-dsh-modal] .dsh-body .dsh-log-head{display:flex;align-items:baseline;gap:10px;margin-bottom:4px;}' +
        '[data-dsh-modal] .dsh-body .dsh-log-ver{font-size:14px;font-weight:600;color:var(--dsh-modal-heading);}' +
        '[data-dsh-modal] .dsh-body .dsh-log-date{font-size:12px;color:var(--dsh-modal-muted);}' +
        '[data-dsh-modal] .dsh-body .dsh-log-divider{border:none;border-top:1px solid var(--dsh-modal-border);margin:0 0 14px;}'

      // 注入时按当前生效主题设置组件级 CSS 变量（横幅与模态框共用同一套变量）
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

      var root = document.createElement('div')
      root.setAttribute('data-dsh-modal', '')

      var backdrop = document.createElement('div')
      backdrop.className = 'dsh-backdrop'

      var card = document.createElement('div')
      card.className = 'dsh-card'

      var head = document.createElement('div')
      head.className = 'dsh-head'
      var titleEl = document.createElement('span')
      titleEl.className = 'dsh-title'
      titleEl.textContent = ${JSON.stringify(title)}
      var closeBtn = document.createElement('button')
      closeBtn.className = 'dsh-close'
      closeBtn.setAttribute('aria-label', '关闭')
      closeBtn.textContent = '×'
      head.appendChild(titleEl)
      head.appendChild(closeBtn)

      var body = document.createElement('div')
      body.className = 'dsh-body'
      body.setAttribute('data-dsh-modal-body', '')
      body.innerHTML = ${JSON.stringify(bodyHtml)}

      // 模态框内 fragment 锚点导航委托：更新日志的 [中文](#cn-...) 目录链接
      // 命中后拦截默认行为（防止整个 DSH 页面被 fragment 导航），改为在内容区
      // 滚动到目标标题（id 均由渲染端白名单校验后输出）
      body.addEventListener('click', function (e) {
        var el = e.target
        while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentNode
        if (!el || el.nodeType !== 1) return
        var href = el.getAttribute('href') || ''
        if (href.charAt(0) !== '#') return
        e.preventDefault()
        var target = document.getElementById(href.slice(1))
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })

      card.appendChild(head)
      card.appendChild(body)
      root.appendChild(style)
      root.appendChild(backdrop)
      root.appendChild(card)
      document.body.appendChild(root)

      function close() {
        root.remove()
        document.removeEventListener('keydown', onKey)
        window.__dshModalCleanup = null
      }
      function onKey(e) { if (e.key === 'Escape') close() }
      document.addEventListener('keydown', onKey)
      closeBtn.addEventListener('click', close)
      backdrop.addEventListener('click', close)
      window.__dshModalCleanup = close
    })()
  `
  try {
    await dshView.webContents.executeJavaScript(modalCode)
  } catch (err) {
    console.warn(`[DSH] 注入模态框失败: ${(err as Error).message}`)
  }
}

/**
 * 替换当前模态框的内容区 HTML（无模态框时静默忽略）
 */
async function updateModalBody(bodyHtml: string): Promise<void> {
  if (!dshView) return
  const code = `
    (function () {
      var body = document.querySelector('[data-dsh-modal-body]')
      if (body) body.innerHTML = ${JSON.stringify(bodyHtml)}
    })()
  `
  try {
    await dshView.webContents.executeJavaScript(code)
  } catch { /* 页面导航中静默忽略 */ }
}

/**
 * 将更新日志条目列表拼装为模态框内容 HTML
 *
 * version / publishedAt 已在 changelog.ts 校验（白名单 + 日期截取），可安全内插；
 * notes 经 renderMarkdownToHtml 安全渲染（全文转义 + 受限标签）。
 */
function buildChangelogHtml(entries: ChangelogEntry[]): string {
  if (entries.length === 0) {
    return '<p style="color:var(--dsh-modal-muted)">暂无更新日志。</p>'
  }
  const blocks = entries.map((entry) => `
    <div class="dsh-log-entry">
      <div class="dsh-log-head"><span class="dsh-log-ver">v${entry.version}</span><span class="dsh-log-date">${entry.publishedAt}</span></div>
      ${entry.notes.trim() ? renderMarkdownToHtml(entry.notes) : '<p style="color:var(--dsh-modal-muted)">暂无说明</p>'}
    </div>
  `)
  return blocks.join('<hr class="dsh-log-divider">') +
    '<p style="color:var(--dsh-modal-muted);font-size:12px;margin-top:4px">数据来自 GitHub Releases</p>'
}

/**
 * 帮助菜单「更新日志」入口：拉取并展示更新日志模态框
 *
 * 先注入加载中模态框，数据到达后替换内容；失败时在模态框内显示错误。
 * 受 isShowingChangelog 互斥锁保护，防止并发拉取互踩。
 */
async function showChangelog(kind: 'dsh' | 'app'): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !dshView) return
  if (isShowingChangelog) return
  isShowingChangelog = true
  const title = kind === 'dsh' ? 'DSH 运行包更新日志' : 'DSH Desktop 客户端更新日志'
  try {
    await injectModalShell(title, '<p style="color:var(--dsh-modal-muted)">正在加载更新日志，请稍候...</p>')
    const entries = await (kind === 'dsh' ? fetchDshChangelogs() : fetchAppChangelogs())
    await updateModalBody(buildChangelogHtml(entries))
  } catch (err) {
    await updateModalBody(`<p style="color:#dc2626">加载失败: ${escapeHtml((err as Error).message)}</p>`)
  } finally {
    isShowingChangelog = false
  }
}

/**
 * 帮助菜单「关于」入口：展示关于模态框
 *
 * 内容：DSH Desktop 客户端版本号 + DSH 运行包版本号 + GitHub 仓库链接按钮。
 */
async function showAboutModal(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !dshView) return
  const appVersion = escapeHtml(getInstalledAppVersion())
  const dshVersion = escapeHtml(getInstalledDshVersion())
  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:320px">
      <div style="font-size:16px;font-weight:600;color:var(--dsh-modal-heading)">DSH Desktop</div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
        <div><span style="color:var(--dsh-modal-muted)">客户端版本：</span><strong>v${appVersion}</strong></div>
        <div><span style="color:var(--dsh-modal-muted)">DSH 运行包版本：</span><strong>v${dshVersion}</strong></div>
      </div>
      <div style="margin-top:6px">
        <button class="dsh-about-repo" style="display:inline-flex;align-items:center;gap:6px;padding:6px 14px;background:#2563eb;color:#fff;border:none;border-radius:6px;font-size:12px;font-weight:600;cursor:pointer;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="#fff"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub 仓库</button>
      </div>
    </div>
  `
  await injectModalShell('关于 DSH Desktop', bodyHtml)
  // 绑定 GitHub 仓库按钮：走 window.dsh.openExternal（受 isTrustedSender 守卫）
  const wireCode = `
    (function () {
      var btn = document.querySelector('.dsh-about-repo')
      if (btn) btn.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.openExternal === 'function') {
          window.dsh.openExternal(${JSON.stringify(GITHUB_REPO_URL)})
        }
      })
    })()
  `
  try {
    await dshView.webContents.executeJavaScript(wireCode)
  } catch { /* 页面导航中静默忽略 */ }
}

/**
 * 创建主窗口（自定义标题栏 + 内容子视图）
 *
 * - titleBarStyle: 'hidden' + titleBarOverlay：隐藏系统标题栏，
 *   由 Windows 绘制最小化/最大化/关闭按钮（WCO），保留 Snap Layouts、
 *   双击标题栏最大化等原生行为；
 * - 主窗口 webContents：加载 titlebar.html（拖拽区域 + 帮助按钮，
 *   WCO 环境变量仅在主 webContents 中生效）；
 * - dshView：子视图覆盖标题栏以下区域，loading / error / DSH Web UI 全部加载于此。
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    // WCO 按钮区（最小化/最大化/关闭）配色按当前生效主题初始化：
    // 深色沿用出厂值 #202020，浅色 #f3f3f3（见 theme-manager）。必须与
    // titlebar.html 的 body 背景同步，漏一处会出现色差断层；
    // 运行中切换主题由 applyTheme 调 setTitleBarOverlay 更新
    titleBarOverlay: { ...getOverlayColors(), height: TITLEBAR_HEIGHT },
    icon: nativeImage.createFromPath(getWindowIconPath()),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  dshView = new WebContentsView({
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })
  mainWindow.contentView.addChildView(dshView)
  layoutViews()

  // 内容视图模拟当前生效主题的 prefers-color-scheme（DSH UI 若响应该媒体查询则跟随）；
  // 此时页面尚未提交导航（无 URL），CDP 回退路径内部会跳过，
  // 真正生效靠后续导航完成点（startDshAndLoad / performUpdate）的重设
  applyEmulateMedia(dshView.webContents, getEffectiveTheme())

  // 加载标题栏与 loading 界面
  loadTitlebarPage()
  loadLoadingPage()

  // 窗口准备好后再显示，避免出现白屏
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 窗口尺寸变化（resize / 最大化 / 还原）时同步视图布局；
  // 设置菜单浮层的坐标是打开时一次性计算的，尺寸变化直接关闭避免错位
  mainWindow.on('resize', () => {
    hideSettingsMenuView()
    layoutViews()
  })

  // 外部链接在系统默认浏览器中打开（挂在内容视图上）
  // 仅对真正的外部 http(s) URL 转发；DSH 自身地址(127.0.0.1/localhost)、
  // 空 URL、about:blank 一律 deny 不打开浏览器，避免 DSH Web UI 加载时
  // 自动 window.open 自身地址导致系统浏览器跟着弹出
  dshView.webContents.setWindowOpenHandler((details) => {
    try {
      const url = new URL(details.url)
      const isHttp = url.protocol === 'http:' || url.protocol === 'https:'
      const isLoopback =
        url.hostname === '127.0.0.1' ||
        url.hostname === 'localhost' ||
        url.hostname === '::1'
      if (isHttp && !isLoopback) {
        void shell.openExternal(details.url)
      }
    } catch {
      // 非 URL（如 about:blank）直接 deny 不处理
    }
    return { action: 'deny' }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    dshView = null
    menuView = null
  })
}

/**
 * 确保设置菜单浮层视图已创建（懒创建：首次打开设置菜单时）
 *
 * 背景透明：面板之外的区域可透视到下方内容；每次打开前重新加载页面，
 * 以重置展开状态（并天然拿到当前主题的 data-theme 打标）。
 */
function ensureMenuView(): WebContentsView {
  if (!menuView) {
    menuView = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        transparent: true,
        preload: join(__dirname, '../preload/index.js')
      }
    })
    // 层叠无需 setZIndex：子视图按加入顺序绘制，menuView 最后 addChildView，
    // 天然覆盖在标题栏页面与 dshView 之上
    const base = getRendererBaseUrl()
    if (base) {
      void menuView.webContents.loadURL(`${base}/menu.html`)
    } else {
      void menuView.webContents.loadFile(join(__dirname, '../renderer/menu.html'))
    }
  } else {
    const base = getRendererBaseUrl()
    if (base) {
      void menuView.webContents.loadURL(`${base}/menu.html`)
    } else {
      void menuView.webContents.loadFile(join(__dirname, '../renderer/menu.html'))
    }
  }
  return menuView
}

/**
 * 一次性外部点击上报钩子：菜单打开期间注入内容视图（含 DSH 远程页，
 * preload 同样生效），任意 mousedown 上报关闭并自我移除；
 * 菜单下次打开时重新注入，避免监听残留重复上报。
 */
const DSH_OUTSIDE_CLICK_HOOK = `(() => {
  try {
    if (window.__dshMenuCloser) document.removeEventListener('mousedown', window.__dshMenuCloser, true)
    const h = () => {
      document.removeEventListener('mousedown', h, true)
      window.__dshMenuCloser = null
      try {
        if (window.dsh && typeof window.dsh.sendSettingsMenuOutside === 'function') {
          window.dsh.sendSettingsMenuOutside()
        }
      } catch (e) {}
    }
    window.__dshMenuCloser = h
    document.addEventListener('mousedown', h, true)
  } catch (e) {}
})()`

/**
 * 打开设置菜单浮层：视图左边缘对齐设置按钮左边缘（根面板在视图内 (0,0)，
 * 即菜单正好出现在设置按钮正下方）、顶部紧贴标题栏下沿，
 * 右侧/底部超出窗口时向内收紧。视图加到 contentView 顶层，覆盖标题栏页面与 dshView。
 */
function showSettingsMenuView(position: { x: number; y: number; width: number }): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const view = ensureMenuView()
  const [winWidth, winHeight] = mainWindow.getContentSize()
  const left = Math.min(Math.round(position.x), Math.max(0, winWidth - SETTINGS_MENU_WIDTH))
  const top = Math.min(TITLEBAR_HEIGHT, Math.max(0, winHeight - SETTINGS_MENU_HEIGHT))
  view.setBounds({ x: left, y: top, width: SETTINGS_MENU_WIDTH, height: SETTINGS_MENU_HEIGHT })
  mainWindow.contentView.addChildView(view)

  // 菜单浮层只覆盖左上角一小块区域，内容区其余部分的点击仍落在 dshView 上，
  // 需向内容视图注入一次性 capture mousedown 监听，点击内容区即上报关闭菜单。
  // 标题栏区域的点击由 titlebar.html 自身的 capture 监听补报。
  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.executeJavaScript(DSH_OUTSIDE_CLICK_HOOK, true).catch(() => {
      /* 页面导航中静默忽略 */
    })
  }
}

/**
 * 关闭设置菜单浮层：移除视图并通知标题栏页面复位「设置」按钮交互态。
 * 覆盖全部关闭路径：选中主题项 / 点击外部 / Esc / 窗口 resize 与关闭。
 */
function hideSettingsMenuView(): void {
  if (menuView && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.contentView.removeChildView(menuView)
  }
  if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('settings-menu-closed')
  }
}

/**
 * 启动 DSH 服务并在就绪后加载到内容视图
 *
 * 流程：
 * 1. 发送状态更新到加载界面
 * 2. 启动 DSH 进程
 * 3. 等待服务就绪（最多 60 秒）
 * 4. 就绪后加载 DSH 的 Web 界面；超时则显示错误界面
 */
async function startDshAndLoad(): Promise<void> {
  if (isStarting) return
  isStarting = true

  try {
    sendStatus('正在启动 DSH 服务...')

    const dshProcess = await startDsh()

    sendStatus(`服务已启动，正在等待就绪 (${dshProcess.url})...`)

    // 健康检查：最多等 60 秒（DSH 包已预装时通常 3-5 秒就绪）
    // 首次下载场景由 startDsh 内部的 npx 处理，下载完成后才会 resolve
    const ready = await waitForDshReady(dshProcess.url, 60_000)

    if (!ready) {
      showError('DSH 服务启动超时（60秒），请检查网络连接后重试')
      return
    }

    // 服务就绪后加载 DSH Web 界面
    if (mainWindow && !mainWindow.isDestroyed() && dshView) {
      await dshView.webContents.loadURL(dshProcess.url)
      // 预置注入组件的主题 CSS 变量（新文档上旧变量已失效，为后续横幅/模态框注入做准备）
      syncInjectedTheme()
      // 新文档上重设 prefers-color-scheme 模拟（CDP 会话跨导航不保留，每次导航后需重设）
      applyEmulateMedia(dshView.webContents, getEffectiveTheme())
      // 更新窗口标题显示当前版本
      mainWindow.setTitle(`DSH Desktop v${getInstalledAppVersion()} - DSH v${getInstalledDshVersion()}`)
      // 异步检查更新（不阻塞启动流程）
      checkDshUpdateAndPrompt()
      // 异步检查桌面应用自身更新（不阻塞启动流程；有新版时引导打开 GitHub Release 页面）
      void checkForGitHubAppUpdateAndPrompt()
    }
  } catch (err) {
    const error = err as Error
    const isPackageMissing = error.name === DSH_PACKAGE_MISSING_ERROR_NAME
    showError(`DSH 启动失败: ${error.message}`, isPackageMissing)
  } finally {
    isStarting = false
  }
}

/**
 * 检查 DSH 是否有新版本，有则在 DSH UI 顶部注入蓝色更新横幅
 *
 * 供启动时与定时轮询复用；对同一最新版本只提示一次（lastPromptedDshVersion），
 * 避免更新轮询导致的重复横幅；检查失败仅记录日志，不打断用户操作。
 */
function checkDshUpdateAndPrompt(): void {
  void checkForUpdate().then(result => {
    if (result.hasUpdate && result.latestVersion !== lastPromptedDshVersion) {
      lastPromptedDshVersion = result.latestVersion
      pendingDshUpdateVersion = result.latestVersion
      void injectDshUpdateBanner()
    }
  }).catch(err => {
    console.error(`[DSH] 版本检查失败: ${err.message}`)
  })
}

/**
 * 启动 DSH 更新定时轮询（每 6 小时检查一次）
 *
 * 仅在打包环境生效，避免开发时周期性弹窗打扰。
 */
function startPeriodicDshUpdateCheck(): void {
  if (!app.isPackaged) return
  const SIX_HOURS = 6 * 60 * 60 * 1000
  setInterval(() => {
    checkDshUpdateAndPrompt()
  }, SIX_HOURS)
}

/**
 * 执行 DSH 更新流程
 *
 * 两阶段：先 prepare（下载+校验+安装到 staging，旧 DSH 继续运行），
 * 再 stopDsh → activate（rm + rename，毫秒级不可用窗口），最后 startDsh。
 * 全程受 isUpdating 互斥保护，防止并发触发与临时目录互踩。
 *
 * 更新成功后同时复位 pendingDshUpdateVersion 与 lastPromptedDshVersion，
 * 避免镜像滞后场景下用户被同一版本永久抑制（详见方案报告 #20）。
 */
async function performUpdate(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isUpdating) {
    console.warn('[DSH] DSH 更新已在进行中，忽略重复触发')
    return
  }
  isUpdating = true
  try {
    // 显示加载页面
    loadLoadingPage()
    sendStatus('正在下载最新版本 DSH 包...')

    // 阶段一：下载+校验+安装到 staging（旧 DSH 不受影响，继续对外服务）
    const prepared = await prepareDshPackage((msg: string) => sendStatus(msg))

    // 阶段二：先停后换（Windows 下 native 模块会锁定缓存目录，必须先停进程）
    sendStatus('下载完成，正在切换 DSH 版本...')
    await stopDsh()
    activateDshPackage(prepared.stagingDir)

    sendStatus('更新完成，正在重启 DSH 服务...')
    const dshProcess = await startDsh()
    sendStatus(`服务已启动，正在等待就绪 (${dshProcess.url})...`)

    const ready = await waitForDshReady(dshProcess.url, 60_000)
    if (!ready) {
      showError('DSH 服务启动超时（60秒），请检查网络连接后重试')
      return
    }

    // 重新加载 DSH Web UI
    if (mainWindow && !mainWindow.isDestroyed() && dshView) {
      await dshView.webContents.loadURL(dshProcess.url)
      // 预置注入组件的主题 CSS 变量（同 startDshAndLoad）
      syncInjectedTheme()
      // 新文档上重设 prefers-color-scheme 模拟（同 startDshAndLoad）
      applyEmulateMedia(dshView.webContents, getEffectiveTheme())
      // 更新窗口标题
      mainWindow.setTitle(`DSH Desktop v${getInstalledAppVersion()} - DSH v${getInstalledDshVersion()}`)
    }

    // DSH 运行包已更新，清除待安装标记并复位抑制计数（避免镜像滞后时该版本永不再提示）
    pendingDshUpdateVersion = null
    lastPromptedDshVersion = null

    // 更新完成后再次检查版本（走带抑制逻辑的检查，避免同一版本重复横幅）
    checkDshUpdateAndPrompt()
  } catch (err) {
    const error = err as Error
    console.error(`[DSH] 更新失败: ${error.message}`)
    dialog.showErrorBox('更新失败', `DSH 更新失败: ${error.message}`)
    loadErrorPage(error.message)
  } finally {
    isUpdating = false
  }
}

/**
 * 检查 GitHub 是否有桌面客户端新版本，有则注入更新横幅
 *
 * 检测到新版本后不再自动下载安装（自 1.0.3 起移除 electron-updater 与 Gitee 回退源），
 * 而是记录版本号与 Release 页面地址，由用户点击横幅后引导打开 GitHub Release 页面手动下载。
 * 全程仅在打包环境下执行；任何异常仅记录日志，不打断启动流程。
 */
async function checkForGitHubAppUpdateAndPrompt(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const info = await checkForGitHubAppUpdate()
    if (!info) {
      console.log('[DSH] 客户端版本检查：已是最新版本')
      return
    }
    pendingAppUpdateVersion = info.version
    pendingAppUpdateReleaseUrl = info.releaseUrl
    await injectAppUpdateBanner()
  } catch (err) {
    console.error(`[DSH] 客户端版本检查失败: ${(err as Error).message}`)
  }
}

/**
 * 向 DSH UI 顶部注入 DSH 运行包更新横幅
 *
 * 蓝色横幅，明确文案「DSH 运行包有更新 v当前 → v最新」。
 * 点击「更新 DSH」调用 window.dsh.installDshUpdate 触发 performUpdate。
 * 关闭按钮仅隐藏横幅，不影响定时轮询的抑制状态。
 */
async function injectDshUpdateBanner(): Promise<void> {
  if (!dshView) return
  if (!pendingDshUpdateVersion) return
  if (!isDshPageLoaded()) return
  // 防御性白名单：远端版本号未通过校验则放弃注入
  if (!isValidVersion(pendingDshUpdateVersion)) {
    console.warn(`[DSH] 最新版本号格式非法，放弃注入 DSH 更新横幅: ${pendingDshUpdateVersion}`)
    return
  }
  const currentVersion = getInstalledDshVersion()
  const latestVersion = pendingDshUpdateVersion
  const bannerCode = `
    (function () {
      var container = document.querySelector('[data-dsh-update-banners]')
      if (!container) {
        container = document.createElement('div')
        container.setAttribute('data-dsh-update-banners', '')
        container.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;'
        document.body.appendChild(container)
      }
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

      var existing = container.querySelector('[data-dsh-update-banner="dsh"]')
      if (existing) existing.remove()

      var banner = document.createElement('div')
      banner.setAttribute('data-dsh-update-banner', 'dsh')
      banner.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;background:#2563eb;color:#fff;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      banner.innerHTML = '<span>DSH 运行包有更新 <strong>v${currentVersion}</strong> → <strong>v${latestVersion}</strong></span><button data-action="update" style="padding:4px 12px;background:var(--dsh-banner-btn-bg);color:#2563eb;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">更新 DSH</button><button data-action="close" style="margin-left:4px;padding:2px 6px;background:transparent;color:#fff;border:none;font-size:16px;line-height:1;cursor:pointer;">×</button>'

      banner.querySelector('[data-action="update"]').addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.installDshUpdate === 'function') {
          window.dsh.installDshUpdate()
        }
      })
      banner.querySelector('[data-action="close"]').addEventListener('click', function () {
        banner.remove()
      })

      container.appendChild(banner)
    })()
  `
  try {
    await dshView.webContents.executeJavaScript(bannerCode)
  } catch (err) {
    // 页面尚未就绪或上下文已销毁时静默忽略（6h 轮询触发但页面处于 loading/error 页）
    console.warn(`[DSH] 注入 DSH 更新横幅失败: ${(err as Error).message}`)
  }
}

/**
 * 向 DSH UI 顶部注入 DSH Desktop 客户端更新横幅
 *
 * 紫色横幅，明确文案「DSH Desktop 客户端有更新 v当前 → v最新」。
 * 点击「前往下载」调用 window.dsh.installUpdate，弹出确认框后打开 GitHub Release 页面。
 * 关闭按钮仅隐藏横幅。
 */
async function injectAppUpdateBanner(): Promise<void> {
  if (!dshView) return
  if (!pendingAppUpdateVersion) return
  if (!isDshPageLoaded()) return
  if (!isValidVersion(pendingAppUpdateVersion)) {
    console.warn(`[DSH] 最新版本号格式非法，放弃注入客户端更新横幅: ${pendingAppUpdateVersion}`)
    return
  }
  const currentVersion = getInstalledAppVersion()
  const latestVersion = pendingAppUpdateVersion
  const bannerCode = `
    (function () {
      var container = document.querySelector('[data-dsh-update-banners]')
      if (!container) {
        container = document.createElement('div')
        container.setAttribute('data-dsh-update-banners', '')
        container.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;flex-direction:column;font-family:system-ui,-apple-system,sans-serif;'
        document.body.appendChild(container)
      }
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

      var existing = container.querySelector('[data-dsh-update-banner="app"]')
      if (existing) existing.remove()

      var banner = document.createElement('div')
      banner.setAttribute('data-dsh-update-banner', 'app')
      banner.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;background:#7c3aed;color:#fff;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      banner.innerHTML = '<span>DSH Desktop 客户端有更新 <strong>v${currentVersion}</strong> → <strong>v${latestVersion}</strong></span><button data-action="update" style="padding:4px 12px;background:var(--dsh-banner-btn-bg);color:#7c3aed;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">前往下载</button><button data-action="close" style="margin-left:4px;padding:2px 6px;background:transparent;color:#fff;border:none;font-size:16px;line-height:1;cursor:pointer;">×</button>'

      banner.querySelector('[data-action="update"]').addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.installUpdate === 'function') {
          window.dsh.installUpdate()
        }
      })
      banner.querySelector('[data-action="close"]').addEventListener('click', function () {
        banner.remove()
      })

      container.appendChild(banner)
    })()
  `
  try {
    await dshView.webContents.executeJavaScript(bannerCode)
  } catch (err) {
    console.warn(`[DSH] 注入客户端更新横幅失败: ${(err as Error).message}`)
  }
}

// 固定 AppUserModelID，与 electron-builder.yml 的 appId 保持一致。
// 必须严格在 app.whenReady() resolve 之前调用：
// 1) Electron 官方要求此方法必须在 ready 事件之前执行，才能让 Windows 在启动进程时
//    正确把该进程与 AppUserModelID 关联；
// 2) AppUserModelID 是 Windows 任务栏/开始菜单对应用身份识别的依据——
//    安装阶段注册的 HKLM\SOFTWARE\Classes\AppUserModelID\com.dsh.desktop
//    会被任务栏固定条目引用，必须跨升级保持不变（见 AGENTS.md §8.1）；
// 3) 升级路径上 electron-builder NSIS 模板靠 ${isUpdated} 标志启用 keep-shortcuts
//    链路，本调用仅负责运行时关联。
app.setAppUserModelId('com.dsh.desktop')

// 应用就绪时启动
app.whenReady().then(() => {
  // 一次性诊断：升级后默认在主进程启动路径上打印 AppUserModelID 与 .exe 路径，
  // 如果用户反馈任务栏丢失可在终端/日志头里查到本行，确认运行时是否拿到了正确的身份关联。
  console.log(`[DSH] AppUserModelID = ${app.getPath('exe')} | AUMID=com.dsh.desktop`)
  // 一次性：清理旧版本下载到安装目录下的遗留安装包
  cleanupLegacyInstallers()
  // 注册主题模块：窗口获取器 + 注入组件同步回调；监听系统明暗变化（「跟随系统」时生效）
  registerThemeHooks(() => ({ mainWindow, dshView }), () => syncInjectedTheme())
  registerNativeThemeListener()
  createWindow()
  void startDshAndLoad()
  // 启动 DSH 更新定时轮询（每 6 小时，仅在打包环境生效）
  startPeriodicDshUpdateCheck()

  // macOS 下点击 dock 图标时重新创建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow()
      void startDshAndLoad()
    }
  })
})

// 重试事件：先停止旧 DSH，再重新加载 loading 并启动
ipcMain.on('retry', async () => {
  if (isStarting) return

  try {
    await stopDsh()
  } catch (err) {
    console.error(`[DSH] 重试前停止失败: ${(err as Error).message}`)
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
  } else {
    loadLoadingPage()
  }

  await startDshAndLoad()
})

// 在线修复 DSH 包事件
// 由错误页面"在线修复"按钮触发，下载并解压 DSH 包到用户缓存目录
// 受 isRepairing 互斥锁保护，防止并发点击重复触发（共享 staging 目录互踩）
ipcMain.handle('repair-dsh', async (event) => {
  if (!isTrustedSender(event)) {
    return { success: false, error: '不受信任的调用来源' }
  }
  if (isRepairing) {
    return { success: false, error: '修复正在进行中，请勿重复操作' }
  }
  isRepairing = true
  try {
    const cachePath = await repairDsh((msg) => {
      // 上报修复进度到渲染进程
      if (!event.sender.isDestroyed()) {
        event.sender.send('repair-progress', msg)
      }
    })
    return { success: true, cachePath }
  } catch (err) {
    console.error(`[DSH] 在线修复失败: ${(err as Error).message}`)
    return { success: false, error: (err as Error).message }
  } finally {
    isRepairing = false
  }
})

// 获取已安装的 DSH 版本号
// 由 loading.html 加载时调用，用于显示当前版本
ipcMain.handle('get-installed-version', async () => {
  return getInstalledDshVersion()
})

// 检查更新
// 比较本地版本与 npm registry 最新版本，返回检查结果
ipcMain.handle('check-update', async () => {
  return await checkForUpdate()
})

// 获取桌面应用自身的版本号
// 由 loading.html 加载时调用，用于显示应用版本
ipcMain.handle('get-app-version', async () => app.getVersion())

// 获取应用图标 data URL（标题栏左侧图标显示用）
// 读取 getWindowIconPath()（dev: build/icon.ico / 打包: resources/icon.ico），
// nativeImage 缩放到 32x32 后转 PNG data URL（高 DPI 下 16 CSS px 实际渲染 32 物理像素）。
// 走 data URL 规避两种环境的路径问题：dev 页面在 localhost 引用不到 build/ 目录、
// 打包后页面在 asar 内而图标在 asar 外。失败返回空串（页面侧隐藏图标，不影响其他功能）。
ipcMain.handle('get-app-icon', (event) => {
  if (!isTrustedSender(event)) {
    return ''
  }
  try {
    const icon = nativeImage.createFromPath(getWindowIconPath())
    if (icon.isEmpty()) return ''
    return icon.resize({ width: 32 }).toDataURL()
  } catch {
    return ''
  }
})

// 获取当前外观设置与生效主题（设置菜单勾选态 / 页面主题初始化使用）
ipcMain.handle('get-theme', async (event) => {
  if (!isTrustedSender(event)) {
    return { setting: 'system' as const, effective: getEffectiveTheme() }
  }
  return { setting: getThemeSetting(), effective: getEffectiveTheme() }
})

// 同步获取生效主题：供 preload 在 document_start 时机为页面打 data-theme 标，
// 实现首屏无闪烁（主/内容视图的每个页面加载都会经过）。仅返回字符串，无阻塞风险。
ipcMain.on('get-theme-sync', (event) => {
  event.returnValue = getEffectiveTheme()
})

// 更新外观设置：白名单校验 + 来源守卫，持久化后立即应用（overlay / 广播 / emulateMedia / 注入组件同步）
ipcMain.handle('set-theme', async (event, setting: unknown) => {
  if (!isTrustedSender(event)) {
    return { success: false, error: '不受信任的调用来源' }
  }
  if (setting !== 'light' && setting !== 'dark' && setting !== 'system') {
    return { success: false, error: '非法的主题设置值' }
  }
  setThemeSetting(setting)
  return { success: true }
})

// 在系统默认浏览器中打开外部链接
// 由 DSH UI 中的 GitHub 图标 / 关于模态框触发，仅允许 http(s) 协议
ipcMain.handle('open-external', async (event, url: string) => {
  if (!isTrustedSender(event)) {
    return { success: false, error: '不受信任的调用来源' }
  }
  try {
    if (typeof url !== 'string' || !/^https?:\/\//.test(url)) {
      return { success: false, error: '不支持的链接格式' }
    }
    await shell.openExternal(url)
    return { success: true }
  } catch (err) {
    return { success: false, error: (err as Error).message }
  }
})

/**
 * DSH 运行包更新事件
 *
 * 由 DSH UI 中的 DSH 更新横幅触发，直接执行 DSH 更新流程。
 */
ipcMain.on('install-dsh-update', async (event) => {
  if (!isTrustedSender(event)) return
  if (!pendingDshUpdateVersion) return
  await performUpdate()
})

/**
 * 客户端更新引导事件
 *
 * 由 DSH UI 中的客户端更新横幅触发，弹出确认框后打开 GitHub Release 页面，
 * 由用户手动下载最新安装包并完成更新（不再自动下载安装）。
 */
ipcMain.on('install-update', async (event) => {
  if (!isTrustedSender(event)) return
  if (!app.isPackaged) return
  if (!pendingAppUpdateVersion || !pendingAppUpdateReleaseUrl) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '发现新版本',
    message: 'DSH Desktop 客户端有新版本可用',
    detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${pendingAppUpdateVersion}\n\n点击「前往下载」将打开 GitHub Release 页面，请下载最新安装包并手动完成更新。`,
    buttons: ['前往下载', '稍后更新'],
    defaultId: 0,
    cancelId: 1
  })
  if (result.response === 0) {
    await shell.openExternal(pendingAppUpdateReleaseUrl)
  }
})

/**
 * 帮助菜单事件
 *
 * 由标题栏「帮助」按钮触发。仅信任主窗口 webContents（标题栏页面加载于此）的调用；
 * 按钮位置（标题栏页面内 CSS 像素）直接作为窗口相对坐标传入 Menu.popup，
 * 在按钮正下方弹出原生菜单：
 * - 检查更新... → 弹 dialog 选择检查项（原有检查逻辑不变）
 * - 更新日志 → 子菜单：DSH 运行包日志 / DSH Desktop 客户端日志
 * - 关于 DSH Desktop → 关于模态框（客户端版本 + DSH 运行包版本 + GitHub 仓库）
 */
ipcMain.on('show-help-menu', (event, position: { x: number; y: number; width: number }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  // 仅信任主窗口 webContents（标题栏页面加载于此；内容视图 dshView 虽然也持有
  // 同一 preload，但比对 sender 可确保只有标题栏页面能触发菜单弹出）
  if (event.sender !== mainWindow.webContents) return
  if (
    typeof position !== 'object' || position === null ||
    typeof position.x !== 'number' || typeof position.y !== 'number'
  ) return

  const menu = Menu.buildFromTemplate([
    {
      label: '检查更新...',
      click: () => { void showUpdateCheckChoiceDialog() }
    },
    {
      label: '更新日志',
      submenu: [
        { label: 'DSH 运行包日志', click: () => { void showChangelog('dsh') } },
        { label: 'DSH Desktop 客户端日志', click: () => { void showChangelog('app') } }
      ]
    },
    { type: 'separator' },
    { label: '关于 DSH Desktop', click: () => { void showAboutModal() } }
  ])

  // 菜单关闭后通知标题栏页面复位「帮助」按钮的 hover/active 类：
  // 原生菜单弹出期间渲染进程收不到鼠标事件，关闭后若鼠标已移出按钮，
  // 页面侧的交互态会残留（标题栏仅 48px 高，下方是独立 webContents，不会自动清除）。
  // menu-will-close 覆盖全部关闭路径：Esc / 点击菜单外部 / 选中菜单项。
  menu.once('menu-will-close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('help-menu-closed')
    }
  })

  // 坐标系陷阱（实测：Electron 33 / Windows / 200% DPI）：popup 的 x/y 被 按「窗口客户区
  // 相对坐标」解释，而非官方文档声称的屏幕坐标。若叠加 getContentBounds() 偏移，
  // 最大化时碰巧正确（窗口原点≈屏幕原点），窗口化时菜单会向右下偏移恰好等于
  // 窗口自身的屏幕位置。因此直接传按钮在标题栏页面内的坐标（见 AGENTS.md §12.2 第 23 条）。
  menu.popup({
    window: mainWindow,
    x: Math.round(position.x),
    y: Math.round(position.y + 4)
  })
})

/**
 * 设置菜单事件
 *
 * 由标题栏「设置」按钮触发。守卫与坐标规则与 show-help-menu 一致：
 * 仅信任主窗口 webContents（标题栏页面加载于此），按钮页内坐标直传。
 * 菜单本体为自定义多级浮层（设置 → 外观 → 明暗模式 → 系统/浅色/深色），
 * 由透明 WebContentsView（menu.html）承载叠加在内容区上方；
 * 主题选择、点击外部、Esc 均由 menu.html 经 preload 回传关闭。
 */
ipcMain.on('show-settings-menu', (event, position: { x: number; y: number; width: number }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (event.sender !== mainWindow.webContents) return
  if (
    typeof position !== 'object' || position === null ||
    typeof position.x !== 'number' || typeof position.y !== 'number'
  ) return
  showSettingsMenuView(position)
})

/**
 * 设置菜单关闭请求：选中主题项 / 点击面板外部 / Esc 由 menu.html 上报，
 * 标题栏页面与内容视图（打开菜单时注入的一次性监听）检测到外部点击也会上报。
 * 主题切换本身由 menu.html 直接调 set-theme，这里只负责关菜单。
 */
ipcMain.on('settings-menu-outside', (event) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (
    event.sender !== mainWindow.webContents &&
    event.sender !== menuView?.webContents &&
    event.sender !== dshView?.webContents
  ) return
  // 菜单未打开（内容视图残留监听的延迟上报）则忽略
  if (!menuView || !mainWindow.contentView.children.includes(menuView)) return
  hideSettingsMenuView()
})

// 所有窗口关闭时退出应用（macOS 除外），并清理 DSH 进程
app.on('window-all-closed', async () => {
  try {
    await stopDsh()
  } catch (err) {
    console.error(`[DSH] 停止失败: ${(err as Error).message}`)
  }

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
