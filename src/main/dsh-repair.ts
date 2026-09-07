import { net } from 'electron'
import { existsSync, mkdirSync, rmSync, renameSync, createWriteStream, createReadStream, writeFileSync, readdirSync, copyFileSync, unlinkSync } from 'fs'
import { createHash } from 'crypto'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { spawn, execFileSync } from 'child_process'
import { getNodeBinaryPath, getNodeDir } from './node-binary'
import { fetchLatestVersion, fetchDistIntegrity } from './dsh-version'

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
 * 1. prepareDshPackage：下载 + 完整性校验 + npm 安装 + 复制到 staging 目录
 *    （dsh-cache/dsh.staging.<ts>/），全程不触碰现有 dsh/ 缓存目录，
 *    因此更新期间旧 DSH 进程可以继续运行；
 * 2. activateDshPackage：rm 旧缓存 + rename staging，不可用窗口仅毫秒级。
 *    调用方负责在 activate 之前停止 DSH 进程——Windows 下运行中的
 *    native 模块（node-pty 等 .node 文件）会锁定缓存目录导致 rmSync EPERM。
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
          npm_config_cache: npmCacheDir,
          npm_config_prefix: npmCacheDir
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
 * 清扫缓存目录中残留的 staging / tmp 目录（上次更新或修复中断的产物）
 */
function cleanupStaleStagingDirs(): void {
  const cacheDir = getDshRepairCacheDir()
  try {
    for (const entry of readdirSync(cacheDir, { withFileTypes: true })) {
      if (entry.isDirectory() && (entry.name.startsWith('dsh.staging.') || entry.name === 'dsh.tmp')) {
        try {
          rmSync(join(cacheDir, entry.name), { recursive: true, force: true })
          console.log(`[DSH Repair] 清理残留目录: ${entry.name}`)
        } catch { /* 忽略单个失败 */ }
      }
    }
  } catch { /* 忽略 */ }
}

/**
 * prepareDshPackage 的产物
 */
export interface PreparedDshPackage {
  /** 完整构建并校验过的 staging 目录（尚未激活） */
  stagingDir: string
  /** 本次准备的 DSH 版本号 */
  version: string
}

/**
 * 阶段一：准备新版 DSH 包（下载 → 完整性校验 → npm 安装 → 复制到 staging）
 *
 * 流程：
 * 1. 获取最新版本号（优先国内镜像 npmmirror，失败回退 npm registry）
 * 2. 下载 tgz 到临时目录（双源）
 * 3. 用 npm dist.integrity（sha512）校验 tgz 完整性
 * 4. 在空目录跑 `npm install <tgz>`（不能在 DSH 包目录里跑，详见
 *    installDshFromTarball 注释），npm 解压 tgz 并安装全部 dependencies
 * 5. 校验安装产物（lib/bin.js 存在）
 * 6. 复制到 staging 目录 dsh-cache/dsh.staging.<ts>/
 *
 * 注意：不复用旧缓存的 node_modules。实测 npm arborist 对复用旧树做增量 diff 时
 * 会产出不完整依赖树（0.1.2-rc.1：sharp 升到 0.35.4 但其常规依赖 @img/colour
 * 未落盘），激活后 DSH 启动报 ERR_MODULE_NOT_FOUND。全量 reify 配合 tarball
 * 内容缓存已足够快（实测 24 秒）。
 *
 * 全程不触碰现有 dsh/ 缓存目录，更新期间旧 DSH 进程可继续运行。
 * 失败时清理 staging 与临时目录，现有缓存不受影响。
 *
 * @param onProgress 进度回调（文字描述当前步骤）
 * @returns staging 目录与版本号，由调用方择机 activate
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

  // 清扫上次更新/修复中断残留的 staging 目录
  cleanupStaleStagingDirs()

  // 1. 获取最新版本
  report('正在获取最新版本号...')
  const version = await fetchLatestVersion()
  report(`最新版本: ${version}`)

  // 2. 准备临时目录
  const tempDir = join(tmpdir(), `dsh-repair-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const tgzPath = join(tempDir, `dsh-${version}.tgz`)
  // npm install 的 cwd：必须是空目录，让 npm 把 tgz 当作要安装的包（而非项目根）
  const installDir = join(tempDir, 'install-root')
  mkdirSync(installDir, { recursive: true })

  const cacheDir = getDshRepairCacheDir()
  const stagingDir = join(cacheDir, `dsh.staging.${Date.now()}`)

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

    // 5. 在空目录跑 npm install <tgz>（不复用旧 node_modules，原因见函数注释）
    report('正在安装 DSH 包及其依赖...')
    await installDshFromTarball(tgzPath, installDir, report)

    // 6. 校验 npm install 产物
    const installedDshDir = join(installDir, 'node_modules', '@deepseek-ai', 'dsh')
    if (!existsSync(installedDshDir) || !existsSync(join(installedDshDir, 'lib', 'bin.js'))) {
      throw new Error('npm install 后未找到 DSH 包或 lib/bin.js，安装异常')
    }
    report('DSH 包安装完成')

    // 7. 复制到 staging 目录（不触碰现有 dsh/ 缓存）
    report('正在准备新版本缓存...')
    copyDir(installedDshDir, stagingDir)

    // 预检查缓存目录可写（在复制 node_modules 之前发现权限问题）
    try {
      const testFile = join(stagingDir, '.write-test')
      writeFileSync(testFile, '')
      rmSync(testFile)
    } catch {
      throw new Error('缓存目录不可写，无法保存 DSH 包。请检查磁盘空间或权限设置。')
    }

    // 复制 node_modules 依赖（含 @deepseek-ai/dsh-* 等所有运行时依赖）
    const installedNodeModules = join(installDir, 'node_modules')
    copyDir(installedNodeModules, join(stagingDir, 'node_modules'))

    report(`新版本 DSH 包已就绪（待激活）: v${version}`)
    return { stagingDir, version }
  } catch (err) {
    // 准备失败：清理 staging，现有缓存目录不受影响
    if (existsSync(stagingDir)) {
      try { rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    throw err
  } finally {
    // 清理临时下载/安装目录
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
 * 阶段二：激活 staging 目录为正式缓存（rm 旧缓存 + rename，毫秒级不可用窗口）
 *
 * 调用方必须在此之前停止 DSH 进程——Windows 下运行中的 native 模块
 * 会锁定缓存目录，导致 rmSync 抛 EPERM（更新流程顺序约束见 AGENTS.md §12）。
 * 失败时旧缓存可能已被删除，下次启动将回退到出厂预装版本（dsh-bundled），
 * staging 目录残留由下次 prepare 前的 cleanupStaleStagingDirs 清扫。
 *
 * @param stagingDir prepareDshPackage 返回的 staging 目录
 * @returns 激活后的正式缓存目录路径
 */
export function activateDshPackage(stagingDir: string): string {
  const cacheDir = getDshRepairCacheDir()
  const targetDir = join(cacheDir, 'dsh')

  if (!existsSync(join(stagingDir, 'package.json'))) {
    throw new Error(`staging 目录无效（缺少 package.json）: ${stagingDir}`)
  }

  if (existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true })
  }
  renameSync(stagingDir, targetDir)
  console.log(`[DSH Repair] DSH 包已激活到: ${targetDir}`)
  return targetDir
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
  try {
    const targetDir = activateDshPackage(prepared.stagingDir)
    onProgress?.(`修复完成，DSH 包已保存到: ${targetDir}`)
    return targetDir
  } catch (err) {
    // 激活失败时清理 staging，避免残留
    if (existsSync(prepared.stagingDir)) {
      try { rmSync(prepared.stagingDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
    throw err
  }
}
