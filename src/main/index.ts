import { app, BrowserWindow, WebContentsView, Menu, shell, ipcMain, nativeImage, Tray } from 'electron'
import { join } from 'path'
import type { DshDialogOptions } from './dsh-dialog'
import { startDsh, stopDsh, waitForDshReady, DSH_PACKAGE_MISSING_ERROR_NAME } from './dsh-manager'
import { prepareDshPackage, activateDshPackage, repairDsh, discardRetiredDshDir } from './dsh-repair'
import { getBundledRuntimeInfo } from './node-binary'
import { checkForUpdate, getInstalledDshVersion, isValidVersion, compareVersions } from './dsh-version'
import { checkForAppUpdate, getInstalledAppVersion, cleanupLegacyInstallers, UPDATE_FEED_URL } from './app-update'
import {
  configureAutoUpdater,
  markUpdateAvailable,
  getAppUpdateSnapshot,
  onAppUpdateState,
  downloadAppUpdate,
  cancelAppUpdateDownload,
  setDownloadStalled,
  installAppUpdateNow,
  installAppUpdateOnQuit,
  deferInstallToNextLaunch,
  shouldInstallOnNextLaunch,
  isAppUpdateReadyToInstall
} from './auto-updater'
import { fetchDshChangelogs, fetchAppChangelogs, renderMarkdownToHtml, escapeHtml, ChangelogEntry } from './changelog'
import { diag } from './update-diag'
import { getThemeSetting, setThemeSetting, getEffectiveTheme, getOverlayColors, registerThemeHooks, registerNativeThemeListener, applyEmulateMedia } from './theme-manager'
import { INJECTED_THEME_VARS, FONT_STACK } from './injected-theme'
import { showDshMessageBox, initDshDialog, ensureDialogHost, waitForNextDialogHost } from './dsh-dialog'
import { injectModalShell, updateModalBody } from './injected-modal'
import { fetchNotices, planNotices, markNoticeRead, getReadNoticeIds, type Notice } from './notice'
import { syncNoticeBanner } from './notice-banner'
import { refreshBalance, startBalancePolling, stopBalancePolling, getBalanceSnapshot, onBalanceUpdate, type BalanceSnapshot } from './deepseek-balance'

// 自定义标题栏高度（与 BrowserWindow 的 titleBarOverlay.height 保持一致）
const TITLEBAR_HEIGHT = 48

// 主窗口引用（其 webContents 加载标题栏页面 titlebar.html）
let mainWindow: BrowserWindow | null = null

// 内容视图（loading / error / DSH Web UI 全部加载于此，覆盖标题栏以下全部区域）
let dshView: WebContentsView | null = null

// 系统托盘实例（必须持有引用，否则被 GC 后托盘图标消失）
let tray: Tray | null = null

// 退出确认互斥锁（防止重复弹确认框，同时作为「已确认退出」标记）
let isQuitting = false

// 标记是否正在执行启动流程（防止重试重复触发）
let isStarting = false

// DSH 运行包更新互斥锁（performUpdate 与标题栏「更新DSH」入口检查）
let isUpdating = false

// DSH 修复互斥锁（repair-dsh IPC 重入保护）
let isRepairing = false

// 手动检查更新互斥锁（防止快速点击重复弹 dialog）
let isCheckingUpdate = false

// 更新日志展示互斥锁（防止重复触发并发拉取与模态框互踩）
let isShowingChangelog = false

// 客户端更新的最新版本号与安装包直链（由 checkForAppUpdateAndPrompt / manualCheckAppUpdate 赋值）。
// 直链仅用于「浏览器下载」人工兜底——自动下载链路本身由 auto-updater 内部按 latest.yml 解析，
// 不依赖这里的 URL。更新状态（下载中/已完成等）一律从 auto-updater 的快照取，本文件不另存一份。
let pendingAppUpdateVersion: string | null = null
let pendingAppUpdateDownloadUrl: string | null = null

// 待安装的 DSH 运行包版本号（由 checkDshUpdateAndPrompt 赋值，标题栏「更新DSH」IPC 与 performUpdate 读取）
let pendingDshUpdateVersion: string | null = null

// 最近一次已提示过更新的 DSH 最新版本（用于抑制同一版本的重复弹窗/横幅）
let lastPromptedDshVersion: string | null = null

// 最近一次由窗口聚焦触发余额刷新的时间（30s 防抖，避免 Alt+Tab 等频繁聚焦触发查询）
let lastFocusBalanceRefresh = 0

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
 * 余额明细 tooltip 注入样式（注入 DSH 内容页）
 *
 * 面板必须注入在 dshView（DSH 页）内而非标题栏页：dshView 子视图绘制在主
 * webContents **之上**，标题栏页内的面板会被 DSH 内容完全遮挡。早期版本
 * 用「展开期间隐藏 dshView」规避，导致内容区整片黑屏，已废弃。
 *
 * 主题适配走 prefers-color-scheme 媒体查询：DSH UI 本身响应该媒体查询
 * （applyEmulateMedia 按生效主题模拟），面板随之自动切换，无需额外同步变量。
 * 垂直定位 top:0 —— dshView 视口从标题栏底（y=48）开始，面板顶紧贴标题栏
 * 下沿即"紧贴徽章下方"的物理极限（徽章底 y=38 与标题栏底 y=48 之间属标题栏
 * 区域，dshView 无法绘制）。left:242px 仅为缺省兜底（与 .bb-wrap 同源），
 * 展开时由 showBalanceTooltip 按徽章实时 rect 动态计算左对齐 left。
 * 选择器统一加 #dsb-tooltip 前缀，避免与 DSH 页面自身样式碰撞。
 */
const BALANCE_TOOLTIP_CSS = [
  '#dsb-tooltip {',
  '  position: fixed; top: 0; left: 242px; width: 264px;',
  '  padding: 14px 16px; border-radius: 16px;',
  '  border: 1px solid var(--dsh-dlg-glass-border);',
  '  background: var(--dsh-dlg-glass);',
  '  -webkit-backdrop-filter: blur(14px) saturate(180%);',
  '  backdrop-filter: blur(14px) saturate(180%);',
  '  box-shadow: var(--dsh-dlg-shadow), inset 0 1px 0 0 var(--dsh-dlg-highlight);',
  '  color: var(--dsh-dlg-body); font-size: 12px; line-height: 1.7;',
  '  z-index: 2147483646; pointer-events: none;',
  `  font-family: ${FONT_STACK};`,
  '}',
  '#dsb-tooltip .bbt-title { font-size: 11px; color: var(--dsh-dlg-muted); }',
  '#dsb-tooltip .bbt-amount { font-size: 20px; font-weight: 600; color: var(--dsh-dlg-fg); letter-spacing: 0.2px; margin-top: 2px; }',
  '#dsb-tooltip .bbt-amount.is-warn { color: #f87171; }',
  '#dsb-tooltip .bbt-grid { display: flex; gap: 18px; margin-top: 8px; }',
  '#dsb-tooltip .bbt-grid .k { color: var(--dsh-dlg-muted); font-size: 11px; }',
  '#dsb-tooltip .bbt-msg { margin-top: 8px; color: var(--dsh-dlg-muted); font-size: 11px; }',
  '#dsb-tooltip .bbt-hint { margin-top: 8px; padding-top: 8px; border-top: 1px solid var(--dsh-dlg-hairline); color: var(--dsh-dlg-muted); font-size: 11px; }'
].join('\n')

/**
 * 注入余额明细 tooltip 外壳（样式 + 空容器）到 DSH 内容页
 *
 * 幂等：已存在则跳过。每次内容视图文档加载完成（did-finish-load）时调用，
 * 保证刷新/导航后面板随新文档重建、首次悬停零延迟；
 * loading/error 页（非 DSH 页）经 isDshPageLoaded 守卫自动跳过。
 */
function injectBalanceTooltipShell(): void {
  if (!dshView || dshView.webContents.isDestroyed() || !isDshPageLoaded()) return
  const code = `
    (function () {
      // 玻璃令牌补写（幂等）：tooltip 现在依赖 --dsh-dlg-*，而 syncInjectedTheme
      // 只在主题切换 / 导航到 DSH 之后才写。首次悬停可能早于那条路径，
      // 令牌缺失会让面板变成无背景无色。
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])
      if (document.getElementById('dsb-tooltip')) return 'exists'
      var style = document.createElement('style')
      style.id = 'dsb-tooltip-style'
      style.textContent = ${JSON.stringify(BALANCE_TOOLTIP_CSS)}
      ;(document.head || document.documentElement).appendChild(style)
      var panel = document.createElement('div')
      panel.id = 'dsb-tooltip'
      panel.hidden = true
      ;(document.body || document.documentElement).appendChild(panel)
      return 'injected'
    })()
  `
  void dshView.webContents.executeJavaScript(code).catch(() => {
    /* 页面导航中静默忽略 */
  })
}

/**
 * 展开余额明细 tooltip
 *
 * html 由标题栏页构建（buildTooltip：本地数字与固定文案，无远端文本），
 * 经 JSON.stringify 安全嵌入注入代码。外壳缺失时一并补建（单次往返），
 * 覆盖 SPA 路由替换 body 的极端场景。
 *
 * anchor 为徽章实时 rect（相对标题栏视口，与 dshView 视口水平坐标一致），
 * 用于面板左边缘对齐徽章左边缘：left = 徽章 left，clamp 到视口内。
 * anchor 缺省（tooltip 展开中的数据刷新）时保持现有 left 不动，避免刷新跳动。
 */
function showBalanceTooltip(html: string, anchor?: { left: number; width: number }): void {
  if (!dshView || dshView.webContents.isDestroyed() || !isDshPageLoaded()) return
  const hasAnchor =
    anchor != null && Number.isFinite(anchor.left) && Number.isFinite(anchor.width)
  const anchorCode = hasAnchor ? JSON.stringify({ left: anchor.left, width: anchor.width }) : 'null'
  const code = `
    (function () {
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])
      if (!document.getElementById('dsb-tooltip')) {
        var style = document.createElement('style')
        style.id = 'dsb-tooltip-style'
        style.textContent = ${JSON.stringify(BALANCE_TOOLTIP_CSS)}
        ;(document.head || document.documentElement).appendChild(style)
        var shell = document.createElement('div')
        shell.id = 'dsb-tooltip'
        ;(document.body || document.documentElement).appendChild(shell)
      }
      var panel = document.getElementById('dsb-tooltip')
      panel.innerHTML = ${JSON.stringify(html)}
      panel.hidden = false
      var anchor = ${anchorCode}
      if (anchor) {
        var vw = document.documentElement.clientWidth
        var left = anchor.left
        left = Math.max(8, Math.min(left, vw - panel.offsetWidth - 8))
        panel.style.left = left + 'px'
      }
      return 'shown'
    })()
  `
  void dshView.webContents.executeJavaScript(code).catch(() => {
    /* 页面导航中静默忽略 */
  })
}

