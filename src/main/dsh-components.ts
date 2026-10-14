import { existsSync, mkdirSync, readFileSync, writeFileSync, unlinkSync, renameSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { join, dirname } from 'path'
import { tmpdir, homedir } from 'os'
import { getNodeBinaryPath } from './node-binary'
import { fetchPackageDistIntegrity } from './dsh-version'
import { getActiveDshPackageRoot, getBundledDshDir } from './dsh-tree'
import {
  downloadFile,
  verifyFileIntegrity,
  installDshFromTarball,
  NPM_REGISTRY,
  NPM_REGISTRY_MIRROR
} from './dsh-repair'

/**
 * DSH 按需组件安装模块（1.0.19 起）
 *
 * 背景：`@deepseek-ai/libreoffice-kit-win32-x64` 是 DSH 依赖树里最大的单包
 * （181.5 MB 原始 / 约 68 MB 压缩，占 1.0.18 安装包的 27%），但它只服务
 * `.docx/.xlsx/.pptx → PDF` 转换，PDF/Excel 预览走的是同目录的
 * `lib/client.pdf.js` / `client.excel.js`，与它无关。因此改为运行时按需下载。
 *
 * 为什么**不需要占位包**：上游在平台包缺失时会自己抛一条可读错误——
 * `libreoffice-kit/lib/index.js` 的 `resolveEngine()` 在 win32 分支
 * 抛出 `Required LibreOfficeKit native package is missing: <name>`；
 * 该错误被 `dsh-office-to-pdf` 的 `createConverter().catch()` 接住，
 * 再包成 `OfficeToPdfError` 作为一次普通的工具调用失败返回，**不会崩会话**。
 * 而且同一处的 `delete slot.converter` 会在失败时让缓存失效，
 * 组件装好后下一次调用会自动重新初始化，无需重启 DSH。
 *
 * 为什么装在 %LOCALAPPDATA% 而不是安装目录：`resources/` 在 Program Files 下，
 * 运行时写入会踩 NSIS 升级/卸载与杀软占用两个既有坑（见 AGENTS.md §12.1 第 50 条）。
 * 改用 `NODE_PATH` 让 DSH 子进程在解析链末端看到该目录，不污染安装目录。
 */

/** 组件包名（含 scope），平台包与主机一一对应 */
const LIBREOFFICE_KIT_PACKAGE = '@deepseek-ai/libreoffice-kit-win32-x64'

/** 入口包名，用于读取平台包的版本约束 */
const LIBREOFFICE_KIT_ENTRY = '@deepseek-ai/libreoffice-kit'

/** rename 退避序列（毫秒），与 dsh-repair 的 renameWithRetry 同量级 */
const RENAME_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000]
const RENAME_MAX_ATTEMPTS = RENAME_BACKOFF_MS.length

/**
 * 组件安装根目录（用户可写）
 * @returns `%LOCALAPPDATA%/DSH Desktop/components`
 */
export function getComponentsDir(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'DSH Desktop', 'components')
}

/**
 * 组件的 node_modules 根目录
 *
 * 该目录整体作为 DSH 子进程的 `NODE_PATH`。Node 的模块解析先走 package.json
 * 向上逐级找 `node_modules/`，都找不到才查 `NODE_PATH`，因此
 * `libreoffice-kit` 里 `require.resolve()` 与 `installedPackageExists()`
 * （两者都基于 `require.resolve.paths()`）看到的是同一份结果，不会出现
 * 「一个说有、一个说没有」的不一致状态。
 *
 * @returns `%LOCALAPPDATA%/DSH Desktop/components/node_modules`
 */
export function getComponentsNodeModulesDir(): string {
  return join(getComponentsDir(), 'node_modules')
}

/** 注入给 DSH 子进程的 NODE_PATH 值 */
export function getComponentsNodePath(): string {
  return getComponentsNodeModulesDir()
}

