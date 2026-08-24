import { net } from 'electron'
import { join, dirname, resolve as resolvePath } from 'path'
import { existsSync, readFileSync } from 'fs'
import { findCachedDshEntry } from './dsh-manager'

/**
 * DSH 版本检测与更新提醒模块
 *
 * 提供：
 * - 读取已安装 DSH 包的版本号（复用 dsh-manager 的查找逻辑）
 * - 从 npm registry 获取最新版本号
 * - 比较本地与最新版本，判断是否有可用更新
 */

// npm registry 地址
const NPM_REGISTRY = 'https://registry.npmjs.org'
// 国内镜像（阿里云 npmmirror），优先使用，失败回退到 NPM_REGISTRY
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'
const DSH_PACKAGE = '@deepseek-ai/dsh'

// 远程请求超时（毫秒）
const REQUEST_TIMEOUT = 30_000

/**
 * 版本号白名单校验（semver core + 可选预发布标签）
 *
 * 远端版本号在进入文件路径 / URL / 注入 JS 模板前必须通过此校验，
 * 防止路径穿越与模板注入（纵深防御；git 标签命名规则是第一道防线）
 */
export function isValidVersion(v: string): boolean {
  return /^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$/.test(v)
}

/**
 * 通过 Electron net 模块请求 JSON（Chromium 网络栈，自动遵循系统代理）
 *
 * fetch 语义自动跟随重定向。仅用于远程 registry 请求；
 * loopback 健康探测仍使用 Node http（见 dsh-manager.checkUrl），
 * 避免 127.0.0.1 被系统代理规则劫持。
 */
async function fetchJson(url: string, headers?: Record<string, string>): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const res = await net.fetch(url, { headers, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`请求失败 (状态码 ${res.status})`)
    }
    return await res.json()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000}秒）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 版本检查结果
 */
export interface UpdateCheckResult {
  hasUpdate: boolean
  currentVersion: string
  latestVersion: string
  error?: string
}

/**
 * 读取已安装的 DSH 版本号
 *
 * 复用 dsh-manager.ts 中 findCachedDshEntry() 的查找逻辑定位 DSH 包入口，
 * 再从入口向上查找包含 bin 字段的 package.json，读取其 version 字段。
 *
 * @returns 版本号字符串，未找到时返回 '未知'
 */
export function getInstalledDshVersion(): string {
  const entryPath = findCachedDshEntry()
  if (!entryPath) {
    return '未知'
  }

  // 从 bin 入口路径向上查找包含 bin 字段的 package.json
  let currentDir = dirname(entryPath)

  while (true) {
    const pkgJsonPath = join(currentDir, 'package.json')
    if (existsSync(pkgJsonPath)) {
      try {
        const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
        const binField = pkg.bin
        let binPath: string | undefined
        if (typeof binField === 'string') {
          binPath = binField
        } else if (binField && typeof binField === 'object') {
          binPath = binField['dsh'] || binField['dsh-web'] || Object.values(binField)[0] as string
        }
        // 验证此 package.json 的 bin 字段确实指向我们的入口
        if (binPath && resolvePath(currentDir, binPath) === resolvePath(entryPath)) {
          return typeof pkg.version === 'string' ? pkg.version : '未知'
        }
      } catch {
        // 忽略解析错误，继续向上查找
      }
    }

    const parentDir = dirname(currentDir)
    if (parentDir === currentDir) {
      // 已到达根目录
      break
    }
    currentDir = parentDir
  }

  return '未知'
}

/**
 * 从 npm registry 获取最新版本号
 *
 * 优先使用国内镜像（npmmirror），失败回退到 npm registry（npmjs.org）。
 * 读取包的 dist-tags，取所有标签指向版本中的最大版本号。
 * 原因：@deepseek-ai/dsh 的预发布版本可能发布在 `next` 等标签而非 `latest`，
 * 仅读 `/latest` 会漏检（如 0.1.0-rc.8 发布在 next 标签时）。
 *
 * @returns 版本号字符串，如 "1.2.3"
 */
export function fetchLatestVersion(): Promise<string> {
  return fetchLatestVersionFromRegistry(NPM_REGISTRY_MIRROR)
    .catch((mirrorErr) => {
      console.warn(`[DSH] 国内镜像查询版本失败，回退到 npm registry: ${mirrorErr.message}`)
      return fetchLatestVersionFromRegistry(NPM_REGISTRY)
    })
}

/**
 * 从指定 registry 获取最新版本号（内部实现）
 *
 * @param registry registry 根地址，如 'https://registry.npmmirror.com'
 * @returns 版本号字符串
 */
function fetchLatestVersionFromRegistry(registry: string): Promise<string> {
  // 轻量 dist-tags 接口：https://registry.npmjs.org/-/package/@deepseek-ai/dsh/dist-tags
  const url = `${registry}/-/package/${encodeURIComponent(DSH_PACKAGE).replace('%40', '@')}/dist-tags`
  // 注意：npm registry 对 scoped 包路径要求 @ 不编码
  return fetchJson(url).then((data) => pickLatestFromDistTags(data as Record<string, unknown>))
}