/** 收起余额明细 tooltip（保留内容，下次展开无闪烁） */
function hideBalanceTooltip(): void {
  if (!dshView || dshView.webContents.isDestroyed()) return
  const code = `
    (function () {
      var panel = document.getElementById('dsb-tooltip')
      if (panel) panel.hidden = true
      return true
    })()
  `
  void dshView.webContents.executeJavaScript(code).catch(() => {
    /* 页面导航中静默忽略 */
  })
}

/**
 * 客户端更新包下载进度横幅的样式（仅 downloading 阶段显示）
 *
 * 定位在 DSH 页面顶部通栏。配色全部走 INJECTED_THEME_VARS 的 --dsh-* 变量，
 * 主题切换时由 syncInjectedTheme 更新。进度条用天蓝（--dsh-accent），
 * 与标题栏「更新」按钮同色系，让两处视觉上属于同一件事。
 *
 * 全部选择器加 #dsh-ub 前缀，避免与 DSH 页面自身样式碰撞。
 */
const APP_UPDATE_BANNER_CSS = [
  '#dsh-ub {',
  '  position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000;',
  '  box-sizing: border-box; padding: 10px 16px 12px;',
  '  background: var(--dsh-modal-bg);',
  '  border-bottom: 1px solid var(--dsh-modal-border);',
  '  box-shadow: 0 2px 12px rgba(0,0,0,0.18);',
  '  font-family: system-ui, -apple-system, "Segoe UI", sans-serif;',
  '  color: var(--dsh-modal-text);',
  '  pointer-events: none;',
  '}',
  '#dsh-ub[hidden] { display: none; }',
  '#dsh-ub .dsh-ub-row {',
  '  display: flex; align-items: baseline; justify-content: space-between;',
  '  gap: 12px; margin-bottom: 8px;',
  '}',
  '#dsh-ub .dsh-ub-title {',
  '  font-size: 13px; font-weight: 600; color: var(--dsh-modal-heading);',
  '}',
  '#dsh-ub .dsh-ub-pct {',
  '  font-size: 13px; font-weight: 600; color: var(--dsh-accent);',
  '  font-variant-numeric: tabular-nums;',
  '}',
  '#dsh-ub .dsh-ub-track {',
  '  height: 6px; border-radius: 3px; overflow: hidden;',
  '  background: var(--dsh-modal-hover);',
  '}',
  '#dsh-ub .dsh-ub-bar {',
  '  height: 100%; width: 0%; border-radius: 3px;',
  '  background: var(--dsh-accent);',
  '  transition: width 0.25s ease-out;',
  '}',
  '#dsh-ub .dsh-ub-meta {',
  '  margin-top: 6px; font-size: 12px; color: var(--dsh-modal-muted);',
  '  display: flex; justify-content: space-between; gap: 12px;',
  '}',
  '#dsh-ub .dsh-ub-num { font-variant-numeric: tabular-nums; }'
].join('\n')

/**
 * 同步 DSH 页顶部的「客户端更新包下载中」进度横幅
 *
 * **只在 auto-updater 的 downloading 阶段出现**，其余阶段一律隐藏：
 * - available / downloaded：标题栏「更新」按钮已经承载了这两件事，不再重复提示；
 * - error：按钮点开就是「重试下载 / 浏览器下载」，横幅留着只会碍事；
 * - idle：已是最新。
 *
 * 纯展示、零交互、零 IPC 面：取消入口只在标题栏按钮上，所以这个横幅不需要
 * 任何点击事件，也就不必再开一条受信任 sender 才能触发的通道。
 *
 * 幂等：每次都走同一段「不存在就建、存在就改」的代码，一整包下载最多触发约 100 次
 * （进度节流见 auto-updater 的 PROGRESS_MIN_PERCENT_STEP），不会堆 DOM。
 *
 * ── 为什么这段代码要写得这么啰嗦（真机 61% 冻结事故的教训）────────────────────
 * 真机上出现过：主进程进度事件一直在发（标题栏按钮的 N% 正常变化）、DSH 页面也能
 * 正常操作，但横幅永远停在 61%。原因就是这里的两个静默失效点：
 *   A) `isDshPageLoaded()` 是 getURL() 的纯布尔判定，返回 false 就直接 return，
 *      不留任何痕迹；
 *   B) executeJavaScript 的异常被 `.catch(() => {})` 吞掉。注入脚本抛一次
 *      （例如某次 querySelector 返回 null），此后每次都同样抛、同样被吞，
 *      横幅就永久停在那一个值上。
 * 两者都不会让主进程出错，所以「按钮在动、页面正常、横幅不动」是可以同时成立的。
 * 因此这里的原则是：**任何一次失败都必须留痕，且失败到一定次数就降级到标题栏独占**，
 * 绝不静默冻结；恢复则靠事件驱动 + 周期性无条件重投影（见下方两处）。
 */
function syncAppUpdateBanner(): void {
  const snap = getAppUpdateSnapshot()

  // ── 1) 准入判断：不静默 return，把失败原因记下来 ──
  if (!dshView || dshView.webContents.isDestroyed() || !isDshPageLoaded()) {
    // 仅在下载期记录（其它阶段横幅本来就不该出现，不值得刷日志）。
    // 同一 URL 只记一次：导航抖动会让 getURL() 反复取到同一个值。
    if (snap.phase === 'downloading') {
      const reason = !dshView
        ? 'dshView 尚未创建'
        : dshView.webContents.isDestroyed()
          ? 'dshView.webContents 已销毁'
          : `dshView 当前 URL 非 loopback: "${dshView.webContents.getURL()}"`
      if (bannerSkipUrl !== reason) {
        bannerSkipUrl = reason
        console.warn(`[DSH] 进度横幅跳过投影（${reason}），本轮进度仅在标题栏按钮显示`)
      }
    }
    return
  }

  const payload = JSON.stringify({
    downloading: snap.phase === 'downloading',
    version: snap.version || '',
    percent: snap.percent,
    transferred: snap.transferred,
    total: snap.total,
    bytesPerSecond: snap.bytesPerSecond,
    stalled: snap.stalled,
    stalledSec: snap.stalled ? Math.max(0, Math.floor((Date.now() - snap.progressAt) / 1000)) : 0
  })
  const code = `
    (function () {
      var D = ${payload};
      var el = document.getElementById('dsh-ub');
      if (!D.downloading) {
        if (el) el.hidden = true;
        return 'hidden';
      }
      // 自愈：元素被 SPA 摘除（isConnected === false）时先清掉再重建。
      // 不这么做的话 getElementById 会一直返回这个游离节点，后续赋值全部无效。
      if (el && !el.isConnected) {
        try { el.remove(); } catch (e) { /* ignore */ }
        el = null;
      }
      if (!el) {
        if (!document.getElementById('dsh-ub-style')) {
          var style = document.createElement('style');
          style.id = 'dsh-ub-style';
          style.textContent = ${JSON.stringify(APP_UPDATE_BANNER_CSS)};
          (document.head || document.documentElement).appendChild(style);
        }
        el = document.createElement('div');
        el.id = 'dsh-ub';
        el.hidden = false;
        el.innerHTML =
          '<div class="dsh-ub-row">' +
            '<span class="dsh-ub-title"></span>' +
            '<span class="dsh-ub-pct"></span>' +
          '</div>' +
          '<div class="dsh-ub-track"><div class="dsh-ub-bar"></div></div>' +
          '<div class="dsh-ub-meta">' +
            '<span class="dsh-ub-num dsh-ub-size"></span>' +
            '<span class="dsh-ub-num dsh-ub-speed"></span>' +
          '</div>';
        (document.body || document.documentElement).appendChild(el);
      }
      el.hidden = false;
      function fmtBytes(b) {
        if (!b || b < 0) return '--';
        if (b >= 1073741824) return (b / 1073741824).toFixed(2) + ' GB';
        if (b >= 1048576) return (b / 1048576).toFixed(1) + ' MB';
        if (b >= 1024) return (b / 1024).toFixed(0) + ' KB';
        return b + ' B';
      }
      // 判空后逐个赋值：任何一个子节点缺失都只跳过它，不再让整段脚本抛异常。
      // 抛异常的后果是 executeJavaScript reject，而旧实现把这个 reject 吞掉，
      // 结果是横幅永久冻结——这里必须宁可少更新一个字段，也不要让整段失败。
      function setText(sel, text) {
        var node = el.querySelector(sel);
        if (node) node.textContent = text;
      }
      var pct = Math.max(0, Math.min(100, D.percent));
      setText('.dsh-ub-title',
        '正在下载 DSH Desktop' + (D.version ? ' v' + D.version : '') + ' 更新包');
      setText('.dsh-ub-pct', pct + '%');
      var bar = el.querySelector('.dsh-ub-bar');
      if (bar) bar.style.width = pct + '%';
      if (D.stalled) {
        setText('.dsh-ub-size',
          '速度为 0，已等待 ' + D.stalledSec + ' 秒…可点标题栏「下载中 N%」按钮取消');
        setText('.dsh-ub-speed', '');
      } else {
        setText('.dsh-ub-size',
          fmtBytes(D.transferred) + ' / ' + fmtBytes(D.total) +
          ' · 可点标题栏「下载中 N%」按钮取消');
        setText('.dsh-ub-speed',
          D.bytesPerSecond > 0 ? fmtBytes(D.bytesPerSecond) + '/s' : '');
      }
      return 'shown';
    })()
  `

  // ── 2) 注入执行：成功归零失败计数，失败留痕 ──
  void dshView.webContents.executeJavaScript(code).then(
    () => {
      bannerFailureStreak = 0
      bannerLastError = null
    },
    (err: Error) => {
      bannerLastError = err.message
      bannerFailureStreak++
      if (bannerFailureStreak === 1) {
        console.warn(`[DSH] 进度横幅注入失败（第 1 次）: ${err.message}`)
      } else if (bannerFailureStreak >= BANNER_FAIL_DEGRADE_AT) {
        // ── 3) 降级：停止空打 CDP，进度改由标题栏按钮独占承载 ──
        if (!bannerDegradedLogged) {
          bannerDegradedLogged = true
          console.error(
            `[DSH] 进度横幅已降级：连续 ${bannerFailureStreak} 次注入失败（${err.message}）。` +
            '本次下载的进度将只在标题栏「更新」按钮上显示，DSH 页不再重复注入。' +
            '若下次仍不恢复，请把本行日志连同复现步骤一起反馈。'
          )
        }
      }
    }
  )
}

