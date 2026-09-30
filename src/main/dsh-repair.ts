import { net } from 'electron'
import { existsSync, mkdirSync, rmSync, renameSync, createWriteStream, createReadStream, writeFileSync, readdirSync, copyFileSync, unlinkSync, type Dirent } from 'fs'
import { promises as fsp } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { spawn, execFileSync } from 'child_process'
import { getNodeBinaryPath, getNodeDir, getBundledNodeVersion } from './node-binary'
import { fetchLatestVersion, fetchDistIntegrity } from './dsh-version'
import { diag } from './update-diag'

/**
 * DSH 在线修复 / 更新模块
 *
 * 当 dsh-bundled 损坏或缺失、或用户触发 DSH 更新时，下载 DSH 包 tgz，
 * 通过内置 npm 安装到临时目录，再复制到用户可写的缓存目录。
 *
 * 修复后的 DSH 包存放在：%LOCALAPPDATA%/DSH Desktop/dsh-cache/dsh/
 * 该目录会被 dsh-manager.ts 中的 findCachedDshEntry 优先识别。
 *
 * 两阶段设计（关键约束，见 AGENTS.md §12）：
 * 1. prepareDshPackage：下载 + 完整性校验 + **npm 直接装进 dsh-cache/dsh.new.<ts>/**
 *    + 把 DSH 包本体上提到目录根（20 个文件）。全程不触碰现有 dsh/ 缓存目录，
 *    因此更新期间旧 DSH 进程可以继续运行；
 * 2. activateDshPackage：两次同卷 rename（dsh → dsh.old.<ts>，dsh.new.<ts> → dsh），
 *    不做任何删除，不可用窗口仅毫秒级。调用方负责在 activate 之前停止 DSH 进程。
 *    旧目录的实际删除推迟到 DSH 启动就绪之后，由 discardRetiredDshDir 异步完成。
 *
 * 为什么要这样拆（实测数据见 AGENTS.md §12）：依赖树 26,617 个文件 / 453MB，
 * 而真正需要搬动的 DSH 包本体只有 20 个文件 / 0.07MB。任何"把大树同步拷/删
 * 一遍"的做法都会把 Electron 主线程堵住十几秒，Windows 随即把窗口判为
 * 「未响应」（约 5 秒无消息即触发）。因此这里的原则是：
 * **让产物原地就位，用 rename 换位，绝不在主线程上删大树。**
 */

// npm registry 地址
const NPM_REGISTRY = 'https://registry.npmjs.org'
// 国内镜像（阿里云 npmmirror），优先使用，失败回退到 NPM_REGISTRY
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'
const DSH_PACKAGE = '@deepseek-ai/dsh'

/**
 * 获取用户可写的修复缓存目录（与 dsh-manager.ts 中 getNpmCacheDir 同级）
 */
export function getDshRepairCacheDir(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  const dir = join(localAppData, 'DSH Desktop', 'dsh-cache')
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
  return dir
}

/** 下载空闲超时（毫秒）：有数据流动即重置计时 */
const DOWNLOAD_IDLE_TIMEOUT = 120_000

/**
 * 下载文件（Electron net.fetch：自动遵循系统代理、自动跟随重定向）
 *
 * 空闲超时 120 秒：每次收到数据块重置计时；中断/出错时删除部分文件。
 *
 * @param url 下载地址
 * @param dest 目标文件路径
 * @param onProgress 进度回调（已下载字节数）
 */
async function downloadFile(url: string, dest: string, onProgress?: (downloaded: number) => void): Promise<void> {
  const controller = new AbortController()
  let timer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT)
  const resetTimer = (): void => {
    clearTimeout(timer)
    timer = setTimeout(() => controller.abort(), DOWNLOAD_IDLE_TIMEOUT)
  }

  try {
    const res = await net.fetch(url, { signal: controller.signal })
    if (!res.ok || !res.body) {
      throw new Error(`下载失败 (状态码 ${res.status})`)
    }

    const reader = res.body.getReader()
    const stream = createWriteStream(dest)
    let downloaded = 0
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        resetTimer()
        downloaded += value.byteLength
        onProgress?.(downloaded)
        // 背压处理：写缓冲满时等待 drain，避免内存堆积
        if (!stream.write(value)) {
          await new Promise<void>((resolveDrain, rejectDrain) => {
            stream.once('drain', resolveDrain)
            stream.once('error', rejectDrain)
          })
        }
      }
      await new Promise<void>((resolveClose, rejectClose) => {
        stream.close((err) => (err ? rejectClose(new Error(`关闭文件失败: ${err.message}`)) : resolveClose()))
      })
    } catch (err) {
      stream.destroy()
      try { unlinkSync(dest) } catch { /* 忽略 */ }
      throw err
    }
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      try { unlinkSync(dest) } catch { /* 忽略 */ }
      throw new Error('下载超时（120秒无数据传输）')
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 校验文件 sha512 与 npm dist.integrity 是否匹配
 *
 * @param filePath 待校验文件路径
 * @param integrity npm packument 的 dist.integrity，形如 "sha512-<base64>"
 */
