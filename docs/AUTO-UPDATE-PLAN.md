# DSH Desktop 客户端自动更新方案

> 状态：**方案已定稿**，云端准备阶段进行中。本文档只做方案设计，不含代码改动。
> 适用版本：1.0.16 起
> 关联模块：`src/main/app-update.ts`、`src/main/index.ts`、`electron-builder.yml`、`build/installer.nsh`
>
> **前置操作**：R2 与域名的配置请照着 **[`R2-SETUP-GUIDE.md`](./R2-SETUP-GUIDE.md)** 一步步做，本文 §4.5 解释为什么这么配。

---

## 1. 目标与现状

### 1.1 目标

用户看到更新提示后，**点击即在应用内完成下载与安装**，不再跳转 GitHub Release 页面手动下载。

### 1.2 现状链路（**改造前**的历史基线，1.0.3 – 1.0.16）

```
启动 → checkForGitHubAppUpdate() → 拉 api.github.com/repos/.../releases/latest
     → 注入横幅 → 用户点「前往下载」→ install-update IPC
     → dialog 确认 → shell.openExternal(GitHub Release 页)
     → 用户自行下载 exe → 双击安装（走完整安装向导）
```

> 1.0.17 起这条链路已整体废弃：不再走 GitHub Releases API，改拉 R2 的 `latest.yml`；也不再注入横幅，改为标题栏内条件显示按钮。

问题点（均已在代码中确认）：

| 问题 | 证据 |
| --- | --- |
| 检测与下载都依赖 GitHub，国内网络不稳定 | `app-update.ts:21` 直连 `api.github.com` |
| 更新检查失败被静默吞掉 | `index.ts:1204` `if (result.status === 'error') return` |
| 手动双击升级会丢任务栏固定图标 | `installer.nsh:13-14` 明确记载该问题根因 |
| 升级时旧安装目录走 `atomicRMDir`，多搬两趟 584MB | `installer.nsh:96-118` |

---

## 2. 已确认的前提（重要）

以下事实直接决定方案形态，**不是推测**：

### 2.1 安装包 250MB，`useZip` 与差分更新互斥

- 1.0.14 是 145.22MB，1.0.15 起 250.42MB —— `useZip: true` 用体积换了安装速度。
- `electron-builder.yml:48-55` 已写明：`useZip: true` **必须**配 `differentialPackage: false`，否则 `NsisTarget.js` 强制 7z 格式，安装器会用 `nsisunz` 去解 7z，**安装必然失败**。
- 1.0.14 实测：18,888 个文件用 7z 全新安装需 **360 秒**；同机 robocopy 单线程复制同一棵树只要 **24.7 秒**。

**结论**：本方案采用全量下载，不做差分。在国内 10MB/s 宽带下 250MB 约需 25 秒，而改用 7z 换差分的代价是安装从约 1 分钟涨到 6 分钟——得不偿失。

### 2.2 产物未签名

`Get-AuthenticodeSignature` 对 `DSH Desktop.exe` 返回 `NotSigned`。

经查 `electron-updater` 源码（`NsisUpdater.verifySignature`）：

```ts
publisherName = (await this.configOnDisk.value).publisherName
if (publisherName == null) {
  this._logger.warn("Signature verification ... was skipped ... This fail-open
                     behavior is deprecated: electron-builder v28 will treat a
                     missing publisherName as a verification failure")
  return { response: "success" }   // 当前放行
}
```

**结论**：未签名状态下，更新包**只校验 sha512**（`latest.yml` 中的哈希），不做 Authenticode 校验。这在当前版本可用，但 electron-builder v28 会改成 fail-closed（直接拒绝安装）。需在升级依赖时重新处理。

`sha512` 本身由 `latest.yml` 提供，而 `latest.yml` 走 HTTPS 传输，因此未签名状态下更新链路的信任根是「TLS + 云端元数据」。**这意味着云端存储桶必须配置为不可被第三方篡改**——见 §4.2。

### 2.3 `latest.yml` 缺 `size` 字段

当前 `latest.yml` 内容（1.0.16）：

```yaml
version: 1.0.16
files:
  - url: DSH-Desktop-Setup-1.0.16.exe
    sha512: yyPNTywxh...
path: DSH-Desktop-Setup-1.0.16.exe
sha512: yyPNTywxh...
releaseDate: '2026-09-28T08:55:40.141Z'
```

缺 `size` 是 `differentialPackage: false` 的副作用。经查 `Provider.resolveFiles` 与 `executeDownload`：`size` **不参与**完整性校验，校验只用 `sha512`。但 `download-progress` 事件的 `total` 依赖它。

**结论**：不影响功能，但下载进度条无法显示百分比。处理方式见 §5.3。

### 2.4 应用以管理员权限运行

`electron-builder.yml:24` `requestedExecutionLevel: requireAdministrator`。`NsisUpdater.doInstall` 对 `isAdminRightsRequired` 为真时走 `elevate.exe` 提权，**与本项目现状一致，无需改动**。

---

## 3. 技术选型：electron-updater + generic provider

### 3.1 为什么是 electron-updater

这是 Electron 生态的官方标准方案，与 `electron-builder` 同源，且**已从本项目移除过一次**（1.0.3 移除 electron-updater + Gitee 回退源）。重新引入的理由与当时的移除理由不同：

| | 1.0.3 移除时 | 1.0.17 重新引入时 |
| --- | --- | --- |
| 目的 | 消除自动下载 | 恢复自动下载 |
| 云端 | GitHub + Gitee 双源 | 单一国内云源 |
| 用户体验 | 手动下载 | 应用内一键更新 |

### 3.2 为什么是 generic provider 而非现成 provider

