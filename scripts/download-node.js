// @ts-check
/**
 * 下载内置 Node.js 二进制脚本
 *
 * 功能：
 * 1. 下载 Node.js v22.19.0 (Windows x64) 二进制压缩包
 * 2. 解压并将整个目录内容（node.exe + node_modules 等）复制到 resources/node/
 * 3. 如果 resources/node/node.exe 已存在则跳过下载（除非传入 --force）
 * 4. 提供下载进度提示
 *
 * 使用方式：
 *   node scripts/download-node.js          # 如不存在则下载
 *   node scripts/download-node.js --force  # 强制重新下载
 */

const fs = require('fs')
const path = require('path')
const https = require('https')
const { execSync, execFileSync } = require('child_process')

// Node.js 版本和下载源配置
const NODE_VERSION = '22.19.0'
const NODE_PLATFORM = 'win'
const NODE_ARCH = 'x64'
const NODE_DIR_NAME = `node-v${NODE_VERSION}-${NODE_PLATFORM}-${NODE_ARCH}`

// 下载源：国内镜像优先，官方源备用
const MIRROR_URLS = [
  `https://npmmirror.com/mirrors/node/v${NODE_VERSION}/${NODE_DIR_NAME}.zip`,
  `https://nodejs.org/dist/v${NODE_VERSION}/${NODE_DIR_NAME}.zip`
]

// 项目根目录
const PROJECT_ROOT = path.resolve(__dirname, '..')
// 资源目录
const RESOURCES_DIR = path.join(PROJECT_ROOT, 'resources')
// 目标 Node.js 目录
const TARGET_NODE_DIR = path.join(RESOURCES_DIR, 'node')
// 目标 node.exe 路径
const TARGET_NODE_EXE = path.join(TARGET_NODE_DIR, 'node.exe')

// 临时下载文件路径
const TEMP_ZIP_PATH = path.join(RESOURCES_DIR, `${NODE_DIR_NAME}.zip`)
// 临时解压目录
const TEMP_EXTRACT_DIR = path.join(RESOURCES_DIR, NODE_DIR_NAME)

/**
 * 格式化字节大小
 * @param {number} bytes
 * @returns {string}
 */
function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(2)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

/**
 * 下载文件到指定路径，带进度提示
 * @param {string} url 下载地址
 * @param {string} dest 目标文件路径
 * @returns {Promise<void>}
 */
function downloadFile(url, dest) {
  return new Promise((resolve, reject) => {
    console.log(`[下载] 正在从 ${url} 下载...`)

    const request = https.get(url, { headers: { 'User-Agent': 'dsh-web-desktop/1.0 (Node.js script)' } }, (response) => {
      // 处理重定向
      if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        response.resume()
        const redirectUrl = response.headers.location
        downloadFile(redirectUrl, dest).then(resolve).catch(reject)
        return
      }

      if (response.statusCode !== 200) {
        response.resume()
        reject(new Error(`HTTP 状态码异常: ${response.statusCode}`))
        return
      }

      const totalBytes = parseInt(response.headers['content-length'] || '0', 10)
      let receivedBytes = 0
      let lastLogTime = 0

      const fileStream = fs.createWriteStream(dest)

      response.on('data', (chunk) => {
        receivedBytes += chunk.length
        // 节流日志输出，避免控制台刷屏
        const now = Date.now()
        if (now - lastLogTime > 500 || receivedBytes === totalBytes) {
          if (totalBytes > 0) {
            const percent = ((receivedBytes / totalBytes) * 100).toFixed(1)
            console.log(`[下载] 进度: ${percent}% (${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)})`)
          } else {
            console.log(`[下载] 已下载: ${formatBytes(receivedBytes)}`)
          }
          lastLogTime = now
        }
      })

      response.pipe(fileStream)

      fileStream.on('finish', () => {
        fileStream.close(() => {
          console.log(`[下载] 完成，共 ${formatBytes(receivedBytes)}`)
          resolve()
        })
      })

      fileStream.on('error', (err) => {
        fs.unlink(dest, () => {})
        reject(err)
      })
    })

    request.on('error', (err) => {
      reject(err)
    })

    // 设置超时（60秒）
    request.setTimeout(60000, () => {
      request.destroy(new Error('下载超时'))
    })
  })
}

/**
 * 尝试从镜像列表下载，依次重试
 * @returns {Promise<void>}
 */
async function downloadWithFallback() {
  let lastError = null
  for (const url of MIRROR_URLS) {
    try {
      await downloadFile(url, TEMP_ZIP_PATH)
      return
    } catch (err) {
      lastError = err
      console.warn(`[下载] ${url} 失败: ${err.message}`)
      // 清理可能存在的部分文件
      if (fs.existsSync(TEMP_ZIP_PATH)) {
        fs.unlinkSync(TEMP_ZIP_PATH)
      }
    }
  }
  throw new Error(`所有下载源都失败，最后错误: ${lastError && lastError.message}`)
}

