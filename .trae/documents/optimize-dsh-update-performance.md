# 优化 DSH 运行包更新耗时方案

## 摘要

当前 DSH 运行包更新流程耗时 5-10 分钟，主要瓶颈在于：所有网络请求（版本号、tgz 包、npm install 依赖）均走国外 `registry.npmjs.org`，国内访问极慢；且每次更新都在空目录全量安装依赖，不复用已有的 `node_modules`。

本方案通过 4 个优化点提速：① npm registry 默认改为国内镜像 `registry.npmmirror.com`，失败回退国外源；② tgz 包下载同步使用国内镜像；③ 版本号查询同步使用国内镜像；④ npm install 前复用缓存目录中已有的旧版 `node_modules`，让 npm 走 `--prefer-offline` 增量安装。

预期效果：国内网络环境下，更新耗时从 5-10 分钟降至 1-3 分钟。

---

## 当前状态分析

### 更新流程链路（[src/main/index.ts](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/index.ts#L239) 的 `performUpdate`）

1. `loadLoadingPage()` 显示加载页面
2. `repairDsh()` ([src/main/dsh-repair.ts](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L215)) 在线修复：
   - `fetchLatestVersion()` ([src/main/dsh-version.ts](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-version.ts#L87)) — 从 `registry.npmjs.org` 取 dist-tags（30s 超时）
   - `downloadFile()` — 从 `registry.npmjs.org` 下载 tgz（120s 超时）
   - `installDshFromTarball()` — 在空目录跑 `npm install <tgz>`（300s 超时，**最慢**）
   - `copyDir()` 复制 DSH 包本身 + `copyDir()` 复制整个 `node_modules`
   - `renameSync()` 原子重命名
3. `stopDsh()` + `startDsh()` + `waitForDshReady(60s)`

### 性能瓶颈识别

| # | 瓶颈点 | 文件位置 | 原因 | 影响 |
|---|--------|---------|------|------|
| 1 | npm install 走国外源 | [dsh-repair.ts#L110-L122](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L110-L122) | `spawn` 的 npm 命令未指定 `--registry`，默认走 `registry.npmjs.org` | 国内下载 `@deepseek-ai/dsh-*` 等依赖极慢，2-5 分钟 |
| 2 | tgz 下载走国外源 | [dsh-repair.ts#L248](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L248) | `tgzUrl` 硬编码为 `${NPM_REGISTRY}/${DSH_PACKAGE}/-/dsh-${version}.tgz` | tgz 本身几 MB，下载 30s-2min |
| 3 | 版本号查询走国外源 | [dsh-version.ts#L90](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-version.ts#L90) | `url` 硬编码为 `registry.npmjs.org` | 取版本号 1-10s |
| 4 | 每次全量安装依赖 | [dsh-repair.ts#L238](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L238) | `installDir` 永远是空目录，npm 重新下载所有 dependencies | 已有依赖重复下载，1-3 分钟 |

### 用户决策（已确认）

| 决策点 | 选择 |
|--------|------|
| 实际耗时 | 5-10 分钟 |
| 镜像策略 | 国内优先 + 国外回退 |
| 目录结构 | 保持当前结构（不改变 `findCachedDshEntry` 查找逻辑） |
| 依赖复用 | 允许复用缓存目录中已有的旧版 `node_modules` |
| tgz 下载镜像 | 同步使用国内镜像 |

---

## 提议改动

### 改动 1：`src/main/dsh-version.ts` — 版本查询走国内镜像

**目标**：`fetchLatestVersion()` 优先用国内镜像，失败回退到国外源。

**What**：
- 新增常量 `NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'`
- 将原 `fetchLatestVersion()` 拆为：
  - 公开 `fetchLatestVersion()`：先尝试镜像源，失败回退到 `registry.npmjs.org`，并记录日志
  - 私有 `fetchLatestVersionFromRegistry(registry: string)`：原实现，但 URL 用传入的 registry 拼接
- 在回退时打印 `[DSH] 镜像源失败，回退到 npm registry: ${err.message}` 日志

**Why**：版本查询是更新流程的第一步，国内镜像可以将 1-10s 的查询时间降至 200ms-1s。

**How**：
```typescript
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'

export function fetchLatestVersion(): Promise<string> {
  return fetchLatestVersionFromRegistry(NPM_REGISTRY_MIRROR)
    .catch((mirrorErr) => {
      console.warn(`[DSH] 国内镜像查询版本失败，回退到 npm registry: ${mirrorErr.message}`)
      return fetchLatestVersionFromRegistry(NPM_REGISTRY)
    })
}

function fetchLatestVersionFromRegistry(registry: string): Promise<string> {
  // 原 fetchLatestVersion 实现，url 用 ${registry}/-/package/.../dist-tags
}
```

---

### 改动 2：`src/main/dsh-repair.ts` — tgz 下载走国内镜像

**目标**：`repairDsh()` 下载 tgz 时优先用国内镜像，失败回退到 `registry.npmjs.org`。

**What**：
- 新增常量 `NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'`
- 在 `repairDsh()` 中（[dsh-repair.ts#L247-L255](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L247-L255)）将 tgz 下载逻辑改为：
  - 先尝试 `https://registry.npmmirror.com/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  - 失败回退到 `https://registry.npmjs.org/@deepseek-ai/dsh/-/dsh-${version}.tgz`
  - 回退时打印日志并通过 `onProgress` 通知用户

**Why**：tgz 包本身通常几 MB，国内镜像可将下载时间从 30s-2min 降至 2-5s。

**How**：
```typescript
const NPM_REGISTRY_MIRROR = 'https://registry.npmmirror.com'

// 在 repairDsh 内部：
const mirrorTgzUrl = `${NPM_REGISTRY_MIRROR}/${DSH_PACKAGE}/-/dsh-${version}.tgz`
const primaryTgzUrl = `${NPM_REGISTRY}/${DSH_PACKAGE}/-/dsh-${version}.tgz`

report('正在下载 DSH 包（国内镜像）...')
try {
  await downloadFile(mirrorTgzUrl, tgzPath, (downloaded) => {
    if (downloaded % (1024 * 1024) < 100 * 1024) {
      report(`下载中: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
    }
  })
} catch (mirrorErr) {
  report(`国内镜像下载失败，回退到 npm registry: ${mirrorErr.message}`)
  // 清理可能的部分下载文件
  if (existsSync(tgzPath)) {
    try { unlinkSync(tgzPath) } catch { /* 忽略 */ }
  }
  report('正在下载 DSH 包（npm registry）...')
  await downloadFile(primaryTgzUrl, tgzPath, (downloaded) => {
    if (downloaded % (1024 * 1024) < 100 * 1024) {
      report(`下载中: ${(downloaded / 1024 / 1024).toFixed(1)} MB`)
    }
  })
}
report('下载完成')
```

---

### 改动 3：`src/main/dsh-repair.ts` — npm install 走国内镜像

**目标**：`installDshFromTarball()` 在 spawn 的 npm 命令中添加 `--registry` 参数，优先国内镜像，失败回退国外源。

**What**：
- 将 `installDshFromTarball()` 拆为：
  - 公开 `installDshFromTarball(tgzPath, installDir, onProgress)`：先尝试镜像源，失败回退到 `registry.npmjs.org`，并记录日志
  - 私有 `installDshFromTarballWithRegistry(tgzPath, installDir, registry, onProgress)`：原 `installDshFromTarball` 实现，但 spawn 参数添加 `--registry=${registry}` 和 `--prefer-offline`
- 在 spawn 的 npm 命令中添加：
  - `--registry=https://registry.npmmirror.com`（或回退时用 `registry.npmjs.org`）
  - `--prefer-offline`（优先用本地缓存，加速增量安装）

**Why**：npm install 是最慢的一步（2-5 分钟），国内镜像 + `--prefer-offline` 可降至 30s-1min。

**How**：
```typescript
function installDshFromTarball(
  tgzPath: string,
  installDir: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  return installDshFromTarballWithRegistry(tgzPath, installDir, NPM_REGISTRY_MIRROR, onProgress)
    .catch((mirrorErr) => {
      console.warn(`[DSH Repair] 国内镜像安装失败，回退到 npm registry: ${mirrorErr.message}`)
      onProgress?.('国内镜像安装失败，回退到 npm registry 重试...')
      return installDshFromTarballWithRegistry(tgzPath, installDir, NPM_REGISTRY, onProgress)
    })
}

function installDshFromTarballWithRegistry(
  tgzPath: string,
  installDir: string,
  registry: string,
  onProgress?: (msg: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const npmCli = join(getNodeDir(), 'node_modules', 'npm', 'bin', 'npm-cli.js')
    if (!existsSync(npmCli)) {
      reject(new Error('内置 npm 不可用，无法安装 DSH 包'))
      return
    }

    const localAppData = process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    const npmCacheDir = join(localAppData, 'DSH Desktop', 'npm-cache')
    mkdirSync(npmCacheDir, { recursive: true })

    const child = spawn(
      getNodeBinaryPath(),
      [
        npmCli, 'install', tgzPath,
        '--omit=dev', '--no-save', '--no-audit', '--no-fund',
        '--loglevel=warn',
        '--registry=' + registry,
        '--prefer-offline'
      ],
      {
        cwd: installDir,
        windowsHide: true,
        env: {
          ...process.env,
          npm_config_cache: npmCacheDir,
          npm_config_prefix: npmCacheDir
        }
      }
    )
    // ...原有 stdout/stderr/timeout/exit 处理逻辑不变...
  })
}
```

**注意点**：
- 镜像失败回退时，`installDir` 中可能已有部分文件（npm install 失败前留下的）。npm install 是幂等的，重跑会覆盖，无需手动清理。
- 回退时整个 npm install 从头开始，所以镜像失败的总耗时 = 镜像耗时 + 国外源耗时。这种情况下总耗时会比直接用国外源更长，但只有镜像失败时才会发生。
- `--prefer-offline` 让 npm 优先用本地 npm 缓存，配合改动 4 的"复用 node_modules"才能最大化效果。

---

### 改动 4：`src/main/dsh-repair.ts` — 复用已有 node_modules

**目标**：在 `installDshFromTarball()` 之前，把缓存目录中已有的旧版 `node_modules` 复制到 `installDir`，让 npm install 走增量安装。

**What**：
- 在 `repairDsh()` 中（[dsh-repair.ts#L260](file:///e:/MyProject/IdeaProject/lingwulab-all/deepseek-harness-desktop/src/main/dsh-repair.ts#L260)）调用 `installDshFromTarball` 之前，新增逻辑：
  - 检查 `getDshRepairCacheDir()/dsh/node_modules` 是否存在
  - 如果存在，复制到 `installDir/node_modules`，并通过 `onProgress` 通知用户"复用旧依赖"
  - 如果不存在或复制失败，跳过（不影响主流程）

**Why**：DSH 增量更新时，大部分依赖（如 `@deepseek-ai/dsh-*`、`koa`、`react` 等）版本不变，复用旧 node_modules 后 npm install 只需下载差异部分，可从 1-3 分钟降至 10-30s。

**How**：
```typescript
// 在 repairDsh 中，installDshFromTarball 调用之前：
const existingDshCacheDir = join(getDshRepairCacheDir(), 'dsh')
const existingNodeModules = join(existingDshCacheDir, 'node_modules')
if (existsSync(existingNodeModules)) {
  report('检测到旧版本依赖缓存，复用以加速安装...')
  try {
    // 复制旧 node_modules 到 installDir，让 npm install 走增量更新
    copyDir(existingNodeModules, join(installDir, 'node_modules'))
    report('旧依赖复用完成')
  } catch (err) {
    console.warn(`[DSH Repair] 复用旧依赖失败，将全量安装: ${(err as Error).message}`)
    // 清理可能的部分复制
    if (existsSync(join(installDir, 'node_modules'))) {
      try { rmSync(join(installDir, 'node_modules'), { recursive: true, force: true }) } catch { /* 忽略 */ }
    }
  }
}

// 然后执行 npm install（原有逻辑）
report('正在安装 DSH 包及其依赖...')
await installDshFromTarball(tgzPath, installDir, report)
```

**注意点**：
- 复用的 `node_modules` 中包含旧版的 `@deepseek-ai/dsh` 目录，但 `npm install <tgz>` 会用 tgz 中的新版本覆盖它，不会污染最终结果。
- 复制 `node_modules` 本身有 IO 开销（数千小文件），但远快于重新下载。
- 如果复制失败，清理后继续走全量安装，不影响功能正确性。

---

## 假设与决策

### 假设

1. **npmmirror.com 镜像可用**：`registry.npmmirror.com` 是阿里云维护的 npm 国内镜像，长期稳定可用。如果整个镜像服务下线，回退逻辑会自动切到 `registry.npmjs.org`。
2. **DSH 包发布到 npm registry 后，npmmirror 同步延迟可接受**：通常 npmmirror 同步延迟在 10 分钟内，对桌面客户端更新场景影响不大（用户不会在 DSH 发布后立即更新）。
3. **复用旧 `node_modules` 不会引入兼容性问题**：npm 的 `package-lock.json` 机制能正确处理依赖版本差异，`npm install <tgz>` 会根据 tgz 的 `package.json` 调整依赖树。
4. **回退场景的总耗时仍可接受**：镜像失败时回退到国外源，总耗时 = 镜像尝试耗时 + 国外源耗时。由于镜像通常在连接阶段就会失败（快速失败），不会显著增加总耗时。

### 决策

| 决策 | 选择 | 理由 |
|------|------|------|
| 镜像源 | `registry.npmmirror.com` | 阿里云维护，国内最稳定的 npm 镜像 |
| 回退策略 | 镜像失败 → 国外源重试一次 | 不做多次重试，避免拖长失败场景的耗时 |
| 依赖复用 | 复用整个 `node_modules`（含 `@deepseek-ai/dsh` 旧版） | npm install 会覆盖 `@deepseek-ai/dsh`，无需特殊处理 |
| `--prefer-offline` | 添加 | 优先用本地 npm 缓存，配合依赖复用最大化提速 |
| 不改 `findCachedDshEntry` | 保持当前查找逻辑 | 用户明确要求不改目录结构 |

### 不在本次改动范围

- ❌ 不修改 `findCachedDshEntry()` 的查找顺序与目录结构
- ❌ 不修改 `performUpdate()` 的整体流程（`loadLoadingPage → repairDsh → stopDsh → startDsh → loadURL`）
- ❌ 不修改 `stopDsh` / `startDsh` / `waitForDshReady` 的逻辑
- ❌ 不修改 `preinstall-dsh.js` 打包预装脚本（打包时仍走 npx 默认源，因为打包在国内开发机执行，影响小）
- ❌ 不新增测试 / lint / CI（遵循 AGENTS.md §10）

---

## 验证步骤

### 1. TypeScript 编译检查

```bash
npm run build
```

确认无类型错误。

### 2. 开发环境手动验证

由于 `repairDsh` 只在打包后通过 UI 触发，开发环境验证需要：

```bash
# 在 src/main/index.ts 临时加一行触发代码，或用 DevTools 触发
npm run dev
```

在 DevTools Console 执行：
```javascript
window.dsh.repairDsh() // 但 preload 没暴露这个，需要通过 IPC
```

实际验证方式：通过错误页面的"在线修复"按钮触发 `repairDsh`，观察日志中是否出现：
- `[DSH Repair] 正在下载 DSH 包（国内镜像）...`
- `[DSH Repair] 检测到旧版本依赖缓存，复用以加速安装...`
- `[DSH Repair] 旧依赖复用完成`

### 3. 打包后完整验证

```bash
# 管理员 PowerShell
npm run package
```

打包后安装，手动触发 DSH 更新（通过 DSH 更新横幅的"更新 DSH"按钮），观察：
1. **首次更新**（无旧 node_modules）：耗时应该从 5-10 分钟降至 2-4 分钟
2. **二次更新**（有旧 node_modules）：耗时应该进一步降至 1-2 分钟
3. **镜像失败回退**：手动断网或屏蔽 npmmirror.com，验证回退到 npmjs.org 的日志与流程正常

### 4. 日志检查点

更新过程中，主进程日志（开发模式终端可见，打包后可通过 DevTools 查看）应包含：
- `[DSH] 国内镜像查询版本...` 或类似（改动 1）
- `[DSH Repair] 正在下载 DSH 包（国内镜像）...`（改动 2）
- `[DSH Repair] 检测到旧版本依赖缓存，复用以加速安装...`（改动 4，仅二次更新）
- npm install 输出中包含 `--registry=https://registry.npmmirror.com`（改动 3）

---

## 文件变更清单

| 文件 | 变更类型 | 说明 |
|------|---------|------|
| `src/main/dsh-version.ts` | 修改 | 拆分 `fetchLatestVersion` 为镜像优先+回退 |
| `src/main/dsh-repair.ts` | 修改 | tgz 下载镜像优先+回退；npm install 镜像优先+回退+`--prefer-offline`；新增复用旧 node_modules 逻辑 |

无新增文件，无删除文件。
