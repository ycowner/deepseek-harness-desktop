import { app } from 'electron'
import { autoUpdater } from 'electron-updater'
import type { Logger, ProgressInfo, UpdateDownloadedEvent, UpdateInfo } from 'electron-updater'
import { CancellationToken } from 'builder-util-runtime'
import { getInstalledAppVersion, UPDATE_FEED_URL } from './app-update'
import { diag } from './update-diag'

/**
 * 客户端自动更新（下载 + 安装）模块
 *
 * 封装 electron-updater 单例，把它的内部事件收敛成一份可订阅的 UI 状态快照，
 * 供 index.ts 渲染更新横幅。分工：
 * - app-update.ts：元数据检查（有没有新版本、版本号是多少），不碰 electron-updater；
 * - 本模块：真正的下载与安装。
 *
 * 三条与交互策略直接相关的约定，改动前务必确认：
 * 1. autoDownload = false —— **刻意关掉 electron-updater 自带的「一发现就自动下」**。
 *    它的触发时机是 checkForUpdates() 成功那一刻，而我们的检测走 app-update.ts 拉
 *    latest.yml（有完整的「网络失败/清单非法」错误处理与三态返回），两条链路要各走一次
 *    才能对齐。改为：app-update.ts 判定确有新版本后，由 index.ts 调本模块的
 *    downloadAppUpdate() 手动启动下载，等价于「检测到就自动下」但只有一条链路。
 * 2. autoInstallOnAppQuit = false —— electron-updater v6 该字段默认为 **true**，
 *    且 BaseUpdater.executeDownload 在下载完成的回调里就会注册 app.on('quit') 处理器：
 *    只要保持默认 true，用户即便点了「稍后」，下次正常退出时也会被静默安装。
 *    置 false 才能让「立即重启」/「下次启动时安装」完全由用户显式选择。
 *    （副作用：BaseUpdater.addQuitHandler 因此不会注册，本模块的「下次启动时安装」
 *     改由 index.ts 的退出流程显式调用 quitAndInstall 完成，不依赖这层内部机制。）
 * 3. 产物未签名、未设 win.publisherName，electron-updater v6 的 verifySignature 走
 *    fail-open 分支（只校验 latest.yml 里的 sha512，不校验 Authenticode 签名）。
 *    electron-builder 升级到 v28 后该分支改为 fail-closed，届时必须补签名，
 *    否则下载完成后会直接报 ERR_UPDATER_INVALID_SIGNATURE 而拒绝安装。
 *    见 docs/AUTO-UPDATE-PLAN.md §2.2。
 *
 * 交互策略（自 1.0.18）：**检测到不下载，等用户点「更新」才下载**。本模块只负责
 * 下载与安装三件事——标记 available、按需下载、取消下载；「按钮长什么样、进度条
 * 画在哪」这层 UI 决策全在 index.ts（标题栏按钮 + DSH 页进度横幅）。
 *
 * 取消下载靠显式持有的 CancellationToken（见 downloadAppUpdate）。判断「被取消」
 * 一律用 cancelRequested 标志位，**不要改回 `err instanceof CancellationError`**：
 * builder-util-runtime 在本项目里同时服务两条链——运行时（electron-updater）用 9.7.0，
 * 构建工具链（electron-builder）用 9.2.10，两份是不同副本、不同类对象。本项目已把
 * package.json 依赖声明成 ^9.7.0 让运行时收敛成一份，但只要将来依赖解析再分叉，
 * instanceof 就会静默失效，把用户主动取消误判成下载失败并弹出「重试下载」。
 *
 * 重开应用不会白下第二遍：DownloadedUpdateHelper.validateDownloadedPath 会在真正
 * 下载前核对缓存目录（%LOCALAPPDATA%\<updaterCacheDirName>\pending\）里的
 * update-info.json 与安装包 sha512，命中就完全跳过下载直接派发 update-downloaded。
 * 这个缓存目录名来自 resources/app-update.yml 的 updaterCacheDirName，
 * 所以该文件必须随包产出，缺失时 getOrCreateDownloadHelper() 会直接报错。
 */

/** 更新状态机阶段 */
export type AppUpdatePhase =
  /** 尚未发现新版本 */
  | 'idle'
  /** 已有新版本，等待用户在标题栏点「更新」后才开始下载 */
  | 'available'
  /** 下载中 */
  | 'downloading'
  /** 下载完成，等待用户选择安装时机 */
  | 'downloaded'
  /** 检查或下载失败 */
  | 'error'

