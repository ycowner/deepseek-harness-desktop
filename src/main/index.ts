import { app, BrowserWindow, shell, ipcMain, nativeImage, dialog } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { spawn } from 'child_process'
import { startDsh, stopDsh, waitForDshReady, DSH_PACKAGE_MISSING_ERROR_NAME } from './dsh-manager'
import { repairDsh } from './dsh-repair'
import { checkForUpdate, getInstalledDshVersion } from './dsh-version'
import { checkForAppUpdate, getDownloadedAppPath, getInstallDir, downloadAppUpdate, getInstalledAppVersion } from './app-update'

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 标记是否正在执行启动流程（防止重试重复触发）
let isStarting = false

// 待安装的桌面应用版本号（由 checkAndDownloadAppUpdate 赋值，install-update IPC 与 performAppUpdate 读取）
let pendingAppUpdateVersion: string | null = null

// 最近一次已提示过更新的 DSH 最新版本（用于抑制同一版本的重复弹窗）
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
      // 异步检查并下载桌面应用自身更新（不阻塞启动流程）
      void checkAndDownloadAppUpdate()
      // 向 DSH UI 注入 GitHub 仓库链接图标（不阻塞启动流程）
      void injectGitHubLink()
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
 * 显示更新提醒对话框
 *
 * 当检测到 DSH 有新版本时，弹出对话框询问用户是否立即更新。
 * 用户选择"立即更新"后触发 performUpdate 流程。
 */
async function showUpdateDialog(currentVersion: string, latestVersion: string): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const result = await dialog.showMessageBox(mainWindow, {
    type: 'info',
    title: '发现新版本',
    message: `DSH 有新版本可用`,
    detail: `当前版本: v${currentVersion}\n最新版本: v${latestVersion}\n\n是否立即更新?`,
    buttons: ['立即更新', '稍后'],
    defaultId: 0,
    cancelId: 1
  })
  if (result.response === 0) {
    await performUpdate()
  }
}

/**
 * 检查 DSH 是否有新版本，有则弹出更新提醒
 *
 * 供启动时与定时轮询复用；对同一最新版本只提示一次（lastPromptedDshVersion），
 * 避免更新下载/轮询导致的重复弹窗；检查失败仅记录日志，不打断用户操作。
 */