`electron-updater` 内置 github / gitee / s3 / spaces / azure 等 provider。generic provider 只要求服务端能通过 HTTPS 提供两个文件：

```
latest.yml                                  ← 元数据
DSH-Desktop-Setup-<version>.exe             ← 安装包
```

这意味着**换云厂商时只改一个 URL 字符串**，不依赖任何厂商 SDK，是本方案可维护性的关键。

### 3.3 provider 多源能力

`setFeedURL` 支持传入数组实现多源回退。方案保留 GitHub 作为**第二源**：国内主源不可用时自动降级到 GitHub，而不是直接失败。这条对国内用户是实打实的可靠性提升。

---

## 4. 云端存储选型

### 4.1 需求约束

- 免备案（中国大陆）
- 中国大陆访问速度快
- 支持 HTTPS + Range 请求（断点续传 / `useMultipleRangeRequest`）
- 成本尽量低

### 4.2 已排除的方案

| 方案 | 排除原因 |
| --- | --- |
| Gitee Release 附件 | **单附件 100MB 上限**，安装包 250MB 放不下（社区版配额已核实） |
| Cloudflare R2 | 官方明确**不支持在大陆创建桶**、不支持大陆 custom domain；无 China Network 的站点走境外 Anycast，联通线路特别不稳 |
| npmmirror 二进制托管 | 已转白名单模式，第三方包需提交 PR 申请，且仅面向 npm 生态，不收应用安装包 |
| GitHub Releases | 国内访问不稳定，正是本次要解决的问题 |
| 阿里云 OSS / 腾讯云 COS | 需实名认证。**免费额度均为 6 个月**（COS 50GB 存储 + 10GB/月流量），不是永久免费 |

### 4.3 Cloudflare R2 能不能用

**可以，且已定为最终方案（方案 A）。** 本节保留完整评估过程，**结论已于后续讨论中更新**——下表是当时的顾虑，§4.5 与 §9 是最终定稿。

| 维度 | 当时顾虑 | 现状 |
| --- | --- | --- |
| 免备案、免费额度 | ✅ R2 绑自定义域名不需备案，免费档 10GB 存储 + 0 出口费。250MB 装得下 | ✅ 成立，已采纳 |
| 大陆可达性 | ⚠️ 官方明确不支持在大陆创建 R2 桶，也不支持大陆 custom domain。未开 China Network 的站点走境外 Anycast | ⚠️ 属实，**已知并接受**（用户明确「先不考虑大陆速度，能下载就行」） |
| 线路质量 | ❌ 社区实测：中国联通（AS4837）到 CF 免费档 IP 延迟异常高、丢包明显 | ⚠️ 属实，**已知并接受**，后续用实测数据决定是否切主源 |
| 支付 | ⚠️ 大陆双币卡常被风控拒绝 | ✅ **已解决**：域名在 Cloudflare 购买，说明支付通道可用 |

> **决策记录**：域名已在 Cloudflare 购买 → 方案 A 的两个前置条件（自持域名、支付通道）均满足 → R2 路线确立为**主源**。下方「结论」段为历史记录，保留供追溯。

<details>
<summary>（历史结论，2026-09-29 已被上表更新取代）</summary>

**当时的结论**：R2 适合放兜底源（成本为零、海外用户友好），不适合做国内主源。把它当主源意味着把更新可用性押在一条「联通不稳 + 跨境链路」的路径上。

如果一定要用 R2 做主源，务必实测联通网络下的实际下载速率再决定——不要看纸面参数。

</details>

#### 概念澄清：「经 Cloudflare 边缘节点分发」≠「用了 R2」

这两者常被混为一谈，但属于不同层次：

| | Cloudflare R2 | 边缘节点分发（CDN） |
| --- | --- | --- |
| 层次 | **存储**（S3 兼容对象存储，存文件的仓库） | **分发**（把文件送到最近节点的加速网络） |
| 可否单独使用 | 可以，但需自行解决访问入口 | 可以，源站在任何地方都行 |

R2 + 自定义域名是最常见搭配（R2 出口免费且能直接绑 CDN），但边缘分发的源站**也可能是自建服务器、GitHub、阿里云 OSS**——只要能被 Cloudflare 缓存，一样叫「边缘分发」。

**实证案例（CC Switch）**：其官网 `ccswitch.io` 文案写「下载经 Cloudflare 边缘节点分发」，但实测抓取显示：

- 页面内**唯一**的 Cloudflare 痕迹是 `static.cloudflareinsights.com/beacon.min.js`，那是 **Cloudflare Analytics 访问统计脚本，与文件分发无关**；
- 页面中 `r2.dev` / `workers.dev` / `cloudflarestorage` / `cf-assets` **均不存在**；
- 最新版 v3.20.4 的 21 个 Assets **全部挂在 GitHub Releases**。

即：官网文案与实际产物存放位置存在张力，实际下载域名未能证实。

**由此得出一条选型纪律：不要把「宣称走 Cloudflare 加速」当作选型依据，必须实测最终下载域名。** 验证方法：国内网络点下载 → 查看 HTTP 重定向链 → 确认最终落在哪个域名 → 测量实际速率。

#### 「用 Cloudflare 代理分发 GitHub 上的包」这条路走不通

一个自然的想法是：包继续放 GitHub，前面套一层 Cloudflare 边缘节点。逐条核实后**这条路不成立**：

**技术可行性**：可行。Cloudflare Free/Pro/Business 档的**可缓存单文件上限为 512MB**（Enterprise 为 5GB），250MB 安装包在限内；`.exe` 也在 Cloudflare 默认缓存扩展名列表中。做法是橙云代理 + 源站回源 GitHub + 边缘缓存。

