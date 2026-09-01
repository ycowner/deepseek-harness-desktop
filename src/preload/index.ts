import { contextBridge, ipcRenderer } from 'electron'

/**
 * 修复结果
 */
interface RepairResult {
  success: boolean
  cachePath?: string
  error?: string
}

/**
 * 外观设置信息：设置值（浅色/深色/跟随系统）+ 生效主题（实际渲染的明暗态）
 */
interface ThemeInfo {
  setting: 'light' | 'dark' | 'system'
  effective: 'dark' | 'light'
}

// 首屏无闪烁：preload 在 document_start 时机执行（早于页面渲染），同步取生效主题并立即
// 给 <html> 打 data-theme 标。主/内容视图的每个页面（含 DSH 页）都加载同一 preload，
// 天然获得首屏正确主题。document_start 时 documentElement 可能尚未就绪，
// DOMContentLoaded 补一次；重复赋同值无副作用。
try {
  const effective = ipcRenderer.sendSync('get-theme-sync') as 'dark' | 'light'
  const applyInitialTheme = (): void => {
    // @ts-ignore preload 在渲染进程执行，tsconfig.node.json 无 DOM lib
    if (document.documentElement) {
      // @ts-ignore
      document.documentElement.dataset.theme = effective
    }
  }
  applyInitialTheme()
  // @ts-ignore
  document.addEventListener('DOMContentLoaded', applyInitialTheme)
} catch (e) {
  console.error(e)
}

/**
 * 通过 contextBridge 暴露给渲染进程的安全 API
 * 用于 loading.html / error.html 与主进程之间的通信
 */
const api = {
  // 通知主进程重新启动 DSH 服务（错误页面重试按钮使用）
  retry: (): void => {
    ipcRenderer.send('retry')
  },
  // 从当前页面 URL query 中读取错误信息（错误页面加载时使用）
  getErrorInfo: (): string => {
    // @ts-ignore preload 在渲染进程执行，tsconfig.node.json 无 DOM lib
    const params = new URLSearchParams(window.location.search)
    return params.get('error') || '未知错误'
  },
  // 订阅主进程发送的状态更新（加载页面接收状态文字使用）
  onStatus: (callback: (status: string) => void): void => {
    ipcRenderer.on('status', (_event, status: string) => callback(status))
  },
  // 触发 DSH 包在线修复（错误页面"在线修复"按钮使用）
  // 返回修复结果：成功时包含 cachePath，失败时包含 error 信息
  repairDsh: (): Promise<RepairResult> => {
    return ipcRenderer.invoke('repair-dsh')
  },
  // 订阅修复进度消息（在 repairDsh 调用期间通过 onRepairProgress 上报步骤文字）
  onRepairProgress: (callback: (msg: string) => void): void => {
    ipcRenderer.on('repair-progress', (_event, msg: string) => callback(msg))
  },
  // 触发版本检查（主进程比较本地与 npm registry 最新版本）
  checkUpdate: (): Promise<{ hasUpdate: boolean; currentVersion: string; latestVersion: string; error?: string }> => {
    return ipcRenderer.invoke('check-update')
  },
  // 获取已安装的 DSH 版本号
  getInstalledVersion: (): Promise<string> => {
    return ipcRenderer.invoke('get-installed-version')
  },
  // 获取桌面应用自身的版本号
  getAppVersion: (): Promise<string> => {
    return ipcRenderer.invoke('get-app-version')
  },
  // 触发客户端更新引导（主进程弹出确认框后打开 GitHub Release 页面，由用户手动下载安装）
  installUpdate: (): void => {
    ipcRenderer.send('install-update')
  },
  // 触发 DSH 运行包更新（主进程切回 loading 页后下载安装并重启服务）
  installDshUpdate: (): void => {
    ipcRenderer.send('install-dsh-update')
  },
  // 在系统默认浏览器中打开外部链接（DSH UI 中的 GitHub 图标使用）
  // 返回 openExternal 结果：成功时 success 为 true，失败时包含 error 信息
  openExternal: (url: string): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('open-external', url)
  },
  // 获取应用图标 data URL（标题栏左侧图标显示用）
  // 主进程读取 icon.ico 缩放为 32x32 PNG；失败返回空串（页面侧隐藏图标）
  getAppIcon: (): Promise<string> => {
    return ipcRenderer.invoke('get-app-icon')
  },
  // 触发帮助菜单（标题栏「帮助」按钮使用，主进程在按钮下方弹出原生菜单：
  // 检查更新 / 更新日志（DSH 运行包、DSH Desktop 客户端）/ 关于）
  showHelpMenu: (position: { x: number; y: number; width: number }): void => {
    ipcRenderer.send('show-help-menu', position)
  },
  // 订阅帮助菜单关闭通知（主进程在 menu-will-close 时发送；
  // titlebar.html 据此复位按钮的 hover/active 类，防止交互态颜色残留）
  onHelpMenuClosed: (callback: () => void): void => {
    ipcRenderer.on('help-menu-closed', () => callback())
  },
  // 获取当前外观设置与生效主题（设置菜单勾选态 / 页面主题初始化使用）
  getTheme: (): Promise<ThemeInfo> => {
    return ipcRenderer.invoke('get-theme')
  },
  // 更新外观设置：浅色 / 深色 / 跟随系统；主进程持久化后立即应用，无需重启
  setTheme: (setting: 'light' | 'dark' | 'system'): Promise<{ success: boolean; error?: string }> => {
    return ipcRenderer.invoke('set-theme', setting)
  },
  // 订阅主题变化（用户切换设置或系统明暗变化且处于「跟随系统」时触发；
  // 页面据此更新 data-theme 切换 CSS 变量色板）
  onThemeChanged: (callback: (info: ThemeInfo) => void): void => {
    ipcRenderer.on('theme-changed', (_event, info: ThemeInfo) => callback(info))
  },
  // 触发设置菜单（标题栏「设置」按钮使用，主进程在按钮下方弹出原生菜单：
  // 外观 → 浅色 / 深色 / 跟随系统）
  showSettingsMenu: (position: { x: number; y: number; width: number }): void => {
    ipcRenderer.send('show-settings-menu', position)
  },
  // 订阅设置菜单关闭通知（主进程在菜单视图移除时发送；
  // titlebar.html 据此复位「设置」按钮的交互态类，机制与帮助按钮一致）
  onSettingsMenuClosed: (callback: () => void): void => {
    ipcRenderer.on('settings-menu-closed', () => callback())
  },
  // 上报设置菜单关闭请求（点击面板外部 / Esc / 选中主题项后，
  // 由 menu.html 与 titlebar.html 调用，主进程移除菜单视图）
  sendSettingsMenuOutside: (): void => {
    ipcRenderer.send('settings-menu-outside')
  }
}

if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('dsh', api)
  } catch (error) {
    console.error(error)
  }
} else {
  // @ts-ignore contextIsolation 关闭时直接挂载到 window
  window.dsh = api
}