// ─────────────────── 下载停滞看门狗与自愈重投影 ───────────────────

/**
 * 停滞阈值（毫秒）
 *
 * 取 8 秒的依据：上游 electron-updater 的 ProgressCallbackTransform 自身 1 秒才
 * 发一次进度，本模块又按 2 秒节流，所以正常情况下相邻两次放行间隔 ≤ 2 秒。
 * 连续 4 次（8 秒）都没有新进度，才认为是真的卡住了。
 * 弱网（<1 MB/s）下偶尔 3-4 秒无数据属正常，8 秒足以覆盖。
 * 只想改提示、不想改行为时，调大这个常量即可。
 */
const DOWNLOAD_STALL_THRESHOLD_MS = 8000

/** 连续注入失败多少次后判定横幅不可用并降级 */
const BANNER_FAIL_DEGRADE_AT = 3

// 横幅投影的诊断状态（供日志与降级判断使用，不参与 UI 渲染）
let bannerFailureStreak = 0
let bannerLastError: string | null = null
let bannerDegradedLogged = false
/** 上一次记录过的「跳过投影」原因，用于同一原因只打一次日志 */
let bannerSkipUrl: string | null = null

let stallWatchdogTimer: NodeJS.Timeout | null = null
let reprojectTimer: NodeJS.Timeout | null = null

/**
 * 停滞看门狗：把「UI 停在旧值」翻译成「已等待 N 秒」的明确提示
 *
 * 只提示、**不自动取消也不自动重试**——自动重试会引入新的并发下载与半截文件
 * 风险，超出本次修复的范围。是否重下交给用户点按钮决定。
 *
 * setDownloadStalled 内部对值去重，所以每 2 秒 tick 一次在非停滞期不产生任何
 * IPC / 重投影开销。
 */
function startDownloadStallWatchdog(): void {
  if (stallWatchdogTimer) return
  stallWatchdogTimer = setInterval(() => {
    const snap = getAppUpdateSnapshot()
    if (snap.phase !== 'downloading') return
    const idle = Date.now() - snap.progressAt
    if (idle > DOWNLOAD_STALL_THRESHOLD_MS) {
      if (!snap.stalled) {
        console.warn(
          `[DSH] 客户端更新包下载已停滞 ${Math.floor(idle / 1000)} 秒` +
          `（${snap.transferred} / ${snap.total} 字节），横幅与按钮会提示「已等待 N 秒」` +
          '；不会自动重试，可点标题栏按钮取消后重新下载'
        )
      }
      setDownloadStalled(true)
    } else {
      setDownloadStalled(false)
    }
  }, 2000)
  // 不拖住进程退出（与 stopBalancePolling 同理）
  stallWatchdogTimer.unref()
}

/** 停止停滞看门狗（应用退出路径调用） */
function stopDownloadStallWatchdog(): void {
  if (!stallWatchdogTimer) return
  clearInterval(stallWatchdogTimer)
  stallWatchdogTimer = null
}

/**
 * 下载期周期性重投影：每 3 秒无条件再投影一次横幅
 *
 * 存在的理由：进度事件是「变化驱动」的——没有新进度就不该有投影。但如果某一次
 * 投影因为页面状态异常丢了（失效点 A/B），此后即使页面恢复正常也不会有下一次
 * 变化来触发它，横幅就永久停住。周期投影不依赖进度事件，是兜底的自愈。
 *
 * 定时器只在 downloading 期间存在，进度事件本身也会调本函数做开关。
 */
function syncDownloadPeriodicReprojection(): void {
  const shouldRun = getAppUpdateSnapshot().phase === 'downloading'
  if (shouldRun && !reprojectTimer) {
    reprojectTimer = setInterval(() => {
      // 降级后不再空打 CDP，交给标题栏独占承载
      if (bannerDegradedLogged) return
      syncAppUpdateBanner()
    }, 3000)
    reprojectTimer.unref()
  } else if (!shouldRun && reprojectTimer) {
    clearInterval(reprojectTimer)
    reprojectTimer = null
    // 一轮下载结束，重置诊断状态，下一轮从头计
    bannerFailureStreak = 0
    bannerLastError = null
    bannerDegradedLogged = false
    bannerSkipUrl = null
  }
}

/** 停止周期性重投影（应用退出路径调用） */
function stopDownloadPeriodicReprojection(): void {
  if (!reprojectTimer) return
  clearInterval(reprojectTimer)
  reprojectTimer = null
}

// ─────────────────── 下载完成后的自动安装确认 ───────────────────

/** 上一次已自动弹过安装确认框的版本号，保证「一次下载至多提示一次」 */
let lastPromptedDownloadVersion: string | null = null
/** 安装确认框互斥锁：自动弹窗与用户点击按钮共用，保证同一时刻至多一个框 */
let installPromptOpen = false
/** 上一次的更新阶段，用于检测「跃迁到 downloaded」 */
let lastClientUpdatePhase: string | null = null

/**
 * 客户端更新阶段跃迁检测：由 onAppUpdateState 每次状态变化时调用
 *
 * 只在「非 downloaded → downloaded」这一刻动作，并且只在用户主动下载的那一轮里
 * 触发：
 * - 重新进入 downloading 时清空 lastPromptedDownloadVersion，
 *   这样「下载完 → 取消 → 重新下载 → 完成」会再次提示，而不是被永久压制；
 * - 其余阶段（idle / available / error）不弹窗。
 */
function onClientUpdatePhaseChange(): void {
  const snap = getAppUpdateSnapshot()
  const phase = snap.phase
  const prev = lastClientUpdatePhase
  lastClientUpdatePhase = phase
  diag('phase', `跃迁检测 prev=${prev} → phase=${phase} version=${snap.version} prompted=${lastPromptedDownloadVersion}`)

  if (phase === 'downloading') {
    lastPromptedDownloadVersion = null
    return
  }
  if (phase !== 'downloaded') return
  if (prev === 'downloaded') {
    diag('phase', '不弹窗：prev 已是 downloaded（同一阶段重复回调）')
    return
  }
  if (!snap.version) {
    diag('phase', '不弹窗：snap.version 为空')
    return
  }
  if (lastPromptedDownloadVersion === snap.version) {
    diag('phase', `不弹窗：版本 ${snap.version} 本轮已提示过`)
    return
  }

  lastPromptedDownloadVersion = snap.version
  console.log(`[DSH] 客户端更新包 v${snap.version} 下载完成，自动弹出安装确认框`)
  diag('phase', `决定弹窗：v${snap.version} 下载完成，调用 promptInstallTiming()`)
  void promptInstallTiming()
}

/**
 * 弹出安装时机确认框（立即重启 / 下次启动时安装 / 取消）
 *
 * 两个调用点共用：① 下载完成后自动弹；② 用户点标题栏「更新」按钮。
 * 共用的原因是要共享 installPromptOpen 互斥锁——自动弹窗显示期间用户又点了
 * 按钮，若各弹各的会出现两个框叠在一起。
 *
 * 取舍说明：当前实现不判断窗口是否前台，窗口最小化时也会弹（showMessageBox
 * 带 mainWindow 是窗口模态，会把窗口拉到前台）。这是按需求确认的选择。若实测
 * 觉得打扰，只需在本函数开头加一行 `if (!mainWindow.isFocused()) return`
 * 即可切换为「仅前台自动弹」，无需改动其它任何地方。
 */
async function promptInstallTiming(): Promise<void> {
  if (installPromptOpen) {
    diag('prompt', '守卫拦截：installPromptOpen 已为 true（已有弹窗在显示）')
    return
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    diag('prompt', '守卫拦截：mainWindow 不存在或已销毁')
    return
  }
  if (!isAppUpdateReadyToInstall()) {
    diag('prompt', `守卫拦截：isAppUpdateReadyToInstall() 为 false（当前 phase=${getAppUpdateSnapshot().phase}）`)
    return
  }
  installPromptOpen = true
  try {
    const snap = getAppUpdateSnapshot()
    diag('prompt', `即将弹自绘对话框，message="DSH Desktop 客户端 v${pendingAppUpdateVersion || snap.version || ''} 已下载完成"`)
    const r = await showDshMessageBox({
      type: 'info',
      title: '更新已就绪',
      message: `DSH Desktop 客户端 v${pendingAppUpdateVersion || snap.version || ''} 已下载完成`,
      detail: `当前版本: v${getInstalledAppVersion()}\n\n可立即重启安装，也可等下次退出 DSH Desktop 时静默安装。`,
      buttons: ['立即重启安装', '下次启动时安装', '取消'],
      defaultId: 0,
      cancelId: 2
    })
    diag('prompt', `对话框返回 response=${r.response}`)
    if (r.response === 0) {
      await quitAndInstallAppUpdate(false)
    } else if (r.response === 1) {
      deferInstallToNextLaunch()
      pushTitlebarUpdateState()
    }
  } catch (err) {
    diag('prompt', `安装时机对话框抛异常：${(err as Error).message}`)
    throw err
  } finally {
    installPromptOpen = false
  }
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
    // includeGitHub：手动检查附加查询上游 GitHub Releases，
    // 用于「GitHub 已发布但 npm 未发布」的告知（自动路径不查）
    const result = await checkForUpdate({ includeGitHub: true })
    if (result.error) {
      await showDshMessageBox({
        type: 'warning',
        title: '检查失败',
        message: 'DSH 运行包版本检查失败',
        detail: result.error,
        detailTone: 'notice',
        buttons: ['确定'],
        defaultId: 0
      })
      return
    }
    if (result.hasUpdate) {
      pendingDshUpdateVersion = result.latestVersion
      pushTitlebarUpdateState()
      await showDshMessageBox({
        type: 'info',
        title: '发现新版本',
        message: 'DSH 运行包有新版本可用',
        detail: `当前版本: v${result.currentVersion}\n最新版本: v${result.latestVersion}\n\n顶部蓝色横幅已显示，点击横幅中的「更新 DSH」即可执行更新。`,
        buttons: ['确定'],
        defaultId: 0
      })
    } else {
      // GitHub 有更新但 npm 未发布（npm latest 旧于 GitHub latest）：
      // 该版本当前不可安装，对话框附加告知，不判定为可更新
      const ghVersion = result.githubLatestVersion
      const ghNewerThanNpm = ghVersion !== undefined && compareVersions(result.latestVersion, ghVersion) < 0
      await showDshMessageBox({
        type: 'info',
        title: ghNewerThanNpm ? '已是最新可安装版本' : '已是最新版本',
        message: ghNewerThanNpm ? 'DSH 运行包已是最新可安装版本' : 'DSH 运行包已是最新版本',
        detail: ghNewerThanNpm
          ? `当前版本: v${result.currentVersion}\n最新可安装版本（npm）: v${result.latestVersion}\n\n上游 GitHub 已发布 v${ghVersion}，但该版本尚未发布到 npm，暂无法自动更新。上游发布到 npm 后，客户端将自动提示更新。`
          : `当前版本: v${result.currentVersion}\n最新版本: v${result.latestVersion}`,
        buttons: ['确定'],
        defaultId: 0
      })
    }
  } catch (err) {
    await showDshMessageBox({
      type: 'error',
      title: '检查失败',
      message: 'DSH 运行包版本检查异常',
      detail: (err as Error).message,
      detailTone: 'notice',
      buttons: ['确定'],
      defaultId: 0
    })
  }
}