/**
 * 获取指定版本 DSH 包的 dist.integrity（sha512，base64）
 *
 * 使用 abbreviated packument（Accept: application/vnd.npm.install-v1+json），
 * 体积远小于完整 packument；npmmirror 与 npmjs 均支持该格式。
 * 优先国内镜像，失败回退 npm registry。
 *
 * @param version 版本号，如 "1.2.3"
 * @returns integrity 字符串，形如 "sha512-<base64>"；缺失时抛异常
 */
export function fetchDistIntegrity(version: string): Promise<string> {
  return fetchDistIntegrityFromRegistry(NPM_REGISTRY_MIRROR, version)
    .catch((mirrorErr) => {
      console.warn(`[DSH] 国内镜像查询包完整性失败，回退到 npm registry: ${mirrorErr.message}`)
      return fetchDistIntegrityFromRegistry(NPM_REGISTRY, version)
    })
}

/**
 * 从指定 registry 获取指定版本的 dist.integrity（内部实现）
 */
async function fetchDistIntegrityFromRegistry(registry: string, version: string): Promise<string> {
  const url = `${registry}/${encodeURIComponent(DSH_PACKAGE).replace('%40', '@')}`
  const data = (await fetchJson(url, { Accept: 'application/vnd.npm.install-v1+json' })) as {
    versions?: Record<string, { dist?: { integrity?: string } }>
  }
  const integrity = data.versions?.[version]?.dist?.integrity
  if (!integrity) {
    throw new Error(`未找到 ${DSH_PACKAGE}@${version} 的 dist.integrity`)
  }
  return integrity
}

/**
 * 从 dist-tags 对象中取所有标签指向版本中的最大版本号
 *
 * @param distTags dist-tags 对象，如 { latest: '1.0.0', next: '1.1.0-rc.1' }
 * @returns 最大版本号；无有效版本时抛异常
 */
function pickLatestFromDistTags(distTags: Record<string, unknown>): string {
  const versions = Object.values(distTags).filter(
    (v): v is string => typeof v === 'string' && /^\d+\.\d+\.\d+/.test(v)
  )
  if (versions.length === 0) {
    throw new Error('未找到任何 dist-tag 版本')
  }
  let latest = versions[0]
  for (const v of versions) {
    if (compareVersions(latest, v) < 0) {
      latest = v
    }
  }
  return latest
}

/**
 * semver 比较函数（支持 major.minor.patch 和预发布标签）
 *
 * 规则：
 * - 先比较 major.minor.patch（数字大小）
 * - 若相等，无预发布标签的版本 > 有预发布标签的版本
 * - 若都有预发布标签，逐段比较（数字段比数值，非数字段比字符串）
 *
 * @returns v1 < v2 返回 -1，v1 > v2 返回 1，相等返回 0
 */
export function compareVersions(v1: string, v2: string): number {
  const parseVersion = (v: string): { core: number[]; prerelease: string[] } => {
    const match = v.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?/)
    if (!match) return { core: [0, 0, 0], prerelease: [] }
    const prerelease = match[4] ? match[4].split('.') : []
    return {
      core: [parseInt(match[1], 10), parseInt(match[2], 10), parseInt(match[3], 10)],
      prerelease
    }
  }

  const p1 = parseVersion(v1)
  const p2 = parseVersion(v2)

  // 1. 比较 major.minor.patch
  for (let i = 0; i < 3; i++) {
    if (p1.core[i] < p2.core[i]) return -1
    if (p1.core[i] > p2.core[i]) return 1
  }

  // 2. 无预发布标签的版本 > 有预发布标签的版本
  if (p1.prerelease.length === 0 && p2.prerelease.length > 0) return 1
  if (p1.prerelease.length > 0 && p2.prerelease.length === 0) return -1

  // 3. 都有预发布标签，逐段比较
  for (let i = 0; i < Math.max(p1.prerelease.length, p2.prerelease.length); i++) {
    const a = p1.prerelease[i]
    const b = p2.prerelease[i]
    // 较短的预发布标签排在前面（较小）
    if (a === undefined) return -1
    if (b === undefined) return 1
    // 数字段比数值，非数字段比字符串
    const aNum = parseInt(a, 10)
    const bNum = parseInt(b, 10)
    const aIsNum = !isNaN(aNum)
    const bIsNum = !isNaN(bNum)
    if (aIsNum !== bIsNum) {
      // 类型不同时，数字段 < 字符串段（semver 规范）
      return isNaN(aNum) ? 1 : -1
    }
    if (!isNaN(aNum)) {
      if (aNum < bNum) return -1
      if (aNum > bNum) return 1
    } else {
      if (a < b) return -1
      if (a > b) return 1
    }
  }
  return 0
}

/**
 * 检查 DSH 是否有可用更新
 *
 * 比较本地已安装版本与 npm registry 最新版本，
 * 网络失败时在 error 字段中填充错误信息（不抛出异常）。
 *
 * @returns 版本检查结果对象
 */
export async function checkForUpdate(): Promise<UpdateCheckResult> {
  const currentVersion = getInstalledDshVersion()

  let latestVersion: string
  try {
    latestVersion = await fetchLatestVersion()
  } catch (err) {
    return {
      hasUpdate: false,
      currentVersion,
      latestVersion: '未知',
      error: (err as Error).message
    }
  }

  const hasUpdate = compareVersions(currentVersion, latestVersion) < 0

  return {
    hasUpdate,
    currentVersion,
    latestVersion
  }
}