async function verifyFileIntegrity(filePath: string, integrity: string): Promise<void> {
  const expected = integrity.replace(/^sha512-/, '')
  const actual = await new Promise<string>((resolveHash, rejectHash) => {
    const hash = createHash('sha512')
    const rs = createReadStream(filePath)
    rs.on('data', (chunk) => hash.update(chunk))
    rs.on('end', () => resolveHash(hash.digest('base64')))
    rs.on('error', rejectHash)
  })
  if (actual !== expected) {
    throw new Error('DSH 包完整性校验失败（sha512 不匹配），安装包可能被篡改或下载损坏')
  }
}

/** npm install 超时时间（毫秒） */
const NPM_INSTALL_TIMEOUT = 300_000

/**
 * 在空目录跑 `npm install <tgz>`，让 npm 把 tgz 当作要安装的包
 *
 * 不能在 DSH 包目录里直接跑 `npm install`：cwd 的 package.json name 是
 * `@deepseek-ai/dsh`，npm 的 reify 阶段会把所有 `@deepseek-ai/dsh-*` 依赖当作
 * self-scope 跳过（node_modules/@deepseek-ai/dsh-* 一个都不会装），同时清理 cwd
 * 中 `files` 字段之外的源文件（lib/、config/、LICENSE 都会被删，只剩 README 和 package.json）。
 *
 * 改为在空目录跑 `npm install <tgz>`：npm 会把 tgz 解压到
 * `installDir/node_modules/@deepseek-ai/dsh/`（完整保留 lib/），并安装其 dependencies
 * 到 `installDir/node_modules/`。这正是 `preinstall-dsh.js` 走 npx 流程的成功路径。
 *
 * 优先使用国内镜像（npmmirror）加速依赖下载，失败回退到 npm registry（npmjs.org）。
 * 注意：不能传 --prefer-offline。该标志下 npm 仅在缓存 miss 时才联网，已存在的
 * packument 缓存条目即使过期也原样复用（不重验证），会解析不到上游新发布的版本
 * 并报 ETARGET，且重试无法自愈（实测踩坑：2026-09 更新 0.1.2-rc.1 失败即因此）。
 * 元数据走 npm 默认缓存策略（过期条件重验证），提速靠 tarball 内容寻址缓存
 * （实测 522 个包全量安装仅 24 秒，无需复用旧 node_modules）。
 *
 * @param tgzPath DSH 包 tgz 文件路径
 * @param installDir 空的安装目录（npm install 的 cwd，不能是 DSH 包目录本身）
 * @param onProgress 进度回调（文字描述）
 */
function installDshFromTarball(tgzPath: string, installDir: string, onProgress?: (msg: string) => void): Promise<void> {
  return installDshFromTarballWithRegistry(tgzPath, installDir, NPM_REGISTRY_MIRROR, onProgress)
    .catch((mirrorErr) => {
      console.warn(`[DSH Repair] 国内镜像安装失败，回退到 npm registry: ${mirrorErr.message}`)
      onProgress?.('国内镜像安装失败，回退到 npm registry 重试...')
      return installDshFromTarballWithRegistry(tgzPath, installDir, NPM_REGISTRY, onProgress)
    })
}

/**
 * 在空目录跑 `npm install <tgz>`，使用指定 registry（内部实现）
 *
 * 关键：spawn 用的必须是内置 node.exe，且 env 里把内置 node 目录前置到 PATH——
 * node-gyp 按「运行它的那个 Node」编译（实测 node-gyp 12 直接忽略 --target），
 * 所以 PATH 前置是 ABI 对齐的唯一机制。缺了它，npm 跑 fs-ext 等 nan 源码编译型
 * 模块的生命周期脚本时会命中环境 PATH 上的系统 Node，编出的 .node 与运行时内置
 * Node 的 ABI 不一致，DSH 启动即 ERR_DLOPEN_FAILED 崩溃（历史实例：系统 Node
 * v24/ABI137 编译 vs 当时的内置 Node v22/ABI127 运行）。
 *
 * @param tgzPath DSH 包 tgz 文件路径
 * @param installDir 空的安装目录（npm install 的 cwd，不能是 DSH 包目录本身）
 * @param registry npm registry 根地址
 * @param onProgress 进度回调（文字描述）
 */