/**
 * 手动检查 DSH Desktop 客户端更新（仅打包环境允许）
 *
 * 发现更新 → 点亮标题栏「更新DSH」按钮 + 弹 dialog 告知；
 * 已是最新 → 弹 dialog 显示版本（最新版本号随检查结果携带，无需额外请求）；
 * 检查失败 → 弹 dialog 显示错误原因（不得误报为「已是最新版本」）；
 * 开发环境 → 弹 dialog 提示不支持。
 */
async function manualCheckAppUpdate(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!app.isPackaged) {
    await showDshMessageBox({
      type: 'info',
      title: '开发环境提示',
      message: '客户端更新检查仅在打包环境生效',
      detail: `当前应用版本: v${getInstalledAppVersion()}\n开发环境无法读取 ${UPDATE_FEED_URL}/latest.yml，请打包后验证。`,
      buttons: ['确定'],
      defaultId: 0
    })
    return
  }
  try {
    const result = await checkForAppUpdate()
    if (result.status === 'error') {
      await showDshMessageBox({
        type: 'warning',
        title: '检查失败',
        message: 'DSH Desktop 客户端版本检查失败',
        detail: result.error,
        detailTone: 'notice',
        buttons: ['确定'],
        defaultId: 0
      })
      return
    }
    if (result.status === 'update-available') {
      rememberAppUpdate(result.latest.version, result.latest.downloadUrl)
      const phase = getAppUpdateSnapshot().phase
      if (phase === 'downloading') {
        await showDshMessageBox({
          type: 'info',
          title: '正在下载更新包',
          message: 'DSH Desktop 客户端正在下载更新包',
          detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${result.latest.version}\n\n下载进度显示在 DSH 页面顶部，也可点标题栏的「下载中 N%」按钮取消本次下载。`,
          buttons: ['确定'],
          defaultId: 0
        })
        return
      }
      if (phase === 'downloaded') {
        await showDshMessageBox({
          type: 'info',
          title: '更新已就绪',
          message: 'DSH Desktop 客户端更新包已下载完成',
          detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${result.latest.version}\n\n标题栏「更新」按钮已就绪，点击可选择「立即重启安装」或「下次启动时安装」。`,
          buttons: ['确定'],
          defaultId: 0
        })
        return
      }
      // 首次发现更新：只标记，不下载。下载改由用户在标题栏点「更新」后确认触发，
      // 避免 251MB 在用户不知情时就把带宽和磁盘占掉
      markUpdateAvailable(result.latest.version)
      await showDshMessageBox({
        type: 'info',
        title: '发现新版本',
        message: 'DSH Desktop 客户端有新版本可用',
        detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${result.latest.version}\n\n尚未开始下载（约 251 MB）。点击标题栏的「更新」按钮即可开始下载并查看进度。`,
        buttons: ['确定'],
        defaultId: 0
      })
      return
    }
    await showDshMessageBox({
      type: 'info',
      title: '已是最新版本',
      message: 'DSH Desktop 客户端已是最新版本',
      detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${result.latest.version}`,
      buttons: ['确定'],
      defaultId: 0
    })
  } catch (err) {
    await showDshMessageBox({
      type: 'warning',
      title: '检查失败',
      message: 'DSH Desktop 客户端版本检查失败',
      detail: (err as Error).message,
      detailTone: 'notice',
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
    // 按钮顺序即优先级：全部检查（主）→ 两个单项 → 取消。
    // 下标与下面的 response 分支一一对应，改文案时必须同步改这里
    const choice = await showDshMessageBox({
      type: 'question',
      title: '检查更新',
      message: '请选择要检查的项目',
      buttons: ['全部检查', '检查DSH运行包', '检查客户端', '取消'],
      defaultId: 0,
      cancelId: 3,
      // 主按钮就是数组首位、也就是 defaultId。主按钮靠 lead 类的 min-width
      // 撑成全组最宽——4 汉字的「全部检查」纯按内容排版会比 5 汉字 + 拉丁字母
      // 的「检查DSH运行包」还窄，"主按钮最大"就不成立
      primaryId: 0
    })
    if (choice.response === 3) return // 取消

    if (choice.response === 0) {
      // 全部检查：串行执行，第一个 dialog 关闭后再弹第二个
      await manualCheckDshUpdate()
      if (!mainWindow || mainWindow.isDestroyed()) return
      await manualCheckAppUpdate()
    } else if (choice.response === 1) {
      await manualCheckDshUpdate()
    } else if (choice.response === 2) {
      await manualCheckAppUpdate()
    }
  } finally {
    isCheckingUpdate = false
  }
}

/**
 * 将更新日志条目列表拼装为模态框内容 HTML
 *
 * version / publishedAt 已在 changelog.ts 校验（白名单 + 日期截取），可安全内插；
 * notes 经 renderMarkdownToHtml 安全渲染（全文转义 + 受限标签）。
 */
function buildChangelogHtml(entries: ChangelogEntry[]): string {
  if (entries.length === 0) {
    return '<p style="color:var(--dsh-dlg-muted)">暂无更新日志。</p>'
  }
  const blocks = entries.map((entry) => `
    <div class="log-entry">
      <div class="log-head"><span class="log-ver">v${entry.version}</span><span class="log-date">${entry.publishedAt}</span></div>
      ${entry.notes.trim() ? renderMarkdownToHtml(entry.notes) : '<p style="color:var(--dsh-dlg-muted)">暂无说明</p>'}
    </div>
  `)
  return blocks.join('<hr class="log-divider">') +
    '<p style="color:var(--dsh-dlg-muted);font-size:12px;margin-top:4px">数据来自 GitHub Releases</p>'
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
    // 两段式：先弹壳（doc 图标），数据到达后替换正文
    await injectModalShell(
      dshView.webContents,
      title,
      '<p style="color:var(--dsh-dlg-muted)">正在加载更新日志，请稍候...</p>',
      'doc'
    )
    const entries = await (kind === 'dsh' ? fetchDshChangelogs() : fetchAppChangelogs())
    await updateModalBody(dshView.webContents, buildChangelogHtml(entries))
  } catch (err) {
    await updateModalBody(
      dshView.webContents,
      `<p style="color:#f87171">加载失败: ${escapeHtml((err as Error).message)}</p>`
    )
  } finally {
    isShowingChangelog = false
  }
}

/**
 * 帮助菜单「关于」入口：展示关于模态框
 *
 * 内容：DSH Desktop 客户端版本号 + DSH 运行包版本号 + 内置 Node 运行时（版本与 ABI）
 * + GitHub 仓库链接按钮。内置 Node 行仅在查询成功时渲染，不留空值。
 */
async function showAboutModal(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed() || !dshView) return
  const appVersion = escapeHtml(getInstalledAppVersion())
  const dshVersion = escapeHtml(getInstalledDshVersion())
  // 内置 Node 运行时信息（诊断用）：查询失败时 version 为空串，整行不渲染
  const runtime = getBundledRuntimeInfo()
  const nodeRowHtml = runtime.version
    ? `<div><span style="color:var(--dsh-dlg-muted)">内置 Node 运行时：</span><strong>v${escapeHtml(runtime.version)}${runtime.abi ? `（ABI ${escapeHtml(runtime.abi)}）` : ''}</strong></div>`
    : ''
  const bodyHtml = `
    <div style="display:flex;flex-direction:column;gap:10px;min-width:320px">
      <div style="font-size:16px;font-weight:600;color:var(--dsh-dlg-fg)">DSH Desktop</div>
      <div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
        <div><span style="color:var(--dsh-dlg-muted)">客户端版本：</span><strong>v${appVersion}</strong></div>
        <div><span style="color:var(--dsh-dlg-muted)">DSH 运行包版本：</span><strong>v${dshVersion}</strong></div>
        ${nodeRowHtml}
      </div>
      <div style="margin-top:6px">
        <button class="about-repo" style="display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:12px;background:var(--dsh-dlg-primary-bg);color:var(--dsh-dlg-primary-fg);border:1px solid transparent;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;"><svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>GitHub 仓库</button>
      </div>
    </div>
  `
  await injectModalShell(dshView.webContents, '关于 DSH Desktop', bodyHtml, 'info')
  // 绑定 GitHub 仓库按钮：走 window.dsh.openExternal（受 isTrustedSender 守卫）。
  // 按钮在 Shadow Root 内，必须经 __dshModal.shadow 查，document 级选择器查不到
  const wireCode = `
    (function () {
      if (!window.__dshModal) return 'no-modal'
      var btn = window.__dshModal.shadow.querySelector('.about-repo')
      if (!btn) return 'no-button'
      btn.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.openExternal === 'function') {
          window.dsh.openExternal(${JSON.stringify(GITHUB_REPO_URL)})
        }
      })
      return 'wired'
    })()
  `
  try {
    const result = (await dshView.webContents.executeJavaScript(wireCode, true)) as string
    if (result !== 'wired') {
      console.warn(`[DSH] 关于模态框的 GitHub 按钮未绑定（${result}）`)
    }
  } catch (err) {
    console.warn(`[DSH] 关于模态框按钮绑定失败: ${(err as Error).message}`)
  }
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

  // 内容视图每次文档加载完成（首次 + 刷新/导航）后预置余额 tooltip 注入外壳
  // （样式 + 空容器），保证首次悬停零延迟；非 DSH 页（loading/error）由
  // isDshPageLoaded 守卫自动跳过。同时重建下载进度横幅（DSH 页被刷新时，
  // 注入的节点会随文档一起消失，需要重新投影当前下载进度）
  dshView.webContents.on('did-finish-load', () => {
    // 自绘对话框宿主。此处刻意不加 isDshPageLoaded 守卫：退出确认一类弹窗
    // 最常发生在 error 页（DSH 起不来时用户点关闭），loading/error 两种页面
    // 都需要能弹对话框
    if (dshView && !dshView.webContents.isDestroyed()) {
      ensureDialogHost(dshView.webContents)
    }
    injectBalanceTooltipShell()
    syncAppUpdateBanner()
    // 公告横幅与更新横幅都随文档消失，同样需要重投影
    reprojectNoticeBanner()
  })

  // SPA 软路由（history.pushState / hash 变化）：文档不重建，注入的节点还在，
  // 但 DOM 可能被框架重排过。补这个钩子是为了让横幅有机会被重新拉回正确状态。
  dshView.webContents.on('did-navigate-in-page', () => {
    syncAppUpdateBanner()
    reprojectNoticeBanner()
  })

  // ── 渲染进程健康监听 ──
  // 真机出现过「主进程进度正常、页面也能操作，但横幅永久停在 61%」的事故。
  // 当时这段完全没有监听，任何渲染侧异常都不可见。这里补齐后：
  // unresponsive 只影响 UI（主进程与下载不受影响），恢复时立刻尝试重投影；
  // render-process-gone 记明原因，且会走横幅的降级路径而不是静默冻结。
  dshView.webContents.on('unresponsive', () => {
    console.warn('[DSH] DSH 内容页无响应（主进程与更新下载不受影响，仅 UI 暂停）')
  })
  dshView.webContents.on('responsive', () => {
    console.log('[DSH] DSH 内容页已恢复响应，尝试重建进度横幅')
    syncAppUpdateBanner()
  })
  dshView.webContents.on('render-process-gone', (_e, details) => {
    console.error(
      `[DSH] DSH 内容页渲染进程退出: reason=${details.reason} exitCode=${details.exitCode}`
    )
    // 此时横幅几乎必然注入失败，这里主动投影一次以触发失败计数与降级日志
    syncAppUpdateBanner()
  })
  // DSH 页加载失败属于错误页链路（showErrorPage），不在本修复范围内，仅留痕
  dshView.webContents.on('did-fail-load', (_e, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return
    console.error(`[DSH] DSH 内容页加载失败: ${errorCode} ${errorDescription} (${validatedURL})`)
  })

  // 自绘对话框层接线：注册 dsh-dialog-response 的 IPC 守卫与导航打断收敛。
  // 必须早于首次 loadLoadingPage()，否则首个页面加载完成时钩子还没挂上
  initDshDialog({
    getWebContents: () =>
      dshView && !dshView.webContents.isDestroyed() ? dshView.webContents : null,
    getParentWindow: () =>
      mainWindow && !mainWindow.isDestroyed() ? mainWindow : null
  })

  // 加载标题栏与 loading 界面
  loadTitlebarPage()
  loadLoadingPage()

  // 窗口准备好后再显示，避免出现白屏
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 兜底显示：若 ready-to-show 在监听挂载前已触发（时序竞争）或事件丢失，
  // 窗口将永远停在 show:false 状态（现象：应用启动后无窗口，进程与托盘均正常）。
  // 延迟 3s 检查：仍未显示且未在退出/最小化流程中则强制 show()。
  // timer unref 避免拖住事件循环；closed 时 mainWindow 置空由闭包守卫防误触
  const showFallbackTimer = setTimeout(() => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !isQuitting &&
      !mainWindow.isVisible() &&
      !mainWindow.isMinimized()
    ) {
      mainWindow.show()
      console.warn('[DSH] ready-to-show 未按时触发，已兜底显示窗口')
    }
  }, 3000)
  showFallbackTimer.unref()

  // 窗口尺寸变化（resize / 最大化 / 还原）时同步视图布局
  mainWindow.on('resize', () => {
    layoutViews()
  })

  // 窗口重新聚焦时刷新余额（30s 防抖）：用户切回应用能看到较新余额，
  // 又避免 Alt+Tab、对话框关闭等频繁聚焦触发查询
  mainWindow.on('focus', () => {
    const now = Date.now()
    if (now - lastFocusBalanceRefresh < 30_000) return
    lastFocusBalanceRefresh = now
    void refreshBalance('focus')
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

  // 拦截窗口关闭（标题栏 WCO 关闭按钮 / Alt+F4 / window.close 等全部路径）：
  // 先弹退出确认框，取消则保持运行；确认后 isQuitting 已置位，
  // app.quit() 触发的第二次 close 事件直接放行，走既有清理链路
  // （window-all-closed → 销毁托盘 → stopDsh → 退出）
  mainWindow.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    void confirmAndQuit()
  })

  mainWindow.on('closed', () => {
    mainWindow = null
    dshView = null
  })
}

