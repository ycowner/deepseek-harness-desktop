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
  // 触发手动检查更新菜单（主进程弹 dialog 让用户选择检查 DSH 运行包 / 客户端 / 全部）
  showUpdateMenu: (): void => {
    ipcRenderer.send('show-update-menu')
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