function installDshFromTarballWithRegistry(
  tgzPath: string,
  installDir: string,
  registry: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCli = join(getNodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) {
      reject(new Error('内置 npm 不可用，无法安装 DSH 包'))
      return
    }

    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const npmCacheDir = join(localAppData, 'DSH Desktop', 'npm-cache')
    mkdirSync(npmCacheDir, { recursive: true })

    // 查询内置 Node 版本：作为 npm_config_target 传给 node-gyp。实测 node-gyp 12
    // 已忽略 --target（编译目标恒等于运行它的 Node），故此值主要用作诊断；
    // 真正的 ABI 对齐靠上面的 node.exe + 下面的 PATH 前置。
    const bundledNodeVersion = getBundledNodeVersion()

    // --no-save：不修改 installDir 的 package.json（installDir 本就是空的，无需记录依赖）
    // --omit=dev：DSH 的 devDependencies 是构建期工具，运行时不需要
    // --registry：指定 npm registry（国内镜像或国外源）
    // 不传 --prefer-offline：元数据过期时按 npm 默认策略条件重验证，防止陈旧
    // packument 缓存导致 ETARGET（tarball 为内容寻址缓存，命中时不重复下载）
    const child = spawn(
      getNodeBinaryPath(),
      [
        npmCli, 'install', tgzPath,
        '--omit=dev', '--no-save', '--no-audit', '--no-fund',
        '--loglevel=warn',
        '--registry=' + registry
      ],
      {
        cwd: installDir,
        windowsHide: true,
        env: {
          ...process.env,
          // 前置内置 node 目录到 PATH：npm 跑 fs-ext 等原生模块的 node-gyp 生命周期
          // 脚本时，.bin 垫片按 PATH 解析 node；若不前置会命中系统 Node，编出的 .node
          // 与运行时内置 Node 的 ABI 不一致，DSH 启动即 ERR_DLOPEN_FAILED。
          // 与 dsh-manager.startDsh / preinstall-dsh.js 的 PATH 前置保持一致。
          PATH: `${getNodeDir()};${process.env.PATH ?? ''}`,
          npm_config_cache: npmCacheDir,
          npm_config_prefix: npmCacheDir,
          // 辅助信号：显式传内置 Node 版本与架构（保留向后兼容旧版 node-gyp；
          // node-gyp 12+ 已忽略 --target，不要依赖它做 ABI 对齐）
          ...(bundledNodeVersion ? { npm_config_target: bundledNodeVersion } : {}),
          npm_config_arch: 'x64',
          // 旧版 node-gyp 编译需下载对应版本头文件，走国内镜像避免 nodejs.org 在境内不稳定
          npm_config_disturl: 'https://npmmirror.com/mirrors/node'
        }
      }
    )

    let stdout = ''
    let stderr = ''
    let lastProgressTime = 0

    child.stdout?.on('data', (chunk: Buffer) => {
      const text = chunk.toString()
      stdout += text
      const now = Date.now()
      if (now - lastProgressTime > 2000) {
        const match = text.match(/added\s+(\d+)\s+packages/)
        if (match) {
          onProgress?.(`已安装 ${match[1]} 个依赖包...`)
        } else {
          onProgress?.('正在安装 DSH 包及其依赖...')
        }
        lastProgressTime = now
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    onProgress?.('正在安装 DSH 包及其依赖...')

    const timeout = setTimeout(() => {
      // Windows 下 child.kill 杀不掉 npm 派生的子进程树，必须 taskkill /f /t
      //（与 dsh-manager.stopDsh 同一原则，见 AGENTS.md §12.1）
      if (process.platform === 'win32' && child.pid !== undefined) {
        try {
          // 使用 execFile 传参数组形式，避免 shell 元字符风险
          execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })
        } catch { /* 进程可能已退出 */ }
      } else {
        child.kill('SIGTERM')
      }
      reject(new Error('npm 安装超时（5分钟），请检查网络连接'))
    }, NPM_INSTALL_TIMEOUT)

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`npm 启动失败: ${err.message}`))
    })

    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        onProgress?.('DSH 包及其依赖安装完成')
        resolve()
      } else {
        const errMsg = stderr || stdout || '未知错误'
        const combinedMsg = errMsg.toLowerCase()
        if (combinedMsg.includes('eperm') || combinedMsg.includes('operation not permitted')) {
          reject(new Error(`npm 安装失败: 权限不足，无法写入缓存目录。请检查杀毒软件或手动删除旧缓存后重试。\n${errMsg}`))
        } else if (combinedMsg.includes('etimedout') || combinedMsg.includes('econnreset') || combinedMsg.includes('network')) {
          reject(new Error(`npm 安装失败: 网络连接异常。请检查网络后重试。\n${errMsg}`))
        } else if (combinedMsg.includes('notarget') || combinedMsg.includes('etarget')) {
          reject(new Error(`npm 安装失败: 依赖的目标版本在 registry 中不存在（上游可能尚未发布或镜像未同步），请稍后重试。\n${errMsg}`))
        } else {
          reject(new Error(`npm 安装失败 (退出码 ${code})\n${errMsg}`))
        }
      }
    })
  })
}

/**
 * 递归复制目录（同 preinstall-dsh.js 中的逻辑）
 *
 * **刻意保持同步实现，不要"顺手"换成 `fs.promises.cp`**：
 * 实测（本机，2026-09-30）在大量小文件场景下 `fsp.cp` 反而比 `cpSync` 慢约一倍
 * （6,640 文件：cpSync 4.6s vs fsp.cp 9.8s），换过去只是把瓶颈从"阻塞"换成"更慢"。
 * 本函数现在只用于把 `@deepseek-ai/dsh` 包本体上提到新目录根——实测仅 20 个文件
 * / 0.07 MB，同步成本可忽略。真正的大头（26,617 文件的 node_modules）已由
 * prepareDshPackage 改为「npm 直接装到目标目录、原地就位」而不再需要拷贝。
 * 详见 AGENTS.md §12。
 */