/**
 * 使用 PowerShell 的 Expand-Archive 解压 zip 文件
 * @param {string} zipPath 要解压的 zip 文件路径
 * @param {string} extractToDir 解压目标目录（zip 内含同名子目录，解压后会形成 extractToDir/node-vXX.../）
 */
function extractZip(zipPath, extractToDir) {
  console.log(`[解压] 正在解压 ${path.basename(zipPath)} ...`)

  // 确保目标目录存在（不删除已有内容，避免误删 .gitkeep 等其他资源）
  fs.mkdirSync(extractToDir, { recursive: true })

  // 使用 PowerShell 解压（在 PowerShell 命令字符串内用单引号包裹路径，避免外层双引号冲突）
  const psCommand = `Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractToDir}' -Force`
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', psCommand], { stdio: 'inherit' })
    console.log('[解压] 完成')
  } catch (err) {
    throw new Error(`解压失败: ${err.message}`)
  }
}

/**
 * 复制目录内容到目标目录
 * @param {string} src 源目录
 * @param {string} dest 目标目录
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) {
    throw new Error(`源目录不存在: ${src}`)
  }

  // 创建目标目录
  fs.mkdirSync(dest, { recursive: true })

  const entries = fs.readdirSync(src, { withFileTypes: true })
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name)
    const destPath = path.join(dest, entry.name)

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath)
    } else {
      fs.copyFileSync(srcPath, destPath)
    }
  }
}

/**
 * 清理临时文件
 */
function cleanupTempFiles() {
  if (fs.existsSync(TEMP_ZIP_PATH)) {
    fs.unlinkSync(TEMP_ZIP_PATH)
  }
  if (fs.existsSync(TEMP_EXTRACT_DIR)) {
    fs.rmSync(TEMP_EXTRACT_DIR, { recursive: true, force: true })
  }
}

/**
 * 主流程
 */
async function main() {
  console.log('================================================')
  console.log(`  内置 Node.js 二进制下载脚本`)
  console.log(`  Node 版本: v${NODE_VERSION} (${NODE_PLATFORM}-${NODE_ARCH})`)
  console.log('================================================')

  // 检查是否强制重新下载
  const args = process.argv.slice(2)
  const forceDownload = args.includes('--force')

  // 如果目标 node.exe 已存在且未要求强制下载，则跳过
  if (fs.existsSync(TARGET_NODE_EXE) && !forceDownload) {
    console.log(`[跳过] 已检测到 ${TARGET_NODE_EXE} 存在，如需重新下载请使用 --force 参数`)
    return
  }

  if (forceDownload && fs.existsSync(TARGET_NODE_DIR)) {
    console.log(`[清理] 删除旧的 ${TARGET_NODE_DIR} ...`)
    fs.rmSync(TARGET_NODE_DIR, { recursive: true, force: true })
  }

  // 确保 resources 目录存在
  fs.mkdirSync(RESOURCES_DIR, { recursive: true })

  // 清理可能残留的临时文件
  cleanupTempFiles()

  // 下载
  try {
    await downloadWithFallback()
  } catch (err) {
    console.error(`[错误] 下载失败: ${err.message}`)
    console.error('[错误] 请检查网络连接，或手动从以下地址下载并解压到 resources/node/ 目录:')
    console.error(`  ${MIRROR_URLS[0]}`)
    process.exit(1)
  }

  // 解压
  try {
    extractZip(TEMP_ZIP_PATH, RESOURCES_DIR)
  } catch (err) {
    console.error(`[错误] 解压失败: ${err.message}`)
    cleanupTempFiles()
    process.exit(1)
  }

  // 复制解压出来的 Node.js 目录内容到目标目录
  const extractedDir = path.join(RESOURCES_DIR, NODE_DIR_NAME)
  if (!fs.existsSync(extractedDir)) {
    console.error(`[错误] 解压目录不存在: ${extractedDir}`)
    cleanupTempFiles()
    process.exit(1)
  }

  console.log(`[复制] 将 ${NODE_DIR_NAME} 内容复制到 resources/node/ ...`)
  try {
    copyDir(extractedDir, TARGET_NODE_DIR)
  } catch (err) {
    console.error(`[错误] 复制失败: ${err.message}`)
    cleanupTempFiles()
    process.exit(1)
  }

  // 清理临时文件
  cleanupTempFiles()

  // 验证 node.exe
  if (!fs.existsSync(TARGET_NODE_EXE)) {
    console.error(`[错误] 验证失败: ${TARGET_NODE_EXE} 不存在`)
    process.exit(1)
  }

  // 输出 node 版本号进行验证
  try {
    const version = execSync(`"${TARGET_NODE_EXE}" -v`, { encoding: 'utf-8' }).trim()
    console.log(`[验证] Node.js 版本: ${version}`)
  } catch (err) {
    console.warn(`[警告] 无法执行 ${TARGET_NODE_EXE} -v: ${err.message}`)
  }

  console.log('================================================')
  console.log('  下载完成！文件已就位于 resources/node/')
  console.log('================================================')
}

main().catch((err) => {
  console.error('[错误] 未捕获的异常:', err)
  process.exit(1)
})
