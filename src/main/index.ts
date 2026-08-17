import { app, BrowserWindow, shell, ipcMain, nativeImage } from 'electron'
import { join } from 'path'
import { startDsh, stopDsh, waitForDshReady, DSH_PACKAGE_MISSING_ERROR_NAME } from './dsh-manager'
import { repairDsh } from './dsh-repair'

// 主窗口引用
let mainWindow: BrowserWindow | null = null

// 标记是否正在执行启动流程（防止重试重复触发）
let isStarting = false

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
  mainWindow.webContents.setWindowOpenHandler((details) => {
    void shell.openExternal(details.url)
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
    }
  } catch (err) {
    const error = err as Error
    const isPackageMissing = error.name === DSH_PACKAGE_MISSING_ERROR_NAME
    showError(`DSH 启动失败: ${error.message}`, isPackageMissing)
  } finally {
    isStarting = false
  }
}

// 应用就绪时启动
app.whenReady().then(() => {
  createWindow()
  void startDshAndLoad()

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
