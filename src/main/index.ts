import { app, BrowserWindow, shell, ipcMain, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { startDsh, stopDsh, waitForDshReady, DSH_PACKAGE_MISSING_ERROR_NAME } from './dsh-manager'
import { prepareDshPackage, activateDshPackage, repairDsh } from './dsh-repair'
import { checkForUpdate, getInstalledDshVersion, isValidVersion } from './dsh-version'
import { checkForGitHubAppUpdate, getInstalledAppVersion, cleanupLegacyInstallers, fetchGitHubLatest } from './app-update'

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 标记是否正在执行启动流程（防止重试重复触发）
let isStarting = false

// DSH 运行包更新互斥锁（performUpdate 与 install-dsh-update 入口检查）
let isUpdating = false

// DSH 修复互斥锁（repair-dsh IPC 重入保护）
let isRepairing = false

// 手动检查更新互斥锁（防止快速点击重复弹 dialog）
let isCheckingUpdate = false

// 待更新的桌面应用版本号与 GitHub Release 页面地址（由 checkForGitHubAppUpdateAndPrompt 赋值，install-update IPC 读取）
let pendingAppUpdateVersion: string | null = null
let pendingAppUpdateReleaseUrl: string | null = null

// 待安装的 DSH 运行包版本号（由 checkDshUpdateAndPrompt 赋值，install-dsh-update IPC 与 performUpdate 读取）
let pendingDshUpdateVersion: string | null = null

// 最近一次已提示过更新的 DSH 最新版本（用于抑制同一版本的重复弹窗/横幅）
let lastPromptedDshVersion: string | null = null

// GitHub 仓库地址（右上角图标点击后在系统默认浏览器打开）
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
 * 加载 loading.html（开发环境用 URL，生产环境用文件）
 */
function loadLoadingPage(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const base = getRendererBaseUrl()
  if (base) {
    void mainWindow.loadURL(`${base}/loading.html`)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/loading.html'))
  }
}

/**
 * 加载 error.html 并通过 query 参数传递错误信息
 */
function loadErrorPage(message: string): void {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const base = getRendererBaseUrl()
  if (base) {
    void mainWindow.loadURL(`${base}/error.html?error=${encodeURIComponent(message)}`)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/error.html'), {
      query: { error: message }
    })
  }
}

/**
 * 向加载界面发送状态更新（通过 IPC channel 'status'）
 */
function sendStatus(status: string): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('status', status)
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
    const url = new URL(event.senderFrame.url)
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
 * 判断主窗口当前是否加载着 DSH Web UI（loopback 页面）
 *
 * 横幅/图标仅在 DSH 页面注入，避免污染 loading/error 页（这些页面结构简单，
 * 注入 banner 可能造成 UI 错位）；也避免在 DSH UI 尚未加载时执行 JS 抛错。
 */
function isDshPageLoaded(): boolean {
  if (!mainWindow || mainWindow.isDestroyed()) return false
  try {
    const url = new URL(mainWindow.webContents.getURL())
    return (url.protocol === 'http:' || url.protocol === 'https:') &&
      (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1')
  } catch {
    return false
  }
}

/**
 * 根据当前横幅高度，同步调整右上角浮动图标的 top 位置
 *
 * 涉及 GitHub 图标 [data-dsh-github-link] 与检查更新图标 [data-dsh-update-check]。
 * 横幅出现/关闭时统一调用，避免图标被横幅遮挡。
 */
async function adjustFloatingIconsPosition(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const adjustCode = `
    (function () {
      var banners = document.querySelector('[data-dsh-update-banners]')
      var bannerHeight = banners ? banners.offsetHeight : 0
      var selectors = ['[data-dsh-github-link]', '[data-dsh-update-check]']
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) el.style.top = (16 + bannerHeight) + 'px'
      }
    })()
  `
  try {
    await mainWindow.webContents.executeJavaScript(adjustCode)
  } catch { /* 页面未就绪时静默忽略 */ }
}

/**
 * 向 DSH Web UI 右上角注入"检查更新"图标
 *
 * 与 GitHub 图标风格一致：40x40 圆形、半透明黑底、白色刷新 SVG。
 * 位置：GitHub 图标（right:16px）左侧 56px 处，即 right:72px。
 * 点击：调用 window.dsh.showUpdateMenu()，主进程弹 dialog 让用户选择检查项。
 */
async function injectUpdateCheckButton(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!isDshPageLoaded()) return
  const buttonCode = `
    (function () {
      if (document.querySelector('[data-dsh-update-check]')) {
        return
      }
      var link = document.createElement('div')
      link.setAttribute('data-dsh-update-check', '')
      link.title = '检查更新'
      var bannerHeight = 0
      var banners = document.querySelector('[data-dsh-update-banners]')
      if (banners) bannerHeight = banners.offsetHeight
      link.style.cssText = 'position: fixed; top: ' + (16 + bannerHeight) + 'px; right: 72px; z-index: 2147483647; width: 40px; height: 40px; border-radius: 20px; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);'
      link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-3-6.7L21 8"/><path d="M21 3v5h-5"/></svg>'
      link.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.showUpdateMenu === 'function') {
          window.dsh.showUpdateMenu()
        }
      })
      document.body.appendChild(link)
    })()
  `
  try {
    await mainWindow.webContents.executeJavaScript(buttonCode)
  } catch (err) {
    console.warn(`[DSH] 注入检查更新图标失败: ${(err as Error).message}`)
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
 * 创建主窗口并加载 loading.html
 */
function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    icon: nativeImage.createFromPath(getWindowIconPath()),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: join(__dirname, '../preload/index.js')
    }
  })

  // 先加载 loading 界面
  loadLoadingPage()

  // 窗口准备好后再显示，避免出现白屏
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 外部链接在系统默认浏览器中打开
  // 仅对真正的外部 http(s) URL 转发；DSH 自身地址(127.0.0.1/localhost)、
  // 空 URL、about:blank 一律 deny 不打开浏览器，避免 DSH Web UI 加载时
  // 自动 window.open 自身地址导致系统浏览器跟着弹出
  mainWindow.webContents.setWindowOpenHandler((details) => {
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
  })
}

