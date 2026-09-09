import { spawn, execSync, type ChildProcess } from 'child_process'
import { createServer, type Server } from 'net'
import { get } from 'http'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'
import { getNodeBinaryPath, getNodeDir, checkNodeBinary } from './node-binary'
import { getDshRepairCacheDir, invalidateRepairCacheDir } from './dsh-repair'

/**
 * DSH 包未预装或已损坏的错误标识
 * 主进程通过 err.name === 'DSH_PACKAGE_MISSING' 识别此错误，触发在线修复流程
 */
export const DSH_PACKAGE_MISSING_ERROR_NAME = 'DSH_PACKAGE_MISSING'

/**
 * 查找已缓存的 DSH 包入口路径
 *
 * 检查位置（按优先级）：
 * 1. 在线修复/更新缓存目录（%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/，可写，由 dsh-repair 下载）
 *    —— 用户显式修复/更新后的版本优先于出厂预装版本，否则更新永远不生效
 * 2. 打包时预安装的独立目录（resources/dsh-bundled/，只读，不受 node_modules 排除影响）
 * 3. npx 缓存中的打包预安装位置（resources/node/.npm-cache/_npx/，只读，仅开发环境有）
 * 4. 用户运行时 npx 缓存（%LOCALAPPDATA%/DSH Desktop/npm-cache/_npx/，可写）
 *
 * @returns dsh bin 入口脚本的绝对路径，未找到则返回 null
 */
export function findCachedDshEntry(): string | null {
  // 通用：从指定目录读取 DSH 包的 bin 入口
  const resolveDshBin = (dshDir: string): string | null => {
    const pkgJsonPath = join(dshDir, 'package.json')
    if (!existsSync(pkgJsonPath)) return null
    try {
      const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
      const binField = pkg.bin
      let binPath: string | undefined
      if (typeof binField === 'string') {
        binPath = binField
      } else if (binField && typeof binField === 'object') {
        binPath = binField['dsh'] || binField['dsh-web'] || Object.values(binField)[0] as string
      }
      if (binPath && existsSync(join(dshDir, binPath))) {
        return join(dshDir, binPath)
      }
    } catch {
      // 忽略解析错误
    }
    return null
  }

/**
 * 校验 DSH 包是否依赖完整（可运行）
 *
 * 从 npm 下载解压的包（如 dsh-repair 产物）默认不含 node_modules，
 * 缺少依赖会导致启动时 ERR_MODULE_NOT_FOUND。此处通过检查 package.json
 * 是否声明了 dependencies、且对应 node_modules 目录是否存在来判断。
 *
 * @param dshDir DSH 包目录
 * @returns 依赖完整返回 true；无声明依赖或依赖已安装返回 true
 */
function isPkgDepsComplete(dshDir: string): boolean {
  const pkgJsonPath = join(dshDir, 'package.json')
  if (!existsSync(pkgJsonPath)) return true
  try {
    const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'))
    const deps = pkg.dependencies
    // 无 dependencies 声明则无需校验
    if (!deps || typeof deps !== 'object' || Object.keys(deps).length === 0) {
      return true
    }
    const nodeModulesDir = join(dshDir, 'node_modules')
    if (!existsSync(nodeModulesDir)) return false
    // 校验每个顶层依赖目录存在（捕获 node_modules 存在但复制中断的场景）
    // 依赖名可能包含 scope（如 @deepseek-ai/dsh-web-app），join 可正确处理
    for (const dep of Object.keys(deps)) {
      if (!existsSync(join(nodeModulesDir, dep))) {
        console.warn(`[DSH] 依赖缺失: ${dep} (${dshDir})`)
        return false
      }
    }
    return true
  } catch {
    // 解析失败视为完整（交给后续启动流程暴露真实错误）
    return true
  }
}

  // 1. 优先检查在线修复/更新缓存目录（由 dsh-repair 下载，用户显式更新的版本应优先于出厂预装）
  const repairCacheDir = join(getDshRepairCacheDir(), 'dsh')
  if (existsSync(repairCacheDir)) {
    const entry = resolveDshBin(repairCacheDir)
    if (entry && isPkgDepsComplete(repairCacheDir)) {
      console.log('[DSH] 在在线修复缓存目录中找到 DSH 包')
      return entry
    }
    if (entry) {
      console.warn('[DSH] 在线修复缓存 DSH 包依赖不完整，跳过并回退到内置版本')
    }
  }

  // 2. 回退到打包预安装目录（dsh-bundled，出厂版本；缓存不存在或无效时使用）
  const bundledDir = join(getNodeDir(), '..', 'dsh-bundled')
  if (existsSync(bundledDir)) {
    const entry = resolveDshBin(bundledDir)
    if (entry && isPkgDepsComplete(bundledDir)) {
      console.log('[DSH] 在打包预安装目录 (dsh-bundled) 中找到 DSH 包')
      return entry
    }
    if (entry) {
      console.warn('[DSH] 内置 dsh-bundled DSH 包依赖不完整，继续查找其他候选')
    }
  }

  // 3 & 4. 检查 npx 缓存目录（打包预安装 + 用户运行时）
  // 注意：打包后 resources/node/node_modules 被排除，npx 不再可用，此处仅作为开发环境兜底
  const npxDirs = [
    getBundledNpxCacheDir(),
    join(getNpmCacheDir(), '_npx')
  ]

  for (const npxDir of npxDirs) {
    if (!existsSync(npxDir)) continue

    try {
      const entries = readdirSync(npxDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const dshPkgPath = join(npxDir, entry.name, 'node_modules', '@deepseek-ai', 'dsh')
        if (existsSync(dshPkgPath)) {
          const found = resolveDshBin(dshPkgPath)
          if (found) {
            console.log(`[DSH] 在 ${npxDir === getBundledNpxCacheDir() ? '打包预安装 npx 缓存' : '用户缓存'} 中找到 DSH 包`)
            return found
          }
        }
      }
    } catch {
      // 忽略读取错误
    }
  }
  return null
}

