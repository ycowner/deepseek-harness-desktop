import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 客户端更新链路的诊断日志
 *
 * 为什么需要它：生产模式下 Electron 的 console.log 不落盘（Windows GUI 程序没有
 * 控制台），`console.*` 里那些「下载完成 / 自动弹窗 / 守卫拦截」的判断过程在真机上
 * 完全不可见。1.0.17-Rc 真机演练就因为看不到这些而无法定位「下载完成但不弹框」。
 *
 * 落盘位置：%APPDATA%\DSH Desktop\logs\update-diag.log（app.getPath('userData') 下）
 * 同时保留最近 MAX_LINES 行在内存，供标题栏诊断面板读取。
 *
 * 写入失败（权限/磁盘）一律静默忽略——诊断功能绝不能反过来影响更新主流程。
 */

const MAX_LINES = 800
const lines: string[] = []
let filePath: string | null = null

function targetFile(): string {
  const dir = path.join(app.getPath('userData'), 'logs')
  fs.mkdirSync(dir, { recursive: true })
  return path.join(dir, 'update-diag.log')
}

/**
 * 记录一条更新链路诊断
 *
 * @param tag 分类标签，便于 grep：cfg / check / dl / ev / phase / prompt / banner
 * @param msg 文本
 */
export function diag(tag: string, msg: string): void {
  const line = `[${new Date().toISOString()}] [${tag}] ${msg}`
  lines.push(line)
  if (lines.length > MAX_LINES) lines.shift()
  // 同时打到 console：dev 模式与 attach 终端时仍能直接看
  console.log(`[DIAG ${tag}] ${msg}`)
  try {
    if (filePath === null) filePath = targetFile()
    fs.appendFileSync(filePath, `${line}\n`, 'utf8')
  } catch {
    // 落盘失败就只留内存，绝不抛出影响主流程
    filePath = null
  }
}

/** 读取内存中的诊断行（最近优先的倒序由调用方决定） */
export function diagLines(): string[] {
  return lines.slice()
}

/** 当前诊断日志文件路径（尚未初始化时为 null） */
export function diagFilePath(): string | null {
  return filePath
}
