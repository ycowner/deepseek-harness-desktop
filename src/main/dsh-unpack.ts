import { createReadStream, existsSync, readFileSync, statSync } from 'fs'
import { promises as fsp } from 'fs'
import { createZstdDecompress } from 'zlib'
import { join } from 'path'
import { homedir } from 'os'
import { getDshUnpackTargetDir, getDshUnpackZstPath } from './dsh-tree'

/**
 * 出厂 DSH 树的 zstd 运行时解包（1.0.19 起）
 *
 * 背景：出厂 DSH（11,322 个文件 / 155.3 MB）原先以目录形式随安装包分发。
 * electron-builder 的 NSIS 载荷是**逐文件**压缩的，装机要写 1.1 万个小文件；
 * 而换用 7z/LZMA2 又会因为 LZMA2 解压慢（实测约 340 秒）而不可接受。
 *
 * 做法：把整棵树打成单个 `dsh-bundled.tar.zst`（构建期 `scripts/bundle-dsh-zst.js`），
 * 安装时不解压，首次启动时用 Electron 自带 Node 的 `zlib.createZstdDecompress`
 * 解开。zstd-9 实测解压 11,303 个文件 9 秒、压缩后体积 37.5 MB
 * （原逐文件 deflate 为 50.6 MB），两个指标同时改善。
 *
 * 为什么解到 %LOCALAPPDATA% 而不是 resources/：
 * resources/ 在 Program Files 下，运行时写入会踩 NSIS 升级/卸载与杀软占用两个坑
 * （AGENTS.md §12.1 第 50 条）——这正是 libreoffice-kit 平台包当初移出 resources 的理由。
 *
 * 依赖约束：本模块只依赖 node 内置模块与 dsh-tree，**不得** import dsh-repair /
 * dsh-manager / dsh-components。dsh-manager 会 import 本模块，而 dsh-repair → dsh-version
 * → dsh-manager 已构成环，再引回去会放大成 4 节点环。故退避 rename 在此自行实现。
 */

/** tar 块大小（ustar 固定 512 字节） */
const TAR_BLOCK = 512

/** 换位退避序列（毫秒）。与 dsh-repair 的 renameWithRetry 同量级 */
const RENAME_BACKOFF_MS = [250, 500, 1000, 2000, 4000, 8000]

/** 进度回报节流：每处理这么多文件回调一次 */
const PROGRESS_EVERY = 1000

/** 标记文件名：记录已解包的是哪个 zst */
const MANIFEST_FILE = '.dsh-bundled-manifest.json'

/**
 * 递归删除的参数
 *
 * ⚠ `maxRetries` 不是可选项：Node 的 `fs.rm` **默认为 0**，即遇到 EPERM/EBUSY
 * 立即失败。这里要删的是 1.1 万个文件（155 MB），而本机杀软（腾讯电脑管家）
 * 必然会在扫描新写文件时瞬时占用其中某几个——本轮实测就因此只删掉了全部文件
 * 却留下空目录，且错误被 `.catch()` 静默吞掉，表现为「每次升级泄漏一份出厂树」。
 * 开启重试后单次删除的失败率降到可忽略；仍失败则下次启动的 sweep 再试。
 */
const RM_OPTIONS = { recursive: true, force: true, maxRetries: 5, retryDelay: 200 } as const

/**
 * 异步递归删除，失败只记日志不抛出
 *
 * 绝不在主线程同步删除大树：1.1 万文件的同步删除会把 GUI 拖成「未响应」
 * （AGENTS.md §12.1 第 50 条）。错误必须留痕——静默失败会让磁盘泄漏无法定位。
 *
 * @param dir 要删的目录
 * @param what 上下文描述，仅用于日志
 */
function removeTreeAsync(dir: string | null, what: string): void {
  if (!dir) return
  void fsp
    .rm(dir, RM_OPTIONS)
    .then(() => {
      console.log(`[DSH Unpack] ${what}已清理: ${dir}`)
    })
    .catch((err: NodeJS.ErrnoException) => {
      console.warn(`[DSH Unpack] ${what}清理失败（${err.code}）: ${dir}；下次启动会再试`)
    })
}

/**
 * 同卷 rename，Windows 杀软/索引器瞬时占用时退避重试
 *
 * 占用是瞬时的（扫描走完即释放），`EXDEV`/`ENOENT` 这类确定性错误立即抛出不浪费等待。
 * 等待用 setTimeout 异步实现，主线程空闲，不会把 GUI 拖成「未响应」。
 */