**但有三个问题：**

**1. 违反 Cloudflare 服务条款（硬伤）**

Service-Specific Terms 的 CDN 条款原文：

> Unless you are an Enterprise customer, Cloudflare offers specific Paid Services (e.g., the Developer Platform, Images, and Stream) that you must use in order to serve video and other large files via the CDN. Cloudflare reserves the right to disable or limit your access to or use of the CDN, or to limit your End Users' access to certain of your resources through the CDN, if you use or are suspected of using the CDN without such Paid Services to serve video or a disproportionate percentage of pictures, audio files, or other large files.

官方中文文档表述更直接：

> 如果你在使用 Free、Pro 或 Business 计划，并且提供视频或过多数量的非 HTML 内容（如**软件二进制文件**或大量图像），因而违反自助订阅协议… Cloudflare 可能会将您的内容重定向。请勿尝试规避重定向，否则可能会导致您以后彻底不能使用 Cloudflare。

两个关键点：

- **「软件二进制文件」在字面上正好命中 .exe 安装包**；
- 豁免只有两条：Enterprise 客户，或内容托管在 Cloudflare 自有服务（Stream / Images / **R2**）。**「源站在 GitHub」不在豁免范围内**。

补充：老「2.8 条」虽于 2023 年撤销，但**限制本身被移入 CDN 服务条款**，并未取消（见 [Cloudflare 官方博客](https://blog.cloudflare.com/updated-tos/)）。网上「2.8 已废、随便用」的说法已过时。

**2. 不解决大陆访问问题（本问题的核心）**

大陆下载慢的根因是**跨境链路**，不是 GitHub 这个域名。Cloudflare 免费档无大陆 PoP（China Network 仅 Enterprise 且需 ICP 备案），国内用户仍走境外 Anycast。代理 GitHub 只是把

```
用户 → GitHub（跨境）
```

变成

```
用户 → Cloudflare 境外节点 → 回源 GitHub（跨境）
```

**境内那一段依然要出境，且多了一跳。** 前述社区实测中「联通到 CF 免费档 IP 延迟异常高」正是此问题的体现。

**3. 额外成本**：代理需自持域名（可免备案），多一层域名与配置管理。

**结论**：这条路既违规又无效。Cloudflare 的豁免条款只认 R2 / Stream / Images / Enterprise，**其设计意图恰恰是引导「把文件搬进 Cloudflare 或是买付费大文件服务」**——换个角度说，「用 Cloudflare 分发 GitHub 包」这件事本身就在把你推向 R2 或国内云，绕不过去。

> **这条判断仍然成立，但已被纳入方案**：要让大陆用户下载**快**，唯一出路是让文件本身位于境内节点——Cloudflare 免费档做不到，代理 GitHub 也做不到。**代价是 0.5 元/GB 的流量费**。若日后实测 R2 的大陆速率不可接受，这就是切换到境内节点的理由（详见 §9.3）。

### 4.4 自建服务器能不能用

**不推荐，除非用户量极小且固定。** 按 250MB 全量下载算账：

**下载耗时**（理论值，实际还要打折）：

| 带宽 | 下载 250MB 耗时 |
| --- | --- |
| 2 Mbps | 约 2.1 分钟 |
| 3 Mbps | 约 1.4 分钟 |
| 5 Mbps | 约 50 秒 |
| 10 Mbps | 约 25 秒 |

**成本对比**（对象存储 0.5 元/GB 下行 vs ECS 固定带宽）：

| 用户规模 | 月流量 | 对象存储 | 自建（5Mbps 固定带宽） |
| --- | --- | --- | --- |
| 50 人 | 12 GB | 约 6 元 | 125 元（理论上限 1582 GB） |
| 200 人 | 49 GB | 约 24 元 | 125 元 |
| 1000 人 | 244 GB | 约 122 元 | 125 元（已接近带宽上限） |
| 5000 人 | 1221 GB | 约 610 元 | 带宽打满，**必须加流量包/升配** |

自建方案的问题：

- **带宽是共享的**。5Mbps 理论上限 1582 GB/月，但更新往往集中在发版后的几天，其余时间空转。要么为峰值买带宽，要么为日常付空置成本。
- **单点风险**。服务器宕机 = 全部用户无法更新，没有自动容灾。
- **要自己运维**：Nginx 配置、HTTPS 证书续期、防盗链、系统安全更新。
- **超出流量要另付费**，5Mbps 跑满后需升配（10Mbps = 800 元/月）或买流量包（0.8 元/GB）。

自建唯一的优势是**用户量小（<100 人）且可接受 2 分钟下载**时的确定性，以及完全可控。超出这个规模，成本和复杂度都不划算。

### 4.5 推荐方案 A：Cloudflare R2 + 自定义域名（零成本路线）

> 若当前阶段**优先考虑成本**、且可以接受大陆下载偏慢，这是**最省的可行方案**，且**完全合规**。

**为什么合规**：Cloudflare 服务条款对「经 CDN 分发大文件」的要求是必须使用其自有付费服务（Stream / Images / **R2**）。**R2 正是被点名的豁免对象之一**，所以「文件存 R2 + 边缘节点分发」不是规避，而是官方推荐的组合。

**可行性逐项核实**：

| 检查项 | 结论 |
| --- | --- |
| 250MB 能否被缓存 | ✅ Free/Pro/Business 可缓存单文件上限 **512MB**（Enterprise 5GB） |
| `.exe` 是否默认缓存 | ✅ 属 Cloudflare 默认缓存扩展名列表 |
| 出口流量费 | ✅ **$0**（R2 核心卖点；对比国内云 0.5 元/GB） |
| 存储成本 | 10GB 免费档（≈40 个版本）；超出 $0.015/GB/月 |
| 免备案 | ✅ 自定义域名不需 ICP 备案 |
| 大陆速度 | ⚠️ 慢（见 §4.3），但可用 |

**三个必须注意的落地细节**：

1. **禁止使用 `r2.dev` 免费公开地址**。官方文档明确标注其 "is not intended for production usage"，存在可变速率限制（每秒数百请求），超限返回 **429 Too Many Requests**，**且带宽同样会被限速**。生产环境必须绑定 Custom Domain（Cloudflare 会自动生成 CNAME）。

2. **必须自持域名**。自定义域名要求域名已托管在 Cloudflare zone 内。免备案，但绕不开「要有一个域名」。

3. **不要用预签名 URL 访问自定义域名**。预签名仅对 S3 域名（`<bucket>.<account>.r2.cloudflarestorage.com`）有效。本场景是公开读下载，直接读自定义域名即可，无需预签名。

#### 关于 `latest.yml` 的缓存策略（实测已验证，无需设置）

> **2026-09-29 实测结论：不需要设置任何 Cache-Control。** 本节此前的「必须设 no-store」警告**已确认是错的**。

对已绑定自定义域名的桶实测返回：

```
HTTP/1.1 200 OK
Content-Type: text/yaml
ETag: "8d92aa8627382c44de2158e5842ad8bf"
cf-cache-status: DYNAMIC        ← 边缘不缓存，每次回源
```

**原因**：R2 经自定义域名返回对象时**不带 `Cache-Control` 响应头**，而 `.yml` 也不在 Cloudflare 默认缓存扩展名列表中（该列表含 `.exe`、`.zip`、`.png`，不含 `.yml`）。二者叠加 → 判定为不可缓存。

**这恰好是期望行为**：覆盖 `latest.yml` 后客户端立即可读到新版本，不存在缓存陈旧问题。

> R2 对象详情页**没有**编辑 HTTP 元数据（Cache-Control）的入口，这是正常设计而非遗漏。若日后确需设置，只能用 `wrangler` 或 S3 API 在上传时指定。

**若日后 exe 出现分发不及时**：`.exe` **在**默认缓存扩展名列表内，届时可为它单独设置 `Cache-Control: public, max-age=31536000, immutable`。

#### 配置

```yaml
publish:
  provider: generic
  url: https://download.<你的域名>     # 自定义域名，禁用 r2.dev
  channel: latest
```

桶开启公有读 → 绑定 Custom Domain → 上传 `latest.yml` + 安装包。

**「省」的折扣与风险提示**：

- R2 的 0 出口费成立，但**跨境时间成本转嫁给了用户**。按 §2.1 的包体，1000 用户各更新一次 = 250GB 跨境流量；若实际速率 1–2MB/s，单次更新需 2–4 分钟。
- **单源可用性风险**：R2 在 2025 Q1 发生过两次中断（2/6 共 59 分钟、3/21 共 1 小时 7 分钟）；Cloudflare 另有 2025-11-18 与 2025-12-05 两次全球故障。
- **建议**：按 R2 跑通主链路，**同时把国内对象存储作为兜底源**（`setFeedURL` 支持多源回退），与 §4.6 的交互方案配合。

### 4.6 推荐方案 B：国内对象存储（速度优先路线）

**推荐腾讯云 COS 或阿里云 OSS 二选一**（等价，看你已有哪个账号）。理由：

- 公有读 bucket 的默认 endpoint 自带 HTTPS，**无需域名、无需备案**。
- 存储费 0.099–0.12 元/GB/月，250MB × 20 个版本 = 5GB ≈ **0.5 元/月**。
- 流量费 0.5 元/GB 起。**这是真正的成本项**：1000 用户各更新一次 = 250GB ≈ 125 元/月。
- 免费额度可覆盖前 6 个月，足够把链路完整验证一遍再决定是否付费。

**关键建议：只保留当前版本 + 上一个版本**。用生命周期规则或人工清理，避免历史版本持续占用存储（下载量只发生在当前版本上，历史版本仅占存储费，成本很低）。

> **安全提醒**：未签名状态下，攻击者若能写入 bucket 或篡改 `latest.yml`，即可让所有客户端安装恶意程序。bucket 必须配置为**公有读私有写**，且发布凭据（AccessKey）只用于 CI 上传、绝不下发到客户端。客户端只读、不写。

### 4.7 关于成本

> **本节结论已被 §4.5 / §9 更新**：定稿采用 R2，**出口流量费为 $0**，因此「不存在完全免费方案」的说法**已不适用于当前选型**。以下为选择境内节点时的成本参考，保留供日后切换时决策。

若日后改用境内对象存储（COS/OSS），成本结构如下——**R2 不收出口费，这正是选用 R2 的原因**：

| 用户规模（每次全量更新） | 月流量 | 国内对象存储月成本 |
| --- | --- | --- |
| 50 人 | 12.5 GB | 约 6 元 |
| 200 人 | 50 GB | 约 25 元 |
| 1000 人 | 250 GB | 约 125 元 |

对照：**同样的 1000 人全量更新，R2 的出口费用为 $0**。R2 的成本仅剩存储（10GB 免费档内为 $0，超出 $0.015/GB/月）。

若这个成本不可接受，**唯一的解法是缩小安装包体积**（当前 250MB 中 `resources/node` 约 81MB + 内置 npm 约 11MB + dsh-bundled 约 150MB）。这属于独立议题，不在本方案范围内，但对任何分发方案都是最大的成本杠杆。

---

## 5. 实施设计

### 5.1 依赖变更

```jsonc
// package.json
"dependencies": {
  "electron-updater": "^6.3.9"   // 必须与 electron-builder 25 同代
}
```

版本必须与 `electron-builder@25` 匹配，不可独立升级到 7.x（7.x 对应 electron-builder 27，且 `quitAndInstall` 签名已变更）。

### 5.2 配置变更（`electron-builder.yml`）

恢复 `publish` 段并**显式关闭差分下载**：

```yaml
publish:
  provider: generic
  url: https://download.<你的域名>     # R2 自定义域名，禁用 r2.dev
  channel: latest

nsis:
  # ... 保持现有配置不变
  useZip: true
  differentialPackage: false   # 必须保持 false，理由见 §2.1
```

> **`url` 必须是自定义域名，不能用 `r2.dev` 官方地址**——后者标注为非生产用途，有速率与带宽限制（详见 §4.5 与 `R2-SETUP-GUIDE.md`）。

**不设置 `win.publisherName`**。产物未签名时若设置该字段，会导致签名校验失败并直接拒绝安装（见 §2.2 的 fail-closed 演进）。当前状态下**不写**该字段，走 fail-open 分支。

### 5.3 补齐 `latest.yml` 的 `size` 字段

由于 `differentialPackage: false` 不产 blockmap，`size` 缺失导致进度条无百分比。两种处理：

- **方案 A（推荐）**：在 `scripts/` 加一个打包后脚本，读 exe 实际大小补写进 `latest.yml`。零额外依赖。
- **方案 B**：主进程下载时改用自实现进度计算（Content-Length），不走 `download-progress` 的 `total`。

方案 A 改动最小，且对用户可见（进度条能显示百分比），推荐。

### 5.4 主进程改造（`src/main/app-update.ts`）

保留现有的版本号比较逻辑（`compareVersions` / `isValidVersion`），**只替换元数据来源**：

```
GitHub releases/latest API  →  GET {publish.url}/latest.yml
```

`app-update.ts` 的三态返回结构（`update-available` / `up-to-date` / `error`）保留不动，只换 `fetchGitHubLatest` 的实现为 `fetchLatestYml`。这样 `index.ts` 的调用方几乎不用改。

新增 electron-updater 事件接线：

| 事件 | 处理 |
| --- | --- |
| `update-available` | 只 `markUpdateAvailable()` → 标题栏亮起「更新」按钮，**不下载** |
| `download-progress` | 节流后同时推标题栏按钮（文案变「下载中 N%」）与 DSH 页顶部进度横幅 |
| `update-downloaded` | 进度横幅隐藏，按钮恢复为「更新」，点开是 [立即重启安装]/[下次启动时安装]/[取消] |
| `error` | 按钮保留，点开是 [重试下载] / [浏览器下载] / [取消] |
| `update-cancelled`（用户主动取消） | 状态退回 `available`，半截文件由 `removeFileIfAny()` 清理，按钮恢复为「更新」 |

### 5.5 安装交互

按你的选择：**下载完成后提示，用户选「立即重启」或「下次启动时安装」**。

```ts
autoUpdater.autoDownload = true          // 检测到新版自动开始下载
autoUpdater.autoInstallEvent = "manual"  // 关键：不自动装，等用户决定
```

- 「立即重启」→ `autoUpdater.quitAndInstall()`，走 `--updated` 参数。
- 「下次启动时安装」→ 记入本地 pending 标记，用户正常退出时安装；或下次启动时由主进程检测并安装。

> ⚠️ 上面的 `autoDownload = true` 是本文早期的写法，**实际落地时已改为 `autoDownload = false`**（见 `AGENTS.md` §6.5：检测走 `app-update.ts` 拉 `latest.yml`，由 `index.ts` 在用户点了「下载并更新」之后才显式调 `downloadAppUpdate()`，符合「不点不下载」）。

**下载完成后自动弹出确认框**（真机演练发现「横幅消失、按钮恢复『更新』，但不弹窗」后补上）：

- `onClientUpdatePhaseChange()` 在每次 `onAppUpdateState` 时做**跃迁检测**——只认「非 `downloaded` → `downloaded`」这一次跃迁，其余阶段不动作。
- `lastPromptedDownloadVersion` 保证同一版本只自动弹一次；**`phase === 'downloading'` 时清空**，这样「下载完 → 取消 → 重新下载 → 完成」会再次提示。
- 自动弹窗与用户点标题栏「更新」按钮共用 `promptInstallTiming()`，靠 `installPromptOpen` 互斥锁保证同一时刻至多一个框。
- 选「取消」不改变 `lastPromptedDownloadVersion`，用户点按钮仍能手动补弹。
- 当前**不判窗口前台**（最小化时也会弹），要改成「仅前台」在 `promptInstallTiming()` 开头加一行 `if (!mainWindow.isFocused()) return`。
- `downloaded` 阶段横幅隐藏、标题栏按钮回退为「更新」——这正是「不弹窗」事故的现象表现。

**这里有个额外收益**：`build/installer.nsh` 的方案 B' 正是为 `--updated` 参数设计的（`installer.nsh:16-27`）。当前手动双击升级**永远不带** `--updated`，导致 keep-shortcuts 链路断裂、任务栏固定图标丢失。走自动更新后，安装器会带上 `--updated`，**这个历史 bug 顺带被修好**。

### 5.6 升级时序与进程清理

`index.ts` 现有的退出流程会 `stopDsh()` 并 `taskkill` 杀整棵进程树。自动更新时必须走**同一条路径**，否则 DSH 子进程仍持有 `node.exe` 文件锁，安装器的 `RMDir /r` 会失败。

`customRemoveFiles`（`installer.nsh:116-119`）用 `RMDir /r "$INSTDIR"` 替代了 `atomicRMDir`，速度快但**失去了文件占用时的回滚保护**。自动更新场景下，若残留第三方进程占用文件，会表现为「升级后残留个别文件」——不影响覆盖安装，但需在测试中重点验证。

### 5.7 错误处理与回退

- 检测失败：不再静默 return，改为在「检查更新」对话框中如实报错（现有手动路径已是这个行为，自动路径应对齐）。
- 下载失败：清除临时文件（electron-updater 自带），保留手动下载入口。
- 建议**保留 GitHub Release 页面作为兜底入口**，与国内主源并存。
- **投影失败降级**（真机 61% 冻结事故后新增）：进度同时投影到两个通道——标题栏按钮（`mainWindow.webContents.send()`，无 guard）与 DSH 页横幅（`dshView.webContents.executeJavaScript()`，有准入判定 + 异常路径）。后者是**可降级副本**：准入失败记 `getURL()` 原因、注入失败计数，连续 `BANNER_FAIL_DEGRADE_AT = 3` 次即打 `console.error` 停止空打 CDP，本次下载的进度改由标题栏独占承载。一轮下载结束时重置诊断状态。
- **下载停滞只提示不重试**：`DOWNLOAD_STALL_THRESHOLD_MS = 8000`（上游 1s 一次 + 我方 2s 节流，连续 4 次缺失才判定卡住）超过后 `stalled = true`，横幅与按钮改显「速度为 0，已等待 N 秒」。**不自动重试**——自动重试会引入并发下载与半截文件风险。
- **周期重投影兜底**：进度事件是变化驱动的，丢一次投影就没有下一次变化来触发它，因此 `syncDownloadPeriodicReprojection()` 在 downloading 期间每 3 秒无条件再投影一次。

---

## 6. 发布流程变更

当前：`npm run package` → 产物在 `dist-exe/<版本>/` → 手动上传 GitHub Release。

改为：

```
npm run package
  → 补写 size 的脚本
  → 上传 exe 到 R2
  → 上传 latest.yml 到 R2   ← 必须最后
  → 发版后 curl 验证 latest.yml 立即可读到新版本号
  → 保留上传 GitHub Release 作为兜底
  → 创建 GitHub Release（tag 必须以 v 开头）
```

**上传顺序很重要**：**先传 exe，最后传 `latest.yml`**。反之（先传 latest.yml）会出现客户端拉到新元数据、却下载不到包的窗口期。

> ⚠️ 早期版本的本文档此处写反了（写成「先传 latest.yml」），已更正。若你此前的笔记抄了旧版本，请以本节为准。

建议写 `scripts/publish-update.js`，用 `wrangler` 或 R2 S3 SDK，避免手工操作出错。

---

## 7. 风险清单

| 风险 | 等级 | 应对 |
| --- | --- | --- |
| 未签名状态下元数据被篡改即可投毒 | **高** | R2 桶只开公有读、写权限仅账号持有；AccessKey 只用于 CI 上传，**绝不下发到客户端** |
| `latest.yml` 被边缘节点缓存导致发新版客户端看不到 | ~~高~~ **已排除** | 实测 `cf-cache-status: DYNAMIC`，边缘不缓存，无此风险（详见 §4.5） |
| R2 大陆线路不稳（联通尤甚）导致更新慢或失败 | 中 | 已知并接受；实测速率后决定是否切主源；国内云兜底 |
| R2 服务中断（2025 Q1 两次：59 分钟 / 1 小时 7 分钟） | 中 | 保留国内云或 GitHub 作为兜底源 |
| `customRemoveFiles` 无回滚保护，升级中途失败可能损坏安装 | 中 | 测试环境完整演练；保留手动安装包 |
| electron-updater 版本与 electron-builder 25 强绑定 | 中 | 不单独升级；升级时同步验证 |
| v28 起缺 `publisherName` 变 fail-closed，自动更新失效 | 中 | 纳入依赖升级检查清单 |
| 250MB 全量下载在弱网下体验差 | 低 | 进度条 + 可取消；后续再评估减包 |

---

## 8. 建议实施顺序

**阶段一：云端准备（已完成）**

1. ✅ 按 [`R2-SETUP-GUIDE.md`](./R2-SETUP-GUIDE.md) 配置 R2 与自定义域名。
2. ✅ 用小测试文件验证链路：域名可拉取 `latest.yml`，且实测 `cf-cache-status: DYNAMIC`（R2 经自定义域名返回对象时不带 `Cache-Control`，`.yml` 也不在 Cloudflare 默认缓存扩展名列表中，二者叠加 → 边缘不缓存，**不存在此前担心的 2 小时缓存延迟**）。
3. ⏳ 记录一次真实的大陆下载速率（需先上传 250MB 正式包，阶段三做）。

**阶段二：代码接入（已完成，2026-09-29）**

4. ✅ 引入 `electron-updater@^6.8.9`，配 `publish` 段（`provider: generic` / `url: https://download.dsh.392700.xyz` / `channel: latest`）。
5. ✅ 写 `scripts/patch-latest-yml-size.js` 补 `size`，已在真实 1.0.16 产物上验证（补出的 `262599877` 与 exe 字节数一致，幂等）。
6. ✅ 接线事件 → 标题栏按钮。模块划分：
   - `src/main/app-update.ts` — 只做元数据检查（拉 `latest.yml`、版本比较、清单文件名净化），保留原有三态返回，`index.ts` 调用方改动最小；
   - `src/main/auto-updater.ts` — 封装 electron-updater 单例、状态机、进度节流、安装决策；
   - `src/main/index.ts` — `buildTitlebarUpdateState()` 把 phase 折算成 `{ client: {show,...}, dsh: {show,...} }`，`pushTitlebarUpdateState()` 只在状态真变化时推 `titlebar-update-state` IPC；titlebar.html 据 `show` 控制两个按钮显隐。
7. ✅ 补充校验脚本 `scripts/verify-release.js`：上传前核对 sha512 / size / version，并打印严格有序的上传步骤。已用真实产物验证通过，用伪造的坏 sha512 验证确实会 exit 1。
8. ✅ `npm run build` 与 `tsc --noEmit` 均通过；核查产物中 electron-updater 的 `require("electron")` 已被 rollup 正确改写为 electron 导入，无 `require.resolve` / `createRequire` 残留（`electron.vite.config.ts` 未配 `externalizeDepsPlugin`，依赖被打进主进程 bundle，恰好与 `files: ["dist/**/*", "package.json"]` 的严格白名单相容）。
9. ✅ 交互模型按用户决策从「检测 → 手动点下载」改为**后台静默预下载**：检测到更新即自动开始下载，过程不显示进度、不弹窗、不打扰，下完才在标题栏亮起「更新」按钮，用户点一下才安装。失败态保留「重试下载」+「浏览器下载」两条兜底。
10. ✅ **交互模型第三轮改造（2026-09-29）**：废弃全部 DSH 页面横幅，改为标题栏内条件显示按钮。
    - 删除 `injectAppUpdateBanner` / `injectDshUpdateBanner`（共 199 行）、`appUpdateBannerInjected` 状态记忆与 `did-finish-load` 里的横幅重投影；
    - 删除 4 条横幅专用 IPC（`install-dsh-update` / `download-app-update` / `install-app-update` / `defer-app-update`）与对应 4 个 preload API；
    - 新增 3 条标题栏 IPC（`get-titlebar-update-state` / `titlebar-client-update` / `titlebar-dsh-update`）+ 4 个 preload API（`getTitlebarUpdateState` / `onTitlebarUpdateState` / `clientUpdateClicked` / `dshUpdateClicked`），均比对 `event.sender === mainWindow.webContents`；
    - 「更新」= DSH Desktop 客户端（天蓝），仅 `downloaded` / `error` 相显示；「更新DSH」= 运行包（DeepSeek 官方蓝系），`pendingDshUpdateVersion` 非空时显示；两者都在余额徽章右侧的 `.tb-actions` flex 容器内；
    - 已在浏览器实拍浅色/深色两套主题并验证 `is-hover` 交互态生效；布局实测坐标见 AGENTS.md §6.5。
11. ✅ **交互模型第四轮改造（2026-09-29）**：从「静默预下载」改为**按需下载 + 可见进度**，横幅以缩减形态回归。
    - 检测到新版本只点亮标题栏按钮，**不自动下载**；点按钮 → [下载并更新]/[取消] 确认框 → 才开始；
    - 下载中：DSH 页顶部 `#dsh-ub` 进度横幅（百分比 + 已下载量 + 速度）+ 标题栏按钮变「下载中 N%」，两者由 `onAppUpdateState` 同一回调成对投影；
    - 取消：按钮点击可弹框取消，依赖显式持有的 `CancellationToken`（见下）；
    - **依赖变更**：`package.json` 新增 `builder-util-runtime@^9.7.0`。原因是 electron-updater 用 9.7.0、electron-builder 用 9.2.10，两份副本的 `CancellationError` 是不同类对象，跨副本 `instanceof` 恒 false。声明 9.7.0 让运行时收敛成一份，tsc 才放行 `downloadUpdate(token)`；
    - **判断取消一律用 `cancelRequested` 标志位**，不用 `instanceof`——依赖解析再分叉时会静默失效，把用户主动取消误判成下载失败。

**静默预下载成立的前提（已核实）**：`DownloadedUpdateHelper.validateDownloadedPath` 会在真正下载前核对缓存目录 `%LOCALAPPDATA%\dsh web desktop-updater\pending\` 下的 `update-info.json` 与安装包 sha512，命中就**完全跳过下载**直接派发 `update-downloaded`。所以「下完 251MB 后关掉应用、重开再下一遍」这个担心不存在——这也是静默方案能被采纳的关键依据。

**阶段四：联调与演练（待做）**

11. ⏳ 上传 1.0.17 正式包到 R2（先 exe 后 `latest.yml`），确认可下载。
12. ⏳ 真机演练 1.0.17-Rc → 1.0.17（当前交互模型）：
    - 启动后标题栏应**立刻**亮起「更新」按钮，且**不发生任何下载**（看网络/磁盘确认）；
    - 点「更新」→ 确认框只有 [下载并更新] / [取消] 两项，选取消应无副作用；
    - 选「下载并更新」→ DSH 页顶部出现进度横幅，标题栏按钮变「下载中 N%」；
    - **重点验取消**：下载中途点「下载中 N%」按钮 → 确认框默认焦点在「继续下载」；选取消后应立刻退回「更新」按钮、横幅消失、**且不应弹出「重试下载」**（这是 `cancelRequested` 标志位是否生效的判据）；
    - 重新点「更新」应能从头再下（验证半截文件被 `removeFileIfAny()` 清干净）；
    - 下完后 [立即重启安装] / [下次启动时安装] 两条路径。**特别验「下次启动时安装」**——它依赖 `stopDsh()` 先跑完，若 DSH 进程没清干净，安装器清空安装目录时会撞文件占用；
    - 另验任务栏固定图标在自动升级后是否还在原位。
13. ⏳ 记录真实大陆下载速率，作为后续是否配置国内兜底源的决策依据。
14. ⏳ 灰度：先发一个测试版本给内部用户验证，再正式发布。

> **联调前的已知阻塞点**：R2 桶 `dsh-desktop` 当前是空的（`latest.yml` 与 `test.txt` 均返回 404），需要先上传。域名与 Cloudflare 路由本身正常。

---

## 9. 云存储选型结论

### 9.1 两条可行路线（R2 方案已完成合规与可行性核实）

| | **方案 A：R2 + 自定义域名** | **方案 B：国内对象存储** |
| --- | --- | --- |
| 合规性 | ✅ R2 是 Cloudflare 条款明确豁免的服务 | ✅ |
| 流量成本 | ✅ **$0 出口费** | 0.5 元/GB |
| 存储成本 | 10GB 免费档（≈40 版本） | 0.099–0.12 元/GB/月 |
| 长期成本 | 极低（1000 人全量更新 ≈ 250GB 出口，费用 $0） | ≈ 122 元/月 |
| 免备案 | ✅ | ✅ |
| 大陆速度 | ⚠️ 慢，1–2MB/s 时单次更新 2–4 分钟 | 好（境内节点） |
| 域名要求 | **必须有自持域名托管在 CF** | 不需要 |
| 支付门槛 | ⚠️ 大陆信用卡常被风控拒绝 | 需实名认证 |

**方案 A 是当前的成本最优解**，前提是：① 有（或愿意买）一个域名；② 能解决 Cloudflare 支付；③ 接受大陆下载偏慢。

### 9.2 已排除的方案

| 方案 | 排除原因 |
| --- | --- |
| CDN 代理 GitHub 上的包 | 违反服务条款（分发非 Cloudflare 托管的大文件），且不解决跨境问题（详见 §4.3） |
| Gitee Release 附件 | 单附件 100MB 上限，装不下 250MB |
| 自建服务器 | 用户量 <100 且可接受 2 分钟下载时可行；规模上去后带宽成本远超对象存储（详见 §4.4） |

### 9.3 最终建议

**采用方案 A（R2）作主源 + 方案 B（国内对象存储）作兜底源。**

**前置条件已确认**：域名在 Cloudflare 购买 → 方案 A 的两个约束（① 自持域名、② 支付通道）均已满足，无需额外采购。

理由：

1. **成本**：R2 出口免费，把「用户规模」这个变量从成本公式里彻底消除了。这是相比国内云最实质的优势。
2. **可靠性**：R2 有过服务中断记录（2025 Q1 两次），Cloudflare 有过全球故障，叠加国内云兜底后，任一源故障用户仍可更新。
3. **可迁移**：`setFeedURL` 只认一个 URL 字符串，日后要切到国内云或反之，改配置即可，无需改代码。

**实施顺序建议**：先用 R2 跑通完整链路（成本为零，适合早期小用户量），积累真实的大陆下载速率数据。若实测速率可接受（≥3MB/s，250MB 在 90 秒内完成），就此长期使用；若明显偏慢并影响口碑，再把国内云提为主源——届时用户量数据也能支撑成本决策。

**落地检查清单**（避免 §4.5 的缓存坑）：

1. 域名 zone 状态为 **Active**（非 Pending）
2. R2 建桶并开启**公有读**
3. 绑定 **Custom Domain**（如 `download.<主域名>`），**不启用** `r2.dev`
4. （无需设置 Cache-Control——实测确认边缘不缓存，行为正确）
5. `electron-builder.yml` 配 `publish.url` 指向自定义域名
6. 发版后 **curl 验证** `latest.yml` 立即可读到新版本号
7. 关闭桶上的 Public Development URL（避免 r2.dev 长期暴露）

---

## 10. 决策记录

已确认的事项（2026-09-29）：

| # | 议题 | 决定 |
| --- | --- | --- |
| 1 | 代码签名 | **暂不签名**，先跑通链路。签名与自动更新架构解耦，后续加 `CSC_LINK` 即可 |
| 2 | 云存储 | **Cloudflare R2 + 自定义域名**（域名已在 Cloudflare 购买，前置条件满足） |
| 3 | 安装交互 | **提示后安装**：下载完成 → 用户选「立即重启」或「下次启动时安装」 |
| 4 | 差分更新 | **暂不做**，全量下载 250MB（7z 差分会撤销 1.0.14 的提速优化，安装从 1 分钟涨到 6 分钟） |
| 5 | 测试环境 | **有**，可真机演练升级 |
| 6 | 下载完成后的提示时机 | **自动弹**三选一确认框（同一版本只弹一次，错过可点标题栏「更新」补弹）——真机 61% 冻结事故暴露「不弹窗」后才定的 |
| 7 | 进度的权威载体 | **标题栏按钮**，横幅是可降级副本；横幅连续注入失败 3 次即降级到按钮独占 |

仍未决定的（阶段二代码接入时再定）：

| 议题 | 说明 |
| --- | --- |
| 兜底源具体用哪家 | 国内对象存储（需实名 + 6 个月免费额度）还是沿用现有 GitHub Releases（零改动） |
| 是否配置国内云兜底 | 可先只做 R2 单源，等实测中断风险后再补 |

---

## 附：文档导航

- [`R2-SETUP-GUIDE.md`](./R2-SETUP-GUIDE.md) —— 云端配置操作手册（**当前阶段看这个**）
- 本文 §2 —— 技术前提（为什么不能做差分、为什么要注意 sha512）
- 本文 §4.5 —— R2 落地细节与 `latest.yml` 缓存坑
- 本文 §5 —— 代码改造设计

