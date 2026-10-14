import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { getNodeDir } from './node-binary'

/**
 * DSH 包树位置与「本次实际启动的树」的共享记录点
 *
 * 为什么单独成模块：`dsh-manager` 需要记录它命中的 DSH 根目录，`dsh-components`
 * 需要读它来决定按需组件的版本约束；而 `dsh-manager` 已经 import 了
 * `dsh-components`（取 `getComponentsNodePath`），反向 import 会形成循环依赖。
 * 本模块只依赖 node 内置库与 `node-binary`，是这张子图的叶子。
 *
 * 共享的是「出厂路径表达式」与「本次实际启动的树」两件事：
 * - 出厂路径此前在 `dsh-manager` 与 `dsh-components` 各拼一次，是 1.0.19-rc
 *   之前那个「路径少退一级」缺陷的温床（见 AGENTS.md §12.1 第 54 条）；
 *   收敛到本模块后只有一处定义。
 * - 实际启动的树必须由 `findCachedDshEntry()` 在**命中的那一刻**记录——
 *   从 bin 入口路径反推根目录不可靠（各版本 `bin` 字段的路径深度不同）。
 */

/** 本次 findCachedDshEntry() 实际命中的 DSH 包根目录 */
let activeDshPackageRoot: string | null = null

/**
 * 记录本次实际启动的 DSH 包根目录
 *
 * 唯一写入口，只应由 `findCachedDshEntry()` 在返回前调用。传 null 表示
 * 「本次查找未命中任何候选」。
 *
 * @param dir DSH 包根目录（其下有 package.json 与 node_modules/）
 */
export function setActiveDshPackageRoot(dir: string | null): void {
  activeDshPackageRoot = dir
}

/**
 * 取本次实际启动的 DSH 包根目录
 *
 * 记录值失效时返回 null（**不重解析**），调用方据此回退出厂树。DSH 更新场景
 * 无需重解析：`performUpdate()` 会在同一主进程内重新 `startDsh()` →
 * `findCachedDshEntry()`，记录值随之刷新。
 *
 * @returns DSH 包根目录；尚未解析成功或记录值已失效返回 null
 */
export function getActiveDshPackageRoot(): string | null {
  if (activeDshPackageRoot && existsSync(join(activeDshPackageRoot, 'package.json'))) {
    return activeDshPackageRoot
  }
  return null
}

/**
 * 出厂预装 DSH 树的**实际可用目录**（双态，1.0.19 起）
 *
 * - 打包后：出厂 DSH 以 `dsh-bundled.tar.zst` 单文件随包分发，首次启动由
 *   `dsh-unpack.ts` 解到 `%LOCALAPPDATA%/DSH Desktop/dsh-bundled/`。已解包 →
 *   返回该目录；**尚未解包** → 返回下面的 resources 路径（该路径不存在，
 *   `findCachedDshEntry()` 会自然跳过，这正是「未解包就不该被使用」的表达）。
 * - 开发模式：`.tar.zst` 不存在，直接返回 `resources/dsh-bundled/`。
 *
 * `resources/` 下两者是**兄弟目录**（都在 resources 下），不是 node 的子目录，
 * 必须退一级。别写成 `dirname(getNodeBinaryPath())`——那等于 `<resources>/node`，
 * 少退一级会解析到不存在的路径（AGENTS.md §12.1 第 54 条）。
 *
 * 单一权威：`dsh-manager` 与 `dsh-components` 都从这里取，不要各自拼。
 */
export function getBundledDshDir(): string {
  const unpacked = getDshUnpackTargetDir()
  if (existsSync(unpacked)) return unpacked
  return join(getNodeDir(), '..', 'dsh-bundled')
}

/**
 * 出厂 DSH 的 zstd 单文件（1.0.19 起）
 *
 * 出厂 DSH 不再以目录形式随安装包分发（11,322 个小文件会让 NSIS 载荷极慢），
 * 改为单个 `dsh-bundled.tar.zst`，首次启动时由 `dsh-unpack.ts` 解开。
 * 开发模式下该文件不存在——`resources/dsh-bundled/` 目录仍在，走原路径。
 *
 * @returns `.tar.zst` 绝对路径；不存在时调用方应跳过解包
 */
export function getDshUnpackZstPath(): string {
  return join(getNodeDir(), '..', 'dsh-bundled.tar.zst')
}

/**
 * 出厂 DSH 的解包目标（用户可写）
 *
 * 放 `%LOCALAPPDATA%` 而不是 `resources/`：后者在 Program Files 下，运行时写入
 * 会踩 NSIS 升级/卸载与杀软占用两个坑（AGENTS.md §12.1 第 50 条），这正是
 * libreoffice-kit 平台包当初移出 resources 的同一理由。
 */
export function getDshUnpackTargetDir(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'DSH Desktop', 'dsh-bundled')
}