function getPackageDir(packageName: string): string {
  return join(getComponentsNodeModulesDir(), ...packageName.split('/'))
}

/**
 * 读取入口包声明的平台包版本号
 *
 * 版本**不写死**：入口包 `@deepseek-ai/libreoffice-kit` 的
 * `optionalDependencies` 才是权威来源。上游把 `libreoffice-kit` 与
 * `libreoffice-kit-win32-x64` 一起发版，写死版本会在上游发新版后
 * 装错版本，被 `readEngine()` 的 `pkg.version !== ENGINE_VERSIONS[target]`
 * 判定为「incompatible or incomplete manifest」而直接失效。
 *
 * **读哪棵树**：必须读**本次实际运行的那棵** DSH（`getActiveDshPackageRoot()`），
 * 出厂 `dsh-bundled` 只作兜底。因为两棵树会分叉——用户更新过 DSH 后，
 * `dsh-cache/dsh` 是 1 优先级（`findCachedDshEntry()` 实际运行它），
 * 而 `dsh-bundled` 停在出厂版本；两者的 `optionalDependencies` 不同。
 * 固定读 `dsh-bundled` 会让运行中的 DSH 拿到另一棵树要求的版本，
 * 必然被强校验判为「incompatible or incomplete manifest」。
 *
 * @returns 版本号字符串；所有候选都读不到返回 null
 */
export function getRequiredLibreOfficeKitVersion(): string | null {
  // 运行中的树优先 → 出厂树兜底（记录值可能因用户手工删目录而失效）
  const candidates = [getActiveDshPackageRoot(), getBundledDshDir()]
  for (const dshRoot of candidates) {
    if (!dshRoot) continue
    const entryPkg = join(dshRoot, 'node_modules', ...LIBREOFFICE_KIT_ENTRY.split('/'), 'package.json')
    try {
      const pkg = JSON.parse(readFileSync(entryPkg, 'utf-8')) as {
        optionalDependencies?: Record<string, string>
      }
      const version = pkg.optionalDependencies?.[LIBREOFFICE_KIT_PACKAGE]
      if (typeof version === 'string' && version.length > 0) return version
    } catch {
      // 换下一棵候选
    }
  }
  return null
}

/**
 * 判断组件是否已就绪
 *
 * 校验四件事，缺一不可：`package.json` 在、`prebuilds.json` 在、
 * 清单声明的可执行文件在、**已装版本与当前 DSH 要求的版本一致**。
 *
 * 第三条最关键——`readEngine()` 最终会 `stat()` `engine.executable`，
 * 只有前两条而缺 exe 的话，上游报的错是「is not a file」而不是「组件未安装」，
 * 会误导排查。
 *
 * 第四条是自愈的前提：DSH 更新后要求的新版本与已装版本不同时，此处必须返回
 * false，否则菜单会一直谎报「已安装」，系统没有任何机会重装。配合
 * `reconcileComponentsAfterDshUpdate()` 重置 `attemptedThisSession` 闸门，
 * 版本错位能自动纠正到正确版本。
 *
 * 要求版本读不到（`required` 为 null，通常是 DSH 树异常）时**不比较版本**——
 * 否则每次启动都判定未就绪，白白重下 68 MB。
 *
 * @returns 已就绪返回 true
 */
export function isLibreOfficeKitReady(): boolean {
  const dir = getPackageDir(LIBREOFFICE_KIT_PACKAGE)
  const pkgPath = join(dir, 'package.json')
  const manifestPath = join(dir, 'prebuilds.json')
  if (!existsSync(pkgPath) || !existsSync(manifestPath)) return false
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { name?: string; version?: string }
    if (pkg.name !== LIBREOFFICE_KIT_PACKAGE) return false
    // 版本一致性：与运行中的 DSH 所要求的版本对不上就是「已装了个废的」
    const required = getRequiredLibreOfficeKitVersion()
    if (required && pkg.version !== required) {
      console.log(`[DSH Components] 已装版本 ${pkg.version} 与当前 DSH 要求的 ${required} 不一致，判定为未就绪以触发重装`)
      return false
    }
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8')) as {
      schemaVersion?: number
      status?: string
      platform?: string
      version?: string
      engine?: { kind?: string; executable?: string }
    }
    if (
      manifest.schemaVersion !== 1 ||
      manifest.status !== 'built' ||
      manifest.platform !== 'win32-x64' ||
      manifest.version !== pkg.version ||
      manifest.engine?.kind !== 'native' ||
      typeof manifest.engine?.executable !== 'string'
    ) {
      return false
    }
    return statSync(join(dir, manifest.engine.executable)).isFile()
  } catch {
    return false
  }
}

