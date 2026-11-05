/**
 * settings.json 的唯一读写方
 *
 * 之前这个文件由 theme-store.ts 独占读写，只存一个 theme 键。现在更新偏好
 * （自动更新开关、被跳过的版本号）也要落盘，于是抽出本模块作为**唯一**写方：
 * 主题与更新偏好共用一个文件，如果各写各的，后写的会把先写的字段覆盖掉。
 *
 * 读写策略照抄 theme-store.ts 与 notice.ts 的既有做法：
 * - 读失败（文件不存在 / 损坏 / 非法 JSON）一律回退到默认值，不抛错；
 * - 写失败只记日志（磁盘满 / 权限异常），内存态已生效，不影响本次操作。
 */
import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

/**
 * 更新相关偏好
 *
 * autoUpdate 对应面板上的复选框「以后自动下载并安装更新」。**默认 false**，
 * 即默认行为与引入本功能之前完全一致（检测到新版本只点亮标题栏按钮，
 * 等用户点「更新」才下载）。
 *
 * skippedClientVersions / skippedDshVersions 是「跳过此版本」的持久化记录，
 * 客户端与 DSH 运行包各记各的（两个是独立产品，版本号空间不通用）。
 * 上限 20 条，超出丢最旧的。
 */
export interface UpdateSettings {
  /** 是否自动下载并在下次启动时安装客户端更新 */
  autoUpdate: boolean
  /** 被跳过的 DSH Desktop 客户端版本号 */
  skippedClientVersions: string[]
  /** 被跳过的 DSH 运行包版本号 */
  skippedDshVersions: string[]
}

/** 跳过记录上限：超出后丢最旧的 */
const MAX_SKIPPED = 20

export const DEFAULT_UPDATE_SETTINGS: UpdateSettings = {
  autoUpdate: false,
  skippedClientVersions: [],
  skippedDshVersions: []
}

/**
 * 设置文件路径（%APPDATA%/dsh-web-desktop/settings.json）
 *
 * app.getPath 必须在 app ready 之后调用，故延迟到函数内求值。
 */
function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 读取整个 settings 对象
 *
 * 读不出来一律返回空对象——各取用方对自己的字段都有默认值兜底，
 * 不需要在这里区分「文件不存在」与「字段缺失」。
 */
export function readSettings(): Record<string, unknown> {
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    const data = JSON.parse(raw) as unknown
    if (typeof data !== 'object' || data === null || Array.isArray(data)) return {}
    return data as Record<string, unknown>
  } catch {
    return {}
  }
}

/**
 * 合并写入 settings 对象（保留未提及的字段）
 *
 * 写入失败只记日志：内存态已生效，不该因为磁盘满就让主题切换或更新偏好
 * 整条链路失败。
 */
export function writeSettings(patch: Record<string, unknown>): void {
  const path = getSettingsPath()
  const current = readSettings()
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ ...current, ...patch }, null, 2), 'utf-8')
  } catch (err) {
    console.error(`[DSH] 保存设置失败: ${(err as Error).message}`)
  }
}

/**
 * 读取更新偏好（字段缺失或类型非法一律回退默认值）
 */
export function loadUpdateSettings(): UpdateSettings {
  const raw = readSettings().update
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...DEFAULT_UPDATE_SETTINGS }
  }
  const update = raw as Record<string, unknown>
  return {
    autoUpdate: typeof update.autoUpdate === 'boolean' ? update.autoUpdate : DEFAULT_UPDATE_SETTINGS.autoUpdate,
    skippedClientVersions: sanitizeVersionList(update.skippedClientVersions),
    skippedDshVersions: sanitizeVersionList(update.skippedDshVersions)
  }
}

/**
 * 保存更新偏好（合并写入，不影响同文件里的 theme 等其他字段）
 */
export function saveUpdateSettings(patch: Partial<UpdateSettings>): void {
  const current = loadUpdateSettings()
  writeSettings({
    update: {
      autoUpdate: patch.autoUpdate ?? current.autoUpdate,
      skippedClientVersions: patch.skippedClientVersions ?? current.skippedClientVersions,
      skippedDshVersions: patch.skippedDshVersions ?? current.skippedDshVersions
    }
  })
}

/**
 * 把某个版本号加入跳过列表
 *
 * 重复加入同一个版本是幂等的；列表超出上限时丢最旧的。
 */
export function addSkippedVersion(target: 'client' | 'dsh', version: string): void {
  if (!version) return
  const current = loadUpdateSettings()
  const list = target === 'client' ? current.skippedClientVersions : current.skippedDshVersions
  if (list.includes(version)) return
  const next = [...list, version]
  while (next.length > MAX_SKIPPED) next.shift()
  saveUpdateSettings(
    target === 'client'
      ? { skippedClientVersions: next }
      : { skippedDshVersions: next }
  )
}

/**
 * 某个版本是否已被跳过
 *
 * 跳过只对**精确版本号**生效：出现更高版本时自动恢复正常提示。
 */
export function isVersionSkipped(target: 'client' | 'dsh', version: string | null | undefined): boolean {
  if (!version) return false
  const current = loadUpdateSettings()
  const list = target === 'client' ? current.skippedClientVersions : current.skippedDshVersions
  return list.includes(version)
}

/**
 * 清洗跳过列表：只保留合法的版本号字符串，非法项丢弃
 *
 * settings.json 可能被手工篡改，读取时逐一校验。
 */
function sanitizeVersionList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const list = value.filter((v): v is string => typeof v === 'string' && v.length > 0 && v.length <= 64)
  return list.slice(-MAX_SKIPPED)
}