/**
 * 恢复、显示并聚焦主窗口（托盘菜单「打开主界面」）
 *
 * 覆盖最小化 / 隐藏 / 失焦三种状态；窗口已销毁时兜底重建
 * （复用 app.on('activate') 中的重建逻辑）。
 */
function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow()
    void startDshAndLoad()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

/**
 * 托盘菜单「退出」：先弹确认框，用户明确确认后才执行退出
 *
 * 受 isQuitting 互斥锁保护，防止重复触发并发弹框；取消后复位锁，
 * 客户端继续运行。确认后必须先销毁托盘（否则 Windows 托盘区残留
 * 幽灵图标），再 app.quit() 走既有清理链路（window-all-closed →
 * stopDsh 杀 DSH 进程树 → 退出）。
 */
async function confirmAndQuit(): Promise<void> {
  if (isQuitting) return
  isQuitting = true
  try {
    const options: DshDialogOptions = {
      type: 'question',
      title: '退出确认',
      message: '确定要退出 DSH Desktop 吗？',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      // 与「更新 DSH 运行包」同型：默认焦点给「取消」（退出是打断性操作），
      // 但视觉强调仍在「退出」——键盘语义与视觉强调是分开的两个参数
      primaryId: 0
    }
    // 内容视图不可用时由对话框层自动回落系统弹窗（parent 取 mainWindow）
    const result = await showDshMessageBox(options)
    if (result.response !== 0) {
      // 用户取消：复位锁，保持客户端继续运行
      isQuitting = false
      return
    }
    if (tray) {
      tray.destroy()
      tray = null
    }
    // 用户此前已选「下次启动时安装」：改为静默安装更新包并退出，不再走常规退出链路。
    // 这样点「退出」和点「下次启动时安装」的行为收敛到同一条安装路径。
    if (shouldInstallOnNextLaunch()) {
      await quitAndInstallAppUpdate(true)
      return
    }
    app.quit()
  } catch (err) {
    console.error(`[DSH] 退出确认流程异常: ${(err as Error).message}`)
    isQuitting = false
  }
}

/**
 * 创建系统托盘图标（应用启动后常驻，右键弹出原生菜单）
 *
 * 菜单含四项：「打开主界面」/ DeepSeek 余额（只读，随查询结果重建）/「刷新余额」/
 * 「退出」。图标复用 getWindowIconPath()（icon.ico 为多尺寸，Electron 自动选取
 * 托盘尺寸）；图标读取失败时仅记录日志并跳过托盘创建，不影响其他功能。
 */
function createTray(): void {
  if (tray) return
  const icon = nativeImage.createFromPath(getWindowIconPath())
  if (icon.isEmpty()) {
    console.warn('[DSH] 托盘图标加载失败，跳过托盘创建')
    return
  }
  tray = new Tray(icon)
  tray.setToolTip('DSH Desktop')
  console.log('[DSH] 系统托盘图标已创建')
  // Windows 上 setContextMenu 后右键自动弹出，无需监听 right-click
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()))
  // 订阅余额更新：① 推送到标题栏页面渲染徽章（只含数字，绝不含 API Key）；
  // ② 重建托盘菜单（原生菜单不支持逐项着色，警示态用 ⚠ 符号 + 文案区分）
  onBalanceUpdate((snapshot: BalanceSnapshot) => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('balance-update', snapshot)
    }
    updateTrayMenu()
  })
}

/**
 * 构造托盘菜单模板
 *
 * 第二项为 DeepSeek 余额只读项（enabled: false 防误点）：原生菜单无法逐项着色，
 * 警示态通过 ⚠/● 符号与文案表达（红/橙色仅存在于标题栏徽章，见 titlebar.html）。
 * 点击「刷新余额」会触发一次查询，结果经 balance-update 推送后由本模板重建。
 */
function buildTrayTemplate(): Electron.MenuItemConstructorOptions[] {
  return [
    { label: '打开主界面', click: () => { showMainWindow() } },
    { label: buildBalanceMenuLabel(), enabled: false },
    { label: '刷新余额', click: () => { void refreshBalance('tray') } },
    { type: 'separator' },
    { label: '退出', click: () => { void confirmAndQuit() } }
  ]
}