function copyDir(src: string, dest: string): void {
  if (!existsSync(src)) return
  mkdirSync(dest, { recursive: true })
  const entries = readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = join(src, entry.name)
    const destPath = join(dest, entry.name)
    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 校验本地源码编译的原生模块能被内置 Node 加载（防 ABI 不匹配）
 *
 * 扫描 installDir/node_modules 下所有 build/Release/*.node（node-gyp 源码编译的
 * 约定产物路径；N-API 预编译模块走 prebuilds/ 或平台子包，不在此列），逐个用内置
 * node.exe require 加载。若某 .node 是按其它 Node ABI 编译的（如系统 Node），加载
 * 会报 NODE_MODULE_VERSION 不匹配 / ERR_DLOPEN_FAILED——此时让 prepare 失败，绝不
 * 把启动即崩的坏缓存激活上线（实测踩坑：fs-ext 被编成系统 Node v24/ABI137，
 * 而当时内置 Node 是 v22/ABI127）。
 *
 * @param installDir npm install 的根目录（其 node_modules 含全部依赖）
 */
function assertNativeModulesLoadable(installDir: string): void {
  const nodeModulesDir = join(installDir, 'node_modules')
  if (!existsSync(nodeModulesDir)) return

  const compiledBinaries: string[] = []
  // 收集某个包目录下 build/Release/*.node
  const collectFromBuildRelease = (pkgDir: string): void => {
    const releaseDir = join(pkgDir, 'build', 'Release')
    if (!existsSync(releaseDir)) return
    try {
      for (const f of readdirSync(releaseDir)) {
        if (f.endsWith('.node')) compiledBinaries.push(join(releaseDir, f))
      }
    } catch { /* 忽略单个目录读取失败 */ }
  }
  // 遍历 node_modules：@scope 目录下探，具体包目录查 build/Release 及其嵌套 node_modules
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return // 防御性深度上限
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const full = join(dir, entry.name)
      if (entry.name.startsWith('@')) {
        walk(full, depth + 1)
      } else {
        collectFromBuildRelease(full)
        const nested = join(full, 'node_modules')
        if (existsSync(nested)) walk(nested, depth + 1)
      }
    }
  }
  walk(nodeModulesDir, 0)

  for (const bin of compiledBinaries) {
    try {
      execFileSync(getNodeBinaryPath(), ['-e', 'require(process.argv[1])', bin], {
        stdio: 'pipe',
        encoding: 'utf8',
        timeout: 30_000
      })
    } catch (err) {
      const e = err as { stderr?: string; message?: string }
      const msg = String(e.stderr || e.message || '')
      if (/NODE_MODULE_VERSION|ERR_DLOPEN_FAILED|compiled against a different Node/i.test(msg)) {
        throw new Error(
          `原生模块 ABI 不匹配，无法在内置 Node 下加载: ${bin}\n${msg.slice(0, 500)}\n` +
          `通常是编译时命中了系统 Node 而非内置 Node，请重试更新。`
        )
      }
      // 非 ABI 类加载错误（如缺运行时依赖）不在此拦截，交给启动流程暴露真实原因
      console.warn(`[DSH Repair] 原生模块加载校验跳过（非 ABI 错误）: ${bin}: ${msg.slice(0, 200)}`)
    }
  }
}

/**
 * 清扫缓存目录中残留的 staging / tmp / abi-broken / old 目录
 * （上次更新、修复中断，或启动自愈失效坏缓存的产物）
 *
 * **异步实现**：这里删的可能是一棵 2.6 万文件 / 453MB 的目录（`dsh.old.*`），
 * 同步 `rmSync` 会把主线程堵住十几秒，Windows 随即把窗口判为「未响应」。
 * `fsp.rm` 走 libuv 线程池，await 期间主线程照常处理消息。
 *
 * 前缀覆盖：`dsh.new.`（prepare 中断的半成品）、`dsh.old.`（已换下但没删掉的
 * 旧版本）、`dsh.staging.`（历史命名）、`dsh.tmp`、`dsh.abi-broken.`。
 *
 * 调用时机固定在 prepare 开头且持有 isUpdating 互斥锁的位置，不存在与另一条
 * 更新并发互踩的可能（见 AGENTS.md §12 关于互斥锁的约束）。
 */
