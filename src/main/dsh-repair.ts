import { get } from 'https'
import { existsSync, mkdirSync, rmSync, renameSync, createWriteStream, writeFileSync, readdirSync, statSync, copyFileSync } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { spawn } from 'child_process'
import { getNodeBinaryPath, getNodeDir } from './node-binary'
import { fetchLatestVersion } from './dsh-version'

/**
 * DSH 在线修复模块
 *
 * 当 dsh-bundled 损坏或缺失时，通过 node.exe 内置的 https 模块下载 DSH 包 tgz，
 * 使用 Windows 自带的 tar.exe（System32）解压到用户可写目录。
 *
 * 修复后的 DSH 包存放在：%LOCALAPPDATA%/DSH Desktop/dsh-cache
 * 该目录会被 dsh-manager.ts 中的 findCachedDshEntry 优先识别。
 */

// npm registry 地址
const NPM_REGISTRY = 'https://registry.npmjs.org'
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

/**
 * 下载文件（支持 302 重定向）
 * @param url 下载地址
 * @param dest 目标文件路径
 * @param onProgress 进度回调（已下载字节数）
 */
function downloadFile(url: string, dest: string, onProgress?: (downloaded: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const req = get(url, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        downloadFile(res.headers.location, dest, onProgress).then(resolve).catch(reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`下载失败 (状态码 ${res.statusCode})`))
        return
      }
      const stream = createWriteStream(dest)
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

/**
 * 检查 Windows tar.exe 是否可用
 */
function checkTarAvailable(): boolean {
  try {
    const result = spawn('tar.exe', ['--version'], { shell: true, stdio: 'pipe' })
    return result.pid !== undefined
  } catch {
    return false
  }
}

/** npm install 超时时间（毫秒） */
const NPM_INSTALL_TIMEOUT = 300_000

/**
 * 用内置 npm 为 DSH 包补装运行时依赖
 *
 * 从 npm 下载解压的 tgz 不含 node_modules，需在解压产物根目录执行
 * `npm install --omit=dev` 安装 dependencies，否则 DSH 启动会报 ERR_MODULE_NOT_FOUND。
 *
 * @param pkgDir DSH 包（含 package.json）所在目录（必须是用户可写目录）
 * @param onProgress 进度回调（文字描述）
 */
function installPackageDependencies(pkgDir: string, onProgress?: (msg: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCli = join(getNodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) {
      reject(new Error('内置 npm 不可用，无法安装 DSH 包依赖'))
      return
    }

    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const npmCacheDir = join(localAppData, 'DSH Desktop', 'npm-cache')
    mkdirSync(npmCacheDir, { recursive: true })

    const child = spawn(
      getNodeBinaryPath(),
      [npmCli, 'install', '--omit=dev', '--no-audit', '--no-fund', '--loglevel=warn'],
      {
        cwd: pkgDir,
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
          onProgress?.('正在安装 DSH 包依赖...')
        }
        lastProgressTime = now
      }
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    onProgress?.('正在安装 DSH 包依赖...')

    const timeout = setTimeout(() => {
      child.kill('SIGTERM')
      reject(new Error('npm 安装依赖超时（5分钟），请检查网络连接'))
    }, NPM_INSTALL_TIMEOUT)

    child.on('error', (err) => {
      clearTimeout(timeout)
      reject(new Error(`npm 启动失败: ${err.message}`))
    })

    child.on('exit', (code) => {
      clearTimeout(timeout)
      if (code === 0) {
        onProgress?.('DSH 包依赖安装完成')
        resolve()
      } else {
        const errMsg = stderr || stdout || '未知错误'
        const combinedMsg = errMsg.toLowerCase()
        if (combinedMsg.includes('eperm') || combinedMsg.includes('operation not permitted')) {
          reject(new Error(`npm 安装依赖失败: 权限不足，无法写入缓存目录。请检查杀毒软件或手动删除旧缓存后重试。\n${errMsg}`))
        } else if (combinedMsg.includes('etimedout') || combinedMsg.includes('econnreset') || combinedMsg.includes('network')) {
          reject(new Error(`npm 安装依赖失败: 网络连接异常。请检查网络后重试。\n${errMsg}`))
        } else {
          reject(new Error(`npm 安装依赖失败 (退出码 ${code})\n${errMsg}`))
        }
      }
    })
  })
}

/**
 * 用 Windows tar.exe 解压 tgz 到指定目录
 * @param tgzPath tgz 文件路径
 * @param destDir 解压目标目录
 */