/** 供渲染层消费的状态快照（纯数据，序列化成 JSON 注入横幅脚本） */
export interface AppUpdateSnapshot {
  phase: AppUpdatePhase
  /** 最新版本号，未知时为 null */
  version: string | null
  /** 下载进度百分比（整数 0-100） */
  percent: number
  /** 已下载字节数 */
  transferred: number
  /** 资源总字节数，未知时为 0 */
  total: number
  /** 当前下载速率（字节/秒，未知时为 0） */
  bytesPerSecond: number
  /**
   * 最近一次「真正放行」的进度事件时间戳（Date.now()），0 表示本轮下载还没出过进度
   *
   * 必须区分「最后一次事件到达」与「最后一次事件被放行」：我方节流会把大量上游事件
   * 丢在门外（PROGRESS_MIN_INTERVAL_MS），所以只有放行时才更新。否则看门狗会把
   * 「刚刚还在动」误判成停滞。
   */
  progressAt: number
  /**
   * 下载是否已停滞（downloading 且距上次进度事件超过 STALL_THRESHOLD_MS）
   *
   * 由 index.ts 的看门狗计算后回写，本模块不自己起定时器——保持它是个纯粹的
   * 状态机 + 事件源，定时职责归调用方。
   */
  stalled: boolean
  /** 失败原因，仅 phase === 'error' 时非空 */
  error: string | null
  /** 用户是否已选择「下次启动时安装」 */
  installOnNextLaunch: boolean
}

// 下载中状态推送的节流参数：
// 250MB 的包在百兆内网下每秒可产生数次 download-progress，每次都推 IPC 并重绘横幅
// 会造成肉眼可见的抖动。规则为「推进 1 个百分点」或「距上次放行超过 2 秒」二者满足其一，
// 整包最多放行 100 次，且 100% 必定放行（progress < 100 的条件不成立）。
const PROGRESS_MIN_PERCENT_STEP = 1
const PROGRESS_MIN_INTERVAL_MS = 2000

type SnapshotListener = (snapshot: AppUpdateSnapshot) => void

let configured = false
let snapshot: AppUpdateSnapshot = {
  phase: 'idle',
  version: null,
  percent: 0,
  transferred: 0,
  total: 0,
  bytesPerSecond: 0,
  progressAt: 0,
  stalled: false,
  error: null,
  installOnNextLaunch: false
}
const listeners = new Set<SnapshotListener>()

// 检查结果缓存：downloadUpdate() 前必须先有成功的 checkForUpdates()，
// 复用同一个 promise 既满足该前置条件，也避免重复请求 latest.yml。
let checkPromise: Promise<UpdateInfo> | null = null
let lastEmittedPercent = -1
let lastEmitAt = 0
// 安装是否已被触发。electron-updater 内部对重复 quitAndInstall 的处理是把
// quitAndInstallCalled 复位并静默返回——安装器已经跑起来了，但第二次调用不会
// 再触发 app.quit()，应用就留在「装了一半也没关」的诡异状态。这里自己拦一道。
let installTriggered = false

// 进行中的下载所对应的取消句柄。electron-updater 的 downloadUpdate(token) 接受
// 外部 token 并一路透传到 electronHttpExecutor（其 createPromise 在 cancel 时
// reject CancellationError），同时 AppUpdater.doDownloadUpdate 的 catch 会先
// removeFileIfAny() 删掉半截文件再抛错——所以取消是干净的，不会留垃圾文件。
// 不显式持有 token 就只能等它自己下完，无法取消。
let activeDownloadToken: CancellationToken | null = null
// 用户是否主动点了取消。**判断「被取消」的唯一依据**，不要用 instanceof：
// builder-util-runtime 在本项目里有两份（运行时 9.7.0 / 构建工具链 9.2.10），
// 一旦依赖解析分叉，跨副本的 instanceof 恒为 false（tsc 也已在这一步报过错）。
let cancelRequested = false

/** 合并式更新快照并通知订阅者 */
function patch(changes: Partial<AppUpdateSnapshot>): void {
  snapshot = { ...snapshot, ...changes }
  for (const listener of listeners) {
    try {
      listener(snapshot)
    } catch (err) {
      // 订阅者只负责推 IPC / 重绘横幅，异常不应污染更新状态机
      console.error(`[DSH] 更新状态订阅者异常: ${(err as Error).message}`)
    }
  }
}

/** 读取当前状态快照（返回副本，防止调用方就地改写内部状态） */
export function getAppUpdateSnapshot(): AppUpdateSnapshot {
  return { ...snapshot }
}

