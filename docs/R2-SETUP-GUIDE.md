# R2 分发配置手册（操作步骤）

> 用途：把 DSH Desktop 安装包放到 Cloudflare R2，通过自持域名的边缘节点分发。
> 适用：方案 `AUTO-UPDATE-PLAN.md` 的「方案 A」。本文只讲**云端准备**，不含代码改动。
> 预计耗时：30–60 分钟。

---

## 0. 你需要准备什么

| 项 | 要求 | 备注 |
| --- | --- | --- |
| Cloudflare 账号 | 已有 | 能买域名说明支付已跑通 |
| 域名 | **已托管在 Cloudflare 且 zone 状态为 Active** | 下面第 1 步会确认 |
| 磁盘空间 | 约 300MB | 用来临时存放待上传的安装包 |

---

## 1. 确认域名 zone 状态（必须先做）

登录 [Cloudflare Dashboard](https://dash.cloudflare.com/) → 左侧 **Websites** 列表。

**检查你域名的状态列**：

- ✅ 显示 **Active** → 继续第 2 步
- ⚠️ 显示 **Pending Activation** / **Pending Nameserver Update** → **先停下**，必须先完成激活

> **为什么这步重要**：R2 的 Custom Domain 只能绑到已激活的 zone 上。zone 没激活就配 custom domain，会在连接域名那一步报错，而且错误信息不直观。

---

## 2. 创建 R2 存储桶

### 2.1 开通 R2

左侧菜单 → **R2**（或 **Storage & Databases** → R2）。

首次进入会要求开通 R2，**需要绑定支付方式**。开通后进入 R2 控制台。

### 2.2 建桶

点 **Create bucket**：

| 字段 | 填什么 | 说明 |
| --- | --- | --- |
| Bucket name | `dsh-desktop` | 全局唯一。若被占用可加后缀，如 `dsh-desktop-updates` |
| Location | **Asia Pacific (apac)** | 亚太区，对大陆用户延迟较低 |
| Storage class | **Standard** | 标准存储 |

> **Location 说明**：R2 的存储区域只影响回源速度，分发仍走全球边缘节点。选 apac 是为了回源路径更短。若列表中没有 apac，选默认的 automatic 即可。

### 2.3 开启公有读（关键）

进入刚建的桶 → **Settings** → 找到 **Public access** → 选择 **Allow public access** / 允许公开访问。

**这一步是必需的**：不开启的话，客户端匿名读文件会返回 403。

> **安全说明**：开公有读**不会**导致文件被篡改——写权限仍然只有你的账号持有，客户端只读不写。凭据（AccessKey）不要下发到客户端。

---

## 3. 绑定自定义域名（关键步骤）

进入桶 → **Settings** → **Custom Domains** → **Connect Domain**。

填入你想用的子域名，例如：

```
download.你的主域名.com
```

点 **Continue**，Cloudflare 会：

1. 自动在 DNS 里添加一条 CNAME 记录
2. 自动签发 TLS 证书
3. 状态变为 **Active**（约 1 分钟）

### 3.1 三个必须避开的做法

| ❌ 不要做 | 原因 |
| --- | --- |
| 启用 **Public Development URL**（`r2.dev` 地址） | 官方明确标注 "not intended for production usage"，有可变速率限制，超限返回 **429**，**带宽也会被限速** |
| 把 `r2.dev` 地址做成 CNAME 指过来 | 官方文档点名这是 unsupported access path，无法保证可靠性 |
| 用预签名 URL 访问自定义域名 | 预签名只对 S3 域名（`xxx.r2.cloudflarestorage.com`）有效，对自定义域名会失败 |

**本项目是公开读下载，不需要预签名**，直接读自定义域名即可。

### 3.2 验证域名已生效

在本地 PowerShell 执行（把域名替换成你的）：

```powershell
curl.exe -I https://download.你的主域名.com
```

期望看到 `HTTP/2 200` 或 `404`（**只要不是 DNS 解析失败或连接超时**就说明域名通了）。此时桶里没文件，返回 404 是正常的。

---

## 4. 上传测试文件（先验证链路，再谈正式包）

**先别急着传 250MB 的正式安装包。** 用一个小文件验证整条链路，避免传完 250MB 才发现域名有问题。

### 4.1 准备测试内容

在本地建一个临时目录，放两个小文件：

- `latest.yml`（内容见 4.2）
- `test.txt`（随便写点什么，比如 `hello`）

### 4.2 测试用的 latest.yml

```yaml
version: 0.0.1
files:
  - url: test.txt
    sha512: RExBQjMwRXNlcnNoYXNoNDQyUjFQOUwvc3BOMDdBQzRBOEQ1ME1CUUJWQkRGMzZCREJBQQ==
path: test.txt
sha512: RExBQjMwRXNlcnNoYXNoNDQyUjFQOUwvc3BOMDdBQzRBOEQ1ME1CUUJWQkRGMzZCREJBQQ==
releaseDate: '2026-01-01T00:00:00.000Z'
```

> 这个 sha512 是「假值」，只用于验证元数据能否被拉取。**正式发布时必须用真实安装包的 sha512**。

### 4.3 上传

进入桶 → **Objects** → **Upload**：

1. 把 `test.txt` 和 `latest.yml` 一起拖进去
2. 等待上传完成

### 4.4 缓存头：无需设置

R2 控制台**没有**编辑 Cache-Control 的入口（对象详情页只有创建日期/类型/存储类/大小/URL/自定义元数据）。**这是正常的，不用找——实测确认不设也是正确行为**，详见第 5 节。

如果你用 `wrangler` 或 S3 API 上传，会看到 `cacheControl` 参数，那是可选的，当前场景留空即可。

### 4.5 验证拉取

```powershell
# 验证 latest.yml 能拉到
curl.exe https://download.你的主域名.com/latest.yml

# 验证内容完整性
curl.exe -I https://download.你的主域名.com/test.txt
```

两条命令都有正常返回 → **链路已通**，可以进入第 5 步。

---

## 5. 关于 `latest.yml` 的缓存策略（实测已验证，无需操作）

> **2026-09-29 实测结论：不需要设置任何 Cache-Control，保持现状即可。**
> 本节此前的「必须设 no-store」警告**已确认是错的**，详见下方实测记录。

### 实测记录

对已配好自定义域名的桶执行：

```powershell
curl.exe -sS -I --noproxy '*' https://download.<你的域名>/latest.yml
```

实际返回（节选）：

```
HTTP/1.1 200 OK
Content-Type: text/yaml
ETag: "8d92aa8627382c44de2158e5842ad8bf"
Last-Modified: Tue, 29 Sep 2026 04:53:05 GMT
cf-cache-status: DYNAMIC        ← 关键
Server: cloudflare
```

### 为什么不需要设

`cf-cache-status: DYNAMIC` 表示 **Cloudflare 边缘不对该对象做缓存**，每次请求都回源 R2 取最新内容。

原因是 R2 通过自定义域名返回对象时，**响应中不带 `Cache-Control` 头**；而 `.yml` 也不在 Cloudflare 的默认缓存扩展名列表里（该列表含 `.exe`、`.zip`、`.png` 等，不含 `.yml`）。两者叠加 → Cloudflare 判定为不可缓存。

**这恰好就是我们想要的行为**：覆盖 `latest.yml` 后，客户端立即能读到新版本号，不存在缓存陈旧问题。

### 控制台为什么找不到设置入口

R2 对象详情页只显示「创建日期 / 类型 / 存储类 / 大小 / URL / 自定义元数据」，**没有编辑 HTTP 元数据（Cache-Control）的入口**——这是正常的设计，不是你漏看了。若日后确需设置，只能用 `wrangler` 或 S3 API 在上传时指定。

### 若日后 exe 也出现缓存问题

`.exe` **在** Cloudflare 默认缓存扩展名列表中。若安装包将来出现分发不及时（例如旧包被缓存），可在上传时为 exe 单独设置：

| 文件 | 建议 Cache-Control |
| --- | --- |
| `latest.yml` | **不设**（当前实测 DYNAMIC，行为正确） |
| `DSH-Desktop-Setup-<ver>.exe` | 不设亦可；若需长期缓存，`public, max-age=31536000, immutable` |

---

## 6. 正式发布时上传什么

等方案进入正式实施阶段，每次发版上传**两个文件**：

```
latest.yml                              ← 每次发版覆盖
DSH-Desktop-Setup-<版本号>.exe            ← 每次发版新增
```

> `latest.yml` 你的构建流程**本来就在生成**（见 `dist-exe/<版本>/latest.yml`），1.0.3 移除 electron-updater 后它就成了没人读的产物。现在只是把它连同 exe 一起传到 R2，**不需要改构建流程**。

**唯一需要补的**：`latest.yml` 里缺 `size` 字段（`differentialPackage: false` 的副作用），需要补上，否则客户端进度条显示不出百分比。具体补法见 `AUTO-UPDATE-PLAN.md` §5.3。

**上传顺序**：先传 exe，再传 `latest.yml`。反之会出现客户端拉到新元数据但下载不到包的窗口期。

---

## 7. 上线前检查清单

- [ ] 域名 zone 状态 = **Active**
- [ ] R2 桶已建，Location = apac（或 automatic）
- [ ] 桶的 **Public access = Allow public access**
- [ ] 已绑定 **Custom Domain**，状态 = Active
- [ ] `curl -I https://download.<域名>` 有响应（非 DNS 失败/超时）
- [ ] **未启用** `r2.dev` Public Development URL
- [ ] `latest.yml` 可正常拉取，且响应头 `cf-cache-status: DYNAMIC`（未开启边缘缓存，符合预期）
- [ ] （无需设置 Cache-Control——实测确认不设即为正确行为）

---

## 8. 已知限制（先了解，避免误判为 bug）

| 限制 | 说明 |
| --- | --- |
| 大陆速度 | R2 无大陆 PoP（China Network 仅 Enterprise 且需 ICP 备案），国内用户走境外 Anycast。联通线路尤其不稳 |
| 单点可用性 | R2 在 2025 Q1 有过两次中断（2/6 共 59 分钟、3/21 共 1 小时 7 分钟） |
| 建议 | 主源用 R2，**国内对象存储作兜底源**（`setFeedURL` 支持多源回退） |

---

## 相关文档

- 完整方案与选型论证：`AUTO-UPDATE-PLAN.md`
- 特别注意 §4.5（R2 落地细节 + 缓存坑）、§9（最终建议）