/**
 * 同卷 rename，Windows 杀软/索引器瞬时占用时退避重试
 *
 * 与 dsh-repair.renameWithRetry 同理：占用是瞬时的，扫描走完即释放；
 * `EXDEV` / `ENOENT` 这类确定性错误立即抛出，不浪费等待。
 */
async function renameWithRetry(from: string, to: string, onRetry?: (attempt: number, wait: number) => void): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      renameSync(from, to)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw err
      if (attempt === RENAME_MAX_ATTEMPTS) throw err
      const wait = RENAME_BACKOFF_MS[Math.min(attempt - 1, RENAME_BACKOFF_MS.length - 1)]
      onRetry?.(attempt, wait)
      // setTimeout 异步等待：主线程空闲，不会把 GUI 拖成「未响应」
      await new Promise<void>((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** 组件安装结果 */
export interface InstallComponentResult {
  success: boolean
  /** 失败原因（success 为 false 时给出） */
  error?: string
  /** 实际安装到的包目录 */
  packageDir?: string
}

/** 互斥锁：防止后台预取与用户手动触发同时跑两个 npm install */
let isInstalling = false

/** 本次进程内是否已经尝试过（成功或失败），避免每次启动都重试网络 */
let attemptedThisSession = false

/**
 * 下载并安装按需组件（当前仅 libreoffice-kit 平台包）
 *
 * 流程与 dsh-repair 的 prepare/activate 同构，但更简单——单包无依赖，
 * 不需要版本切换，因此直接在目标目录旁建 staging、装完再换位：
 * 1. 读入口包拿到权威版本号
 * 2. 查 packument 拿 dist.integrity
 * 3. 下载 tgz（国内镜像优先，失败回退 npm registry）
 * 4. sha512 校验
 * 5. 在 staging 目录跑 `npm install <tgz>`（npm 会落到
 *    `staging/node_modules/@deepseek-ai/libreoffice-kit-win32-x64/`）
 * 6. 两次同卷 rename 换到最终位置，旧的异步回收
 *
 * 全程不删大树（AGENTS.md §12.1 第 49、50 条），换位用 rename。
 *
 * @param onProgress 进度回调（文字描述）
 * @returns 安装结果
 */
export async function installLibreOfficeKit(onProgress?: (msg: string) => void): Promise<InstallComponentResult> {
  const report = (msg: string): void => {
    console.log(`[DSH Components] ${msg}`)
    onProgress?.(msg)
  }

  if (isInstalling) return { success: false, error: '组件正在下载中，请稍候' }
  if (isLibreOfficeKitReady()) {
    attemptedThisSession = true
    return { success: true, packageDir: getPackageDir(LIBREOFFICE_KIT_PACKAGE) }
  }
  isInstalling = true
  attemptedThisSession = true

  const targetDir = getPackageDir(LIBREOFFICE_KIT_PACKAGE)
  let tempDir: string | null = null
  let stagingDir: string | null = null
  let retiredDir: string | null = null

  try {
    if (!existsSync(getNodeBinaryPath())) {
      throw new Error('内置 Node.js 不存在，无法安装文档预览组件')
    }

    const version = getRequiredLibreOfficeKitVersion()
    if (!version) {
      throw new Error('无法从 DSH 运行时读取 libreoffice-kit 的版本约束，请重装 DSH 运行包')
    }
    report(`需要版本: ${version}`)

    report('正在查询包完整性...')
    const integrity = await fetchPackageDistIntegrity(LIBREOFFICE_KIT_PACKAGE, version)

    // staging 与目标同父目录，保证 rename 同卷
    const componentsDir = getComponentsDir()
    mkdirSync(componentsDir, { recursive: true })
    const baseName = `${LIBREOFFICE_KIT_PACKAGE.split('/')[1]}-${version}`
    stagingDir = join(componentsDir, `${baseName}.new.${Date.now()}`)
    mkdirSync(stagingDir, { recursive: true })

    // 预检查可写：别等 30 秒的 npm install 跑完才发现没权限
    try {
      const probe = join(stagingDir, '.write-test')
      writeFileSync(probe, '')
      unlinkSync(probe)
    } catch {
      throw new Error('组件目录不可写，请检查磁盘空间或权限设置')
    }

    tempDir = join(tmpdir(), `dsh-component-${Date.now()}`)
    mkdirSync(tempDir, { recursive: true })
    const tgzPath = join(tempDir, `${baseName}.tgz`)

    let lastReportedMB = -1
    const reportProgress = (downloaded: number): void => {
      const mb = Math.floor(downloaded / (1024 * 1024))
      if (mb !== lastReportedMB) {
        lastReportedMB = mb
        report(`下载中: ${mb} MB`)
      }
    }

    const tarballName = `${baseName}.tgz`
    const mirrorUrl = `${NPM_REGISTRY_MIRROR}/${LIBREOFFICE_KIT_PACKAGE}/-/${tarballName}`
    const primaryUrl = `${NPM_REGISTRY}/${LIBREOFFICE_KIT_PACKAGE}/-/${tarballName}`

    report('正在下载文档预览组件（国内镜像）...')
    try {
      await downloadFile(mirrorUrl, tgzPath, reportProgress)
    } catch (mirrorErr) {
      report(`国内镜像下载失败，回退到 npm registry: ${(mirrorErr as Error).message}`)
      if (existsSync(tgzPath)) {
        try { unlinkSync(tgzPath) } catch { /* 忽略 */ }
      }
      lastReportedMB = -1
      report('正在下载文档预览组件（npm registry）...')
      await downloadFile(primaryUrl, tgzPath, reportProgress)
    }
    report('下载完成，正在校验...')
    await verifyFileIntegrity(tgzPath, integrity)
    report('校验通过，正在安装...')

    await installDshFromTarball(tgzPath, stagingDir, (msg) => report(msg))

    const stagedPackage = join(stagingDir, 'node_modules', ...LIBREOFFICE_KIT_PACKAGE.split('/'))
    if (!existsSync(join(stagedPackage, 'prebuilds.json'))) {
      throw new Error('安装结果不完整（缺少 prebuilds.json）')
    }

    // 换位：先让旧目录退位，再把 staging 里的包搬上
    mkdirSync(dirname(targetDir), { recursive: true })
    if (existsSync(targetDir)) {
      retiredDir = join(componentsDir, `${baseName}.old.${Date.now()}`)
      await renameWithRetry(targetDir, retiredDir, (attempt, wait) => {
        report(`旧组件目录被占用，${wait}ms 后重试（第 ${attempt} 次）...`)
      })
    }
    await renameWithRetry(stagedPackage, targetDir, (attempt, wait) => {
      report(`组件目录被占用，${wait}ms 后重试（第 ${attempt} 次）...`)
    })
    report('组件安装完成')

    // 异步回收 staging 与旧目录，绝不在主线程上删大树
    void fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ })
    if (retiredDir) {
      void fsp.rm(retiredDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ })
    }

    return { success: true, packageDir: targetDir }
  } catch (err) {
    const message = (err as Error).message
    report(`安装失败: ${message}`)
    // 失败不留半成品：staging 是独立目录，删掉即可；目标目录可能缺组件，
    // 交给 isLibreOfficeKitReady() 的下一次判定
    if (stagingDir) {
      void fsp.rm(stagingDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ })
    }
    return { success: false, error: message }
  } finally {
    // 下载缓存（tgz，本例 68 MB）**成功路径同样要删**——只写在 catch 里会让每次成功安装
    // 都在 %TEMP% 留下一个 dsh-component-<ts> 目录，长期累积。放 finally 保证两条路径都覆盖。
    if (tempDir) {
      void fsp.rm(tempDir, { recursive: true, force: true }).catch(() => { /* 忽略 */ })
    }
    isInstalling = false
  }
}

