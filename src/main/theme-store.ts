import { app } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

/**
 * 外观设置取值：浅色 / 深色 / 跟随系统
 */
export type ThemeSetting = 'light' | 'dark' | 'system'

// 合法取值白名单（settings.json 可能被手动篡改，读取时逐一校验）
const VALID_SETTINGS: ThemeSetting[] = ['light', 'dark', 'system']

// 默认设置：跟随系统（无持久化文件或文件损坏时回退）
export const DEFAULT_THEME_SETTING: ThemeSetting = 'system'

/**
 * 设置文件路径（%APPDATA%/dsh-web-desktop/settings.json）
 *
 * 用 settings.json 而非独立 theme.json，为未来扩展其他设置项预留空间。
 * app.getPath 必须在 app ready 之后调用，故延迟到函数内求值。
 */
function getSettingsPath(): string {
  return join(app.getPath('userData'), 'settings.json')
}

/**
 * 读取外观设置（损坏/缺失/非法值一律回退默认「跟随系统」）
 */
export function loadThemeSetting(): ThemeSetting {
  try {
    const raw = readFileSync(getSettingsPath(), 'utf-8')
    const data = JSON.parse(raw) as { theme?: unknown }
    if (typeof data.theme === 'string' && VALID_SETTINGS.includes(data.theme as ThemeSetting)) {
      return data.theme as ThemeSetting
    }
    return DEFAULT_THEME_SETTING
  } catch {
    return DEFAULT_THEME_SETTING
  }
}

/**
 * 写入外观设置（与未来其他设置项合并保存，不覆盖已有字段）
 */
export function saveThemeSetting(setting: ThemeSetting): void {
  const path = getSettingsPath()
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>
    if (typeof data !== 'object' || data === null) data = {}
  } catch {
    /* 文件不存在或损坏：从空对象重建 */
  }
  data.theme = setting
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
  } catch (err) {
    // 写入失败仅记录日志（磁盘满/权限异常），内存态已生效，不影响本次切换
    console.error(`[DSH] 保存外观设置失败: ${(err as Error).message}`)
  }
}