async function renameWithRetry(from: string, to: string, onRetry?: (attempt: number, wait: number) => void): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_BACKOFF_MS.length; attempt++) {
    try {
      await fsp.rename(from, to)
      return
    } catch (err) {
      const e = err as NodeJS.ErrnoException
      if (e.code !== 'EPERM' && e.code !== 'EACCES' && e.code !== 'EBUSY') throw err
      if (attempt === RENAME_BACKOFF_MS.length) throw err
      const wait = RENAME_BACKOFF_MS[attempt - 1]
      onRetry?.(attempt, wait)
      await new Promise<void>((resolve) => setTimeout(resolve, wait))
    }
  }
}

/** 解析一个 512 字节 ustar header；遇到全零块返回 null（tar 结束） */
function parseHeader(buf: Buffer): { name: string; size: number; pad: number } | null {
  if (buf.every((b) => b === 0)) return null

  // typeflag 位于 156；本项目只写普通文件（'0'）
  const type = String.fromCharCode(buf[156])
  if (type !== '0' && type !== '\0') {
    throw new Error(`打包产物含非普通文件条目（typeflag=${JSON.stringify(type)}），不支持`)
  }

  const name = buf.toString('utf-8', 0, 100).replace(/\0.*$/, '')
  const prefix = buf.toString('utf-8', 345, 500).replace(/\0.*$/, '')
  const fullName = prefix ? `${prefix}/${name}` : name

  const sizeStr = buf.toString('ascii', 124, 136).replace(/[\0 ]/g, '')
  const size = parseInt(sizeStr, 8) || 0

  return { name: fullName, size, pad: (TAR_BLOCK - (size % TAR_BLOCK)) % TAR_BLOCK }
}

/**
 * 流式解包：zstd → tar → 落盘
 *
 * 内存恒定（不把 155 MB 攒在缓冲里）：逐块读解压流，按 tar 的「header + 数据」
 * 顺序状态机切分，每个文件用 `FileHandle.write()` 异步写并显式等待。
 * 全程不用 `*Sync` 写文件——主线程同步 fs 超过约 5 秒会被 Windows 判「未响应」
 * （AGENTS.md §12.1 第 50 条）。
 */
async function extractTarZstTo(zstPath: string, destDir: string, onProgress?: (done: number, total: number) => void): Promise<number> {
  const input = createReadStream(zstPath, { highWaterMark: 4 * 1024 * 1024 })
  const decompress = createZstdDecompress()
  input.pipe(decompress)

  const header = Buffer.alloc(TAR_BLOCK)
  let headerFill = 0
  let current: { size: number; pad: number; handle: fsp.FileHandle | null } | null = null
  let done = 0
  let sawEnd = false

  for await (const chunk of decompress) {
    let offset = 0
    while (offset < chunk.length) {
      if (current === null) {
        // ---- header 阶段 ----
        const take = Math.min(TAR_BLOCK - headerFill, chunk.length - offset)
        chunk.copy(header, headerFill, offset, offset + take)
        headerFill += take
        offset += take
        if (headerFill < TAR_BLOCK) break

        const entry = parseHeader(header)
        headerFill = 0
        if (entry === null) { sawEnd = true; break }

        // 安全校验：拒绝逃逸出目标目录的路径（tar 路径穿越防护）
        const rel = entry.name.replace(/\\/g, '/')
        if (rel.startsWith('/') || rel.includes('../')) {
          throw new Error(`打包产物含非法路径: ${entry.name}`)
        }
        const filePath = join(destDir, ...rel.split('/'))
        await fsp.mkdir(join(filePath, '..'), { recursive: true })
        current = { size: entry.size, pad: entry.pad, handle: await fsp.open(filePath, 'w') }
      } else {
        // ---- 数据阶段 ----
        if (current.size > 0) {
          const take = Math.min(current.size, chunk.length - offset)
          await current.handle!.write(chunk, offset, take)
          current.size -= take
          offset += take
        }
        if (current.size === 0) {
          if (current.pad > 0) {
            const p = Math.min(current.pad, chunk.length - offset)
            offset += p
            current.pad -= p
          }
          if (current.pad === 0) {
            await current.handle!.close()
            current = null
            done++
            onProgress?.(done, 0)
          }
        }
      }
    }
    if (sawEnd) break
  }

  if (current !== null) {
    await current.handle?.close()
    throw new Error('解包中断：tar 数据不完整')
  }
  if (!sawEnd) {
    throw new Error('解包中断：未读到 tar 结束标记，打包产物可能已损坏')
  }
  return done
}

/** 清扫上次解包/换位留下的 .new.* / .old.* 残留 */
async function sweepStaleDirs(parentDir: string): Promise<void> {
  let entries: string[]
  try {
    entries = await fsp.readdir(parentDir)
  } catch {
    return
  }
  let found = 0
  for (const name of entries) {
    if (!/^dsh-bundled\.(new|old)\./.test(name)) continue
    found++
    removeTreeAsync(join(parentDir, name), '残留目录')
  }
  if (found > 0) console.log(`[DSH Unpack] 发现 ${found} 个残留目录，已发起清理`)
}