function checkDshUpdateAndPrompt(): void {
  void checkForUpdate().then(result => {
    if (result.hasUpdate && result.latestVersion !== lastPromptedDshVersion) {
      lastPromptedDshVersion = result.latestVersion
      void showUpdateDialog(result.currentVersion, result.latestVersion)
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
 * 复用 repairDsh 下载最新版本，然后重启 DSH 服务。
 * 更新完成后重新检查版本（处理下载版本仍非最新的边缘情况）。
 */
async function performUpdate(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  try {
    // 显示加载页面
    loadLoadingPage()
    sendStatus('正在下载最新版本 DSH 包...')

    // 复用修复流程下载最新版
    await repairDsh((msg: string) => {
      sendStatus(msg)
    })

    sendStatus('更新完成，正在重启 DSH 服务...')

    // 停止旧进程
    await stopDsh()

    // 重新启动
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
    }

    // 更新完成后再次检查版本（走带抑制逻辑的检查，避免同一版本重复弹窗）
    checkDshUpdateAndPrompt()
  } catch (err) {
    const error = err as Error
    console.error(`[DSH] 更新失败: ${error.message}`)
    dialog.showErrorBox('更新失败', `DSH 更新失败: ${error.message}`)
    loadErrorPage(error.message)
  }
}

/**
 * 检查并下载桌面应用自身的新版本
 *
 * 仅在打包环境下执行；检测到新版本后下载安装包到安装目录，
 * 下载完成后注入更新徽标。任何异常仅记录日志，不打断启动流程。
 */
async function checkAndDownloadAppUpdate(): Promise<void> {
  if (!app.isPackaged) return
  try {
    const result = await checkForAppUpdate()
    if (!result.hasUpdate) return

    const destPath = getDownloadedAppPath(result.latestVersion)
    // 目标安装包已存在则跳过下载（可能是上次已下载完成）
    if (!existsSync(destPath)) {
      console.log(`[DSH] 开始下载桌面应用新版本 v${result.latestVersion} (来源: ${result.source})`)
      await downloadAppUpdate(result.downloadUrl, destPath, (downloaded) => {
        // 每下载约 1MB 上报一次进度
        if (downloaded % (1024 * 1024) < 100 * 1024) {
          console.log(`[DSH] 下载进度: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
        }
      })
      console.log(`[DSH] 桌面应用新版本下载完成: ${destPath}`)
    } else {
      console.log(`[DSH] 桌面应用新版本安装包已存在，跳过下载: ${destPath}`)
    }

    pendingAppUpdateVersion = result.latestVersion
    await injectUpdateBadge()
  } catch (err) {
    console.error(`[DSH] 桌面应用更新检查失败: ${(err as Error).message}`)
  }
}

/**
 * 向 DSH UI 注入右上角"更新"悬浮按钮
 *
 * 深灰半透明胶囊按钮：左侧为涟漪扩散动画的下载图标，右侧为"更新"文字；
 * 悬停时展开显示详情（有更新 v{最新版本} · 点击更新）；
 * 点击后调用 window.dsh.installUpdate 触发安装确认流程。
 * 样式通过 CSSOM 内联设置、动效使用 Web Animations API，规避外部页面 CSP 限制。
 * 注入前先判断按钮是否已存在，避免重复注入。
 */
async function injectUpdateBadge(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const latestVersion = pendingAppUpdateVersion || '新版本'
  const badgeCode = `
    (function () {
      if (document.querySelector('[data-dsh-update-badge]')) {
        return
      }
      // 构建按钮主体（放在 GitHub 图标左侧同一行，紧贴标题栏下方）
      var badge = document.createElement('div')
      badge.setAttribute('data-dsh-update-badge', '')
      badge.style.cssText = 'position:fixed;top:16px;right:64px;z-index:2147483647;display:inline-flex;align-items:center;gap:8px;padding:6px 14px 6px 10px;background:rgba(40,44,52,.72);-webkit-backdrop-filter:blur(6px);backdrop-filter:blur(6px);border:1px solid rgba(255,255,255,.12);border-radius:999px;color:#fff;font-size:13px;font-weight:600;font-family:system-ui,-apple-system,sans-serif;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.25);transition:background .2s ease,box-shadow .2s ease;overflow:hidden;white-space:nowrap;'

      // 涟漪动画下载图标（下载箭头 + 向外扩散并淡出的圆环）
      var icon = document.createElement('span')
      icon.style.cssText = 'position:relative;width:18px;height:18px;flex:0 0 auto;'
      icon.innerHTML = '<svg class="dsh-arrow" viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="#fff" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14"/><path d="M6 13l6 6 6-6"/></svg>'
      var arrow = icon.querySelector('.dsh-arrow')
      arrow.style.cssText = 'position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);'
      badge.appendChild(icon)

      // 涟漪动画：每 0.6s 新增一个向外扩散并淡出的圆环（Web Animations API，不依赖 @keyframes）
      function spawnRipple(el) {
        if (!document.body.contains(el)) {
          return
        }
        var ring = document.createElement('span')
        ring.style.cssText = 'position:absolute;inset:0;border-radius:50%;border:1.5px solid rgba(255,255,255,.55);pointer-events:none;'
        el.appendChild(ring)
        var anim = ring.animate(
          [{ transform: 'scale(0.6)', opacity: 0.9 }, { transform: 'scale(2.2)', opacity: 0 }],
          { duration: 1800, easing: 'ease-out' }
        )
        anim.onfinish = function () {
          ring.remove()
        }
        setTimeout(function () {
          spawnRipple(el)
        }, 600)
      }
      spawnRipple(icon)

      // "更新"文字
      var label = document.createElement('span')
      label.style.cssText = 'line-height:1;'
      label.textContent = '更新'
      badge.appendChild(label)

      // 悬停详情
      var detail = document.createElement('span')
      detail.style.cssText = 'max-width:0;opacity:0;overflow:hidden;white-space:nowrap;transition:max-width .25s ease,opacity .2s ease,margin-left .25s ease;font-weight:400;color:rgba(255,255,255,.85);font-size:12px;'
      detail.textContent = '有更新 v${latestVersion} · 点击更新'
      badge.appendChild(detail)

      // 悬停交互
      badge.addEventListener('mouseenter', function () {
        badge.style.background = 'rgba(52,58,68,.85)'
        badge.style.boxShadow = '0 4px 14px rgba(0,0,0,.35)'
        detail.style.maxWidth = '200px'
        detail.style.opacity = '1'
        detail.style.marginLeft = '2px'
      })
      badge.addEventListener('mouseleave', function () {
        badge.style.background = 'rgba(40,44,52,.72)'
        badge.style.boxShadow = '0 2px 8px rgba(0,0,0,.25)'
        detail.style.maxWidth = '0'
        detail.style.opacity = '0'
        detail.style.marginLeft = '0'
      })

      // 点击触发安装确认流程
      badge.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.installUpdate === 'function') {
          window.dsh.installUpdate()
        }
      })
      document.body.appendChild(badge)
    })()
  `
  await mainWindow.webContents.executeJavaScript(badgeCode)
}

/**
 * 向 DSH UI 注入右上角 GitHub 仓库链接图标
 *
 * 图标可点击，点击后调用 window.dsh.openExternal 在系统默认浏览器打开仓库。
 * 注入前先判断图标是否已存在，避免重复注入。
 */
async function injectGitHubLink(): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) return
  const linkCode = `
    (function () {
      if (document.querySelector('[data-dsh-github-link]')) {
        return
      }
      var link = document.createElement('div')
      link.setAttribute('data-dsh-github-link', '')
      link.title = '查看 GitHub 仓库'
      link.style.cssText = 'position: fixed; top: 16px; right: 16px; z-index: 2147483647; width: 40px; height: 40px; border-radius: 20px; background: rgba(0,0,0,.45); display: flex; align-items: center; justify-content: center; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.3);'
      link.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 16 16" fill="#fff"><path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></svg>'
      link.addEventListener('click', function () {
        if (window.dsh && typeof window.dsh.openExternal === 'function') {
          window.dsh.openExternal('${GITHUB_REPO_URL}')
        }
      })
      document.body.appendChild(link)
    })()
  `
  await mainWindow.webContents.executeJavaScript(linkCode)
}

/**
 * 执行桌面应用安装流程
 *
 * 校验安装包存在后停止 DSH 服务，弹出提示，启动安装向导并退出应用。
 */
async function performAppUpdate(): Promise<void> {
  if (!pendingAppUpdateVersion) return
  const installerPath = getDownloadedAppPath(pendingAppUpdateVersion)
  // 校验安装包存在，不存在则报错返回
  if (!existsSync(installerPath)) {
    dialog.showMessageBox(mainWindow!, {
      type: 'error',
      title: '更新失败',
      message: '安装包不存在',
      detail: `未找到安装包: ${installerPath}`
    })
    return
  }

  try {
    await stopDsh()
  } catch (err) {
    console.error(`[DSH] 更新前停止 DSH 失败: ${(err as Error).message}`)
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: '准备安装',
      message: '应用即将关闭',
      detail: '请在安装向导中完成安装'
    })
  }

  try {
    spawn(installerPath, [], { detached: true, stdio: 'ignore' }).unref()
  } catch (err) {
    console.error(`[DSH] 启动安装向导失败: ${(err as Error).message}`)
  }
  app.quit()
}

// 应用就绪时启动
app.whenReady().then(() => {
  // 固定 AppUserModelID，与 electron-builder.yml 的 appId 保持一致，
  // 让 Windows 在升级/重装时能稳定识别应用外壳，避免任务栏固定图标因注册信息重建而失效
  app.setAppUserModelId('com.dsh.desktop')
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
ipcMain.handle('repair-dsh', async (event) => {
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
ipcMain.handle('open-external', async (_event, url: string) => {
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

// 桌面应用安装更新事件
// 由 DSH UI 中的更新徽标触发，确认后执行安装流程
ipcMain.on('install-update', async () => {
  if (!app.isPackaged) return
  if (!pendingAppUpdateVersion) return
  const result = await dialog.showMessageBox(mainWindow!, {
    type: 'info',
    title: '发现新版本',
    message: 'DSH Desktop 有新版本可用',
    detail: `当前版本: v${getInstalledAppVersion()}\n最新版本: v${pendingAppUpdateVersion}\n\n是否立即更新?`,
    buttons: ['立即更新', '稍后更新'],
    defaultId: 0,
    cancelId: 1
  })
  if (result.response === 0) {
    await performAppUpdate()
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
