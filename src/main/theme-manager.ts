import { nativeTheme } from 'electron'
import type { BrowserWindow, WebContentsView } from 'electron'
import { loadThemeSetting, saveThemeSetting, ThemeSetting } from './theme-store'

/**
 * 生效主题（实际渲染的明暗态）：深色 / 浅色
 *
 * 设置值为 system 时，由 nativeTheme.shouldUseDarkColors 决定。
 */
export type EffectiveTheme = 'dark' | 'light'

// titleBarOverlay（WCO 最小化/最大化/关闭按钮区）配色
// 深色沿用出厂值（Win11 深色标题栏标准色 #202020），浅色对齐 Win11 浅色标题栏
const OVERLAY_COLORS: Record<EffectiveTheme, { color: string; symbolColor: string }> = {
  dark: { color: '#202020', symbolColor: '#e6e6e6' },
  light: { color: '#f3f3f3', symbolColor: '#333333' }
}

// 当前生效主题（供 createWindow 初始化 titleBarOverlay 等读取）
let currentEffective: EffectiveTheme = resolveEffective(loadThemeSetting())

// 上一次广播的生效主题（避免 nativeTheme 重复触发时做无效广播）
let lastApplied: EffectiveTheme | null = null

/**
 * 由 index.ts 注册的窗口获取器（避免 theme-manager 持有窗口引用形成循环依赖）
 */
let resolveWindows: (() => { mainWindow: BrowserWindow | null; dshView: WebContentsView | null }) | null = null

/**
 * 由 index.ts 注册的注入组件同步回调（切换主题后同步 DSH 页内的横幅/模态框样式）
 */
let injectedThemeSyncer: ((effective: EffectiveTheme) => void) | null = null

/**
 * 计算设置值对应的生效主题
 */
function resolveEffective(setting: ThemeSetting): EffectiveTheme {
  if (setting === 'system') {
    return nativeTheme.shouldUseDarkColors ? 'dark' : 'light'
  }
  return setting
}

export function getThemeSetting(): ThemeSetting {
  return loadThemeSetting()
}

export function getEffectiveTheme(): EffectiveTheme {
  return currentEffective
}

/**
 * 获取 titleBarOverlay 配色（createWindow 初始化时按当前生效主题取值）
 */
export function getOverlayColors(effective: EffectiveTheme = currentEffective): { color: string; symbolColor: string } {
  return OVERLAY_COLORS[effective]
}

/**
 * 注册窗口获取器与注入组件同步回调（app ready 后由 index.ts 调用）
 */
export function registerThemeHooks(
  windowsResolver: () => { mainWindow: BrowserWindow | null; dshView: WebContentsView | null },
  syncer?: (effective: EffectiveTheme) => void
): void {
  resolveWindows = windowsResolver
  if (syncer) injectedThemeSyncer = syncer
}

/**
 * 对内容视图模拟 prefers-color-scheme（DSH UI 若响应该媒体查询则跟随）。
 *
 * Electron 33 无公开 webContents.emulateMedia API（38+ 实验性引入），
 * 故优先尝试运行时 API（升级 Electron 后自动生效），不可用时回退到
 * webContents.debugger 的 CDP Emulation.setEmulatedMedia（33 稳定 API）。
 * CDP 会话对主框架生效、跨导航保留；页面导航后需重设（见 index.ts 导航点），
 * attach/detach 会短暂启用 DevTools 协议，窗口内无可见副作用。
 */
export function applyEmulateMedia(webContents: Electron.WebContents, scheme: EffectiveTheme): void {
  // 路径一：运行时公开 API（当前版本不存在，留待升级后自动启用）
  const target = webContents as unknown as {
    emulateMedia?: (options: { colorScheme?: string }) => Promise<void>
  }
  if (typeof target.emulateMedia === 'function') {
    target.emulateMedia({ colorScheme: scheme }).catch(() => {
      /* webContents 销毁竞争时静默忽略 */
    })
    return
  }

  // 路径二：CDP 回退（页面尚未提交导航时 document 不存在，CDP 会报错，跳过即可）
  if (webContents.isDestroyed() || !webContents.getURL()) return
  try {
    if (!webContents.debugger.isAttached()) {
      webContents.debugger.attach('1.3')
    }
    webContents.debugger
      .sendCommand('Emulation.setEmulatedMedia', { colorScheme: scheme })
      .catch(() => {
        /* 会话竞争/页面导航中静默忽略 */
      })
  } catch {
    /* attach 失败（如 DevTools 已被外部占用）时放弃模拟，不阻断主题切换 */
  }
}

/**
 * 应用主题：更新 overlay、广播 theme-changed、emulateMedia、同步注入组件
 *
 * 供三个入口复用：用户切换设置、系统明暗变化（跟随系统时）、启动初始化。
 */
export function applyTheme(): void {
  currentEffective = resolveEffective(loadThemeSetting())
  if (lastApplied === currentEffective && lastApplied !== null) return

  lastApplied = currentEffective
  const windows = resolveWindows?.()
  if (!windows) return
  const { mainWindow, dshView } = windows
  if (!mainWindow || mainWindow.isDestroyed()) return

  // 1. WCO 按钮区配色（最小化/最大化/关闭按钮的背景与符号色）
  try {
    mainWindow.setTitleBarOverlay(OVERLAY_COLORS[currentEffective])
  } catch (err) {
    console.warn(`[DSH] setTitleBarOverlay 失败: ${(err as Error).message}`)
  }

  // 2. 广播到标题栏页面与内容视图（页面据此切换 data-theme）
  const payload = { setting: loadThemeSetting(), effective: currentEffective }
  if (!mainWindow.webContents.isDestroyed()) {
    mainWindow.webContents.send('theme-changed', payload)
  }

  if (dshView && !dshView.webContents.isDestroyed()) {
    dshView.webContents.send('theme-changed', payload)
    // 3. 内容视图模拟 prefers-color-scheme（DSH UI 若响应该媒体查询则跟随）
    applyEmulateMedia(dshView.webContents, currentEffective)
  }
  // 4. 同步 DSH 页内已注入的横幅/模态框样式（未加载 DSH 页时内部自行跳过）
  injectedThemeSyncer?.(currentEffective)
}

/**
 * 更新外观设置：持久化后立即应用
 */
export function setThemeSetting(setting: ThemeSetting): void {
  saveThemeSetting(setting)
  applyTheme()
}

/**
 * 监听系统明暗变化（仅「跟随系统」时响应；在 app ready 后调用一次）
 */
export function registerNativeThemeListener(): void {
  nativeTheme.on('updated', () => {
    if (loadThemeSetting() !== 'system') return
    applyTheme()
  })
}