/**
 * 获取一个可写的 npm 缓存目录（运行时使用）
 *
 * 打包后 resources/node/ 目录是只读的（安装在 Program Files 下），
 * 因此运行时缓存必须写到用户可写目录。
 * 优先使用 %LOCALAPPDATA%/DSH Desktop/npm-cache
 */
function getNpmCacheDir(): string {
  // 用户可写的本地应用数据目录
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const userCacheDir = join(localAppData, 'DSH Desktop', 'npm-cache')

  try {
    if (!existsSync(userCacheDir)) {
      mkdirSync(userCacheDir, { recursive: true })
    }
    return userCacheDir
  } catch {
    // 回退到临时目录
    const fallback = join(tmpdir(), 'dsh-npm-cache')
    try {
      mkdirSync(fallback, { recursive: true })
    } catch {
      /* 忽略 */
    }
    return fallback
  }
}

/**
 * 获取打包时预安装的 DSH 缓存目录（只读）
 *
 * 预安装脚本在打包前将 DSH 包下载到 resources/node/.npm-cache/_npx/
 * 打包后这个目录是只读的，但包含了首次运行所需的 DSH 包
 */
function getBundledNpxCacheDir(): string {
  return join(getNodeDir(), '.npm-cache', '_npx')
}

// DSH 默认端口
const DEFAULT_DSH_PORT = 3080
// 健康检查默认超时时间（毫秒）：首次运行 npx 需要下载包，故设置为 180 秒
const DEFAULT_HEALTH_CHECK_TIMEOUT = 180_000
// 健康检查轮询间隔
const HEALTH_CHECK_INTERVAL = 500
// 单次 HTTP 探测超时
const HTTP_PROBE_TIMEOUT = 2000
// 端口冲突时最大重试次数
const MAX_PORT_RETRIES = 20

// 用于解析 DSH 启动日志中 URL 的正则（兼容 http/https、任意主机与端口）
const DSH_URL_REGEX = /https?:\/\/[^\s/:]+:(\d{2,5})[^\s]*/i

// DSH 子进程日志环形缓冲容量（防止长跑运行内存泄漏）
const MAX_LOG_LINES = 500

/**
 * 向环形缓冲追加一行，超过上限时丢弃最旧行
 */
function pushLogLine(arr: string[], line: string): void {
  arr.push(line)
  if (arr.length > MAX_LOG_LINES) {
    arr.splice(0, arr.length - MAX_LOG_LINES)
  }
}

