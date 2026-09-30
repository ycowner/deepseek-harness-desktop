import { app } from 'electron'
import fs from 'node:fs'
import path from 'node:path'

/**
 * 更新链路的诊断日志（客户端更新 + DSH 运行包更新/修复）
 *
 * 为什么需要它：生产模式下 Electron 的 console.log 不落盘（Windows GUI 程序没有
 * 控制台），`console.*` 里那些「下载完成 / 自动弹窗 / 守卫拦截 / rename 重试」的
 * 判断过程在真机上完全不可见。1.0.17-Rc 真机演练就因为看不到这些而无法定位
 * 「下载完成但不弹框」；2026-09-30 又因为 DSH 更新链路一行 diag 都没有，
 * 而无法区分「rename 源目录被占用」与「existsSync 门禁漏判」两种成因。
 *
 * 落盘位置：%APPDATA%\<userData>\logs\update-diag.log
 * （开发模式 userData 为 `dsh-web-desktop`，打包版为 `DSH Desktop`）
 * 同时保留最近 MAX_LINES 行在内存，供标题栏诊断面板读取。
 *
 * 主要标签：
 * - 客户端更新：cfg / check / dl / ev / phase / prompt / banner
 * - DSH 运行包：dsh-prep（准备）/ dsh-rename（每次 rename 尝试）/ dsh-act（激活结论）
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
 * @param tag 分类标签，便于 grep：
 *   cfg / check / dl / ev / phase / prompt / banner（客户端更新）
 *   dsh-prep / dsh-rename / dsh-act（DSH 运行包更新与修复）
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