/** 订阅状态变化，返回取消订阅函数 */
export function onAppUpdateState(listener: SnapshotListener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/**
 * electron-updater 的日志适配器（统一前缀后转发到主进程控制台）
 *
 * 同时桥接到诊断文件：这是**唯一能看到 electron-updater 内部判断**的出口，
 * 诸如「DownloadedUpdateHelper 缓存命中」「sha512 校验失败」「already in progress」
 * 都只打在这里。真机排查更新问题全靠它——生产模式下 console 不落盘。
 */
const updaterLogger: Logger = {
  info: (message?: unknown) => {
    console.log(`[DSH-updater] ${message}`)
    diag('upd-info', String(message))
  },
  warn: (message?: unknown) => {
    console.warn(`[DSH-updater] ${message}`)
    diag('upd-warn', String(message))
  },
  error: (message?: unknown) => {
    console.error(`[DSH-updater] ${message}`)
    diag('upd-err', String(message))
  }
}

/**
 * 初始化 electron-updater（幂等，仅打包环境生效）
 *
 * 必须在 app.whenReady() 之后调用。开发环境直接跳过：electron-updater 依赖
 * 打包时写入的 resources/app-update.yml（其中的 updaterCacheDirName 决定下载中转目录），
 * dev 环境下该文件不存在。
 */
export function configureAutoUpdater(): void {
  if (configured) return
  if (!app.isPackaged) return
  configured = true

  // 显式指定分发源。electron-builder 会把 electron-builder.yml 的 publish 段写进
  // resources/app-update.yml，这里再 setFeedURL 一次，是为了让「换源」只需要改
  // app-update.ts 里的 UPDATE_FEED_URL 一个字符串、不必重新打包即可切到兜底源
  // （见 docs/AUTO-UPDATE-PLAN.md §4.4）。
  autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL, channel: 'latest' })
  // 关闭 electron-updater 自带的自动下载：改由 index.ts 在判定确有新版本后显式调用
  // downloadAppUpdate()，理由见文件头注释第 1 条
  autoUpdater.autoDownload = false
  // 退出时绝不静默安装，理由见文件头注释第 2 条
  autoUpdater.autoInstallOnAppQuit = false
  // 「立即重启安装」走 quitAndInstall(false, true)，安装完成后自动拉起应用
  autoUpdater.autoRunAppAfterInstall = true
  autoUpdater.logger = updaterLogger

  autoUpdater.on('checking-for-update', () => {
    console.log('[DSH] 正在检查客户端更新...')
  })

  autoUpdater.on('update-available', (info: UpdateInfo) => {
    console.log(`[DSH] 客户端发现新版本 v${info.version}（当前 v${getInstalledAppVersion()}）`)
    diag('ev', `update-available latest=${info.version} current=${getInstalledAppVersion()}`)
  })

  autoUpdater.on('update-not-available', (info: UpdateInfo) => {
    console.log(`[DSH] 客户端已是最新版本 v${info.version}`)
    diag('ev', `update-not-available version=${info.version} current=${getInstalledAppVersion()}`)
    patch({ phase: 'idle', version: info.version, error: null })
  })

  autoUpdater.on('download-progress', (info: ProgressInfo) => {
    const percent = Math.floor(info.percent)
    const now = Date.now()
    if (percent === lastEmittedPercent) return
    if (percent - lastEmittedPercent < PROGRESS_MIN_PERCENT_STEP && percent < 100) return
    if (percent < 100 && now - lastEmitAt < PROGRESS_MIN_INTERVAL_MS) return
    lastEmittedPercent = percent
    lastEmitAt = now
    patch({
      phase: 'downloading',
      percent,
      transferred: info.transferred,
      total: info.total,
      bytesPerSecond: info.bytesPerSecond,
      // 只有真正放行时才推进时间戳：看门狗据此判断「是否还在动」，
      // 用放行时间而非事件到达时间，避免节流丢包造成的误判
      progressAt: now,
      stalled: false
    })
  })

  autoUpdater.on('update-downloaded', (info: UpdateDownloadedEvent) => {
    console.log(`[DSH] 更新包下载完成 v${info.version}: ${info.downloadedFile}`)
    diag('ev', `update-downloaded version=${info.version} file=${info.downloadedFile}`)
    lastEmittedPercent = 100
    patch({
      phase: 'downloaded',
      version: info.version,
      percent: 100,
      bytesPerSecond: 0,
      stalled: false,
      error: null,
      installOnNextLaunch: false
    })
    diag('ev', `update-downloaded 后快照 phase=${getAppUpdateSnapshot().phase}`)
  })

  autoUpdater.on('error', (err: Error) => {
    // AppUpdater 构造函数内部已注册了一个 error 监听器负责打印堆栈，这里只取消息推 UI
    console.error(`[DSH] 客户端自动更新失败: ${err.message}`)
    diag('ev', `error ${err.message} | stack=${(err.stack || '').split('\n').slice(0, 3).join(' / ')}`)
    patch({ phase: 'error', error: err.message })
  })
  diag('cfg', `configureAutoUpdater 完成 isPackaged=${app.isPackaged} current=${getInstalledAppVersion()} feed=${UPDATE_FEED_URL}`)
}