/**
 * DSH 进程信息
 */
export interface DshProcess {
  child: ChildProcess
  url: string         // 如 "http://127.0.0.1:3080"
  port: number        // 如 3080
  stdout: string[]    // 累积的 stdout 行
  stderr: string[]    // 累积的 stderr 行
}

// 当前运行的 DSH 进程引用（模块级单例）
let currentDshProcess: DshProcess | null = null

/**
 * 检测指定端口是否可用
 * @param port 待检测的端口
 * @returns 端口可用返回 true，否则返回 false
 */
export function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server: Server = createServer()
    server.once('error', () => resolve(false))
    server.once('listening', () => {
      server.close(() => resolve(true))
    })
    // 显式绑定 127.0.0.1（IPv4），与 DSH 实际 listen 行为一致
    // 避免默认 IPv6 (::) 测试通过但 IPv4 listen 失败的误判
    // Windows 的 IPv4/IPv6 端口排除范围是分开的
    server.listen(port, '127.0.0.1')
  })
}

/**
 * 从指定起始端口开始查找可用端口
 * @param startPort 起始端口，默认 3080
 * @param maxRetries 最大重试次数，默认 20
 * @returns 第一个可用端口号
 */
export async function findAvailablePort(
  startPort: number = DEFAULT_DSH_PORT,
  maxRetries: number = MAX_PORT_RETRIES
): Promise<number> {
  for (let i = 0; i <= maxRetries; i++) {
    const port = startPort + i
    if (await isPortAvailable(port)) {
      return port
    }
  }
  // 所有候选端口都不可用时抛错，而非返回已知不可用的起始端口
  // 否则 spawn 会必然失败且错误信息晦涩（EACCES/EADDRINUSE）
  throw new Error(
    `在端口 ${startPort}-${startPort + maxRetries} 范围内未找到可用端口，` +
    `可能被 Windows 排除端口范围占用，请运行 ` +
    `'netsh int ipv4 show excludedportrange protocol=tcp' 检查系统端口排除范围`
  )
}

/**
 * 通过 HTTP GET 探测 URL 是否能获得响应
 * 任何 HTTP 响应（包括 404）都视为服务已就绪
 * @param url 目标 URL
 * @returns 收到响应返回 true，网络错误或超时返回 false
 */
function checkUrl(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (ok: boolean): void => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const req = get(url, (res) => {
        res.resume()
        finish(res.statusCode !== undefined)
      })
      req.on('error', () => finish(false))
      req.setTimeout(HTTP_PROBE_TIMEOUT, () => {
        req.destroy()
        finish(false)
      })
    } catch {
      finish(false)
    }
  })
}

/**
 * 检测指定 URL 是否已有 DSH 服务在运行
 * @param url 目标 URL
 * @returns 有响应返回 true，否则返回 false
 */
export async function isDshRunningAt(url: string): Promise<boolean> {
  return await checkUrl(url)
}

/**
 * 等待 DSH 服务就绪
 * 每 500ms 探测一次 URL，收到任意 HTTP 响应即视为就绪
 * @param url DSH 服务 URL
 * @param timeoutMs 超时时间（毫秒），默认 180 秒
 * @returns 就绪返回 true，超时返回 false
 */
export async function waitForDshReady(
  url: string,
  timeoutMs: number = DEFAULT_HEALTH_CHECK_TIMEOUT
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await checkUrl(url)) {
      return true
    }
    await new Promise((resolve) => setTimeout(resolve, HEALTH_CHECK_INTERVAL))
  }
  return false
}

/**
 * 从一行日志中解析 DSH URL 与端口
 * @param line 日志行
 * @returns 解析到则返回 { url, port }，否则返回 null
 */
function parseDshUrl(line: string): { url: string; port: number } | null {
  const match = line.match(DSH_URL_REGEX)
  if (!match) return null
  const url = match[0]
  const port = parseInt(match[1], 10)
  if (Number.isNaN(port)) return null
  return { url, port }
}

