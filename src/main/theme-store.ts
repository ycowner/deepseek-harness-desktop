/**
 * 外观设置：浅色 / 深色 / 跟随系统
 *
 * 本模块是外观设置的**对外 API**，实际的文件读写委托给 settings-store.ts——
 * settings.json 现在还存着更新偏好（自动更新开关、跳过的版本号），
 * 必须只有一个写方，否则后写的会把先写的字段覆盖掉。
 */
import { readSettings, writeSettings } from './settings-store'

/**
 * 外观设置取值：浅色 / 深色 / 跟随系统
 */
export type ThemeSetting = 'light' | 'dark' | 'system'

// 合法取值白名单（settings.json 可能被手动篡改，读取时逐一校验）
const VALID_SETTINGS: ThemeSetting[] = ['light', 'dark', 'system']

/**
 * 默认设置：跟随系统（无持久化文件或文件损坏时回退）
 */
export const DEFAULT_THEME_SETTING: ThemeSetting = 'system'

/**
 * 读取外观设置（损坏/缺失/非法值一律回退默认「跟随系统」）
 */
export function loadThemeSetting(): ThemeSetting {
  const theme = readSettings().theme
  if (typeof theme === 'string' && VALID_SETTINGS.includes(theme as ThemeSetting)) {
    return theme as ThemeSetting
  }
  return DEFAULT_THEME_SETTING
}

/**
 * 写入外观设置（与未来其他设置项合并保存，不覆盖已有字段）
 */
export function saveThemeSetting(setting: ThemeSetting): void {
  writeSettings({ theme: setting })
}
