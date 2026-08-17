import { get } from 'https'
import { existsSync, mkdirSync, rmSync, renameSync, createWriteStream } from 'fs'
import { join } from 'path'
import { tmpdir, homedir } from 'os'
import { spawn } from 'child_process'
import { getNodeBinaryPath } from './node-binary'

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
 * 获取最新版本号
 * @returns 版本号字符串，如 "1.2.3"
 */
function fetchLatestVersion(): Promise<string> {
  return new Promise((resolve, reject) => {
    const url = `${NPM_REGISTRY}/${encodeURIComponent(DSH_PACKAGE).replace('%40', '@')}/latest`
    // 注意：npm registry 对 scoped 包路径要求 @ 不编码
    const req = get(url, (res) => {
      // 处理重定向
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        get(res.headers.location, (r2) => {
          if (r2.statusCode !== 200) {
            reject(new Error(`获取版本失败 (重定向后状态码 ${r2.statusCode})`))
            return
          }
          let data = ''
          r2.on('data', (chunk: Buffer) => (data += chunk.toString()))
          r2.on('end', () => {
            try {
              const pkg = JSON.parse(data)
              resolve(pkg.version)
            } catch (e) {
              reject(new Error(`解析版本响应失败: ${(e as Error).message}`))
            }
          })
        }).on('error', reject)
        return
      }
      if (res.statusCode !== 200) {
        reject(new Error(`获取版本失败 (状态码 ${res.statusCode})`))
        return
      }
      let data = ''
      res.on('data', (chunk: Buffer) => (data += chunk.toString()))
      res.on('end', () => {
        try {
          const pkg = JSON.parse(data)
          resolve(pkg.version)
        } catch (e) {
          reject(new Error(`解析版本响应失败: ${(e as Error).message}`))
        }
      })
    })
    req.on('error', reject)
    req.setTimeout(30_000, () => {
      req.destroy()
      reject(new Error('获取版本超时（30秒）'))
    })
  })
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
  const { readdirSync, statSync, copyFileSync } = require('fs')
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
 * 4. 将解压出的 package 目录复制到用户缓存目录
 * 5. 清理临时文件
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

  try {
    // 3. 下载 tgz
    // npm registry 的 tgz 地址格式：https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-1.2.3.tgz
    const tgzUrl = `${NPM_REGISTRY}/${DSH_PACKAGE}/-/dsh-${version}.tgz`
    report(`正在下载 DSH 包...`)
    await downloadFile(tgzUrl, tgzPath, (downloaded) => {
      if (downloaded % (1024 * 1024) < 100 * 1024) {
        // 每下载约 1MB 上报一次进度
        report(`下载中: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
      }
    })
    report('下载完成')

    // 4. 解压
    report('正在解压...')
    await extractTgz(tgzPath, extractDir)
    // tar 解压后会得到 package/ 目录
    const packageDir = join(extractDir, 'package')
    if (!existsSync(packageDir)) {
      throw new Error('解压后未找到 package 目录，文件结构异常')
    }
    report('解压完成')

    // 5. 复制到用户缓存目录（原子性：先到临时目标，再 rename）
    const cacheDir = getDshRepairCacheDir()
    const targetDir = join(cacheDir, 'dsh')
    const tempTargetDir = join(cacheDir, 'dsh.tmp')

    // 清理旧的临时目录
    if (existsSync(tempTargetDir)) {
      rmSync(tempTargetDir, { recursive: true, force: true })
    }
    // 清理旧的目标目录（若存在）
    if (existsSync(targetDir)) {
      rmSync(targetDir, { recursive: true, force: true })
    }

    // 复制到临时目录
    copyDir(packageDir, tempTargetDir)
    // rename 到最终目录（原子操作）
    renameSync(tempTargetDir, targetDir)
    report(`修复完成，DSH 包已保存到: ${targetDir}`)

    return targetDir
  } finally {
    // 6. 清理临时文件
    try {
      if (existsSync(tempDir)) {
        rmSync(tempDir, { recursive: true, force: true })
      }
    } catch (e) {
      console.warn(`[DSH Repair] 清理临时文件失败: ${(e as Error).message}`)
    }
  }
}
