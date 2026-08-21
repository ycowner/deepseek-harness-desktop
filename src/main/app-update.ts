import { app } from 'electron'
import { get } from 'https'
import { join, dirname } from 'path'
import { createWriteStream } from 'fs'
import { compareVersions } from './dsh-version'

/**
 * 桌面应用自身版本检测与下载模块
 *
 * 提供：
 * - 读取当前安装的桌面应用版本号（app.getVersion）
 * - 从 GitHub / Gitee 获取最新发布版本（Gitee 作为 GitHub 不可用时的回退源）
 * - 下载新版本安装包到安装目录（安装包与主程序同级，便于直接运行安装向导）
 */

// GitHub 仓库信息
const GITHUB_OWNER = 'ycowner'
const GITHUB_REPO = 'deepseek-harness-desktop'

// Gitee 仓库信息
const GITEE_OWNER = 'yuchao668'
const GITEE_REPO = 'deepseek-harness-desktop'

// 最新版本 API
const GITHUB_LATEST_API = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`
const GITEE_LATEST_API = `https://gitee.com/api/v5/repos/${GITEE_OWNER}/${GITEE_REPO}/releases/latest`

// 下载 URL 模板
const GITHUB_DOWNLOAD_URL_TEMPLATE = `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}/releases/download/{tag}/{asset}`
const GITEE_DOWNLOAD_URL_TEMPLATE = `https://gitee.com/${GITEE_OWNER}/${GITEE_REPO}/releases/download/{tag}/{asset}`

// 安装包命名模板（连字符格式，避免上传平台对空格的处理导致匹配失败）
const INSTALLER_NAME_TEMPLATE = 'DSH-Desktop-Setup-{version}.exe'

// API 请求头（GitHub API 强制要求 User-Agent，缺失会返回 403 Forbidden）
const REQUEST_HEADERS = {
  'User-Agent': 'DSH-Desktop-Updater/1.0.0',
  'Accept': 'application/json'
}

/**
 * 桌面应用更新检查结果
 */
export interface AppUpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  assetName: string
  downloadUrl: string
  source: 'github' | 'gitee'
  error?: string
}

/**
 * 某个发布源解析出的最新版本信息
 */
interface ReleaseInfo {
  version: string
  assetName: string
  downloadUrl: string
}

/**
 * 获取当前安装的桌面应用版本号
 * @returns 版本号字符串（如 "1.0.0"）
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
 * 获取指定版本安装包的本地路径
 * @param version 版本号（如 "1.0.0"）
 */
export function getDownloadedAppPath(version: string): string {
  return join(getInstallDir(), `DSH-Desktop-Setup-${version}.exe`)
}

/**
 * 从发布源 API 获取最新版本信息
 *
 * 请求 releases/latest API，解析 JSON：
 * - 取 tag_name 并去掉前缀 'v' 得到版本号
 * - 从 assets[] 中查找 name 形如 "DSH Desktop Setup {version}.exe" 的安装包资源
 * - downloadUrl 优先取该 asset 的 browser_download_url，缺失时用下载 URL 模板拼接
 *
 * @param apiUrl 发布源 latest API 地址
 * @param downloadUrlTemplate 下载 URL 模板
 * @returns 最新版本信息；无匹配安装包或请求失败时抛异常
 */