function extractTgz(tgzPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!checkTarAvailable()) {
      reject(new Error('Windows tar.exe 不可用，请使用 Windows 10 1803+ 或手动安装 DSH 包'))
      return
    }
    const child = spawn('tar.exe', ['-xzf', tgzPath, '-C', destDir], {
      shell: true,
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })
    child.on('error', (err) => {
      reject(new Error(`tar.exe 启动失败: ${err.message}`))
    })
    child.on('exit', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error(`tar.exe 解压失败 (退出码 ${code})\n${stderr}`))
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
 * 在线修复 DSH 包
 *
 * 流程：
 * 1. 获取最新版本号
 * 2. 下载 tgz 到临时目录
 * 3. tar.exe 解压 tgz
 * 4. 复制到用户缓存目录（确保在用户可写目录执行 npm install）
 * 5. 在缓存目录执行 npm install 补装依赖
 * 6. 原子 rename 到最终目录
 * 7. 清理临时文件
 *
 * @param onProgress 进度回调（文字描述当前步骤）
 * @returns 修复后的 DSH 包目录路径
 */
export async function repairDsh(
  onProgress?: (msg: string) => void
): Promise<string> {
  const report = (msg: string): void => {
    console.log(`[DSH Repair] ${msg}`)
    onProgress?.(msg)
  }

  // 0. 校验 node.exe（虽然修复本身不直接用 node，但运行 DSH 需要）
  if (!existsSync(getNodeBinaryPath())) {
    throw new Error('内置 Node.js 不存在，无法验证环境')
  }

  // 1. 获取最新版本
  report('正在获取最新版本号...')
  const version = await fetchLatestVersion()
  report(`最新版本: ${version}`)

  // 2. 准备临时目录
  const tempDir = join(tmpdir(), `dsh-repair-${Date.now()}`)
  mkdirSync(tempDir, { recursive: true })
  const tgzPath = join(tempDir, `dsh-${version}.tgz`)
  const extractDir = join(tempDir, 'extracted')
  mkdirSync(extractDir, { recursive: true })

  // 预先计算缓存目标路径
  const cacheDir = getDshRepairCacheDir()
  const targetDir = join(cacheDir, 'dsh')
  const tempTargetDir = join(cacheDir, 'dsh.tmp')

  try {
    // 3. 下载 tgz
    const tgzUrl = `${NPM_REGISTRY}/${DSH_PACKAGE}/-/dsh-${version}.tgz`
    report(`正在下载 DSH 包...`)
    await downloadFile(tgzUrl, tgzPath, (downloaded) => {
      if (downloaded % (1024 * 1024) < 100 * 1024) {
        report(`下载中: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
      }
    })
    report('下载完成')

    // 4. 解压
    report('正在解压...')
    await extractTgz(tgzPath, extractDir)
    const packageDir = join(extractDir, 'package')
    if (!existsSync(packageDir)) {
      throw new Error('解压后未找到 package 目录，文件结构异常')
    }
    report('解压完成')

    // 5. 先复制到缓存目录（用户可写），再在缓存目录执行 npm install
    //    避免在临时目录执行 npm install 触发 EPERM 权限错误
    report('正在准备安装目录...')
    if (existsSync(tempTargetDir)) {
      rmSync(tempTargetDir, { recursive: true, force: true })
    }
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }
    copyDir(packageDir, tempTargetDir)

    // 预检查缓存目录是否可写（在 npm install 之前发现权限问题）
    try {
      const testFile = join(tempTargetDir, '.write-test')
      writeFileSync(testFile, '')
      rmSync(testFile)
    } catch {
      throw new Error('缓存目录不可写，无法安装 DSH 包依赖。请检查磁盘空间或权限设置。')
    }

    // 6. 在缓存目录（用户可写）执行 npm install 补装运行时依赖
    report('正在安装 DSH 包依赖...')
    await installPackageDependencies(tempTargetDir, report)

    // 7. 原子 rename 到最终目录
    renameSync(tempTargetDir, targetDir)
    report(`修复完成，DSH 包已保存到: ${targetDir}`)

    return targetDir
  } finally {
    // 清理临时文件
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[DSH Repair] 清理临时文件失败: ${(e as Error).message}`)
    }
    // 清理缓存中的临时目标目录（如果流程失败）
    try {
      if (existsSync(tempTargetDir)) {
        rmSync(tempTargetDir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[DSH Repair] 清理临时目标失败: ${(e as Error).message}`)
    }
  }
}