/**
 * 启动 DSH 服务进程
 *
 * 流程：
 * 1. 检查内置 Node.js 是否存在
 * 2. 检查默认端口 3080 是否被占用
 *    - 若被占用且已有 DSH 在运行，则复用该服务（不启动新进程）
 *    - 若被占用但非 DSH，则递增查找下一个可用端口
 * 3. 使用内置 node.exe 运行 npx-cli.js 启动 DSH
 * 4. 监听 stdout/stderr，解析出 DSH 服务 URL 与端口后 resolve
 *
 * @param retryOnAbiMismatch 检测到缓存原生模块 ABI 不匹配时，是否失效缓存并
 *   一次性重试回退内置版（启动自愈）。递归重试时传 false 防止无限循环。
 * @returns DshProcess 对象
 */
export function startDsh(retryOnAbiMismatch = true): Promise<DshProcess> {
  return new Promise<DshProcess>(async (resolve, reject) => {
    // 1. 校验内置 Node.js
    if (!checkNodeBinary()) {
      reject(new Error('内置 Node.js 不存在，请先运行 `npm run download-node` 下载'))
      return
    }

    const nodeExe = getNodeBinaryPath()
    const nodeDir = getNodeDir()
    const npxCli = join(nodeDir, 'node_modules', 'npm', 'bin', 'npx-cli.js')

    // 2. 端口冲突检测与处理
    const defaultUrl = `http://127.0.0.1:${DEFAULT_DSH_PORT}`
    let desiredPort = DEFAULT_DSH_PORT

    if (!(await isPortAvailable(DEFAULT_DSH_PORT))) {
      // 端口被占用，检测是否已有 DSH 在运行
      if (await isDshRunningAt(defaultUrl)) {
        console.log(`[DSH] 检测到端口 ${DEFAULT_DSH_PORT} 已有 DSH 服务运行，复用 ${defaultUrl}`)
        // 复用已有服务：构造一个无子进程的 DshProcess 占位
        const reused: DshProcess = {
          child: null as unknown as ChildProcess,
          url: defaultUrl,
          port: DEFAULT_DSH_PORT,
          stdout: [],
          stderr: [`[复用] 已存在的 DSH 服务 ${defaultUrl}`]
        }
        currentDshProcess = reused
        resolve(reused)
        return
      }
      // 端口被其他程序占用或在 Windows 排除端口范围内，查找下一个可用端口
      // findAvailablePort 在所有候选端口都不可用时会抛错，需捕获并 reject
      try {
        desiredPort = await findAvailablePort(DEFAULT_DSH_PORT + 1)
        console.log(`[DSH] 默认端口 ${DEFAULT_DSH_PORT} 不可用，改用端口 ${desiredPort}`)
      } catch (err) {
        reject(err)
        return
      }
    }

    // 3. 启动 DSH 子进程
    // 设置独立的 npm 缓存目录，避免继承系统全局 npm 配置导致的权限问题（EPERM 等）
    const npmCacheDir = getNpmCacheDir()
    console.log(`[DSH] 使用 node.exe: ${nodeExe}`)
    console.log(`[DSH] npm 缓存目录: ${npmCacheDir}`)
    console.log(`[DSH] 期望端口: ${desiredPort}`)

    // 优先检查是否有已缓存的 DSH 包，直接运行其入口脚本，跳过 npx 开销
    // npx 每次启动都要解析包、检查版本，直接运行可节省 2-5 秒
    const cachedDshEntry = findCachedDshEntry()

    if (!cachedDshEntry) {
      // 打包后 node_modules 被排除，npx 不可用；
      // dsh-bundled 与在线修复缓存均未找到有效 DSH 包
      console.error('[DSH] 未找到 DSH 包，需要在线修复')
      const err = new Error(
        'DSH 包未预装或已损坏。请点击"在线修复"按钮重新下载 DSH 包，或重新安装应用。'
      )
      err.name = DSH_PACKAGE_MISSING_ERROR_NAME
      reject(err)
      return
    }

    console.log(`[DSH] 找到已缓存的 DSH 包，直接运行: ${cachedDshEntry}`)
    // 记录本次入口是否来自在线修复/更新缓存（ABI 不匹配时用于自愈回退到内置版）
    const launchedFromRepairCache = cachedDshEntry.startsWith(join(getDshRepairCacheDir(), 'dsh'))
    // 通过 --port 命令行参数显式传递端口（DSH README 文档支持）
    // 之前仅通过 PORT 环境变量传递，但 DSH 实际未读取该变量，仍监听默认 3080
    // DSH web 启动器（@deepseek-ai/dsh-web-app/lib/startup.js）识别的 flag：
    // --host / --port / --trusted-host / --no-open / --help
    // 关键：DSH 子进程默认在服务 ready 后会通过 `open` npm 包打开系统默认浏览器
    // （参见 dsh-web-app/lib/index.js 的 openBrowser()），这条调用链发生在
    // DSH 子进程自己 fork 的进程里，完全不走 Electron webContents，
    // 主进程现有的 setWindowOpenHandler 拦不到。
    // 加 --no-open 后 startup.js 会把 webStartup.openBrowser 设为 false，
    // 子进程就不会调 open 包，系统浏览器不会被自动打开，
    // 由桌面客户端 BrowserWindow.loadURL 加载 UI 即可。
    const spawnArgs: string[] = [cachedDshEntry, 'web', '--port', String(desiredPort), '--no-open']

    let child: ChildProcess
    try {
      child = spawn(nodeExe, spawnArgs, {
        env: {
          ...process.env,
          PATH: `${nodeDir};${process.env.PATH ?? ''}`,
          PORT: String(desiredPort),
          npm_config_cache: npmCacheDir,
          npm_config_prefix: join(npmCacheDir, 'prefix')
        },
        cwd: nodeDir,
        windowsHide: true
      })
    } catch (err) {
      reject(new Error(`启动 DSH 进程失败: ${(err as Error).message}`))
      return
    }

    const stdoutLines: string[] = []
    const stderrLines: string[] = []
    let resolved = false

    const finishOnce = (err?: Error): void => {
      if (resolved) return
      resolved = true
      if (err) reject(err)
    }

    // 处理 stdout：累积行并尝试解析 URL
    child.stdout?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      // 按行拆分并累积
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        if (line.length === 0) continue
        pushLogLine(stdoutLines, line)
        console.log(`[DSH stdout] ${line}`)

        if (resolved) continue
        const parsed = parseDshUrl(line)
        if (parsed) {
          const result: DshProcess = {
            child,
            url: parsed.url,
            port: parsed.port,
            stdout: stdoutLines,
            stderr: stderrLines
          }
          currentDshProcess = result
          resolved = true
          // 以实际解析到的端口为准
          if (parsed.port !== desiredPort) {
            console.log(`[DSH] 实际端口 ${parsed.port} 与期望 ${desiredPort} 不一致，以实际为准`)
          }
          console.log(`[DSH] 解析到服务地址: ${parsed.url} (端口 ${parsed.port})`)
          resolve(result)
        }
      }
    })

    // 处理 stderr：DSH 可能将日志输出到 stderr，也需要解析
    child.stderr?.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString()
      const lines = text.split(/\r?\n/)
      for (const line of lines) {
        if (line.length === 0) continue
        pushLogLine(stderrLines, line)
        console.error(`[DSH stderr] ${line}`)

        if (resolved) continue
        const parsed = parseDshUrl(line)
        if (parsed) {
          const result: DshProcess = {
            child,
            url: parsed.url,
            port: parsed.port,
            stdout: stdoutLines,
            stderr: stderrLines
          }
          currentDshProcess = result
          resolved = true
          console.log(`[DSH] 从 stderr 解析到服务地址: ${parsed.url} (端口 ${parsed.port})`)
          resolve(result)
        }
      }
    })

    // 监听异常退出
    child.on('error', (err) => {
      console.error(`[DSH] 进程错误: ${err.message}`)
      finishOnce(err)
    })

    child.on('exit', (code, signal) => {
      console.log(`[DSH] 进程退出 code=${code} signal=${signal}`)

      // 若进程在 URL 解析前就退出，收集 stderr 信息并快速失败
      if (!resolved) {
        // 提取 stderr 中的关键错误信息，帮助用户诊断
        const errorDetails = stderrLines.length > 0
          ? stderrLines.join('\n').slice(-500) // 取最后 500 字符避免过长
          : '无 stderr 输出'

        // ABI 不匹配：原生模块（如 fs-ext）被按其它 Node 版本编译，内置 Node 加载失败。
        // 若入口来自在线修复/更新缓存，则失效该缓存并一次性重试，回退到内置 dsh-bundled，
        // 实现启动自愈（否则会反复选中坏缓存崩溃循环）。
        const abiMismatch = /ERR_DLOPEN_FAILED|NODE_MODULE_VERSION|compiled against a different Node/i.test(errorDetails)
        if (abiMismatch && retryOnAbiMismatch && launchedFromRepairCache) {
          console.warn('[DSH] 检测到缓存原生模块 ABI 不匹配，失效缓存并回退内置版本重试')
          invalidateRepairCacheDir()
          resolved = true // 防止本次 exit 再触发 finishOnce / 重复处理
          startDsh(false).then(resolve, reject)
          return
        }

        const startErr = new Error(`DSH 进程在启动期间退出 (code=${code}, signal=${signal})。\n错误详情: ${errorDetails}`)
        // 模块缺失或 ABI 不匹配类错误视为包损坏，让错误页提供"在线修复"入口
        //（修复路径会重新跑 npm install，且已固定按内置 Node ABI 编译原生模块）
        if (/ERR_MODULE_NOT_FOUND|Cannot find module/.test(errorDetails) || abiMismatch) {
          startErr.name = DSH_PACKAGE_MISSING_ERROR_NAME
        }
        finishOnce(startErr)
      }
      // 若是当前单例进程退出，清理引用
      if (currentDshProcess?.child === child) {
        currentDshProcess = null
      }
    })

    // 进程退出事件已经能快速失败（exit 事件在进程退出时立即触发）
    // 不再需要额外的 fastFailTimer，exit 事件的 finishOnce 已经是即时响应
  })
}

