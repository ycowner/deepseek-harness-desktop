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

// 内置 Node 运行时信息模块级缓存（避免重复 spawn 查询）
let cachedBundledRuntime: BundledRuntimeInfo | null = null

/**
 * 内置 Node 运行时信息
 *
 * 两个字段均由一次 execFileSync 从内置 node.exe 动态查出，查询失败时为空串。
 */
export interface BundledRuntimeInfo {
  version: string   // 如 "24.21.0"（process.versions.node）
  abi: string       // 如 "137"（process.versions.modules，原生模块 ABI）
}

/**
 * 获取内置 Node.js 的版本号与原生模块 ABI（一次 spawn 同时取两项）
 *
 * 主要用途是诊断与展示（「关于」模态框）；dsh-repair 会把版本号作为
 * `npm_config_target` 传给 npm，但实测 npm 11 / node-gyp 12 已忽略 `--target`，
 * 编译目标恒等于「运行 node-gyp 的那个 Node」——所以 fs-ext 等 nan 源码编译型
 * 模块的 ABI 对齐实际由 dsh-repair 里的 PATH 前置内置 node 目录保证（见
 * dsh-repair.ts）。若 ABI 不一致，加载会报 ERR_DLOPEN_FAILED，DSH 启动即崩
 * （历史实例：系统 Node v24/ABI137 编出的 .node 在当时的内置 Node v22/ABI127
 * 下加载失败）。内置 Node 升 major 时本函数无需改动，它按当前二进制动态查询。
 */
export function getBundledRuntimeInfo(): BundledRuntimeInfo {
  if (cachedBundledRuntime) return cachedBundledRuntime
  let version = ''
  let abi = ''
  try {
    const out = execFileSync(
      getNodeBinaryPath(),
      ['-p', 'JSON.stringify({ version: process.versions.node, abi: process.versions.modules })'],
      { encoding: 'utf8' }
    ).trim()
    const parsed = JSON.parse(out) as { version?: unknown; abi?: unknown }
    if (typeof parsed.version === 'string') version = parsed.version
    if (typeof parsed.abi === 'string') abi = parsed.abi
  } catch {
    version = ''
    abi = ''
  }
  const info: BundledRuntimeInfo = { version, abi }
  // 查询失败（版本为空）时不写缓存，保留后续重试机会
  if (info.version) cachedBundledRuntime = info
  return info
}

/**
 * 获取内置 Node.js 的版本号（如 "24.21.0"）
 *
 * @returns 内置 Node 版本号；查询失败返回空串（调用方据此跳过 target 设置）
 */
export function getBundledNodeVersion(): string {
  return getBundledRuntimeInfo().version
}

/**
 * 获取内置 Node.js 的原生模块 ABI（如 "137"）
 *
 * @returns process.versions.modules；查询失败返回空串
 */
export function getBundledNodeAbi(): string {
  return getBundledRuntimeInfo().abi
}
