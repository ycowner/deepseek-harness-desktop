# 安装包体积分析（1.0.19 基线）

> 目的：回答「客户端安装包体积还有没有缩小空间，且不损害功能」。
> 本文所有数字均为**本机实测**（2026-10-06，`dist-exe/1.0.19-rc-tmp`），不是估算。
> 复现方法见 §7。

---

## 1. 结论摘要

**还有空间，但要分清「白捡的」和「要付代价的」。**

| 档 | 内容 | 实测可省 | 落地后安装包 | 功能风险 |
| --- | --- | --- | --- | --- |
| **A** | 纯构建配置（4 处） | **-5.3 MiB** | 198.9 → **193.6 MiB** | 无 |
| **B** | 低风险裁剪 / 实机验证后删件 | -5.0 MiB | → 188.7 MiB | 低（需验证） |
| **C** | 沿用本仓库已有的「按需组件」模式 | -12.9 MiB | → 175.8 MiB | 功能不减，但首次使用需联网 |
| **D** | 架构级：运行时/安装期预压缩解包 | -10.5 ~ -40.8 MiB | → 165.3 / **135.0 MiB** | 高，属独立项目 |

- **A 档建议直接做**：4 处改动全是「本来就是这么设计的，但没写对」，零功能风险。
- **C 档里的 `sherpa-onnx` 强烈推荐**：它只服务一个 `experimental` 语音转文字包，而那个功能**本身首次使用就要从 HuggingFace 下载 ONNX 模型**——把运行时也改成按需下载，对用户的实际体验几乎没有增量代价。
- **D 档是唯一能突破「deflate 已到极限」的路**（理论可省 40 MiB），但需要改安装期架构，不属于「不损害功能」的低风险改动，只应作为独立立项评估。

---

## 2. 体积模型：安装包 ≈ 载荷 zip + 0.68 MiB

这是后续所有推算的基础，本轮已实测锁定：

| 项 | 字节 |
| --- | --- |
| 实际安装包 `DSH-Desktop-Setup-1.0.19-rc.exe` | 208,604,955（198.94 MiB） |
| 用 `NsisTarget.js` 同款参数复现的载荷 zip（`-mx=7 -mm=Deflate`） | 207,889,730（198.26 MiB） |
| 差额 = NSIS 自身开销 | 715,225（0.68 MiB，0.34%） |

两条由此确立的机制：

1. **electron-builder 把 NSIS 外层压缩器硬编码成 `zlib`**（`NsisTarget.js:256` 无条件 `commands.SetCompressor = "zlib"`，只有 `compression: store` 才走 `SetCompress off`）。
2. 载荷 zip 本身已是 deflate，再套一层 zlib **几乎不再产生压缩**。

**所以：安装包体积 ≡ 载荷 zip 体积。想减体积，只能减少「进 zip 的原始字节」或「换更强的压缩」。**

---

## 3. 体积构成（434.89 MB 落地 → 198.94 MiB 安装包）

`deflate` 列 = 该组件在安装包里**实际占的字节**；`zstd-19` 列 = 若改成预压缩单文件后会占的字节。

| 组件 | 落地 MB | 占安装包 | deflate MB | zstd-19 MB | 可回收 |
| --- | ---: | ---: | ---: | ---: | ---: |
| `DSH Desktop.exe`（Electron 本体） | 234.65 | **52.3%** | 103.75 | 77.86 | **25.89** |
| `resources/node/node.exe` | 89.24 | **17.2%** | 34.18 | 24.78 | **9.41** |
| `resources/dsh-bundled.tar.zst` | 37.46 | **18.9%** | 37.44 | 37.25 | 0（已压缩） |
| `resources.pak` | 11.86 | 5.9% | 11.77 | 11.74 | 0.03 |
| `LICENSES.chromium.html` | 19.52 | 1.0% | 2.01 | 0.22 | 1.79 |
| `icudtl.dat` | 10.37 | 2.3% | 4.60 | 3.65 | 0.94 |
| `resources/node/node_modules/npm`（1536 文件） | 8.63 | 1.3% | 2.57 | 1.46 | 1.11 |
| `vk_swiftshader.dll` | 5.26 | 1.1% | 2.13 | 1.68 | 0.44 |
| `d3dcompiler_47.dll` | 4.52 | 1.1% | 2.10 | 1.75 | 0.35 |
| `ffmpeg.dll` | 2.97 | 0.6% | 1.24 | 1.04 | 0.19 |
| `resources/app.asar` | 2.80 | 0.3% | 0.64 | 0.42 | 0.22 |
| `locales/`（3 个） | 1.68 | 0.3% | 0.63 | 0.45 | 0.18 |
| `dxil.dll` | 1.44 | 0.3% | 0.66 | 0.55 | 0.12 |
| `chrome_200/100_percent.pak` | 1.90 | 0.9% | 1.83 | 1.82 | 0.01 |
| `vulkan-1.dll` | 0.90 | 0.2% | 0.35 | 0.29 | 0.06 |
| `v8_context_snapshot.bin` + `snapshot_blob.bin` | 1.06 | 0.1% | 0.28 | 0.19 | 0.09 |
| 其余小件 | 3.75 | <0.1% | 0.14 | 0.10 | 0.04 |
| **合计** | **434.89** | 100% | **206.27** | **165.24** | **41.03** |