async function cleanupStaleStagingDirs(): Promise<void> {
  const cacheDir = getDshRepairCacheDir()
  const STALE_PREFIXES = ['dsh.new.', 'dsh.old.', 'dsh.staging.', 'dsh.abi-broken.']
  try {
    const entries = await fsp.readdir(cacheDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const isStale = STALE_PREFIXES.some((p) => entry.name.startsWith(p)) || entry.name === 'dsh.tmp'
      if (!isStale) continue
      try {
        await fsp.rm(join(cacheDir, entry.name), { recursive: true, force: true })
        console.log(`[DSH Repair] 清理残留目录: ${entry.name}`)
      } catch (err) {
        // 单个目录清理失败（如被杀毒软件占用）不影响其余残留的清扫
        console.warn(`[DSH Repair] 清理残留目录失败 ${entry.name}: ${(err as Error).message}`)
      }
    }
  } catch (err) {
    console.warn(`[DSH Repair] 读取缓存目录失败，跳过残留清扫: ${(err as Error).message}`)
  }
}

/**
 * prepareDshPackage 的产物
 */
export interface PreparedDshPackage {
  /** 完整构建并校验过的待激活目录（dsh-cache/dsh.new.<ts>/，尚未激活） */
  preparedDir: string
  /** 本次准备的 DSH 版本号 */
  version: string
}

/**
 * 阶段一：准备新版 DSH 包（下载 → 完整性校验 → npm 安装 → 包体上提）
 *
 * 流程：
 * 1. 获取最新版本号（优先国内镜像 npmmirror，失败回退 npm registry）
 * 2. 下载 tgz 到临时目录（双源）
 * 3. 用 npm dist.integrity（sha512）校验 tgz 完整性
 * 4. **npm 直接装进 `dsh-cache/dsh.new.<ts>/`**（同卷、用户可写），产出
 *    `dsh.new.<ts>/node_modules/` 与 `dsh.new.<ts>/node_modules/@deepseek-ai/dsh/`
 * 5. 校验安装产物（lib/bin.js 存在）
 * 6. 只把 `@deepseek-ai/dsh` 包本体（实测 20 个文件 / 0.07MB）上提到目录根，
 *    使 `dsh.new.<ts>/` 的布局与正式缓存 `dsh/` 完全一致
 * 7. 返回待激活目录，由调用方择机 activate
 *
 * **为什么 npm 直接装进缓存目录（不要改回 TEMP 再拷）**：
 * 依赖树有 26,617 个文件 / 453MB，而需要搬运的包本体只占 0.08%。装在
 * `%TEMP%` 再 copyDir 过来需要主线程同步拷贝 2.6 万个文件（实测 cpSync 推算
 * ~18.6s），Windows 约 5 秒无消息即把窗口判为「未响应」。原地安装后
 * node_modules 已经就位，**这次拷贝整个消失**。附带收益：磁盘峰值从
 * ~900MB（临时装 + 缓存各一份）降到 ~460MB。
 *
 * 注意：不复用旧缓存的 node_modules。实测 npm arborist 对复用旧树做增量 diff 时
 * 会产出不完整依赖树（0.1.2-rc.1：sharp 升到 0.35.4 但其常规依赖 @img/colour
 * 未落盘），激活后 DSH 启动报 ERR_MODULE_NOT_FOUND。全量 reify 配合 tarball
 * 内容缓存已足够快（实测 24 秒）。
 *
 * 全程不触碰现有 dsh/ 缓存目录，更新期间旧 DSH 进程可继续运行。
 * 失败时清理新目录与临时目录，现有缓存不受影响。
 *
 * @param onProgress 进度回调（文字描述当前步骤）
 * @returns 待激活目录与版本号，由调用方择机 activate
 */
