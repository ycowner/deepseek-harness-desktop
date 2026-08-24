// 静态审计：确认 spec 中每条关键实现的源代码实际存在
const fs = require('fs');
const path = require('path');

const files = {
  'src/main/dsh-version.ts': fs.readFileSync('src/main/dsh-version.ts', 'utf8'),
  'src/main/dsh-repair.ts': fs.readFileSync('src/main/dsh-repair.ts', 'utf8'),
  'src/main/dsh-manager.ts': fs.readFileSync('src/main/dsh-manager.ts', 'utf8'),
  'src/main/app-update.ts': fs.readFileSync('src/main/app-update.ts', 'utf8'),
  'src/main/index.ts': fs.readFileSync('src/main/index.ts', 'utf8'),
  'electron-builder.yml': fs.readFileSync('electron-builder.yml', 'utf8'),
  'package.json': fs.readFileSync('package.json', 'utf8'),
  'AGENTS.md': fs.readFileSync('AGENTS.md', 'utf8'),
};

// 单独的字符串/包含检查（避免在 node -e 中转义正则）
const checks = [
  // §1.1 compareVersions + isValidVersion
  ['1.1 aIsNum 修复', files['src/main/dsh-version.ts'], "const aIsNum = !isNaN(aNum)"],
  ['1.1 bIsNum 修复', files['src/main/dsh-version.ts'], "const bIsNum = !isNaN(bNum)"],
  ['1.1 isValidVersion 导出', files['src/main/dsh-version.ts'], "export function isValidVersion(v: string): boolean"],
  ['1.1 移除旧死代码', files['src/main/dsh-version.ts'], "const aIsNum = !isNaN(aNum).toString()", 'absent'],
  // §1.2 fetchDistIntegrity
  ['1.2 fetchDistIntegrity 导出', files['src/main/dsh-version.ts'], "export function fetchDistIntegrity(version: string): Promise<string>"],
  ['1.2 Accept abbreviated packument', files['src/main/dsh-version.ts'], "application/vnd.npm.install-v1+json"],
  ['1.2 dsh-version 用 net.fetch', files['src/main/dsh-version.ts'], "net.fetch"],
  // §1.3 两阶段
  ['1.3 prepareDshPackage 导出', files['src/main/dsh-repair.ts'], "export async function prepareDshPackage"],
  ['1.3 activateDshPackage 导出', files['src/main/dsh-repair.ts'], "export function activateDshPackage(stagingDir: string): string"],
  ['1.3 repairDsh 仍导出', files['src/main/dsh-repair.ts'], "export async function repairDsh"],
  ['1.3 staging 用时间戳', files['src/main/dsh-repair.ts'], "dsh.staging.${Date.now()}"],
  ['1.3 integrity 校验调用', files['src/main/dsh-repair.ts'], "verifyFileIntegrity(tgzPath, integrity)"],
  ['1.3 启动时清扫 staging', files['src/main/dsh-repair.ts'], "function cleanupStaleStagingDirs"],
  ['1.3 npm 超时用 taskkill 参数组', files['src/main/dsh-repair.ts'], "execFileSync('taskkill', ['/pid', String(child.pid), '/f', '/t'], { stdio: 'ignore' })"],
  ['1.3 移除旧 execSync taskkill', files['src/main/dsh-repair.ts'], "execSync(`taskkill /pid ${child.pid} /f /t`)", 'absent'],
  // §1.4 dsh-manager
  ['1.4 isPkgDepsComplete 检查每个 dep', files['src/main/dsh-manager.ts'], "for (const dep of Object.keys(deps))"],
  ['1.4 ERR_MODULE_NOT_FOUND 正则', files['src/main/dsh-manager.ts'], "ERR_MODULE_NOT_FOUND|Cannot find module"],
  ['1.4 环形缓冲 pushLogLine', files['src/main/dsh-manager.ts'], "function pushLogLine(arr: string[], line: string)"],
  ['1.4 MAX_LOG_LINES = 500', files['src/main/dsh-manager.ts'], "const MAX_LOG_LINES = 500"],
  ['1.4 readdirSync 已从 fs 导入', files['src/main/dsh-manager.ts'], "import { existsSync, mkdirSync, readFileSync, readdirSync } from 'fs'"],
  ['1.4 移除 require fs', files['src/main/dsh-manager.ts'], "require('fs')", 'absent'],
  // §2.1 依赖与配置
  ['2.1 package.json electron-updater 依赖', files['package.json'], '"electron-updater": "^6.3.0"'],
  ['2.1 electron-builder.yml publish', files['electron-builder.yml'], 'publish:'],
  ['2.1 publish provider: github', files['electron-builder.yml'], 'provider: github'],
  // §2.2 app-update
  ['2.2 checkForGiteeAppUpdate', files['src/main/app-update.ts'], "export async function checkForGiteeAppUpdate"],
  ['2.2 fetchGiteeLatestYml', files['src/main/app-update.ts'], "export async function fetchGiteeLatestYml"],
  ['2.2 latest.yml 资源定位', files['src/main/app-update.ts'], "name === 'latest.yml'"],
  ['2.2 downloadAppUpdate 含 sha512 参数', files['src/main/app-update.ts'], "expectedSha512Base64"],
  ['2.2 verifyFileSha512', files['src/main/app-update.ts'], "export async function verifyFileSha512"],
  ['2.2 验证失败报错', files['src/main/app-update.ts'], '安装包 sha512 校验失败'],
  ['2.2 getAppUpdateDownloadDir', files['src/main/app-update.ts'], "export function getAppUpdateDownloadDir"],
  ['2.2 cleanupLegacyInstallers', files['src/main/app-update.ts'], "export function cleanupLegacyInstallers"],
  ['2.2 isValidVersion 在 parseGiteeReleaseInfo', files['src/main/app-update.ts'], 'isValidVersion(version)'],
  // §2.3 index.ts 客户端更新接线
  ['2.3 autoUpdater 导入', files['src/main/index.ts'], "import { autoUpdater } from 'electron-updater'"],
  ['2.3 pendingAppUpdateSource 声明', files['src/main/index.ts'], "pendingAppUpdateSource: 'electron-updater' | 'gitee-file' | null"],
  ['2.3 setupAppUpdater 函数', files['src/main/index.ts'], "function setupAppUpdater"],
  ['2.3 autoUpdater.autoDownload = true', files['src/main/index.ts'], "autoUpdater.autoDownload = true"],
  ['2.3 update-downloaded 处理', files['src/main/index.ts'], "autoUpdater.on('update-downloaded'"],
  ['2.3 autoUpdater.quitAndInstall', files['src/main/index.ts'], "autoUpdater.quitAndInstall()"],
  ['2.3 移除 CORRUPTED_FILE_MAX_SIZE', files['src/main/index.ts'], "CORRUPTED_FILE_MAX_SIZE", 'absent'],
  ['2.3 移除 MIN_INSTALLER_SIZE', files['src/main/index.ts'], "MIN_INSTALLER_SIZE", 'absent'],
  // §3 并发与 IPC
  ['3 isUpdating 标志', files['src/main/index.ts'], "let isUpdating = false"],
  ['3 isRepairing 标志', files['src/main/index.ts'], "let isRepairing = false"],
  ['3 isTrustedSender 函数', files['src/main/index.ts'], "function isTrustedSender"],
  ['3 lastPromptedDshVersion 复位', files['src/main/index.ts'], "lastPromptedDshVersion = null"],
  ['3 repair-dsh isRepairing 检查', files['src/main/index.ts'], "if (isRepairing)"],
  // §4 横幅注入守卫
  ['4 isDshPageLoaded', files['src/main/index.ts'], "function isDshPageLoaded"],
  ['4 executeJavaScript try/catch (injectDsh)', files['src/main/index.ts'], "await mainWindow.webContents.executeJavaScript(bannerCode)\n  } catch"],
  ['4 isValidVersion 在横幅', files['src/main/index.ts'], "isValidVersion(pendingDshUpdateVersion)"],
  // §5 代理支持
  ['5 dsh-version net.fetch', files['src/main/dsh-version.ts'], "net.fetch"],
  ['5 dsh-repair net.fetch', files['src/main/dsh-repair.ts'], "net.fetch"],
  ['5 app-update net.fetch', files['src/main/app-update.ts'], "net.fetch"],
  ['5 dsh-manager checkUrl 仍用 Node http', files['src/main/dsh-manager.ts'], "const req = get(url"],
  // §6 AGENTS.md 文档
  ['6 AGENTS.md §6.5 客户端更新架构', files['AGENTS.md'], "### 6.5 桌面应用客户端更新架构"],
  ['6 AGENTS.md §8 publish 文档', files['AGENTS.md'], '发布配置（`electron-builder.yml` 的 `publish` 段）'],
  ['6 AGENTS.md §12.13 顺序约束', files['AGENTS.md'], "13. **不要在 `performUpdate()` 里先 `stopDsh` 再 `prepareDshPackage`**"],
  ['6 AGENTS.md §12.14 互斥锁', files['AGENTS.md'], "14. **不要绕过 `isUpdating`"],
  ['6 AGENTS.md §5.5 含 installDshUpdate', files['AGENTS.md'], "| `installDshUpdate()`"],
  ['6 AGENTS.md §5.4 含 install-dsh-update', files['AGENTS.md'], "`install-dsh-update`"],
];

let pass = 0, fail = 0, failures = [];
for (const c of checks) {
  const name = c[0];
  const src = c[1];
  const needle = c[2];
  const mode = c[3] || 'present'; // 'present' or 'absent'
  const found = src.includes(needle);
  const ok = mode === 'absent' ? !found : found;
  if (ok) {
    pass++;
  } else {
    fail++;
    failures.push(`[${mode}] ${name} :: needle=${JSON.stringify(needle).slice(0, 80)}`);
  }
}
console.log('Total: ' + checks.length + ' | PASS: ' + pass + ' | FAIL: ' + fail);
if (fail > 0) {
  console.log('Failures:');
  for (const m of failures) console.log('  - ' + m);
}
process.exit(fail > 0 ? 1 : 0);