/**
 * 首次启动后的后台预取
 *
 * 只在「未装过 + 本次进程没试过」时跑，失败静默——文档预览是可选能力，
 * 下载失败不该打扰用户（与公告拉取失败静默同一原则，AGENTS.md §12.1 第 48 条）。
 * 用户可从「帮助」菜单手动重试。
 */
export function prefetchComponentsInBackground(): void {
  if (attemptedThisSession) return
  if (isLibreOfficeKitReady()) {
    attemptedThisSession = true
    return
  }
  console.log('[DSH Components] 文档预览组件未安装，启动后台预取')
  void installLibreOfficeKit().then((result) => {
    if (!result.success) {
      console.warn(`[DSH Components] 后台预取失败: ${result.error}`)
    }
  })
}

/**
 * DSH 运行包更新后的组件版本对齐
 *
 * 调用时机：`performUpdate()` 里 **DSH 重启完成之后**（必须晚于
 * `startDsh()` → `findCachedDshEntry()`，否则 `getActiveDshPackageRoot()`
 * 还是旧树的记录值）。
 *
 * 做的事只有一件：重置「本次进程只试一次」闸门。
 * 闸门存在的意义是避免每次启动都重试网络；DSH 更新改变了组件的版本约束，
 * 这个前提不再成立，必须允许再判一次。后续版本是否对齐由
 * `isLibreOfficeKitReady()` 的版本一致性校验自己决定——
 * 不一致就静默重装，一致就什么都不做。
 *
 * 不加「强制重新安装」入口：杀软隔离 exe 这类真损坏已被就绪判定里的
 * `statSync(...).isFile()` 覆盖，用户手动重试路径本来就通。
 *
 * @returns 是否发起了重装
 */