/**
 * 标记「已发现新版本」（由 app-update.ts 的元数据检查结果驱动）
 *
 * 存在的理由：横幅文案要立刻显示「v当前 → v最新」，而 electron-updater 的
 * updateInfo 要等到真正开始下载时才拿到。检查在前、文案在后，
 * 所以这里先把版本号并入快照，让状态机不必等到下载才开始变化。
 *
 * 不会把进行中的阶段改回去：downloading / downloaded 优先级更高。
 */
export function markUpdateAvailable(version: string): void {
  if (snapshot.phase === 'downloading' || snapshot.phase === 'downloaded') {
    if (snapshot.version !== version) patch({ version })
    return
  }
  patch({ phase: 'available', version, error: null, installOnNextLaunch: false })
}

/**
 * 确保已拿到可下载的更新信息（electron-updater 要求 downloadUpdate 前先 checkForUpdates）
 *
 * 同一个 promise 复用，天然挡住并发重复请求（横幅连点「重试」也只会打一次源站）。
 * 失败时把缓存置空以允许重试。
 */
function ensureUpdateInfo(): Promise<UpdateInfo> {
  if (checkPromise) return checkPromise
  checkPromise = autoUpdater
    .checkForUpdates()
    .then((result) => {
      // 开发环境（app.isPackaged === false）时 checkForUpdates 直接 resolve null
      if (result == null) {
        throw new Error('当前不是打包环境，自动更新不可用')
      }
      if (!result.isUpdateAvailable) {
        throw new Error(`分发源未提供新版本（当前 v${getInstalledAppVersion()}，源端 v${result.updateInfo.version}）`)
      }
      // 下载中不要被这里的状态覆盖回 available
      if (snapshot.phase !== 'downloading') {
        diag('check', `ensureUpdateInfo then: isUpdateAvailable=${result.isUpdateAvailable} 当时 phase=${snapshot.phase} → patch(available)`)
        patch({ phase: 'available', version: result.updateInfo.version, error: null })
      } else {
        diag('check', `ensureUpdateInfo then: 当时 phase=downloading，守卫挡下 available 回写`)
      }
      return result.updateInfo
    })
    .catch((err) => {
      checkPromise = null
      diag('check', `ensureUpdateInfo 抛错: ${err.message}`)
      throw err
    })
  return checkPromise
}

/**
 * 开始下载更新包
 *
 * 只在用户于确认框点了「下载并更新」之后才调用（不再由检测流程自动触发）。
 * 重复调用是安全的：下载中或已下载完成时直接返回。失败时状态机切到 error，
 * 用户可点按钮「重试下载」。
 *
 * 取消语义：cancelAppUpdateDownload() 会置 cancelRequested 并 cancel token，
 * 此刻 downloadUpdate 的 promise 以 CancellationError 拒绝、半截文件被
 * electron-updater 删掉。这里识别到 cancelRequested 就把状态退回 available
 * （新版本依然存在、只是用户反悔了要重新下），不当作错误，也不向上抛。
 */
