// @ts-check
/**
 * 把 `resources/dsh-bundled/` 打成单个 `dsh-bundled.tar.zst`
 *
 * 1.0.19 起：DSH 运行时（11,322 个文件 / 155.3 MB 原始）改为安装包内单文件存放，
 * 由主进程在**首次启动时**解包到 `%LOCALAPPDATA%/DSH Desktop/dsh-bundled/`。
 *
 * 为什么要这么做（三个实测数字）：
 * 1. 安装耗时：electron-builder 的 NSIS 载荷是逐文件 deflate，装机要写 1.1 万个小
 *    文件。改为单文件后安装阶段只写约 72 个文件 + 1 个 .zst。
 * 2. 压缩率：zstd 单流跨文件共享字典，明显优于逐文件独立 deflate。实测
 *    dsh-bundled 50.6 MB → 33.9 MB（zstd-19）/ 37.7 MB（zstd-9）。
 * 3. 为什么不用安装时解：electron-builder 25 在 NsisTarget.js:75 把载荷格式硬编码为
 *    zip/7z 二选一，且 NSIS 的 Nsis7z 插件**不支持 zstd 压缩方法**。只有走运行时解包。
 *
 * 为什么用内置 Node 跑（本脚本由 scripts/preinstall-dsh.js 用 resources/node/node.exe
 * 调用）：v24.21.0 自带 `zlib.zstdCompressSync`，不引入任何第三方压缩依赖。
 *
 * 容器格式：标准 ustar tar。选它而不是自定义二进制格式，是为了人工可排查——
 * Windows 自带 bsdtar、Python tarfile 都能读，本项目历史上多个「只在实机才暴露」的
 * 缺陷（AGENTS.md §12.1 第 53/54/55 条）都受益于产物可被外部工具检视。
 */

const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const PROJECT_ROOT = path.resolve(__dirname, '..')
const BUNDLED_DSH_DIR = path.join(PROJECT_ROOT, 'resources', 'dsh-bundled')
const OUT_FILE = path.join(PROJECT_ROOT, 'resources', 'dsh-bundled.tar.zst')

/** zstd 压缩级别。9 是体积/构建时间的平衡点（-19.9 MB，打包 3.3s）。 */
const ZSTD_LEVEL = 9

// ---------------------------------------------------------------------------
// 裁剪规则：从 electron-builder.yml 的 extraResources.filter 逐条迁移而来
// ---------------------------------------------------------------------------
// ⚠ 必须还原 yml 的三段时序语义，否则裁剪结果必然不同（首次迁移漏了 4 类，
//   由「解包产物 vs 打包产物逐文件 diff」查出）：
//
//   [第 1 段] 负向 pattern：!**/node_modules/**/{*.map,*.md,test,tests,__tests__,
//             .github,.eslintrc*,.nycrc*,.editorconfig} 与 node-pty 非 win32-x64 的
//             prebuilds —— **只对第三方包生效**（对 @deepseek-ai 随后被豁免覆盖）
//
//   [第 2 段] 正向豁免：`**/node_modules/@deepseek-ai/**` —— 使第 1 段对上游自家
//             包全部失效（README 运行时可能读取，故必须保留）
//
//   [第 3 段] 再负向：**/dist-types/**、**/*.d.ts|.d.cts|.d.mts、**/*.pdb、
//             node-pty/{build,third_party}/**、libreoffice-kit-*/sources/**、
//             libreoffice-kit-win32-*/** —— **对所有包生效（含 @deepseek-ai）**
//
// 另注意：第 1 段的 pattern 都带 `**/node_modules/**` 前缀，所以**根目录下
// 的文件（如 DSH 本体的 README.md）不受它们影响**，必须保留。

/** 第 3 段：目录/整包排除，对所有文件生效 */
const EXCLUDE_DIR_PREFIXES = [
  'node_modules/node-pty/build', // node-pty 原生绑定只从 prebuilds/win32-x64/ 加载
  'node_modules/node-pty/third_party', // 同上，重复拷贝
  'node_modules/@deepseek-ai/libreoffice-kit-win32-x64', // 1.0.19 已改按需下载，见 dsh-components.ts
  'node_modules/@deepseek-ai/libreoffice-kit-win32-arm64',
  'node_modules/@deepseek-ai/libreoffice-kit-win32-ia32'
]

/** 第 3 段：libreoffice-kit 平台包把打包期构建脚本也发进了 npm 包 */
const EXCLUDE_SOURCES_IN_PREFIX = 'node_modules/@deepseek-ai/libreoffice-kit-'

/** 第 3 段：文件后缀，对所有文件生效（含 @deepseek-ai） */
const EXCLUDE_SUFFIXES_ALL = ['.pdb', '.d.ts', '.d.cts', '.d.mts']

/** 第 3 段：目录名，对所有文件生效 */
const EXCLUDE_DIR_NAMES_ALL = ['dist-types']