/**
 * 停止 DSH 进程
 *
 * Windows 下使用 taskkill /f /t 终止整个进程树，确保 npx 派生的子进程也被清理
 * @param dshProcess 可选，未传则使用模块级单例
 */
export async function stopDsh(dshProcess?: DshProcess): Promise<void> {
  const target = dshProcess ?? currentDshProcess
  if (!target) {
    console.log('[DSH] 无运行中的 DSH 进程，无需停止')
    return
  }

  // 复用场景下 child 为空，无需终止
  if (!target.child || target.child.pid === undefined) {
    console.log('[DSH] 当前为复用服务，无子进程需要终止')
    if (currentDshProcess === target) {
      currentDshProcess = null
    }
    return
  }

  const pid = target.child.pid
  console.log(`[DSH] 正在终止进程树，PID=${pid}`)

  // 先尝试常规 kill
  try {
    target.child.kill()
  } catch (err) {
    console.warn(`[DSH] kill() 失败: ${(err as Error).message}`)
  }

  // Windows 下使用 taskkill 强制终止整个进程树
  if (process.platform === 'win32') {
    try {
      execSync(`taskkill /pid ${pid} /f /t`, { stdio: 'ignore' })
      console.log(`[DSH] 已通过 taskkill 终止进程树 PID=${pid}`)
    } catch (err) {
      // 进程可能已退出，忽略错误
      console.warn(`[DSH] taskkill 失败（进程可能已退出）: ${(err as Error).message}`)
    }
  } else {
    // 非 Windows：发送 SIGTERM 后再 SIGKILL
    try {
      target.child.kill('SIGTERM')
    } catch {
      /* 忽略 */
    }
  }

  if (currentDshProcess === target) {
    currentDshProcess = null
  }
}

/**
 * 重启 DSH 进程
 * @returns 新的 DshProcess
 */
export async function restartDsh(): Promise<DshProcess> {
  console.log('[DSH] 正在重启 DSH 服务...')
  await stopDsh()
  return await startDsh()
}

/**
 * 查询当前是否有 DSH 进程在运行
 * @returns 有运行返回 true，否则 false
 */
export function isDshRunning(): boolean {
  return currentDshProcess !== null && !currentDshProcess.child?.killed
}

/**
 * 获取当前运行的 DSH 进程
 * @returns DshProcess 或 null
 */
export function getCurrentDshProcess(): DshProcess | null {
  return currentDshProcess
}
