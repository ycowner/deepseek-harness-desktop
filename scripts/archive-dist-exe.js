const fs = require('fs');
const path = require('path');

// 只归档本次生成的版本子目录（dist-exe/<version>），避免把 dist-exe 下所有累积版本都重复复制
const pkg = require('../package.json');
const SRC = path.resolve(__dirname, '..', 'dist-exe', pkg.version);
const ROOT = path.resolve(__dirname, '..', 'dist-exe-archives');

function pad(n) { return n.toString().padStart(2, '0'); }
function timestamp() {
  const d = new Date();
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function copyDir(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDir(s, d);
    } else {
      fs.copyFileSync(s, d);
    }
  }
}

if (!fs.existsSync(SRC)) {
  console.error(`[archive-dist-exe] 源目录不存在: ${SRC}`);
  process.exit(1);
}

const ts = timestamp();
const dest = path.join(ROOT, ts);

console.log(`========================================`);
console.log(`  归档 DSH Desktop 打包产物`);
console.log(`  源目录: ${SRC}`);
console.log(`  目标:   ${dest}`);
console.log(`========================================`);

copyDir(SRC, dest);

// 统计
let files = 0; let bytes = 0;
function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(p);
    else {
      files++;
      bytes += fs.statSync(p).size;
    }
  }
}
walk(dest);
const mb = (bytes / 1024 / 1024).toFixed(2);
console.log(`[DONE] 归档完成: ${files} 个文件, ${mb} MB`);
console.log(`       目录: ${path.relative(process.cwd(), dest)}`);
