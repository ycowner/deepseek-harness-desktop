/**
 * 补齐 latest.yml 中缺失的 size 字段
 *
 * 背景
 * ----
 * 本项目 electron-builder.yml 同时配置了 `nsis.useZip: true` 与
 * `nsis.differentialPackage: false`（二者必须成对，见配置文件注释）。
 * 后者的副作用是不产出 .blockmap，导致 electron-builder 生成的 latest.yml
 * 里 files[].size 字段缺失。
 *
 * size 的作用范围（已核对 electron-updater 源码）：
 *   - **不参与**完整性校验 —— 校验只用 files[].sha512；
 *   - 只被 download-progress 事件用于计算百分比 total。
 * 所以缺失不会导致安装失败，但进度条会拿不到总量。
 *
 * 本脚本在打包后读取安装包实际字节数，回填到 latest.yml。
 *
 * 用法
 * ----
 *   node scripts/patch-latest-yml-size.js            # 处理 dist-exe/<当前版本>/
 *   node scripts/patch-latest-yml-size.js <目录>     # 处理指定目录
 *
 * 幂等：已有正确的 size 则跳过并正常退出（exit 0）。
 */
const fs = require('fs');
const path = require('path');

const pkg = require('../package.json');

const targetDir = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.resolve(__dirname, '..', 'dist-exe', pkg.version);

const ymlPath = path.join(targetDir, 'latest.yml');

function fail(msg) {
  console.error(`[patch-latest-yml-size] ${msg}`);
  process.exit(1);
}

if (!fs.existsSync(ymlPath)) {
  fail(`未找到 latest.yml: ${ymlPath}\n提示：先执行 npm run build && npx electron-builder`);
}

const raw = fs.readFileSync(ymlPath, 'utf8');

// latest.yml 结构固定且由 electron-builder 生成，形态为：
//   version: 1.0.16
//   files:
//     - url: DSH-Desktop-Setup-1.0.16.exe
//       sha512: xxx
//   path: ...
// 这里按行处理：找到 files 段下每个 "- url: <文件名>" 后，若其后紧邻的
// 同缩进行里没有 size:，就插入一行。刻意不做通用 YAML 解析——
// 引入依赖换取一个固定结构的场景不划算，且行处理对 electron-builder
// 的稳定输出格式足够可靠。
const lines = raw.split(/\r?\n/);
const out = [];
let inFiles = false;
let filesIndent = 0;
let patched = 0;
let skipped = 0;

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const trimmed = line.trim();

  // 进入 files: 段
  if (/^files:\s*$/.test(trimmed)) {
    inFiles = true;
    out.push(line);
    continue;
  }

  // 遇到 files 段的同级或更外层键（path: / sha512: / releaseDate:）则退出
  if (inFiles && line.length > 0) {
    const indent = line.match(/^\s*/)[0].length;
    if (!/^\s*-/.test(line) && indent === 0) {
      inFiles = false;
    } else if (/^\s*-/.test(line)) {
      if (filesIndent === 0) filesIndent = indent;
    } else if (indent <= filesIndent) {
      inFiles = false;
    }
  }

  out.push(line);

  // files 段内遇到 "- url: xxx" → 处理该条目的 size
  if (inFiles) {
    const m = line.match(/^(\s*)-\s+url:\s*(\S+)\s*$/);
    if (m) {
      const indent = m[1];
      const fileName = m[2];

      // 已被别的步骤补过（下一行就是 size）则跳过
      const next = lines[i + 1] || '';
      if (/^\s*size:\s*\d+\s*$/.test(next)) {
        skipped++;
        continue;
      }

      const exePath = path.join(targetDir, fileName);
      if (!fs.existsSync(exePath)) {
        fail(`latest.yml 引用的文件不存在: ${exePath}\n提示：latest.yml 与安装包必须同目录`);
      }

      const size = fs.statSync(exePath).size;
      out.push(`${indent}  size: ${size}`);
      patched++;
      console.log(`[patch-latest-yml-size] ${fileName} -> size: ${size}`);
    }
  }
}

if (patched === 0) {
  if (skipped > 0) {
    console.log(`[patch-latest-yml-size] size 字段已存在且无需修改（${skipped} 项）`);
  } else {
    fail(`未在 latest.yml 的 files 段中找到任何 "- url:" 条目，文件格式可能已变化：\n${ymlPath}`);
  }
  process.exit(0);
}

fs.writeFileSync(ymlPath, out.join('\n'), 'utf8');
console.log(`[patch-latest-yml-size] 已补齐 ${patched} 项，文件: ${ymlPath}`);