/** 第 1 段：仅对第三方包（node_modules 下、非 @deepseek-ai）生效 */
const EXCLUDE_SUFFIXES_THIRD_PARTY = ['.map', '.md']
const EXCLUDE_DIR_NAMES_THIRD_PARTY = ['test', 'tests', '__tests__', '.github']
const EXCLUDE_FILENAME_PATTERNS_THIRD_PARTY = [/^\.eslintrc/, /^\.nycrc/, /^\.editorconfig$/]

/** 第 1 段：node-pty 预编译产物，目标平台仅 win32-x64 */
const NODE_PTY_PREBUILDS = 'node_modules/node-pty/prebuilds/'
const NODE_PTY_KEEP_PLATFORM = 'win32-x64'

/**
 * 判断某个文件是否应被打进 tar
 * @param {string} relPath 相对 dsh-bundled 的 posix 路径，如 'node_modules/zod/index.js'
 * @returns {boolean}
 */
function shouldInclude(relPath) {
  const parts = relPath.split('/')
  const name = parts[parts.length - 1]
  const inNodeModules = parts[0] === 'node_modules'
  const isUpstreamDsh = inNodeModules && parts[1] === '@deepseek-ai'

  // ---- 第 3 段：全局排除 ----
  for (const prefix of EXCLUDE_DIR_PREFIXES) {
    if (relPath === prefix || relPath.startsWith(prefix + '/')) return false
  }
  if (relPath.startsWith(EXCLUDE_SOURCES_IN_PREFIX) && parts.includes('sources')) return false
  if (relPath.startsWith(NODE_PTY_PREBUILDS) && parts[3] !== NODE_PTY_KEEP_PLATFORM) return false
  if (EXCLUDE_DIR_NAMES_ALL.includes(name)) return false
  for (const part of parts) {
    if (EXCLUDE_DIR_NAMES_ALL.includes(part)) return false
  }
  if (EXCLUDE_SUFFIXES_ALL.some((s) => name.endsWith(s))) return false

  // ---- 第 1 段：仅第三方包生效（根目录与 @deepseek-ai 均豁免）----
  if (inNodeModules && !isUpstreamDsh) {
    if (EXCLUDE_SUFFIXES_THIRD_PARTY.some((s) => name.endsWith(s))) return false
    for (const part of parts) {
      if (EXCLUDE_DIR_NAMES_THIRD_PARTY.includes(part)) return false
    }
    if (EXCLUDE_FILENAME_PATTERNS_THIRD_PARTY.some((re) => re.test(name))) return false
  }

  return true
}

// ---------------------------------------------------------------------------
// ustar tar 写入
// ---------------------------------------------------------------------------
const BLOCK = 512

/**
 * 写单个 ustar header
 * @param {string} arName 已转正斜杠的相对路径
 * @param {number} size 文件字节数
 * @param {Buffer} header 512 字节缓冲（会被填满）
 */
function writeHeader(arName, size, header) {
  header.fill(0)

  let name = arName
  let prefix = ''
  // ustar 限制：name 字段 100 字节、prefix 字段 155 字节。
  // 从后往前找第一个 '/'，它保证 name = slice(idx+1) 的长度 <= 100。
  if (Buffer.byteLength(name) > 100) {
    const lowerBound = Math.max(0, name.length - 101)
    let idx = -1
    for (let i = name.length - 1; i >= lowerBound; i--) {
      if (name[i] === '/') { idx = i; break }
    }
    if (idx <= 0) {
      throw new Error(`路径过长且无法用 ustar prefix 拆分: ${arName}`)
    }
    prefix = name.slice(0, idx)
    if (Buffer.byteLength(prefix) > 155) {
      throw new Error(`路径 prefix 段超过 ustar 的 155 字节限制: ${arName}`)
    }
    name = name.slice(idx + 1)
  }

  header.write(name, 0, 100, 'utf-8')
  header.write('0000644', 100, 8, 'ascii')  // mode 0644
  header.write('0000000', 108, 8, 'ascii')  // uid
  header.write('0000000', 116, 8, 'ascii')  // gid
  header.write(size.toString(8).padStart(11, '0'), 124, 12, 'ascii')
  header.write('00000000000', 136, 12, 'ascii') // mtime：固定 0，保证同样输入产出同样字节
  header.fill(0x20, 148, 156)                // checksum 字段先填空格
  header.write('0', 156, 1, 'ascii')          // typeflag：普通文件
  if (prefix) header.write(prefix, 345, 155, 'utf-8')
  header.write('ustar\0', 257, 6, 'ascii')
  header.write('00', 263, 2, 'ascii')

  // checksum = 所有字节之和
  let sum = 0
  for (let i = 0; i < BLOCK; i++) sum += header[i]
  header.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii')
}

/** 取补齐到 512 整数倍的填充长度 */
const padLen = (n) => (BLOCK - (n % BLOCK)) % BLOCK

/**
 * 递归收集应包含的文件
 * @param {string} dir 绝对目录
 * @param {string} base 相对根
 * @returns {{rel: string, abs: string, size: number}[]}
 */