/** 托盘菜单 / tooltip 用的余额文案（一行，纯文本） */
function buildBalanceMenuLabel(): string {
  const snap = getBalanceSnapshot()
  const amount = snap.cny != null ? `¥${snap.cny.toFixed(2)}` : ''
  switch (snap.status) {
    case 'ok':
      return `DeepSeek 余额：${amount}`
    case 'low':
      return `DeepSeek 余额：${amount || '¥0.00'} ⚠ 余额不足`
    case 'auth':
      return 'DeepSeek 余额：⚠ API Key 已失效'
    case 'nocfg':
      return 'DeepSeek 余额：未配置 API Key'
    case 'net':
      return 'DeepSeek 余额：⚠ 查询失败（网络异常）'
    case 'relay':
      return 'DeepSeek 余额：—（自定义 API 地址无法查询）'
    default:
      return 'DeepSeek 余额：查询中...'
  }
}

/** 重建托盘菜单与 tooltip（余额更新回调调用；无托盘时跳过） */
function updateTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayTemplate()))
  const label = buildBalanceMenuLabel()
  tray.setToolTip(`DSH Desktop\n${label}`)
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
      // 异步检查桌面应用自身更新（不阻塞启动流程；此处只拉 latest.yml 266 字节，不下载安装包）
      void checkForAppUpdateAndPrompt()
      // 拉一次公告：横幅直接投到 DSH 页，紧急通知延迟 NOTICE_MODAL_DELAY_MS 再弹。
      // 同样不阻塞启动（拉取失败在 checkNoticesAndShow 内已静默处理）。
      void checkNoticesAndShow('startup')
      // 启动后首次查询 DeepSeek 余额并开启每 5 分钟轮询（异步不阻塞；
      // 结果经 balance-update 推送标题栏徽章与托盘菜单，API Key 不出主进程）
      void refreshBalance('startup')
      startBalancePolling()
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
      pushTitlebarUpdateState()
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
 * 两阶段：先 prepare（下载+校验+npm 直接装进 dsh-cache/dsh.new.<ts>/，旧 DSH 继续运行），
 * 再 stopDsh → activate（两次同卷 rename，毫秒级不可用窗口，不做删除），最后 startDsh；
 * UI 就绪后再异步回收旧版本目录（dsh.old.<ts>）。
 * 全程受 isUpdating 互斥保护，防止并发触发与临时目录互踩。
 *
 * 这条链路上的每一步都不得出现重量级同步 fs / exec 调用：Electron 主进程是单线程，
 * 主线程被占会让窗口收不到 WM_PAINT，Windows 约 5 秒即判「未响应」（详见 AGENTS.md §12）。
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

    // 阶段一：下载+校验+安装到 dsh.new.<ts>/（旧 DSH 不受影响，继续对外服务）
    const prepared = await prepareDshPackage((msg: string) => sendStatus(msg))

    // 阶段二：先停后换（顺序约束见 AGENTS.md §12 第 13 条）。
    // activate 是两次同卷 rename（毫秒级、不做删除），旧目录换名成 dsh.old.<ts> 让位。
    // 传入 sendStatus：rename 被安全软件占用时会退避重试（累计约 15.75s），
    // 期间必须给用户进度反馈，否则看起来像卡死（见 AGENTS.md §12 第 50 条）
    sendStatus('下载完成，正在切换 DSH 版本...')
    await stopDsh()
    const { retiredDir } = await activateDshPackage(prepared.preparedDir, sendStatus)

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

    // UI 已就绪后再回收旧版本目录：那棵树约 453MB / 2.6 万文件，同步删会把主线程
    // 堵住十几秒、窗口被判「未响应」。放在 loadURL 之后用异步删除，对用户零感知，
    // 也不会跟 DSH 启动抢 I/O。失败只记日志，残留由下次 prepare 前的清扫兜底。
    // 注意：本行只在成功路径执行；失败时 dsh.old.* 保留，留给用户手工回滚。
    void discardRetiredDshDir(retiredDir)

    // DSH 运行包已更新，清除待安装标记并复位抑制计数（避免镜像滞后时该版本永不再提示）
    pendingDshUpdateVersion = null
    lastPromptedDshVersion = null
    pushTitlebarUpdateState()

    // 更新完成后再次检查版本（走带抑制逻辑的检查，避免同一版本重复推送状态）
    checkDshUpdateAndPrompt()
  } catch (err) {
    const error = err as Error
    console.error(`[DSH] 更新失败: ${error.message}`)
    // 顺序是刻意的：**先切错误页、再弹对话框**。
    // loadErrorPage 是 fire-and-forget，若先弹弹窗再导航，注入的节点会随文档
    // 一起销毁，挂着的那次弹窗永远等不到回传，会被 did-start-loading 当
    // 「被中断」收敛掉——用户什么都看不到。waitForNextDialogHost 把两步串起来。
    loadErrorPage(error.message)
    await waitForNextDialogHost()
    // 文案与原 dialog.showErrorBox('更新失败', `DSH 更新失败: ${msg}`) 一一对应，
    // 不额外加引导语（错误页本身已经把错误信息完整展示出来了）
    await showDshMessageBox({
      type: 'error',
      title: '更新失败',
      message: `DSH 更新失败: ${error.message}`
    })
  } finally {
    isUpdating = false
  }
}

/**
 * 记录已发现的新版本号与安装包直链
 *
 * 两者用途不同，别混淆：
 * - 版本号用于「已是最新 / 发现新版本」等文案（electron-updater 自己的 updateInfo
 *   要到开始下载才有，这里先行一步）；
 * - 直链只喂给横幅上的「浏览器下载」兜底按钮，自动下载链路走 electron-updater 内部解析。
 */
function rememberAppUpdate(version: string, downloadUrl: string): void {
  pendingAppUpdateVersion = version
  pendingAppUpdateDownloadUrl = downloadUrl
}

/**
 * 标题栏更新按钮的状态快照
 *
 * 两个按钮都是「有更新才出现」，无更新时完全不占位：
 * - client（「更新」，天蓝）：客户端有可安装的新版本。available（等用户点）/ downloading
 *   （正在下）/ downloaded（可安装）/ error（可重试）四个阶段都显示；
 * - dsh（「更新DSH」，DeepSeek 官方蓝）：DSH 运行包有可安装的新版本。
 */
interface TitlebarUpdateState {
  client: {
    show: boolean
    version: string | null
    phase: string
    /** 仅 downloading 阶段有意义，0-100 */
    percent: number
    /** 已下载字节数，仅 downloading 阶段有意义 */
    transferred: number
    /** 资源总字节数，未知时为 0 */
    total: number
    /** 当前速率（字节/秒，未知时为 0） */
    bytesPerSecond: number
    /** 下载是否已停滞（进度横幅降级时，标题栏是唯一的进度载体） */
    stalled: boolean
    error: string | null
    installOnNextLaunch: boolean
  }
  dsh: {
    show: boolean
    version: string | null
  }
}

/**
 * 构造标题栏更新按钮状态
 *
 * 客户端按钮的显隐规则：**除 idle 外全部显示**。available 是「检测到新版、等你点」，
 * downloading 是「正在下、点了可以取消」，downloaded 是「下完了、可以装」，
 * error 是「下载失败、可重试」——四个阶段对用户都是「有事等你处理」，藏起来反而
 * 让人以为没检测到。只有 idle（已是最新）才完全静默。
 */
function buildTitlebarUpdateState(): TitlebarUpdateState {
  const snap = getAppUpdateSnapshot()
  return {
    client: {
      show: snap.phase !== 'idle',
      version: pendingAppUpdateVersion || snap.version,
      phase: snap.phase,
      percent: snap.percent,
      transferred: snap.transferred,
      total: snap.total,
      bytesPerSecond: snap.bytesPerSecond,
      stalled: snap.stalled,
      error: snap.error,
      installOnNextLaunch: snap.installOnNextLaunch
    },
    dsh: {
      show: !!pendingDshUpdateVersion,
      version: pendingDshUpdateVersion
    }
  }
}

/**
 * 把更新按钮状态推送给标题栏页
 *
 * 状态真源全在主进程（auto-updater 快照 + pendingDshUpdateVersion），标题栏只做渲染。
 * 目标固定是 mainWindow.webContents（标题栏页），与内容视图 dshView 无关——
 * 按钮在标题栏，不在 DSH 页面里，因此不受 isDshPageLoaded 之类的时序约束。
 */
function pushTitlebarUpdateState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (mainWindow.webContents.isDestroyed()) return
  mainWindow.webContents.send('titlebar-update-state', buildTitlebarUpdateState())
}

/**
 * 在系统默认浏览器打开客户端安装包（更新失败时的人工兜底）
 */
async function openAppUpdateInBrowser(): Promise<void> {
  if (!pendingAppUpdateDownloadUrl) return
  try {
    await shell.openExternal(pendingAppUpdateDownloadUrl)
  } catch (err) {
    console.error(`[DSH] 打开浏览器下载失败: ${(err as Error).message}`)
  }
}

/**
 * 检查是否有桌面客户端新版本，有则点亮标题栏「更新」按钮
 *
 * 元数据来源为分发源的 latest.yml（app-update.ts）。检测到新版本后**只标记、
 * 不下载**：251MB 的包由用户在标题栏点「更新」→ 确认框点「下载并更新」后才开始，
 * 下载期间 DSH 页面顶部显示进度横幅、可随时取消。带宽和磁盘都交还给用户决定。
 *
 * 重开应用不会白下第二遍：electron-updater 的 DownloadedUpdateHelper.validateDownloadedPath
 * 会在下载前核对缓存目录（%LOCALAPPDATA%\dsh web desktop-updater\pending\）里的
 * update-info.json 与安装包 sha512，命中就完全跳过下载直接派发 update-downloaded。
 * 即用户上次没装就关掉了应用，下次点「更新」会立刻变成「可安装」而不是重下。
 *
 * 全程仅在打包环境下执行；检查失败仅记录日志、不打断启动流程（手动检查路径才会弹错误框）。
 */
async function checkForAppUpdateAndPrompt(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const result = await checkForAppUpdate()
    // 启动路径上检查失败必须静默：网络不通是常态，不该每次开应用都弹窗打扰用户。
    // 错误详情已在 checkForAppUpdate 内落日志，用户主动点「检查更新」时会看到弹窗。
    if (result.status === 'error') return
    if (result.status === 'up-to-date') {
      console.log('[DSH] 客户端版本检查：已是最新版本')
      return
    }
    rememberAppUpdate(result.latest.version, result.latest.downloadUrl)
    markUpdateAvailable(result.latest.version)
  } catch (err) {
    console.error(`[DSH] 客户端版本检查失败: ${(err as Error).message}`)
  }
}