**读法**：`DSH Desktop.exe` + `node.exe` + `dsh-bundled.tar.zst` 三项 = 安装包的 **88.4%**。其余 1,568 个文件加起来只占 11.6%。

**关键约束（引导悖论）**：整棵树 zstd-19 是 165.24 MB，比现在少 41 MB——但 `DSH Desktop.exe` 是**启动应用的那一个文件**，它不可能待在一个需要应用自己解开的压缩包里。所以 41 MB 不能全拿，只能拿「启动之后才需要的东西」。

---

## 4. A 档：零功能风险，纯构建配置（-5.3 MiB）

### A1. `compression: normal` → `maximum`（**-0.62 MiB**，实测）

`electron-builder.yml` 第 17 行现在写的是 `normal`，但它自己的注释写的是「**以体积为先**」——配置与意图不符。

`compute7zCompressArgs()`（`app-builder-lib/out/targets/archive.js:64-74`）里：

- `normal` → `-mx=7 -mm=Deflate`
- `maximum` → `-mx=9 -mfb=258 -mpass=15 -mm=Deflate`

同参数实测：**207,889,730 → 207,238,696 B（-651,034 B）**。

代价只有构建时间。**deflate 的解压速度与压缩级别无关**（注释里这句话本身是对的），所以安装耗时不变、功能零影响。

### A2. `scripts/bundle-dsh-zst.js` 的 `ZSTD_LEVEL: 9` → `19`（**-3.86 MiB**，实测 + 往返验证）

| zstd 级别 | 体积 | 构建耗时 |
| --- | ---: | ---: |
| 9（当前） | 37.46 MB | 3.3 s |
| **19** | **33.60 MB** | 64.2 s |
| 22 | 32.42 MB | 87.3 s |

**往返验证已做**（这是关键，因为 `dsh-unpack.ts` 用的是 `zlib.createZstdDecompress`）：

```
zstd-19 压缩完成: 33.60 MB，64.2s
createZstdDecompress 解压完成: 0.5s
原 tar   sha256 = fdf49d0f72f95e16e711e2e7f5f743dd7e35acb8acc63304abf8543f0874b0d3
回环 tar sha256 = fdf49d0f72f95e16e711e2e7f5f743dd7e35acb8acc63304abf8543f0874b0d3
ROUND-TRIP OK
```

即：**首次启动的解包耗时不受影响（0.5 秒解 164 MB），字节级一致**。这是纯构建期参数，运行期行为完全不变。

> 级别 22 多省 1.18 MiB，但窗口 128 MB、需单独验证解压端窗口上限。**默认建议只提到 19。**
> 提到 19 后 `bundle-dsh-zst.js` 顶部「9 是体积/构建时间的平衡点」注释需同步改掉。

### A3. `scripts/after-pack.js` 增删 `dxil.dll`（**-0.66 MiB**）

`dxcompiler.dll`（24.6 MB）已在 1.0.19 删除，但同属 DXC（DirectX Shader Compiler）链路的 `dxil.dll`（1.44 MB）还留着。两者都只服务 WebGPU/Dawn，不存在「删了 compiler 还留着 validator 有用」的场景。

按与现有条目**完全相同的验证流程**处理（删除后实机启动 + 两个页面渲染正常 + 记入「升级 Electron 时必须重验」清单）。

### A4. `files` 增加 `!**/*.map`（**-0.15 MiB**）