/**
 * 启动 DSH 服务并在就绪后加载到主窗口
 *
 * 流程：
 * 1. 发送状态更新到加载界面
 * 2. 启动 DSH 进程
 * 3. 等待服务就绪（最多 180 秒）
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(dshProcess.url)
      // 更新窗口标题显示当前版本
      mainWindow.setTitle(`DSH Desktop v${getInstalledAppVersion()} - DSH v${getInstalledDshVersion()}`)
      // 异步检查更新（不阻塞启动流程）
      checkDshUpdateAndPrompt()
      // 异步检查桌面应用自身更新（不阻塞启动流程；有新版时引导打开 GitHub Release 页面）
      void checkForGitHubAppUpdateAndPrompt()
      // 向 DSH UI 注入 GitHub 仓库链接图标（不阻塞启动流程）
      void injectGitHubLink()
      // 向 DSH UI 注入右上角"检查更新"图标（不阻塞启动流程）
      void injectUpdateCheckButton()
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
    if (mainWindow && !mainWindow.isDestroyed()) {
      await mainWindow.loadURL(dshProcess.url)
      // 更新窗口标题
      mainWindow.setTitle(`DSH Desktop v${getInstalledAppVersion()} - DSH v${getInstalledDshVersion()}`)
      // 重新注入 GitHub 仓库链接图标
      void injectGitHubLink()
      // 重新注入右上角"检查更新"图标
      void injectUpdateCheckButton()
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
  if (!mainWindow || mainWindow.isDestroyed()) return
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
      var existing = container.querySelector('[data-dsh-update-banner="dsh"]')
      if (existing) existing.remove()

      var banner = document.createElement('div')
      banner.setAttribute('data-dsh-update-banner', 'dsh')
      banner.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;background:#2563eb;color:#fff;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      banner.innerHTML = '<span>DSH 运行包有更新 <strong>v${currentVersion}</strong> → <strong>v${latestVersion}</strong></span><button data-action="update" style="padding:4px 12px;background:#fff;color:#2563eb;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">更新 DSH</button><button data-action="close" style="margin-left:4px;padding:2px 6px;background:transparent;color:#fff;border:none;font-size:16px;line-height:1;cursor:pointer;">×</button>'

      banner.querySelector('[data-action="update"]').addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.installDshUpdate === 'function') {
          window.dsh.installDshUpdate()
        }
      })
      banner.querySelector('[data-action="close"]').addEventListener('click', function () {
        banner.remove()
        var selectors = ['[data-dsh-github-link]', '[data-dsh-update-check]']
        var banners = document.querySelector('[data-dsh-update-banners]')
        var bannerHeight = banners ? banners.offsetHeight : 0
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i])
          if (el) el.style.top = (16 + bannerHeight) + 'px'
        }
      })

      container.appendChild(banner)
      var selectors = ['[data-dsh-github-link]', '[data-dsh-update-check]']
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) el.style.top = (16 + container.offsetHeight) + 'px'
      }
    })()
  `
  try {
    await mainWindow.webContents.executeJavaScript(bannerCode)
    await adjustFloatingIconsPosition()
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
  if (!mainWindow || mainWindow.isDestroyed()) return
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
      var existing = container.querySelector('[data-dsh-update-banner="app"]')
      if (existing) existing.remove()

      var banner = document.createElement('div')
      banner.setAttribute('data-dsh-update-banner', 'app')
      banner.style.cssText = 'display:flex;align-items:center;justify-content:center;gap:12px;padding:10px 16px;background:#7c3aed;color:#fff;font-size:13px;font-weight:500;box-shadow:0 2px 8px rgba(0,0,0,.25);'
      banner.innerHTML = '<span>DSH Desktop 客户端有更新 <strong>v${currentVersion}</strong> → <strong>v${latestVersion}</strong></span><button data-action="update" style="padding:4px 12px;background:#fff;color:#7c3aed;border:none;border-radius:4px;font-size:12px;font-weight:600;cursor:pointer;">前往下载</button><button data-action="close" style="margin-left:4px;padding:2px 6px;background:transparent;color:#fff;border:none;font-size:16px;line-height:1;cursor:pointer;">×</button>'

      banner.querySelector('[data-action="update"]').addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.installUpdate === 'function') {
          window.dsh.installUpdate()
        }
      })
      banner.querySelector('[data-action="close"]').addEventListener('click', function () {
        banner.remove()
        var selectors = ['[data-dsh-github-link]', '[data-dsh-update-check]']
        var banners = document.querySelector('[data-dsh-update-banners]')
        var bannerHeight = banners ? banners.offsetHeight : 0
        for (var i = 0; i < selectors.length; i++) {
          var el = document.querySelector(selectors[i])
          if (el) el.style.top = (16 + bannerHeight) + 'px'
        }
      })

      container.appendChild(banner)
      var selectors = ['[data-dsh-github-link]', '[data-dsh-update-check]']
      for (var i = 0; i < selectors.length; i++) {
        var el = document.querySelector(selectors[i])
        if (el) el.style.top = (16 + container.offsetHeight) + 'px'
      }
    })()
  `
  try {
    await mainWindow.webContents.executeJavaScript(bannerCode)
    await adjustFloatingIconsPosition()
  } catch (err) {
    console.warn(`[DSH] 注入客户端更新横幅失败: ${(err as Error).message}`)
  }
}

/**
 * 向 DSH UI 注入右上角 GitHub 仓库链接图标
 *
 * 图标可点击，点击后调用 window.dsh.openExternal 在系统默认浏览器打开仓库。
 * 注入前先判断图标是否已存在，避免重复注入。
 * 若页面顶部已有更新横幅，图标会自动下移，避免被横幅遮挡。
 */