/**
 * 确保出厂 DSH 已解包到用户可写目录（幂等）
 *
 * 调用点：`startDsh()` 内、`findCachedDshEntry()` 之前，且**必须在它之后没有别的
 * DSH 树记录写入**——本函数自己也会调 `setActiveDshPackageRoot()`。
 *
 * 三种情况直接返回：
 * - 开发模式（没有 .tar.zst）：`resources/dsh-bundled` 目录仍在，走原路径
 * - 标记与当前 zst 一致：已解包过，秒级返回
 * - 正在解包：本次进程已发起过，交给那一路
 *
 * @param onProgress 进度回调（文字描述，会显示在 loading 页）
 */
export async function ensureBundledDshExtracted(onProgress?: (msg: string) => void): Promise<void> {
  const zstPath = getDshUnpackZstPath()
  if (!existsSync(zstPath)) return // 开发模式

  const targetDir = getDshUnpackTargetDir()
  const parentDir = join(targetDir, '..')

  // 清扫上次的残留。
  // ⚠ 必须放在「标记命中直接 return」**之前**：换位时旧树被 rename 成
  // `dsh-bundled.old.<ts>`（155 MB / 1.1 万文件），它的删除是异步的
  // （`void fsp.rm(...)`），常在下一次启动时还没删完。若把清扫排在 return 之后，
  // 正常启动路径永远不会执行，磁盘就会长期泄漏一份出厂树。
  // 只清 `.new`/`.old`，不动当前的 `dsh-bundled`。
  await sweepStaleDirs(parentDir)

  // 标记比对：size + mtimeMs 唯一标识一个 zst 版本。
  // 应用升级会带来新的 zst（两者都变）→ 自动重解；同一版本则秒级跳过。
  let st: { size: number; mtimeMs: number }
  try {
    const s = statSync(zstPath)
    st = { size: s.size, mtimeMs: Math.round(s.mtimeMs) }
  } catch {
    return
  }

  const manifestPath = join(targetDir, MANIFEST_FILE)
  if (existsSync(manifestPath) && existsSync(join(targetDir, 'package.json'))) {
    try {
      const m = JSON.parse(readFileSync(manifestPath, 'utf-8')) as { size?: number; mtimeMs?: number }
      if (m.size === st.size && m.mtimeMs === st.mtimeMs) return
    } catch {
      // 标记损坏 → 重新解包
    }
  }

  const stagingDir = join(parentDir, `dsh-bundled.new.${Date.now()}`)
  const retiredDir = join(parentDir, `dsh-bundled.old.${Date.now()}`)
  onProgress?.('正在准备 DSH 运行组件...')

  let retired = false
  try {
    await fsp.mkdir(stagingDir, { recursive: true })
    const t0 = Date.now()
    const total = await extractTarZstTo(zstPath, stagingDir, (done) => {
      onProgress?.(`正在展开 DSH 运行组件... ${done} 个文件`)
    })
    const secs = ((Date.now() - t0) / 1000).toFixed(1)

    // 写标记：先写进 staging，成功换位后它就在 target 里了
    await fsp.writeFile(
      join(stagingDir, MANIFEST_FILE),
      JSON.stringify({ ...st, files: total, unpackedAt: Date.now() }, null, 2),
      'utf-8'
    )

    // 原子换位：旧目录先退位，新目录再上位（同卷 rename，毫秒级）
    if (existsSync(targetDir)) {
      await renameWithRetry(targetDir, retiredDir, (attempt, wait) => {
        onProgress?.(`DSH 组件目录被占用，${wait}ms 后重试（第 ${attempt} 次）...`)
      })
      retired = true
    }
    await renameWithRetry(stagingDir, targetDir, (attempt, wait) => {
      onProgress?.(`DSH 组件目录被占用，${wait}ms 后重试（第 ${attempt} 次）...`)
    })
    onProgress?.(`DSH 运行组件已就绪（${total} 个文件，${secs} 秒）`)

    // 旧目录异步回收。删除 1.1 万个文件要好几秒，不能挡住返回；
    // 失败也不该阻断启动——下次启动的 sweep 会再试。
    if (retired) removeTreeAsync(retiredDir, '换位退位目录')
  } catch (err) {
    // 换位失败时把旧目录换回原位，避免用户彻底没有可用的 DSH 树
    if (retired && !existsSync(targetDir)) {
      try {
        await fsp.rename(retiredDir, targetDir)
      } catch {
        // 换回也失败：staging 仍留在磁盘上，下次启动会重新解包
      }
    }
    removeTreeAsync(stagingDir, '解包暂存目录')
    throw err
  }
}

/** 用户可写目录（导出供 UI 展示占用与排障） */
export function getDshUnpackRoot(): string {
  const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
  return join(localAppData, 'DSH Desktop')
}
