import { app } from 'electron'
import { join } from 'path'
import { existsSync } from 'fs'

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