async function injectGitHubLink(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  if (!isDshPageLoaded()) return
  const linkCode = `
    (function () {
      if (document.querySelector('[data-dsh-github-link]')) {
        return
      }
      var link = document.createElement('div')
      link.setAttribute('data-dsh-github-link', '')
      link.title = '查看 GitHub 仓库'
      var bannerHeight = 0
      var banners = document.querySelector('[data-dsh-update-banners]')
      if (banners) bannerHeight = banners.offsetHeight
      link.style.cssText = 'position: fixed; top: ' + (16 + bannerHeight) + 'px; right: 16px; z-index: 2147483647; width: 40px; height: 40px; border-radius: 20px; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);'
      link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16" fill="#fff"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
      link.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.openExternal === 'function') {
          window.dsh.openExternal('${GITHUB_REPO_URL}')
        }
      })
      document.body.appendChild(link)
    })()
  `
  try {
    await mainWindow.webContents.executeJavaScript(linkCode)
  } catch (err) {
    console.warn(`[DSH] 注入 GitHub 仓库链接失败: ${(err as Error).message}`)
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

// 在系统默认浏览器中打开外部链接
// 由 DSH UI 中的 GitHub 图标触发，仅允许 http(s) 协议
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
 * 手动检查更新菜单
 *
 * 由 DSH UI 右上角"检查更新"图标触发。弹原生 dialog 让用户选择检查项，
 * 再串行执行对应手动检查函数（避免 dialog 重叠）。
 * 受 isCheckingUpdate 互斥锁保护，防止快速点击重复触发。
 */
ipcMain.on('show-update-menu', async (event) => {
  if (!isTrustedSender(event)) return
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