/**
 * 下载客户端更新包（用户在标题栏「更新」按钮的确认框里点了「下载并更新」之后调用）
 *
 * 刻意不 await：调用方不该被 251MB 的下载阻塞，进度由 auto-updater 的
 * download-progress 事件推给标题栏按钮与 DSH 页进度横幅。
 * 重复调用是安全的——downloadAppUpdate 内部对 downloading / downloaded 阶段直接返回。
 * 失败时状态机切 error，按钮转为「重试下载 / 浏览器下载」，这里不再重复弹窗。
 */
async function startAppUpdateDownload(): Promise<void> {
  try {
    await downloadAppUpdate()
  } catch (err) {
    console.error(`[DSH] 客户端更新包下载失败: ${(err as Error).message}`)
  }
}

// ───────────────────────── 公告（notice）编排 ─────────────────────────
//
// 数据侧在 notice.ts（拉取/校验/已读），渲染侧在 notice-banner.ts（横幅）与
// dsh-dialog.ts（模态）。这里只做编排：决定何时拉、拉完投影到哪、什么时候弹。
//
// 三条纪律：
// 1. 拉取失败**永不打断启动**：网络不通是常态，只有用户主动点铃铛才弹错误。
// 2. 紧急通知**延迟 10 秒**再弹：用户刚开应用通常正要开始干活，立刻拦一下体感差。
// 3. 弹窗走 showDshMessageBox 的 FIFO 队列，不会与更新确认框叠在一起。

/** 紧急通知的延迟展示时长（见纪律 2） */
const NOTICE_MODAL_DELAY_MS = 10_000

let noticeBanner: Notice[] = []
let noticeModals: Notice[] = []
let noticeUnreadCount = 0
let noticeFetching = false
let noticeModalTimer: NodeJS.Timeout | null = null

/** 把公告摘要推给标题栏铃铛（未读数 / 有无未读横幅） */
function pushNoticeState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('notice-state', {
    unread: noticeUnreadCount,
    hasBanner: noticeBanner.length > 0
  })
}

/** 把当前该展示的横幅重新投影到 DSH 页（页面导航后节点会消失，需重投影） */
function reprojectNoticeBanner(): void {
  const wc = dshView && !dshView.webContents.isDestroyed() ? dshView.webContents : null
  syncNoticeBanner(wc, noticeBanner)
}

/** 重新统计未读数并刷新铃铛（横幅被用户 × 掉后要减计数） */
function refreshNoticeCounters(): void {
  const read = getReadNoticeIds()
  const all = [...noticeBanner, ...noticeModals]
  noticeUnreadCount = all.filter((n) => !read.has(n.id)).length
  pushNoticeState()
}

/**
 * 逐条弹紧急通知
 *
 * Esc / 点「我知道了」都记已读；带链接时第二个按钮打开链接（https-only，
 * 见 openHttpsExternal）。showDshMessageBox 自身有队列，不会与其他弹窗叠加。
 */
async function showPendingNoticeModals(): Promise<void> {
  const pending = noticeModals.filter((n) => !getReadNoticeIds().has(n.id))
  for (const n of pending) {
    if (isQuitting || !mainWindow || mainWindow.isDestroyed()) return
    const buttons = n.link ? ['我知道了', n.link.label] : ['我知道了']
    const r = await showDshMessageBox({
      type: n.level,
      title: n.title,
      message: n.body,
      buttons,
      defaultId: 0,
      // Esc 落在「我知道了」上：随手关掉就等于已读，不该下次又弹
      cancelId: 0,
      primaryId: 0
    })
    markNoticeRead(n.id)
    if (n.link && r.response === 1) openHttpsExternal(n.link.url)
    refreshNoticeCounters()
  }
}

function scheduleNoticeModals(): void {
  if (noticeModalTimer) {
    clearTimeout(noticeModalTimer)
    noticeModalTimer = null
  }
  if (noticeModals.length === 0) return
  noticeModalTimer = setTimeout(() => {
    noticeModalTimer = null
    void showPendingNoticeModals()
  }, NOTICE_MODAL_DELAY_MS)
  // unref：公告排期绝不能拖住退出
  noticeModalTimer.unref()
}

/**
 * 拉一次公告并决定展示什么
 *
 * @param trigger startup | periodic 只在打包环境静默执行；manual（点铃铛）任何环境都跑且会弹结果
 */
async function checkNoticesAndShow(trigger: 'startup' | 'periodic' | 'manual'): Promise<void> {
  // 开发环境只在手动点铃铛时拉：既不打扰日常调试，又能随时验证 UI
  if (!app.isPackaged && trigger !== 'manual') return
  if (noticeFetching) return
  noticeFetching = true
  try {
    const plan = planNotices(await fetchNotices(), getReadNoticeIds())
    noticeBanner = plan.banner
    noticeModals = plan.modals
    noticeUnreadCount = plan.banner.length + plan.modals.length
    reprojectNoticeBanner()
    pushNoticeState()

    if (trigger === 'manual' && noticeUnreadCount === 0) {
      await showDshMessageBox({
        type: 'info',
        title: '公告',
        message: '暂无新公告'
      })
      return
    }
    if (plan.modals.length > 0) scheduleNoticeModals()
  } catch (err) {
    const message = (err as Error).message
    console.warn(`[DSH] 拉取公告失败（${trigger}）: ${message}`)
    // 启动/周期路径静默：公告挂不上只是少看一条，不该每次开应用都弹窗报错
    if (trigger === 'manual') {
      await showDshMessageBox({
        type: 'warning',
        title: '公告',
        message: '拉取公告失败',
        detail: message,
        detailTone: 'notice'
      })
    }
  } finally {
    noticeFetching = false
  }
}

/**
 * 打开公告里的外链（主进程侧发起）
 *
 * 协议白名单与 open-external 通道一致但更严：公告只允许 https:。这里不复用
 * IPC handler——那条通道的守卫是给渲染进程用的，主进程自己发起不需要。
 */
function openHttpsExternal(url: string): void {
  if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
    console.warn('[DSH] 公告外链协议非 https，已拒绝')
    return
  }
  void shell.openExternal(url).catch((err: Error) => {
    console.warn(`[DSH] 打开公告外链失败: ${err.message}`)
  })
}

/** 公告周期轮询（与客户端更新同节奏，unref 不拖退出） */
function startPeriodicNoticeCheck(): void {
  if (!app.isPackaged) return
  const SIX_HOURS = 6 * 60 * 60 * 1000
  setInterval(() => {
    void checkNoticesAndShow('periodic')
  }, SIX_HOURS).unref()
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
  // 注册主题模块：窗口获取器 + 注入组件同步回调；监听系统明暗变化（「跟随系统」时生效）。
  // 主题切换时除写 CSS 变量外，还要重投影公告横幅——它的底色/边框全走令牌。
  registerThemeHooks(
    () => ({ mainWindow, dshView }),
    () => {
      syncInjectedTheme()
      reprojectNoticeBanner()
    }
  )
  registerNativeThemeListener()
  createWindow()
  createTray()
  // 初始化客户端自动更新：仅配置，不触发任何网络请求与下载。
  // 检测由启动流程异步发起；检测到新版本只点亮标题栏按钮，是否下载由用户决定。
  configureAutoUpdater()
  // 把 auto-updater 的状态变化同时投给三处 UI / 逻辑：
  // 1) 标题栏「更新」按钮——除 idle 外全部显示，downloading 时呈进度态（权威载体）；
  // 2) DSH 页顶部进度横幅——只在 downloading 阶段出现（纯展示，取消入口在按钮上）；
  // 3) 完成后自动弹安装确认框——见 onClientUpdatePhaseChange 的跃迁检测。
  onAppUpdateState(() => {
    pushTitlebarUpdateState()
    syncAppUpdateBanner()
    onClientUpdatePhaseChange()
    syncDownloadPeriodicReprojection()
  })
  // 停滞看门狗与下载期重投影周期（都 unref，不拖住退出）
  startDownloadStallWatchdog()
  // 首帧状态：标题栏页可能先于任何状态变化完成加载，先推一次当前快照
  pushTitlebarUpdateState()
  pushNoticeState()
  void startDshAndLoad()
  // 启动 DSH 更新定时轮询（每 6 小时，仅在打包环境生效）
  startPeriodicDshUpdateCheck()
  // 公告定时轮询（每 6 小时，仅在打包环境生效）
  startPeriodicNoticeCheck()

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

// ==================== DeepSeek 余额 ====================

// 读取当前余额快照（titlebar.html 徽章初始化时调用，不触发查询）。
// 快照只含状态与数字，绝不含 API Key；来源不受信任时返回 net 态占位。
ipcMain.handle('get-balance', (event) => {
  if (!isTrustedSender(event)) {
    return { status: 'net', message: '不受信任的调用来源' } as BalanceSnapshot
  }
  return getBalanceSnapshot()
})

// 手动刷新余额（titlebar.html 徽章点击触发；结果经 balance-update 推送回本页）
ipcMain.on('refresh-balance', (event) => {
  if (!isTrustedSender(event)) return
  void refreshBalance('manual')
})

// 余额明细 tooltip 开合通知（titlebar.html 徽章悬停/离开触发）
// 面板注入在 DSH 内容页内（见 injectBalanceTooltipShell 注释）：dshView 子视图
// 绘制在主 webContents 之上，标题栏页内的面板会被 DSH 内容完全遮挡（早期版本
// 用展开期间 dshView.setVisible(false) 规避，导致内容区黑屏，已废弃）
ipcMain.on('balance-tooltip', (event, open: boolean, html?: string, anchor?: { left: number; width: number }) => {
  if (!isTrustedSender(event)) return
  if (open === true) {
    if (typeof html !== 'string') return
    showBalanceTooltip(html, anchor)
  } else {
    hideBalanceTooltip()
  }
})

// 同步获取生效主题：供 preload 在 document_start 时机为页面打 data-theme 标，
// 实现首屏无闪烁（主/内容视图的每个页面加载都会经过）。仅返回字符串，无阻塞风险。
ipcMain.on('get-theme-sync', (event) => {
  event.returnValue = getEffectiveTheme()
})

// 公告横幅的「× 关闭」→ 记已读。id 由 markNoticeRead 内部按白名单正则校验，
// 非法值只记日志不落盘；不需要 isTrustedSender 级别的守卫（写本地文件不是高危操作，
// 且 send 者必然是已被注入横幅的那个内容页）。
ipcMain.on('notice-read', (event, id: unknown) => {
  if (!isTrustedSender(event)) return
  if (typeof id !== 'string') return
  markNoticeRead(id)
  refreshNoticeCounters()
})

// 标题栏铃铛读取公告摘要（首帧用，避免早于/晚于推送导致红点状态错位）
ipcMain.handle('get-notice-state', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) {
    return { unread: 0, hasBanner: false }
  }
  return { unread: noticeUnreadCount, hasBanner: noticeBanner.length > 0 }
})