function collect(dir, base, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name)
    const rel = base ? `${base}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      collect(abs, rel, out)
    } else if (entry.isFile()) {
      if (shouldInclude(rel)) {
        out.push({ rel, abs, size: fs.statSync(abs).size })
      }
    }
    // 符号链接等非常规条目：Windows 部署下 node_modules 里不出现，跳过
  }
  return out
}

/**
 * 第一段：流式写未压缩 tar 到临时文件
 *
 * 内存恒定——不把 155 MB 全部读进 Buffer 再压缩。背压通过 write() 返回值
 * 显式等待 drain 处理，否则 zlib 流的内部缓冲会把整个 tar 攒在堆里。
 *
 * @param {{rel: string, abs: string, size: number}[]} files
 * @param {string} tarPath
 * @param {(done: number, total: number) => void} onProgress
 */
async function writeTar(files, tarPath, onProgress) {
  const out = fs.createWriteStream(tarPath)
  // error handler 只挂一次。挂在每次 write() 上会累积成内存泄漏
  // （MaxListenersExceededWarning），且第一次错误之后仍会重复 reject。
  await new Promise((resolve, reject) => {
    out.once('error', reject)
    out.once('open', resolve)
  })
  const write = (buf) =>
    new Promise((resolve) => {
      if (out.write(buf)) resolve()
      else out.once('drain', resolve)
    })

  const header = Buffer.alloc(BLOCK)
  const pad = Buffer.alloc(BLOCK)
  let totalWritten = 0
  let done = 0

  for (const f of files) {
    writeHeader(f.rel, f.size, header)
    await write(Buffer.from(header))
    totalWritten += BLOCK

    await write(fs.readFileSync(f.abs))
    totalWritten += f.size

    const p = padLen(f.size)
    if (p > 0) {
      await write(pad.subarray(0, p))
      totalWritten += p
    }

    done++
    if (done % 2000 === 0) onProgress(done, files.length)
  }

  // tar 结束标记：两个 512 字节零块
  const endMark = Buffer.alloc(BLOCK * 2)
  await write(endMark)
  totalWritten += endMark.length

  // 标准 tar 要求整体补齐到 10240 字节（20 个 512 块）的整数倍
  const tailPad = (10240 - (totalWritten % 10240)) % 10240
  if (tailPad > 0) {
    await write(Buffer.alloc(tailPad))
    totalWritten += tailPad
  }

  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())))
  return totalWritten
}

/**
 * 第二段：流式 zstd 压缩
 * @param {string} tarPath
 * @param {string} outPath
 */
function zstdCompressFile(tarPath, outPath) {
  return new Promise((resolve, reject) => {
    const input = fs.createReadStream(tarPath, { highWaterMark: 4 * 1024 * 1024 })
    const comp = zlib.createZstdCompress({
      params: { [zlib.constants.ZSTD_c_compressionLevel]: ZSTD_LEVEL }
    })
    const output = fs.createWriteStream(outPath)
    input.on('error', reject)
    comp.on('error', reject)
    output.on('error', reject)
    output.on('finish', () => resolve())
    input.pipe(comp).pipe(output)
  })
}

async function main() {
  if (!fs.existsSync(BUNDLED_DSH_DIR)) {
    console.error(`[bundle-dsh-zst] 找不到 ${BUNDLED_DSH_DIR}，请先运行 scripts/preinstall-dsh.js`)
    process.exit(1)
  }

  console.log('[bundle-dsh-zst] 扫描文件...')
  const files = collect(BUNDLED_DSH_DIR, '')
  const rawBytes = files.reduce((s, f) => s + f.size, 0)
  console.log(
    `[bundle-dsh-zst] 保留 ${files.length} 个文件 / ` +
    `${(rawBytes / 1048576).toFixed(1)} MB 原始，开始 zstd-${ZSTD_LEVEL} 压缩...`
  )

  const tarPath = OUT_FILE + '.tar.tmp'
  const t0 = Date.now()
  try {
    const tarBytes = await writeTar(files, tarPath, (done, total) => {
      process.stdout.write(`\r[bundle-dsh-zst] 写 tar: ${done}/${total}`)
    })
    process.stdout.write(`\r[bundle-dsh-zst] tar 容器 ${(tarBytes / 1048576).toFixed(1)} MB，开始压缩...  `)

    await zstdCompressFile(tarPath, OUT_FILE)
  } finally {
    try { fs.unlinkSync(tarPath) } catch { /* 忽略 */ }
  }

  const outMb = fs.statSync(OUT_FILE).size / 1048576
  process.stdout.write('\r')
  console.log(
    `[bundle-dsh-zst] 完成: ${outMb.toFixed(1)} MB ` +
    `(${(rawBytes / 1048576 / outMb).toFixed(2)}x)，耗时 ${((Date.now() - t0) / 1000).toFixed(1)}s`
  )
  console.log(`[bundle-dsh-zst] 输出: ${path.relative(PROJECT_ROOT, OUT_FILE)}`)
}

main().catch((err) => {
  console.error(`[bundle-dsh-zst] 失败: ${err.message}`)
  process.exit(1)
})
