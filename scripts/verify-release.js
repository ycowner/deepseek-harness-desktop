/**
 * 上传前校验：确认 dist-exe/<版本>/ 里的 latest.yml 与安装包完全一致
 *
 * 为什么需要这个脚本
 * ------------------
 * latest.yml 是自动更新链路的信任根：electron-updater 下载完成后用它里的
 * sha512 校验安装包（当前产物未签名，这条校验是唯一的完整性保障）。
 * 一旦 sha512 与实际文件对不上，客户端会在下载 250MB 之后才报错退出——
 * 代价极高且现场很难排查。而 sha512 写错恰恰是手改 yml、重新打包后忘记同步
 * 等场景下最容易发生的错误。
 *
 * 本脚本做四件事，任何一项不通过即 exit 1：
 *   1. 调用 patch-latest-yml-size.js 补齐 size 字段；
 *   2. 校验 latest.yml 里的 version 与 package.json 的 version 一致；
 *   3. 逐字节重新计算安装包的 sha512，与 latest.yml 比对；
 *   4. 校验 size 与文件实际字节数一致。
 * 全部通过后打印**严格有序**的上传步骤。
 *
 * 用法
 * ----
 *   node scripts/verify-release.js              # 校验 dist-exe/<当前版本>/
 *   node scripts/verify-release.js <目录>       # 校验指定目录
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const pkg = require('../package.json');

const targetDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, '..', 'dist-exe', pkg.version);

const ymlPath = path.join(targetDir, 'latest.yml');

function fail(msg) {
  console.error(`\n[verify-release] 校验失败: ${msg}\n`);
  process.exit(1);
}

console.log(`[verify-release] 目标目录: ${targetDir}`);

// ---- 1. 补齐 size 字段（复用既有脚本，保持单一实现） ----
try {
  execFileSync(process.execPath, [path.join(__dirname, 'patch-latest-yml-size.js'), targetDir], {
    stdio: 'inherit'
  });
} catch {
  fail('patch-latest-yml-size.js 执行失败');
}

if (!fs.existsSync(ymlPath)) {
  fail(`未找到 latest.yml: ${ymlPath}\n提示：先执行 npm run build && npx electron-builder`);
}

const raw = fs.readFileSync(ymlPath, 'utf8');

/**
 * 取顶层标量键的值（行首无缩进）
 */
function topLevel(key) {
  const m = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(raw);
  return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
}

// ---- 2. version 一致性 ----
const ymlVersion = topLevel('version');
const ymlPathField = topLevel('path');

if (!ymlVersion) fail('latest.yml 缺少顶层 version 字段');
if (ymlVersion !== pkg.version) {
  fail(`latest.yml 的 version (${ymlVersion}) 与 package.json 的 version (${pkg.version}) 不一致\n` +
    `提示：latest.yml 与安装包必须来自同一次构建，否则客户端会拉到指向不存在文件的元数据`);
}

if (!ymlPathField) fail('latest.yml 缺少顶层 path 字段');

const exePath = path.join(targetDir, ymlPathField);
if (!fs.existsSync(exePath)) {
  fail(`latest.yml 的 path 指向的文件不存在: ${exePath}`);
}

// ---- 3. sha512 校验（流式，避免把 250MB 读进内存） ----
console.log(`[verify-release] 正在计算 sha512（${(fs.statSync(exePath).size / 1024 / 1024).toFixed(1)} MB，稍候）...`);
const actualSha512 = crypto.createHash('sha512')
  .update(fs.readFileSync(exePath))
  .digest('base64');
const expectedSha512 = topLevel('sha512');

if (!expectedSha512) {
  fail('latest.yml 缺少顶层 sha512 字段');
}
if (actualSha512 !== expectedSha512) {
  fail(`sha512 不匹配\n` +
    `  latest.yml: ${expectedSha512}\n` +
    `  实际文件  : ${actualSha512}\n` +
    `提示：安装包在生成 latest.yml 之后被改动过（或 yml 是旧版本残留）。` +
    `sha512 错了会导致客户端下完 250MB 才报错，必须重新构建并同步。`);
}
console.log('[verify-release] sha512 校验通过');

// ---- 4. size 一致性 ----
const sizeMatch = /^\s*size:\s*(\d+)\s*$/m.exec(raw);
if (!sizeMatch) {
  fail('latest.yml 的 files 段仍缺少 size 字段（patch-latest-yml-size.js 未生效）');
}
const actualSize = fs.statSync(exePath).size;
if (Number(sizeMatch[1]) !== actualSize) {
  fail(`size 不匹配: latest.yml 写 ${sizeMatch[1]}，实际 ${actualSize}`);
}
console.log(`[verify-release] size 校验通过 (${actualSize})`);

// ---- 全部通过：给出上传步骤 ----
const mb = (actualSize / 1024 / 1024).toFixed(1);
console.log(`
============================================================
 校验全部通过，可以上传 v${ymlVersion} 到 R2
============================================================

 文件: ${ymlPathField} (${mb} MB)
 清单: latest.yml

 【上传顺序不可颠倒】
 先传安装包，确认它可访问后，最后再传 latest.yml。
 反过来会出现「客户端拉到新元数据、却下载不到包」的窗口期，
 表现为用户点更新后直接下载失败。

   1) 安装包（耗时较长，250MB）
   2) 校验安装包可下载（见下方 curl）
   3) latest.yml（最后一步，几秒内生效）

 上传后自检（在项目根目录执行，--noproxy 用于绕过本机失效的代理环境变量）：

   curl -sS -I --noproxy '*' https://download.dsh.392700.xyz/${ymlPathField}
   curl -sS    --noproxy '*' https://download.dsh.392700.xyz/latest.yml

 期望：安装包返回 200 且 Content-Length = ${actualSize}；
       latest.yml 的 version 为 ${ymlVersion}。
`);