`app.asar` 实占 2.74 MB，其中 **0.65 MB 是第三方 sourcemap**，没有任何运行时代码会读它们：

```
0.18 /node_modules/js-yaml/dist/js-yaml.js.map
0.17 /node_modules/js-yaml/dist/js-yaml.mjs.map
0.17 /node_modules/js-yaml/dist/js-yaml.min.js.map
0.05 /node_modules/electron-updater/out/AppUpdater.js.map
0.04 /node_modules/builder-util-runtime/out/httpExecutor.js.map
```

`dist/` 自身 0 个 `.map`（已核对）。加一行负向 pattern 即可。

> A 档合计 **-5.29 MiB → 193.65 MiB（-2.7%）**，改 4 个文件、零功能风险。

---

## 5. B 档：低风险裁剪（-5.0 MiB，需验证）

### B1. 删除 `vk_swiftshader.dll` + `vulkan-1.dll` + `vk_swiftshader_icd.json`（**-2.48 MiB**）

SwiftShader 是软件 Vulkan，用于「GPU 不可用时的 WebGL/Vulkan 兜底」。DOM 渲染与 Canvas2D 不走这条路，但如果 DSH Web UI 或某个第三方前端库用了 WebGL/WebGPU，在**无显卡驱动的虚拟机、远程桌面、驱动被禁用的机器**上会失去兜底。

**结论：可以删，但必须实机在两种场景下验证**（① 启动参数 `--disable-gpu`；② 设备管理器禁用显卡后启动），确认页面仍正常渲染。没做这两项验证就不要删。

### B2. DSH 树 micro-trim（**-2.51 MiB**，逐项风险不同）

先看现状——`dsh-bundled.tar.zst` 内 **11,322 个文件 / 155.33 MB**，按后缀聚合：

| 后缀 | 文件数 | 原始 MB |
| --- | ---: | ---: |
| `.js` | 6,379 | 67.31 |
| `.dll` | 7 | 40.27 |
| `.mjs` | 1,332 | 9.47 |
| `.cjs` | 305 | 8.38 |
| `.ts` | 775 | 6.21 |
| `.exe` | 2 | 6.19 |
| `.md` | 587 | 5.53 |
| `.json` | 811 | 3.26 |

**sourcemap 已无肉可割**：全树只剩 28 个 `.map`，合计 0.06 MB（`@deepseek-ai` 豁免确实没放走大文件）。这条曾经的怀疑方向可以排除。

真正还有的：

| 项 | 在 zst 里占 | 风险 |
| --- | ---: | --- |
| `@deepseek-ai` 下 585 个 `.md` | 1.26 MiB | **中**：豁免理由写的是「README 运行时可能读取」。删前必须全树 grep `readFile/readFileSync` 找 README 引用；找不到才能删 |
| `.ts` 源码 775 个 | 0.79 MiB | **中**：需确认没有任何包的 `exports`/`main` 指向 `.ts` |
| `@mixmark-io/domino/.yarn/plugins/@yarnpkg/plugin-version.cjs` | 0.25 MiB | **无**：发布包里混进的 Yarn Berry 插件，1 MB 单文件，不可能被引用 |
| `.cc` / `.h` / `.hh` 52 个 | 0.21 MiB | **低**：原生模块源码，运行期不需要（需确认无运行时编译路径） |

> 任何 `extraResources` / filter 改动都必须重跑 AGENTS.md §8.2.4 的三项验证（模块解析差分 / 文件级差分审计 / 真实启动裁剪后的 `dsh-bundled`）。

---

## 6. C 档 / D 档

### C1. `sherpa-onnx-win-x64` 改按需组件（**-6.11 MiB**，推荐）

**这是本轮最干净的一个发现。** 实测证据链：

- 该包 22.42 MB 原始 / **占 zst 6.11 MiB（16%）**，是树里第一大件；
- 全树只有 `@deepseek-ai/dsh-experimental-speech-to-text-sensevoice` 引用它，而该包 package.json 的描述是 **`experimental`**；
- 该功能**本来就不能离线用**：`runtime/assets.json` 里三个 ONNX 模型（model.int8.onnx 等）全部指向 `huggingface.co` 的下载 URL；
- `sherpa-onnx-node` 已把它声明在 `optionalDependencies` 里——上游自己就接受「这个平台包可以不在」。

**净效果**：功能一条不少，只是把 22.4 MB 运行时从安装包挪到「首次使用（或首启后台静默预取）」下载。对一个首次使用本来就要下模型的实验性功能，用户几乎感知不到差别。