function fetchLatestReleaseInfo(apiUrl: string, downloadUrlTemplate: string): Promise<ReleaseInfo> {
  return new Promise((resolve, reject) => {
    const req = get(apiUrl, { headers: REQUEST_HEADERS }, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location, { headers: REQUEST_HEADERS }, (r2) => {
          if (r2.statusCode !== 200) {
            reject(new Error(`获取最新版本失败 (重定向后状态码 ${r2.statusCode})`))
            return
          }
          let data = ''
          r2.on('data', (chunk: Buffer) => (data += chunk.toString()))
          r2.on('end', () => {
            try {
              resolve(parseReleaseInfo(JSON.parse(data), downloadUrlTemplate))
            } catch (e) {
              reject(new Error(`解析最新版本响应失败: ${(e as Error).message}`))
            }
          })
        }).on('error', reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`获取最新版本失败 (状态码 ${res.statusCode})`))
        return
      }
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk.toString()))
      res.on('end', () => {
        try {
          resolve(parseReleaseInfo(JSON.parse(data), downloadUrlTemplate))
        } catch (e) {
          reject(new Error(`解析最新版本响应失败: ${(e as Error).message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => {
      req.destroy()
      reject(new Error('获取最新版本超时（30秒）'))
    })
  })
}

/**
 * 从发布信息 JSON 中解析版本号、安装包资源名与下载地址
 *
 * @param release GitHub / Gitee releases/latest API 返回的 JSON 对象
 * @param downloadUrlTemplate 下载 URL 模板
 * @returns 最新版本信息；缺少 tag_name 或无匹配安装包时抛异常
 */
function parseReleaseInfo(release: Record<string, unknown>, downloadUrlTemplate: string): ReleaseInfo {
  const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
  if (!tag) {
    throw new Error('最新发布缺少 tag_name')
  }
  const version = tag.startsWith('v') ? tag.slice(1) : tag
  const targetName = INSTALLER_NAME_TEMPLATE.replace('{version}', version)
  // 宽松匹配：将资源名中的空格归一化为连字符后比较，
  // 兼容 "DSH-Desktop-Setup-1.0.1.exe" 与 "DSH Desktop Setup 1.0.1.exe" 两种命名
  const normalizedTarget = targetName.replace(/\s+/g, '-')
  const assets = Array.isArray(release.assets) ? (release.assets as Array<Record<string, unknown>>) : []
  const asset = assets.find((a) => {
    if (!a || typeof a.name !== 'string') return false
    const name = a.name
    return name === targetName || name.replace(/\s+/g, '-') === normalizedTarget
  })
  if (!asset) {
    throw new Error(`最新发布中未找到安装包资源: ${targetName}`)
  }
  const assetName = String(asset.name)
  const browserDownloadUrl = typeof asset.browser_download_url === 'string' ? asset.browser_download_url : ''
  const downloadUrl = browserDownloadUrl
    || downloadUrlTemplate.replace('{tag}', tag).replace('{asset}', assetName)
  return { version, assetName, downloadUrl }
}

/**
 * 从 GitHub 获取最新版本信息
 * @returns 最新版本信息；无匹配安装包或请求失败时抛异常
 */
export function fetchGithubLatest(): Promise<ReleaseInfo> {
  return fetchLatestReleaseInfo(GITHUB_LATEST_API, GITHUB_DOWNLOAD_URL_TEMPLATE)
}

/**
 * 从 Gitee 获取最新版本信息
 * @returns 最新版本信息；无匹配安装包或请求失败时抛异常
 */
export function fetchGiteeLatest(): Promise<ReleaseInfo> {
  return fetchLatestReleaseInfo(GITEE_LATEST_API, GITEE_DOWNLOAD_URL_TEMPLATE)
}

/**
 * 检查桌面应用是否有可用更新
 *
 * 先尝试 GitHub，失败后回退 Gitee；用 compareVersions 判定版本大小。
 * 双源均失败时返回 hasUpdate: false 并填充 error（不抛出异常）。
 *
 * @returns 桌面应用更新检查结果
 */
export async function checkForAppUpdate(): Promise<AppUpdateCheckResult> {
  const currentVersion = getInstalledAppVersion()

  let latestInfo: ReleaseInfo
  let source: 'github' | 'gitee' = 'github'
  try {
    latestInfo = await fetchGithubLatest()
  } catch (githubErr) {
    source = 'gitee'
    try {
      latestInfo = await fetchGiteeLatest()
    } catch (giteeErr) {
      const error = `${(githubErr as Error).message}; ${(giteeErr as Error).message}`
      console.error(`[DSH] 桌面应用版本检查失败: ${error}`)
      return {
        hasUpdate: false,
        currentVersion,
        latestVersion: '未知',
        assetName: '',
        downloadUrl: '',
        source: 'github',
        error
      }
    }
  }

  const hasUpdate = compareVersions(currentVersion, latestInfo.version) < 0

  return {
    hasUpdate,
    currentVersion,
    latestVersion: latestInfo.version,
    assetName: latestInfo.assetName,
    downloadUrl: latestInfo.downloadUrl,
    source
  }
}

/**
 * 下载安装包到目标路径（支持 302 重定向）
 *
 * @param downloadUrl 安装包下载地址
 * @param destPath 目标文件路径
 * @param onProgress 进度回调（已下载字节数）
 */
export function downloadAppUpdate(
  downloadUrl: string,
  destPath: string,
  onProgress?: (downloaded: number) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(downloadUrl, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadAppUpdate(res.headers.location, destPath, onProgress).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 (状态码 ${res.statusCode})`))
        return
      }
      const stream = createWriteStream(destPath)
      let downloaded = 0
      res.on('data', (chunk: Buffer) => {
        downloaded += chunk.length
        onProgress?.(downloaded)
      })
      res.pipe(stream)
      stream.on('finish', () => {
        stream.close((err) => {
          if (err) reject(new Error(`关闭文件失败: ${err.message}`))
          else resolve()
        })
      })
      stream.on('error', reject)
    })
    req.on('error', reject)
    req.setTimeout(120_000, () => {
      req.destroy()
      reject(new Error('下载超时（120秒）'))
    })
  })
}