export async function prepareDshPackage(
  onProgress?: (msg: string) => void
): Promise<PreparedDshPackage> {
  const report = (msg: string): void => {
    console.log(`[DSH Repair] ${msg}`)
    onProgress?.(msg)
  }

  // 0. 校验内置 node.exe（npm install 由内置 node 执行，DSH 运行同样依赖它）
  if (!existsSync(getNodeBinaryPath())) {
    throw new Error('内置 Node.js 不存在，无法安装 DSH 包')
  }

  // 清扫上次更新/修复中断残留的 staging / old 目录（异步，不阻塞主线程）
  await cleanupStaleStagingDirs()

  // 1. 获取最新版本
  report('正在获取最新版本号...')
  const version = await fetchLatestVersion()
  report(`最新版本: ${version}`)
  diag('dsh-prep', `开始准备，目标版本 v${version}`)

  // 2. 准备临时目录（只放 tgz）与待激活目录
  const tempDir = join(tmpdir(), `dsh-repair-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const tgzPath = join(tempDir, `dsh-${version}.tgz`)

  const cacheDir = getDshRepairCacheDir()
  // npm install 的 cwd：必须是空目录，让 npm 把 tgz 当作要安装的包（而非项目根）；
  // 直接建在缓存目录内，保证后续 rename 激活时同卷可用
  const preparedDir = join(cacheDir, `dsh.new.${Date.now()}`)
  mkdirSync(preparedDir, { recursive: true })
  diag('dsh-prep', `待激活目录（npm 的 cwd）已建: ${preparedDir}`)

  // 2.1 预检查缓存目录可写：在跑 30 秒的 npm install 之前就发现权限问题
  try {
    const testFile = join(preparedDir, '.write-test')
    writeFileSync(testFile, '')
    unlinkSync(testFile)
  } catch {
    try { rmSync(preparedDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    throw new Error('缓存目录不可写，无法保存 DSH 包。请检查磁盘空间或权限设置。')
  }

  try {
    // 3. 下载 tgz（优先国内镜像，失败回退 npm registry）
    const mirrorTgzUrl = `${NPM_REGISTRY_MIRROR}/${DSH_PACKAGE}/-/dsh-${version}.tgz`
    const primaryTgzUrl = `${NPM_REGISTRY}/${DSH_PACKAGE}/-/dsh-${version}.tgz`
    let lastReportedMB = -1
    const reportDownloadProgress = (downloaded: number): void => {
      const mb = Math.floor(downloaded / (1024 * 1024))
      if (mb !== lastReportedMB) {
        lastReportedMB = mb
        report(`下载中: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
      }
    }
    report('正在下载 DSH 包（国内镜像）...')
    try {
      await downloadFile(mirrorTgzUrl, tgzPath, reportDownloadProgress)
    } catch (mirrorErr) {
      report(`国内镜像下载失败，回退到 npm registry: ${(mirrorErr as Error).message}`)
      // 清理可能的部分下载文件
      if (existsSync(tgzPath)) {
        try { unlinkSync(tgzPath) } catch { /* 忽略 */ }
      }
      lastReportedMB = -1
      report('正在下载 DSH 包（npm registry）...')
      await downloadFile(primaryTgzUrl, tgzPath, reportDownloadProgress)
    }
    report('下载完成')

    // 4. 完整性校验：npm dist.integrity（sha512），防镜像污染/下载损坏
    report('正在校验安装包完整性...')
    const integrity = await fetchDistIntegrity(version)
    await verifyFileIntegrity(tgzPath, integrity)
    report('完整性校验通过')
    diag('dsh-prep', 'tgz 下载完成，sha512 完整性校验通过')

    // 5. 在空目录跑 npm install <tgz>（不复用旧 node_modules，原因见函数注释）
    report('正在安装 DSH 包及其依赖...')
    const installStartedAt = Date.now()
    await installDshFromTarball(tgzPath, preparedDir, report)
    diag('dsh-prep', `npm install 完成，用时 ${Date.now() - installStartedAt}ms（npm 的 cwd 即待激活目录，安装完立刻可能被安全软件扫描占用）`)

    // 6. 校验 npm install 产物
    const installedDshDir = join(preparedDir, 'node_modules', '@deepseek-ai', 'dsh')
    if (!existsSync(installedDshDir) || !existsSync(join(installedDshDir, 'lib', 'bin.js'))) {
      throw new Error('npm install 后未找到 DSH 包或 lib/bin.js，安装异常')
    }
    report('DSH 包安装完成')

    // 6.5 校验本地源码编译的原生模块能被内置 Node 加载（防 ABI 不匹配激活坏缓存）
    report('正在校验原生模块 ABI 兼容性...')
    assertNativeModulesLoadable(preparedDir)

    // 7. 把 DSH 包本体上提到目录根，使 preparedDir 的布局与正式缓存 dsh/ 一致
    //    （package.json + lib/ 在根，node_modules/ 为兄弟目录）
    //    只搬 20 个文件；node_modules 已由 npm 原地装好，不再搬运。
    report('正在写入新版本缓存...')
    copyDir(installedDshDir, preparedDir)

    report(`新版本 DSH 包已就绪（待激活）: v${version}`)
    diag('dsh-prep', `准备完成 v${version}，等待 activate 换位`)
    return { preparedDir, version }
  } catch (err) {
    // 准备失败：清理新目录，现有缓存目录不受影响。
    // 必须异步删——失败时新目录里可能已有一棵 26,617 文件的依赖树，同步删会再卡一次窗口
    if (existsSync(preparedDir)) {
      try {
        await fsp.rm(preparedDir, { recursive: true, force: true })
      } catch {
        try { rmSync(preparedDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
    }
    throw err
  } finally {
    // 清理临时下载目录（新布局下这里只剩 tgz，体积很小）
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[DSH Repair] 清理临时文件失败: ${(e as Error).message}`)
    }
  }
}

/**
 * activateDshPackage 的产物
 */
export interface ActivateDshResult {
  /** 激活后的正式缓存目录（dsh-cache/dsh） */
  activeDir: string
  /** 被换下、待回收的旧版本目录；没有旧目录（首次安装/修复）时为 null */
  retiredDir: string | null
}

/**
 * 可重试的 rename 错误码
 *
 * 这三个都是**占用类**瞬时错误：Windows 上安全软件的文件系统过滤驱动
 * （本机实测为腾讯电脑管家 `QQSysMonX64`）会扫描新写入的文件，并以
 * 不带 FILE_SHARE_DELETE 的方式持有句柄，此时对目录做 MoveFileEx 必被拒。
 * 扫描走完句柄即释放，所以「等一下再试」就能过。
 * EXDEV（跨卷）/ ENOENT 这类是确定性错误，重试没有意义，立即抛出。
 */
const RETRIABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY'])

/** 退避序列，累计约 15.75s */
const RENAME_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000]
const RENAME_MAX_ATTEMPTS = RENAME_BACKOFF_MS.length + 1

/**
 * 带退避重试的 rename（异步）
 *
 * 用 `fsp.rename` 而非 `renameSync`：等待期间主线程完全空闲，
 * 不会重新引入「窗口未响应」（Windows 约 5 秒无消息即判未响应）。
 *
 * @param from 源路径
 * @param to 目标路径
 * @param uiLabel 人话标签，用于进度提示与诊断日志
 * @param onProgress 进度回调（重试时推送）
 */
async function renameWithRetry(
  from: string,
  to: string,
  uiLabel: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      await fsp.rename(from, to)
      diag('dsh-rename', `${uiLabel} 成功（第 ${attempt} 次尝试）${from} -> ${to}`)
      console.log(`[DSH Repair] ${uiLabel}: ${from} -> ${to}（第 ${attempt} 次尝试）`)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      const exhausted = attempt >= RENAME_MAX_ATTEMPTS
      if (!RETRIABLE_RENAME_CODES.has(e.code ?? '') || exhausted) {
        diag(
          'dsh-rename',
          `${uiLabel} ${exhausted ? '重试耗尽' : '不可重试'}（第 ${attempt}/${RENAME_MAX_ATTEMPTS} 次）` +
          ` code=${e.code} errno=${e.errno} syscall=${e.syscall} path=${e.path} msg=${e.message}`
        )
        // 抛最后一次的原始错误，保持既有错误文案形态
        throw err
      }
      const wait = RENAME_BACKOFF_MS[Math.min(attempt - 1, RENAME_BACKOFF_MS.length - 1)]
      diag('dsh-rename', `${uiLabel} 遇 ${e.code}（目录可能被占用），${wait}ms 后重试（第 ${attempt}/${RENAME_MAX_ATTEMPTS} 次）`)
      onProgress?.(`${uiLabel}（目录被占用，正在重试 ${attempt}/${RENAME_MAX_ATTEMPTS - 1}）...`)
      await new Promise<void>((resolve) => setTimeout(resolve, wait))
    }
  }
}

/**
 * 阶段二：激活 preparedDir 为正式缓存（两次同卷 rename，毫秒级窗口）
 *
 * **不做任何常规删除**：`dsh` 与 `dsh.new.<ts>` 同在 `dsh-cache` 下、同卷，
 * rename 只是改目录项，因此这一步与「删除 26,637 个文件」相比是毫秒级的。
 * 旧目录先换名成 `dsh.old.<ts>` 让位，其真正删除推迟到 DSH 启动就绪之后
 * 由 `discardRetiredDshDir` 异步完成——那 453MB 的删除绝不能占着主线程，
 * 否则 Windows 会把窗口判为「未响应」。
 *
 * **为什么两条 rename 都要重试**：刚被 npm 写完的 `dsh.new.*` 会被安全软件的
 * 文件系统过滤驱动实时扫描，持有不带 FILE_SHARE_DELETE 的句柄，
 * 此时 rename 必报 EPERM（实机踩坑：2026-09-30 更新 0.2.0-rc.2 时第一条
 * rename 成功、第二条被拒，旧版本经回滚完好但更新整体失败）。详见 AGENTS.md §12。
 *
 * 调用方必须在此之前停止 DSH 进程（顺序约束见 AGENTS.md §12 第 13 条）：
 * 运行中的 native 模块会锁定缓存目录。保持"先停后换"能让失败点可控。
 *
 * 失败与回滚：第二条 rename 重试耗尽后，尝试把 `dsh.old.*` 换回 `dsh`（同样带重试），
 * 用户完全无感；回滚也失败才抛错，由调用方走错误页 / 在线修复流程。
 *
 * @param preparedDir prepareDshPackage 返回的待激活目录
 * @param onProgress 进度回调（重试等待期间推送，避免用户以为卡死）
 * @returns 正式缓存目录与待回收的旧目录
 */
export async function activateDshPackage(
  preparedDir: string,
  onProgress?: (msg: string) => void
): Promise<ActivateDshResult> {
  const cacheDir = getDshRepairCacheDir()
  const targetDir = join(cacheDir, 'dsh')

  if (!existsSync(join(preparedDir, 'package.json'))) {
    throw new Error(`准备目录无效（缺少 package.json）: ${preparedDir}`)
  }

  diag('dsh-act', `进入激活 preparedDir=${preparedDir} target=${targetDir}`)

  // 旧目录换名让位（毫秒级，不删除）
  let retiredDir: string | null = null
  if (existsSync(targetDir)) {
    retiredDir = join(cacheDir, `dsh.old.${Date.now()}`)
    await renameWithRetry(targetDir, retiredDir, '正在让位旧版本目录', onProgress)
  } else {
    diag('dsh-act', `目标目录不存在，按首次安装/修复处理: ${targetDir}`)
  }

  // 目标存在性复查：无论上面走没走，让位之后目标都必须不存在。
  // existsSync 只是快判，安全网在这里——覆盖"门禁漏判 / 目标被重建"这一支。
  if (existsSync(targetDir)) {
    diag('dsh-act', '让位后目标仍存在（existsSync 门禁漏判或被重建），执行异步兜底删除')
    onProgress?.('正在清理残留目录...')
    await fsp.rm(targetDir, { recursive: true, force: true })
    diag('dsh-act', `兜底删除完成: ${targetDir}`)
  }

  // 新目录上位（毫秒级；被占用时自动退避重试）
  try {
    await renameWithRetry(preparedDir, targetDir, '正在切换 DSH 版本', onProgress)
  } catch (err) {
    // 回滚：把旧目录换回原位，用户完全无感
    if (retiredDir) {
      try {
        await renameWithRetry(retiredDir, targetDir, '正在回滚到旧版本目录', onProgress)
        diag('dsh-act', '激活失败，已回滚到旧版本目录')
        retiredDir = null
      } catch {
        diag('dsh-act', `回滚失败，旧版本目录仍留在 dsh.old.*，下次启动将回退出厂版本: ${(err as Error).message}`)
      }
    }
    throw err
  }

  diag('dsh-act', `激活成功 active=${targetDir} retired=${retiredDir ?? '(无)'}`)
  console.log(`[DSH Repair] DSH 包已激活到: ${targetDir}`)
  return { activeDir: targetDir, retiredDir }
}

/**
 * 回收被换下的旧版本目录（异步，DSH 启动就绪后调用）
 *
 * 用 `fsp.rm` 而非 `fsp.cp` 那套：删除走 libuv 线程池，主线程不被阻塞。
 * 失败只记 warn——不影响运行，残留由下次 prepare 前的清扫兜底。
 *
 * @param retiredDir activateDshPackage 返回的旧目录，null 时直接返回
 */
export async function discardRetiredDshDir(retiredDir: string | null): Promise<void> {
  if (!retiredDir) return
  try {
    await fsp.rm(retiredDir, { recursive: true, force: true })
    console.log(`[DSH Repair] 已清理旧版本目录: ${retiredDir}`)
  } catch (err) {
    console.warn(
      `[DSH Repair] 清理旧版本目录失败（不影响运行，下次更新前兜底清扫）: ${(err as Error).message}`
    )
  }
}

/**
 * 使当前修复缓存失效：把 dsh-cache/dsh 重命名为 dsh-cache/dsh.abi-broken.<ts>
 *
 * 供 dsh-manager 启动自愈使用：检测到缓存内原生模块 ABI 不匹配（ERR_DLOPEN_FAILED）
 * 时调用，重命名后 findCachedDshEntry 会跳过该缓存、回退到内置 dsh-bundled 版本。
 * 调用时 DSH 子进程已退出，.node 不再被锁定，rename 通常成功；失败返回 false，
 * 由调用方走 DSH_PACKAGE_MISSING 错误页兜底。残留目录由下次 prepare 前的
 * cleanupStaleStagingDirs 清扫。
 *
 * @returns 成功重命名返回 true，否则 false
 */
export function invalidateRepairCacheDir(): boolean {
  const cacheDir = getDshRepairCacheDir()
  const targetDir = join(cacheDir, 'dsh')
  if (!existsSync(targetDir)) return false
  const brokenDir = join(cacheDir, `dsh.abi-broken.${Date.now()}`)
  try {
    renameSync(targetDir, brokenDir)
    console.warn(`[DSH Repair] 已将 ABI 不匹配的缓存失效: ${targetDir} -> ${brokenDir}`)
    return true
  } catch (err) {
    console.warn(`[DSH Repair] 失效缓存重命名失败: ${(err as Error).message}`)
    return false
  }
}

/**
 * 在线修复 DSH 包（错误页"在线修复"按钮触发的完整流程）
 *
 * 错误页场景下 DSH 进程未在运行，可直接准备 + 激活。
 * DSH 运行中的版本更新请使用 prepareDshPackage / activateDshPackage 分阶段调用
 *（先 prepare，再 stopDsh，再 activate，最后 startDsh）。
 *
 * @param onProgress 进度回调（文字描述当前步骤）
 * @returns 修复后的 DSH 包目录路径
 */
export async function repairDsh(
  onProgress?: (msg: string) => void
): Promise<string> {
  const prepared = await prepareDshPackage(onProgress)
  let activated: ActivateDshResult
  try {
    activated = await activateDshPackage(prepared.preparedDir, onProgress)
  } catch (err) {
    // 激活失败时清理待激活目录，避免残留（激活已回滚，retiredDir 已被换回 dsh）
    if (existsSync(prepared.preparedDir)) {
      try { await fsp.rm(prepared.preparedDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    throw err
  }
  // 错误页场景下 DSH 进程未在运行，此刻直接回收旧目录即可
  await discardRetiredDshDir(activated.retiredDir)
  onProgress?.(`修复完成，DSH 包已保存到: ${activated.activeDir}`)
  return activated.activeDir
}