### C2. `sharp`（`@img/sharp-win32-x64` + `sharp`）改按需组件（**-6.79 MiB**，产品决策）

- 22.4 MB→ 实测 `@img/sharp-win32-x64` + `sharp` 合计 19.54 MB 原始 / **6.79 MiB（占 zst 18%）**；
- 使用方是 `@deepseek-ai/dsh-attachment-local`（图片附件处理）与 `dsh-spill-policy`；
- **加载方式是惰性的**：`const requireSharp = createLazyRequire("sharp", import.meta.url)`——缺件只在「处理图片附件」那一次调用报错，不影响启动。

所以技术上和 libreoffice-kit 完全同构。**但图片附件是高频路径**，且 `dsh-components.ts` 的 `prefetchComponentsInBackground()` 是「首启静默预取」，离线或首启后立刻粘贴图片的用户会撞上下载窗口。

**建议**：作为产品决策讨论，不作为纯技术优化默认开启。

> **机制成本**：`dsh-components.ts` 目前是**单组件硬编码**（`LIBREOFFICE_KIT_PACKAGE` / `LIBREOFFICE_KIT_ENTRY` / `isLibreOfficeKitReady`）。加 C1/C2 需要先把「包名 / 入口包 / 就绪判定 / 版本约束来源」参数化成组件表——这是一次小重构，不是配置改动。

### C3. 出厂 DSH 树也改成按需下载（**-37.46 MiB**，**不推荐**）

单看数字这是最大的一刀——`dsh-bundled.tar.zst` 占安装包 **18.9%**，而且**下载链路已经存在**（`dsh-repair.ts` 本来就会下载完整 DSH 包并安装到 `dsh-cache/`）。

**为什么不推荐**：出厂树的全部意义就是「**装完即用，且离线可用**」。拿掉它意味着：

- 首次启动必须联网，且要等约 40 MB 下载完成——现在首启只需解包 9 秒；
- 离线环境（内网、无网笔记本）装完直接不可用，而这是当前明确保证过的能力；
- 「在线修复」从**兜底**变成**唯一路径**，兜底能力归零。

这已经不属于「不损害功能使用」，是产品定位的改变。列在这里只为把账算全，不建议执行。

### D1. `node.exe` + npm 预压缩，首启解包（**-10.51 MiB**）

deflate 36.75 → zstd-19 26.24 MiB。

**可行性最高的架构级方案**：不需要引导程序——**Electron 主进程自己就是解压器**，而且 `dsh-unpack.ts` 已经把「manifest 幂等 + 原子 rename + 残留扫描 + 退避重试」这一整套验证过了。把 `resources/node/` 打成一个 tar.zst，首启解到 `%LOCALAPPDATA%/DSH Desktop/node/`，`node-binary.ts` 的 `getNodeDir()` 改指向那里即可。

**风险等级：中高。** 与 dsh-bundled 不同的是——**这是启动硬依赖**。dsh-bundled 解包失败只是「出厂版本不可用、回退在线修复」，而 node 运行时解包失败 = DSH 根本起不来。必须把「node 运行时缺失」显式接进 error.html +「在线修复」链路（`DSH_PACKAGE_MISSING` 同款 `[CODE:...]` 机制），否则一次解包失败就是死局。

### D2. Electron 运行时预压缩，安装期由 NSIS 解包（**-30.31 MiB**）

`DSH Desktop.exe` 103.75 → 77.86 MiB，加上 `locales/` `icudtl.dat` `LICENSES.chromium.html` `app.asar` 与各 dll，整块 132.07 → 101.76 MiB。

**引导悖论决定了它只能这么做**：exe 不能在自己待着的压缩包里，所以必须在**安装期**由已落地的 `node.exe` 解包（NSIS `customInstall` 钩子跑一个解包脚本）。

**风险等级：高。** 需要重验的面很宽：

- 安装期多一个可能失败的步骤 → 失败即「装出一个坏副本」；
- 卸载器文件清单是编译期生成的，**不含运行时解出的文件**（需 `RMDir /r "$INSTDIR"` 兜底）；
- electron-updater 的 `--updated` 安装路径、`CHECK_APP_RUNNING`、`ESTIMATED_SIZE`（安装器显示的占用空间）全部要重验；
- `build/installer.nsh` 的 `${isUpdated}` 重定义（方案 B'）与 keep-shortcuts 链路必须回归。

