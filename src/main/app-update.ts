import { app, net } from 'electron'
import { join, dirname } from 'path'
import { readdirSync, unlinkSync } from 'fs'
import { compareVersions, isValidVersion } from './dsh-version'

/**
 * 桌面应用客户端更新模块（GitHub Release 检测 + 引导手动下载）
 *
 * 自 1.0.3 起不再自动下载/安装客户端安装包：
 * - 原 electron-updater（GitHub 主源）与 Gitee 回退源下载链路均已移除；
 * - 本模块通过 GitHub releases/latest API 检测是否有新版本；
 * - 检测到新版本时由主进程引导用户打开 GitHub Release 页面手动下载安装；
 * - 启动时清理历史版本遗留在安装目录下的旧安装包。
 */

// GitHub 仓库信息（新版本检测与 Release 页面跳转的唯一来源）
const GITHUB_OWNER = 'ycowner'
const GITHUB_REPO = 'deepseek-harness-desktop'

// GitHub latest release API（返回最新 release 的 JSON）
const GITHUB_LATEST_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`

// GitHub Release 页面地址（引导用户手动下载安装包）
const GITHUB_RELEASES_URL = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases`

// API 请求头
const REQUEST_HEADERS = {
  'User-Agent': 'DSH-Desktop-Updater/1.0.0',
  'Accept': 'application/vnd.github+json'
}

/**
 * GitHub 最新版本信息
 */
export interface GitHubReleaseInfo {
  version: string
  /** Release 页面地址（浏览器打开用） */
  releaseUrl: string
}

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
 * 每个版本永久残留约 146MB。已改为引导手动下载后，启动时一次性清理。
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
  const timer = setTimeout(() => controller.abort(), 30_000)
  try {
    const res = await net.fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`请求失败 (状态码 ${res.status})`)
    }
    return await res.text()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error('请求超时（30秒）')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 从 GitHub releases/latest API 获取最新版本信息
 *
 * - 解析 tag_name，去掉前缀 'v' 并校验版本号格式
 * - 白名单校验 html_url 必须指向 https://github.com/（防异常响应注入非 GitHub 地址），
 *   校验失败时回退到按 tag 拼接的页面地址
 *
 * @throws 版本号格式非法或响应异常时抛异常
 */
export async function fetchGitHubLatest(): Promise<GitHubReleaseInfo> {
  const text = await fetchText(GITHUB_LATEST_API)
  const release = JSON.parse(text) as Record<string, unknown>

  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!tag) {
    throw new Error('最新发布缺少 tag_name')
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  if (!isValidVersion(version)) {
    throw new Error(`发布版本号格式非法: ${version}`)
  }

  const releaseUrl = typeof release.html_url === 'string' && release.html_url.startsWith('https://github.com/')
    ? release.html_url
    : `${GITHUB_RELEASES_URL}/tag/${encodeURIComponent(tag)}`

  return { version, releaseUrl }
}

/**
 * 检查 GitHub 是否有可用更新
 *
 * 比较本地版本与 GitHub 最新版本号；当前不落后时返回 null；
 * 网络失败时返回 null（仅记录日志，不打断用户操作）。
 */
export async function checkForGitHubAppUpdate(): Promise<GitHubReleaseInfo | null> {
  const currentVersion = getInstalledAppVersion()
  let latest: GitHubReleaseInfo
  try {
    latest = await fetchGitHubLatest()
  } catch (err) {
    console.error(`[DSH] GitHub 客户端版本检查失败: ${(err as Error).message}`)
    return null
  }
  if (compareVersions(currentVersion, latest.version) >= 0) return null
  return latest
}
