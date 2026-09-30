import { app, net } from 'electron'
import { join, dirname } from 'path'
import { readdirSync, unlinkSync } from 'fs'
import { compareVersions, isValidVersion } from './dsh-version'

/**
 * 桌面应用客户端更新模块（元数据检查）
 *
 * 自 1.0.17 起改走应用内一键更新，不再引导用户跳转到 GitHub Release 页面手动下载：
 * - 元数据来源为安装包分发源上的 `latest.yml`（与 electron-builder 的 publish 段同源），
 *   即 `GET {UPDATE_FEED_URL}/latest.yml`，内容由 electron-builder 构建时生成；
 * - 本模块只负责「有没有新版本 / 新版本号是多少 / 安装包直链」这三件事，
 *   实际下载与安装由 auto-updater.ts 封装 electron-updater 完成；
 * - 启动时清理历史版本遗留在安装目录下的旧安装包（1.0.0/1.0.1 时期的遗留行为）。
 *
 * 保留自实现的版本比较（compareVersions / isValidVersion）而非依赖 electron-updater 的
 * 内部判定：手动「检查更新」对话框需要能区分「已是最新」与「检查失败」两种结果，
 * 复用既有的三态结构可让 index.ts 的调用方改动最小。
 */

// 安装包分发源根地址（Cloudflare R2，经自持域名访问）。
// 必须与 electron-builder.yml 的 publish.url 保持一致，两处同源是 electron-updater
// 能否从打包产物内读到的 app-update.yml 正确指向下载源的前提。
export const UPDATE_FEED_URL = 'https://download.dsh.392700.xyz'

// 分发清单文件名（electron-builder 在打包时自动生成，固定名）
const LATEST_YML = 'latest.yml'

// 请求超时（毫秒）
const REQUEST_TIMEOUT_MS = 30_000

/**
 * 客户端更新元数据
 */
export interface AppUpdateInfo {
  /** 最新版本号（已通过 isValidVersion 校验） */
  version: string
  /** 安装包直链（浏览器可直接下载，作为自动下载失败时的人工兜底） */
  downloadUrl: string
}

/**
 * 客户端更新检查结果（三态判别联合）
 *
 * 失败必须与「无新版本」区分：调用方（手动检查对话框）需要把网络失败
 * 如实报为「检查失败」，而不是误报「已是最新版本」。
 */
export type AppUpdateCheckResult =
  | { status: 'update-available'; latest: AppUpdateInfo }
  | { status: 'up-to-date'; latest: AppUpdateInfo }
  | { status: 'error'; error: string }

/**
 * 获取当前安装的桌面应用版本号
 */
export function getInstalledAppVersion(): string {
  return app.getVersion()
}

/**
 * 获取安装目录（主程序所在目录）
 */
export function getInstallDir(): string {
  return dirname(app.getPath('exe'))
}

/**
 * 启动时清理历史遗留的安装包（仅打包环境）
 *
 * 旧版本（1.0.0/1.0.1）会把更新安装包下载到安装目录（Program Files），
 * 每个版本永久残留约 146MB。1.0.3 改为引导手动下载后仍会残留，故一直保留此清理。
 * 1.0.17 起 electron-updater 的下载中转目录在用户 AppData 下（%LOCALAPPDATA%\DSH Desktop-updater），
 * 不再往安装目录写文件，本函数仅清理上述历史包袱，勿删。
 */
export function cleanupLegacyInstallers(): void {
  if (!app.isPackaged) return
  try {
    const installDir = getInstallDir()
    for (const entry of readdirSync(installDir)) {
      if (/^DSH[- ]Desktop[- ]Setup[- ].*\.exe(\.tmp)?$/i.test(entry)) {
        try {
          unlinkSync(join(installDir, entry))
          console.log(`[DSH] 清理遗留安装包: ${entry}`)
        } catch { /* 忽略单个失败 */ }
      }
    }
  } catch { /* 目录读取失败时静默 */ }
}

/**
 * 通过 Electron net.fetch 请求文本（自动遵循系统代理、自动跟随重定向）
 */