**收益确实大（-15%，能到 ~135 MiB），但它是一个独立项目，不是优化项。**

---

## 7. 明确不建议做的

| 项 | 为什么不做 |
| --- | --- |
| 重开 7z / LZMA2 载荷 | 已实测：**约 340 秒是 LZMA2 自身的解压速度**，换来安装耗时从 24s 回到 360s。§8.2.1 的账已经算清 |
| 删 `d3dcompiler_47.dll` | ANGLE D3D11 后端编译 shader 要用，删了 GPU 加速会退化 |
| 删 `ffmpeg.dll` | `<audio>` / `<video>` 直接失效。DSH 已有 TTS/语音相关能力，不能赌 |
| 删 `LICENSES.chromium.html` | 省 2.01 MiB，但 Chromium 的 BSD 许可要求随附版权声明。法务风险 > 体积收益 |
| 整体删 `icudtl.dat` | `Intl` 全废（日期/数字/排序）。自定义裁剪要精确匹配 ICU 版本、收益仅 0.94 MiB，不划算 |
| 用 Electron 自带 Node 替掉 `node.exe` | ABI 不同 → `node-pty` / `sharp` / `koffi` 等 prebuilt 原生模块 `ERR_DLOPEN_FAILED`，DSH 启动即崩。§12.1 有历史实例 |
| 靠升级 Electron 减体积 | §12.1 第 52 条已量化：Chromium 130→152 让 exe 从 180.3 → 234.3 MB（+54 MB）。升级是安全债，不是优化手段 |
| 删 `resources.pak` | Chromium 初始化必需，且它本身几乎不可压缩（11.86 → 11.77） |

---

## 8. 落地路线

| 阶段 | 动作 | 收益 | 验证要求 |
| --- | --- | --- | --- |
| **第一步（建议立刻）** | A1 + A2 + A3 + A4 | **-5.3 MiB → 193.6 MiB** | A2 已完成 SHA-256 往返验证；A3 需实机启动验证；跑一次完整 `npm run package` + 干净机安装 |
| 第二步 | B2 里无争议的两项（`.yarn`、`.cc/.h/.hh`） | -0.46 MiB | §8.2.4 三项验证 |
| 第三步 | C1（sherpa-onnx 按需化） | -6.1 MiB | 需先参数化 `dsh-components.ts`；验证语音功能首次使用能自动装上 |
| 待评估 | B1 / B2 其余项 / C2 | -5.0 MiB | 实机验证（GPU 兜底 / README 引用审计） |
| 独立立项 | D1 → D2 | -10.5 / -30.3 MiB | 安装与卸载全链路回归 |

**累加预期**：A+B+C ≈ **175.8 MiB（-11.6%）**；再加 D1 ≈ 165.3 MiB；全做（含 D2）≈ **135 MiB（-32%）**。因各项会互相摊薄（先 C 削树后 A2 的 zstd-19 收益变小、先删 vk_swiftshader 后 D2 收益变小），实际合计比直接相加乐观约 2-3 MiB。

---

## 9. 复现方法

探针脚本（一次性，不随包发布）：

1. **载荷 zip 对照**——用 `NsisTarget.js` 同款 7za 参数在 `win-unpacked` 上重建：
   ```
   7za a -bd -mx=7              -mtc=off -mm=Deflate -mcu zip-mx7.zip .
   7za a -bd -mfb=258 -mpass=15 -mx=9 -mtc=off -mm=Deflate -mcu zip-mx9.zip .
   ```
2. **逐组件压缩画像**——对 `win-unpacked` 每个文件算 `zlib.deflateRawSync(level 9)` 与 `zlib.zstdCompressSync(level 19)`，按顶层组件聚合（§3 表）。
3. **zst 内容清单**——用 `zlib.createZstdDecompress` 解出 `dsh-bundled.tar.zst`，顺序解析 ustar 头（只读头，不解文件），得到 11,322 条 `{name,size}`（§5 B2 表、§6 各包占比）。
4. **zstd 级别对照 + 往返校验**——按 §4 A2 的脚本对解出的 tar 重压 19/22 并回环比对 SHA-256。

> 注意：3 与 4 需要解出约 164 MB 的中间 tar，跑完请删除。`dist-exe/<版本>/win-unpacked` 本身是构建产物，不要当作源码改动。
