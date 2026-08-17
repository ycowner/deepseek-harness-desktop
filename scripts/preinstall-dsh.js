// @ts-check
/**
 * 预安装 DSH 包脚本
 *
 * 在打包前运行，将 @deepseek-ai/dsh 包预下载到 npx 缓存目录。
 * 这样应用首次启动时无需联网下载，直接使用缓存的包。
 *
 * 使用方式：
 *   node scripts/preinstall-dsh.js
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// 项目根目录
const PROJECT_ROOT = path.resolve(__dirname, '..')
// 内置 Node.js 目录
const NODE_DIR = path.join(PROJECT_ROOT, 'resources', 'node')
const NODE_EXE = path.join(NODE_DIR, 'node.exe')
const NPX_CLI = path.join(NODE_DIR, 'node_modules', 'npm', 'bin', 'npx-cli.js')

// npx 缓存目录（与 dsh-manager.ts 中 getNpmCacheDir 逻辑一致）
const NPM_CACHE_DIR = path.join(NODE_DIR, '.npm-cache')

// 预安装的 DSH 包独立存放目录（避免 node_modules 被 electron-builder 排除）
const BUNDLED_DSH_DIR = path.join(PROJECT_ROOT, 'resources', 'dsh-bundled')

/**
 * 递归复制目录
 */
function copyDir(src, dest) {
  if (!fs.existsSync(src)) return false
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
  return true
}

/**
 * 主流程
 */
function main() {
  console.log('================================================')
  console.log('  预安装 DSH 包')
  console.log('================================================')

  // 检查 Node.js 二进制是否存在
  if (!fs.existsSync(NODE_EXE)) {
    console.error('[错误] 内置 Node.js 不存在，请先运行 npm run download-node')
    process.exit(1)
  }

  // 确保缓存目录存在
  if (!fs.existsSync(NPM_CACHE_DIR)) {
    fs.mkdirSync(NPM_CACHE_DIR, { recursive: true })
  }

  console.log(`[预安装] Node.js: ${NODE_EXE}`)
  console.log(`[预安装] npx-cli: ${NPX_CLI}`)
  console.log(`[预安装] 缓存目录: ${NPM_CACHE_DIR}`)

  // 使用内置 Node.js 运行 npx 下载 DSH 包
  // -y 自动确认安装
  // 这会在 _npx 目录下创建缓存
  console.log('[预安装] 正在通过 npx 下载 @deepseek-ai/dsh 包...')

  try {
    // 设置超时为 5 分钟（首次下载可能较慢）
    execSync(
      `"${NODE_EXE}" "${NPX_CLI}" -y @deepseek-ai/dsh --version`,
      {
        cwd: NODE_DIR,
        env: {
          ...process.env,
          PATH: `${NODE_DIR};${process.env.PATH || ''}`,
          npm_config_cache: NPM_CACHE_DIR,
          npm_config_prefix: path.join(NPM_CACHE_DIR, 'prefix')
        },
        stdio: 'inherit',
        timeout: 300_000 // 5 分钟超时
      }
    )
    console.log('[预安装] DSH 包下载完成')
  } catch (err) {
    console.warn(`[警告] 预安装失败: ${err.message}`)
    console.warn('[警告] 应用首次启动时仍可通过 npx 下载，不影响功能')
    // 不退出，预安装失败不阻塞打包
  }

  // 验证缓存并复制到独立目录
  const npxDir = path.join(NPM_CACHE_DIR, '_npx')
  if (fs.existsSync(npxDir)) {
    const entries = fs.readdirSync(npxDir, { withFileTypes: true })
    let found = false
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const dshPath = path.join(npxDir, entry.name, 'node_modules', '@deepseek-ai', 'dsh')
      if (fs.existsSync(dshPath)) {
        console.log(`[预安装] 验证成功，DSH 包已缓存于: ${dshPath}`)

        // 复制到独立目录（避免 electron-builder 排除 node_modules）
        console.log(`[预安装] 复制 DSH 包到独立目录: ${BUNDLED_DSH_DIR}`)
        // 先尝试清理旧的，若被锁定则跳过（文件被其他进程占用时复制会覆盖）
        if (fs.existsSync(BUNDLED_DSH_DIR)) {
          try {
            fs.rmSync(BUNDLED_DSH_DIR, { recursive: true, force: true })
          } catch (e) {
            console.warn(`[预安装] 无法清理旧目录 (${e.code})，将覆盖更新`)
          }
        }
        copyDir(dshPath, BUNDLED_DSH_DIR)

        // 同时复制 node_modules 依赖（DSH 包使用了大量 bare specifier 导入）
        // npx 缓存中 node_modules 与 @deepseek-ai/dsh 同级，包含了所有 hoisted 依赖
        const nodeModulesSrc = path.join(dshPath, '..', '..')
        const nodeModulesDest = path.join(BUNDLED_DSH_DIR, 'node_modules')
        console.log(`[预安装] 复制 node_modules 依赖: ${nodeModulesSrc} -> ${nodeModulesDest}`)
        if (fs.existsSync(nodeModulesSrc)) {
          copyDir(nodeModulesSrc, nodeModulesDest)
          console.log('[预安装] node_modules 复制完成')
        } else {
          console.warn(`[预安装] 警告：node_modules 源目录不存在: ${nodeModulesSrc}`)
        }
        console.log('[预安装] 复制完成')

        found = true
        break
      }
    }
    if (!found) {
      console.warn('[预安装] 未在缓存中找到 DSH 包，应用首次启动时会重新下载')
    }
  }

  console.log('================================================')
  console.log('  预安装完成')
  console.log('================================================')
}

main()