// 标题栏铃铛点击：立即拉一次并展示（任何环境都执行，开发期据此验证 UI）
ipcMain.on('notice-refresh', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  void checkNoticesAndShow('manual')
})

// 在系统默认浏览器中打开外部链接
// 由 DSH UI 中的 GitHub 图标 / 关于模态框 / 公告横幅触发，仅允许 http(s) 协议
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
 * 停止 DSH 并退出，随后安装已下载的客户端更新包
 *
 * 两个必须做对的点，都是踩过的坑：
 * 1. isQuitting 必须提前置位。quitAndInstall 内部用 setImmediate 调 app.quit()，
 *    会触发 BrowserWindow 的 close 事件；不置位的话该事件会 preventDefault 并弹
 *    「确定要退出吗」，把更新安装流程卡死在一个多余的确认框上。
 * 2. 必须先 await stopDsh()。安装器要清空安装目录（build/installer.nsh 的
 *    customRemoveFiles 走 RMDir /r "$INSTDIR"），而 DSH 子进程正从安装目录里运行，
 *    不先停会撞上文件占用。app.quit() 触发的 window-all-closed 虽然也会调 stopDsh()，
 *    但那是异步的，app.quit() 不会等它，跑不过紧接着启动的安装器。
 */
async function quitAndInstallAppUpdate(silent: boolean): Promise<void> {
  isQuitting = true
  if (tray) {
    tray.destroy()
    tray = null
  }
  try {
    await stopDsh()
  } catch (err) {
    console.error(`[DSH] 安装更新前停止 DSH 失败: ${(err as Error).message}`)
  }
  stopBalancePolling()
  // 停止更新相关的定时器：两者都 unref 过了，这里是显式清理，语义更清楚
  stopDownloadStallWatchdog()
  stopDownloadPeriodicReprojection()
  if (silent) {
    installAppUpdateOnQuit()
  } else {
    installAppUpdateNow()
  }
}

/**
 * 标题栏：读取当前更新按钮状态
 *
 * 标题栏页加载时机可能早于 / 晚于任何一次状态推送，首帧必须主动拉一次，
 * 否则会出现「更新按钮该亮却没亮」的空窗期。
 */
ipcMain.handle('get-titlebar-update-state', (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return null
  return buildTitlebarUpdateState()
})

/**
 * 标题栏：点击「更新」按钮（DSH Desktop 客户端）
 *
 * 按 auto-updater 的当前阶段走四条互斥分支：
 * - available：确认后才下载 → [下载并更新] / [取消]
 * - downloading：进行中，可反悔 → [取消下载] / [继续下载]（默认与 Esc 都落在「继续」）
 * - downloaded：选安装时机 → [立即重启安装] / [下次启动时安装] / [取消]
 * - error：上次下载失败 → [重试下载] / [浏览器下载] / [取消]
 *
 * 仅信任主窗口 webContents（标题栏页加载于此），比 isTrustedSender 更严格。
 */
ipcMain.on('titlebar-client-update', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (!app.isPackaged) return
  if (!mainWindow || mainWindow.isDestroyed()) return

  const snap = getAppUpdateSnapshot()

  // ---- available：检测到新版，等用户点头才下载 251MB ----
  if (snap.phase === 'available') {
    const r = await showDshMessageBox({
      type: 'info',
      title: '发现新版本',
      message: `DSH Desktop 客户端 v${pendingAppUpdateVersion || snap.version || ''} 可更新`,
      detail: `当前版本: v${getInstalledAppVersion()}\n\n下载约需 251 MB。点击「下载并更新」开始下载，下载期间 DSH 页面顶部会显示进度。`,
      buttons: ['下载并更新', '取消'],
      defaultId: 0,
      cancelId: 1
    })
    if (r.response === 0) {
      void startAppUpdateDownload()
    }
    return
  }

  // ---- downloading：进行中，用户可反悔取消 ----
  if (snap.phase === 'downloading') {
    const r = await showDshMessageBox({
      type: 'info',
      title: '正在下载更新包',
      message: `DSH Desktop 客户端更新包下载中（${snap.percent}%）`,
      detail: '取消后已下载的部分会被删除，下次点「更新」将从头开始。',
      detailTone: 'notice',
      buttons: ['取消下载', '继续下载'],
      // 默认焦点与 Esc 都给「继续下载」：误按回车或想关掉对话框
      // 不应该丢掉已经下了一半的 251MB
      defaultId: 1,
      cancelId: 1,
      // 视觉强调必须与 defaultId 一致：缺省推导认 cancelId=1，会把破坏性的
      // 「取消下载」画成蓝色主按钮，误导用户点它
      primaryId: 1
    })
    if (r.response === 0) {
      cancelAppUpdateDownload()
      pushTitlebarUpdateState()
    }
    return
  }

  if (snap.phase === 'error') {
    const r = await showDshMessageBox({
      type: 'warning',
      title: '更新未完成',
      message: 'DSH Desktop 客户端更新包下载失败',
      detail: `${snap.error || '未知原因'}\n\n可重试下载；若源站持续不可用，也可用浏览器直接下载安装包自行安装。`,
      detailTone: 'notice',
      buttons: ['重试下载', '浏览器下载', '取消'],
      defaultId: 0,
      cancelId: 2
    })
    if (r.response === 0) {
      void startAppUpdateDownload()
    } else if (r.response === 1) {
      await openAppUpdateInBrowser()
    }
    return
  }

  // downloaded：安装时机确认框。复用 promptInstallTiming 以共享 installPromptOpen
  // 互斥锁——下载完成时已自动弹过一次，若此时用户又点按钮，不再弹第二个框。
  if (!isAppUpdateReadyToInstall()) return
  await promptInstallTiming()
})

/**
 * 标题栏：点击「更新DSH」按钮（DSH 运行包）
 *
 * 先弹确认框明示「从哪个版本到哪个版本」——运行包更新会停掉 DSH 服务、装 518 个包、
 * 再拉起来，属于会打断用户工作的操作，默认焦点给「取消」。
 *
 * 这是自绘对话框层（dsh-dialog）的样板调用点：defaultId 给「取消」是刻意的
 * 产品决策（回车不该直接触发一次打断会话的更新），而视觉强调仍在「确定更新」——
 * 两者在 showDshMessageBox 里是分开的 primaryId / defaultId。
 */
ipcMain.on('titlebar-dsh-update', async (event) => {
  if (!mainWindow || event.sender !== mainWindow.webContents) return
  if (!pendingDshUpdateVersion) return
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (isUpdating) return

  const r = await showDshMessageBox({
    type: 'question',
    title: '更新 DSH 运行包',
    message: `DSH 运行包有更新 v${getInstalledDshVersion()} → v${pendingDshUpdateVersion}`,
    detail: '更新过程中 DSH 服务会停止，下载并安装新运行包后自动重启。当前进行中的会话会中断。',
    detailTone: 'notice',
    buttons: ['确定更新', '取消'],
    defaultId: 1,
    cancelId: 1,
    primaryId: 0
  })
  if (r.response === 0) {
    await performUpdate()
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
 * - 关于 DSH Desktop → 关于模态框（客户端版本 + DSH 运行包版本 + 内置 Node 运行时 + GitHub 仓库）
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
 * 菜单本体为原生 Menu.popup：顶级仅「主题」一项，其子菜单为跟随系统 / 浅色 / 深色
 * 三个单选项（当前设置值带单选点），选中后由 theme-manager 持久化并立即应用；
 * 点击外部与 Esc 关闭由原生菜单自行处理。
 */
ipcMain.on('show-settings-menu', (event, position: { x: number; y: number; width: number }) => {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (event.sender !== mainWindow.webContents) return
  if (
    typeof position !== 'object' || position === null ||
    typeof position.x !== 'number' || typeof position.y !== 'number'
  ) return

  const setting = getThemeSetting()
  const menu = Menu.buildFromTemplate([
    {
      label: '主题',
      submenu: [
        { label: '跟随系统', type: 'radio', checked: setting === 'system', click: () => setThemeSetting('system') },
        { label: '浅色', type: 'radio', checked: setting === 'light', click: () => setThemeSetting('light') },
        { label: '深色', type: 'radio', checked: setting === 'dark', click: () => setThemeSetting('dark') }
      ]
    }
  ])

  // 菜单关闭后通知标题栏页面复位「设置」按钮的 hover/active 类（机制与帮助菜单一致）
  menu.once('menu-will-close', () => {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!mainWindow.webContents.isDestroyed()) {
      mainWindow.webContents.send('settings-menu-closed')
    }
  })

  menu.popup({
    window: mainWindow,
    x: Math.round(position.x),
    y: Math.round(position.y + 4)
  })
})

// 所有窗口关闭时退出应用（macOS 除外），并清理 DSH 进程
app.on('window-all-closed', async () => {
  // 兜底销毁托盘：覆盖直接点窗口关闭按钮的退出路径，避免托盘区残留幽灵图标
  if (tray) {
    tray.destroy()
    tray = null
  }
  try {
    await stopDsh()
  } catch (err) {
    console.error(`[DSH] 停止失败: ${(err as Error).message}`)
  }
  // 停止余额轮询（退出路径，避免定时器拖住进程）
  stopBalancePolling()
  // 同理停止更新看门狗与下载期重投影周期
  stopDownloadStallWatchdog()
  stopDownloadPeriodicReprojection()

  if (process.platform !== 'darwin') {
    app.quit()
  }
})