export async function downloadAppUpdate(): Promise<void> {
  if (!app.isPackaged) {
    throw new Error('当前不是打包环境，自动更新不可用')
  }
  if (snapshot.phase === 'downloading' || snapshot.phase === 'downloaded') return

  diag('dl', `downloadAppUpdate 进入 version=${snapshot.version}`)
  patch({
    phase: 'downloading',
    percent: 0,
    transferred: 0,
    total: 0,
    bytesPerSecond: 0,
    // progressAt 取当前时间而不是 0：这一行 patch 一推，看门狗就认为「刚刚还在动」，
    // 给上游首个进度事件留出正常时延，不会一进 downloading 就报停滞
    progressAt: Date.now(),
    stalled: false,
    error: null
  })
  lastEmittedPercent = 0
  lastEmitAt = Date.now()
  cancelRequested = false
  const token = new CancellationToken()
  activeDownloadToken = token

  try {
    await ensureUpdateInfo()
    await autoUpdater.downloadUpdate(token)
    // 后续由 download-progress / update-downloaded 事件推进状态
  } catch (err) {
    if (cancelRequested) {
      // 用户主动取消：退回 available，等待用户想起来了再点一次「更新」。
      // 半截文件由 electron-updater 的 removeFileIfAny() 负责清理。
      console.log('[DSH] 用户取消了客户端更新包下载')
      diag('dl', 'downloadAppUpdate catch: 用户主动取消 → patch(available)')
      patch({
        phase: 'available',
        percent: 0,
        transferred: 0,
        total: 0,
        bytesPerSecond: 0,
        progressAt: 0,
        stalled: false,
        error: null
      })
      return
    }
    const message = (err as Error).message
    diag('dl', `downloadAppUpdate catch: ${message} → patch(error)`)
    patch({ phase: 'error', error: message })
    throw err
  } finally {
    activeDownloadToken = null
  }
}

/**
 * 取消进行中的更新包下载（标题栏「下载中 N%」按钮点开后选「取消下载」）
 *
 * 只置标志并 cancel token；真正的状态回退与日志在 downloadAppUpdate 的 catch 里，
 * 避免两处各改一半状态。不在下载中时是安全的空操作。
 *
 * 注意 electron-updater 自身已把 CancellationError 排除在 error 事件之外
 * （AppUpdater.js 的 errorHandler 对 CancellationError 直接 return），
 * 所以这里 cancel 不会触发 patch({ phase: 'error' })。
 */
export function cancelAppUpdateDownload(): void {
  if (snapshot.phase !== 'downloading' || !activeDownloadToken) return
  cancelRequested = true
  console.log('[DSH] 正在取消客户端更新包下载...')
  activeDownloadToken.cancel()
}

/**
 * 由看门狗回写「下载已停滞 / 已恢复」标记（index.ts 的 downloadStallWatchdog 调用）
 *
 * 只改 stalled 一个字段，不碰任何进度数据。值未变化时直接返回——看门狗每 2 秒
 * tick 一次，不去重的话整个下载期会平白产生几十次 IPC 与重投影。
 *
 * 允许在非 downloading 阶段被调用（例如取消/完成瞬间的竞态 tick），此时直接忽略，
 * 避免把「已经不在下载了」的状态又标成停滞。
 */
export function setDownloadStalled(stalled: boolean): void {
  if (snapshot.stalled === stalled) return
  if (snapshot.phase !== 'downloading') return
  patch({ stalled })
}

/** 更新包是否已下载完成、可以安装 */
export function isAppUpdateReadyToInstall(): boolean {
  return snapshot.phase === 'downloaded'
}

/** 用户是否已选择「下次启动时安装」 */
export function shouldInstallOnNextLaunch(): boolean {
  return snapshot.phase === 'downloaded' && snapshot.installOnNextLaunch
}

/**
 * 立即重启并安装（横幅「立即重启安装」/ 对话框「立即重启」）
 *
 * 非静默安装 + 安装完成后自动拉起应用。调用后主进程即将退出。
 */
export function installAppUpdateNow(): void {
  if (!isAppUpdateReadyToInstall()) {
    throw new Error('更新包尚未下载完成，无法安装')
  }
  if (installTriggered) return
  installTriggered = true
  autoUpdater.quitAndInstall(false, true)
}

/**
 * 推迟到下次启动时安装（横幅 / 对话框「下次启动时安装」）
 *
 * 只置标记，实际安装在 index.ts 的退出流程里由 quitAndInstall(true, false) 触发
 * （静默安装，不自动拉起应用）。此处不能依赖 electron-updater 自带的
 * autoInstallOnAppQuit 机制，原因见文件头注释第 2 条。
 */
export function deferInstallToNextLaunch(): void {
  if (!isAppUpdateReadyToInstall()) return
  patch({ installOnNextLaunch: true })
  console.log('[DSH] 已设置：下次启动时安装客户端更新')
}

/**
 * 静默安装已下载的更新包并退出（由退出流程调用）
 *
 * 与立即安装的差别：静默模式（/S，用户看不到安装向导）且不拉起应用——
 * 反正应用马上就要被关掉，再拉起一次只是让用户以为没装成功。
 */
export function installAppUpdateOnQuit(): void {
  if (!isAppUpdateReadyToInstall()) return
  if (installTriggered) return
  installTriggered = true
  console.log('[DSH] 正在静默安装客户端更新并退出...')
  autoUpdater.quitAndInstall(true, false)
}
