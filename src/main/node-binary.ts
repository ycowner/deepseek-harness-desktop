import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'
import { execFileSync } from 'child_process'

/**
 * 获取 Node.js 二进制所在的目录路径
 *
 * 开发环境：返回项目根目录下的 resources/node/
 * 打包环境：返回 process.resourcesPath/node/
 */
export function getNodeDir(): string {
  // app.isPackaged 在打包后的应用中为 true
  if (app.isPackaged) {
    // process.resourcesPath 指向 Electron 应用的 resources 目录
    return join(process.resourcesPath, 'node')
  }
  // 开发环境使用项目根目录下的 resources/node/
  return join(process.cwd(), 'resources', 'node')
}

/**
 * 获取 Node.js 二进制文件路径（node.exe）
 *
 * 开发环境：返回 <项目根>/resources/node/node.exe
 * 打包环境：返回 <resourcesPath>/node/node.exe
 */
export function getNodeBinaryPath(): string {
  return join(getNodeDir(), 'node.exe')
}

/**
 * 获取 npx 路径
 *
 * 开发环境：返回 <项目根>/resources/node/npx.cmd
 * 打包环境：返回 <resourcesPath>/node/npx.cmd
 */
export function getNpxPath(): string {
  return join(getNodeDir(), 'npx.cmd')
}

/**
 * 获取 npm 路径
 *
 * 开发环境：返回 <项目根>/resources/node/npm.cmd
 * 打包环境：返回 <resourcesPath>/node/npm.cmd
 */
export function getNpmPath(): string {
  return join(getNodeDir(), 'npm.cmd')
}

/**
 * 检查内置 Node.js 二进制文件是否存在
 * @returns boolean - node.exe 是否存在
 */
export function checkNodeBinary(): boolean {
  return existsSync(getNodeBinaryPath())
}

// 内置 Node 版本模块级缓存（避免重复 spawn 查询）
let cachedBundledNodeVersion = ''

/**
 * 获取内置 Node.js 的版本号（如 "22.19.0"）
 *
 * 用于 dsh-repair 在线更新时钉住 node-gyp 的 --target，确保 fs-ext 等
 * nan 源码编译型原生模块按内置 Node 的 ABI 编译，而非环境 PATH 上的系统 Node
 * （实测踩坑：系统 Node v24/ABI137 编出的 .node 在内置 Node v22/ABI127 下
 * 加载报 ERR_DLOPEN_FAILED，DSH 启动即崩）。
 *
 * @returns 内置 Node 版本号；查询失败返回空串（调用方据此跳过 target 设置）
 */
export function getBundledNodeVersion(): string {
  if (cachedBundledNodeVersion) return cachedBundledNodeVersion
  try {
    cachedBundledNodeVersion = execFileSync(getNodeBinaryPath(), ['-p', 'process.versions.node'], {
      encoding: 'utf8'
    }).trim()
  } catch {
    cachedBundledNodeVersion = ''
  }
  return cachedBundledNodeVersion
}