export function reconcileComponentsAfterDshUpdate(): boolean {
  // 关键：DSH 更新后闸门必须清零，否则本进程内永远不会再尝试对齐
  attemptedThisSession = false

  if (isInstalling) {
    // 极窄场景：用户正在下载组件时点了「更新DSH」。不打断它（重装代价 68 MB），
    // 已装结果是旧版本；闸门已清零，本次进程不会自愈，下次启动会自动重试。
    console.log('[DSH Components] 组件正在安装中，DSH 更新后的版本对齐将在下次启动时进行')
    return false
  }

  if (isLibreOfficeKitReady()) {
    // 版本本就一致（或读不到要求版本），无需下载
    attemptedThisSession = true
    return false
  }

  console.log('[DSH Components] DSH 已更新，文档预览组件版本不再匹配，启动后台重装')
  void installLibreOfficeKit().then((result) => {
    if (!result.success) {
      console.warn(`[DSH Components] 更新后对齐重装失败: ${result.error}`)
    }
  })
  return true
}

/** 组件状态，供 UI 展示 */
export interface ComponentStatus {
  /** libreoffice-kit 平台包是否已安装 */
  libreOfficeKitReady: boolean
  /** 当前需要的平台包版本号 */
  requiredVersion: string | null
}

export function getComponentStatus(): ComponentStatus {
  return {
    libreOfficeKitReady: isLibreOfficeKitReady(),
    requiredVersion: getRequiredLibreOfficeKitVersion()
  }
}