async function fetchText(url: string): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await net.fetch(url, {
      headers: {
        'User-Agent': 'DSH-Desktop-Updater/1.0.0',
        'Accept': 'text/yaml, text/plain, */*'
      },
      signal: controller.signal
    })
    if (!res.ok) {
      throw new Error(`请求失败 (状态码 ${res.status})`)
    }
    return await res.text()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`请求超时 (${REQUEST_TIMEOUT_MS / 1000}秒)`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 去除 YAML 标量值的引号包裹（'1.0.17' / "1.0.17" → 1.0.17）
 */
function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim()
  if (trimmed.length >= 2) {
    const first = trimmed[0]
    const last = trimmed[trimmed.length - 1]
    if ((first === "'" && last === "'") || (first === '"' && last === '"')) {
      return trimmed.slice(1, -1)
    }
  }
  return trimmed
}

/**
 * 解析 latest.yml，取出顶层 version 与安装包文件名
 *
 * 不引入 YAML 依赖：latest.yml 由 electron-builder 按固定结构生成（version / files[] /
 * path / sha512 / releaseDate），顶层键一律位于行首无缩进，按行正则解析足够且无依赖成本。
 * 解析不到 version 说明响应不是合法清单（例如源站返回了 HTML 错误页）——此时必须抛错，
 * 不能当作「无新版本」，否则会静默停止更新。
 */
export function parseLatestYml(text: string): { version: string; fileName: string } {
  let version = ''
  let fileName = ''

  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/\r$/, '')
    // 顶层键：行首无空白
    const topLevel = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line)
    if (topLevel) {
      const key = topLevel[1]
      const value = unquoteYamlScalar(topLevel[2])
      if (key === 'version' && value && !version) version = value
      else if (key === 'path' && value && !fileName) fileName = value
      continue
    }
    // files[] 列表项里的 url（顶层 path 缺失时的兜底，缩进 2 或 4 空格皆可）
    if (!fileName) {
      const itemUrl = /^\s*-\s+url:\s*(.+)$/.exec(line)
      if (itemUrl) {
        const value = unquoteYamlScalar(itemUrl[1])
        if (value) fileName = value
      }
    }
  }

  if (!version) {
    throw new Error('更新清单解析失败：未找到 version 字段（源站可能未正确部署 latest.yml）')
  }
  if (!isValidVersion(version)) {
    throw new Error(`更新清单版本号格式非法: ${version}`)
  }
  if (!fileName) {
    throw new Error('更新清单解析失败：未找到安装包文件名')
  }
  return { version, fileName }
}

/**
 * 从分发源获取最新版本元数据
 *
 * @throws 网络失败、响应非 200、清单格式非法时抛异常
 */
export async function fetchLatestUpdateInfo(): Promise<AppUpdateInfo> {
  const text = await fetchText(`${UPDATE_FEED_URL}/${LATEST_YML}`)
  const { version, fileName } = parseLatestYml(text)
  return {
    version,
    // fileName 来自远端清单，拼接前做一次净化：只允许文件名本体，禁止任何路径分隔符或
    // 协议前缀，避免源站被篡改时把下载引到别处（isTrustedSender 之外的又一道防线）
    downloadUrl: `${UPDATE_FEED_URL}/${encodeURIComponent(fileName.replace(/^[a-z]+:\/\//i, '').replace(/[/\\]/g, ''))}`
  }
}

/**
 * 检查是否有可用的桌面客户端更新
 *
 * 比较本地版本与分发源清单中的最新版本号，三态返回：
 * - `update-available` / `up-to-date` 均携带 latest，供对话框直接展示最新版本号；
 * - `error` 表示请求失败（仅记录日志，不打断用户操作），调用方须如实报错，
 *   不得与「无新版本」混同。
 */
export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = getInstalledAppVersion()
  let latest: AppUpdateInfo
  try {
    latest = await fetchLatestUpdateInfo()
  } catch (err) {
    const message = (err as Error).message
    console.error(`[DSH] 客户端版本检查失败: ${message}`)
    return { status: 'error', error: message }
  }
  if (compareVersions(currentVersion, latest.version) >= 0) {
    return { status: 'up-to-date', latest }
  }
  return { status: 'update-available', latest }
}
