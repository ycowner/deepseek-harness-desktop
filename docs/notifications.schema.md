# 公告配置说明（notifications.json）

客户端从**与安装包同一个分发源**拉取公告，路径 `{UPDATE_FEED_URL}/notifications.json`
（即 `https://download.dsh.392700.xyz/notifications.json`）。

放这里而不是 GitHub Releases 的原因：与 `latest.yml` 同源，发布链路已经跑通
（上传顺序、`verify-release.js` 校验都现成），改公告内容**不需要发版**。

可直接上传的示例见 [`notifications.example.json`](./notifications.example.json)。

---

## 格式

```json
{
  "version": 1,
  "notices": [
    {
      "id": "2026-09-30-maint",
      "type": "banner",
      "level": "warning",
      "title": "今晚 02:00–04:00 服务维护",
      "body": "维护期间 DSH 服务会短暂不可用，正在进行的会话会中断。",
      "link": { "label": "查看详情", "url": "https://example.com/status" },
      "startsAt": "2026-09-30T00:00:00Z",
      "expiresAt": "2026-10-01T06:00:00Z",
      "dismissible": true
    }
  ]
}
```

## 字段

| 字段 | 必填 | 取值 | 说明 |
|---|---|---|---|
| `id` | **是** | `^[A-Za-z0-9._-]{1,64}$` | **已读记录的唯一键**。改了 id 就等于发了一条新公告（用户会重新看到）。建议用 `2026-09-30-简短标识` 这种带日期的格式，便于排序与下线。 |
| `type` | 否 | `banner` \| `modal` | 缺省 `banner`。`banner` 贴在 DSH 页顶部、最多堆叠 3 条；`modal` 走客户端对话框层，**延迟 10 秒**在 DSH 页就绪后弹出。 |
| `level` | 否 | `info` \| `warning` \| `error` | 缺省 `info`。决定左侧色条与图标；`error` 的横幅排在最前。 |
| `title` | **是** | ≤ 60 字符 | 单行。 |
| `body` | **是** | ≤ 2000 字符 | **纯文本**，`\n` 会保留换行。HTML 标签不会被解析。 |
| `link` | 否 | `{ label, url }` | `url` **只允许 `https://`**。`label` ≤ 24 字符。 |
| `startsAt` | 否 | ISO 8601 | 最早生效时间，缺省立即生效。用于定时发布。 |
| `expiresAt` | 否 | ISO 8601 | 过期后自动不再展示。**务必设置**，否则一条忘记下线的公告会一直挂着。 |
| `dismissible` | 否 | 布尔 | 缺省 `true`。`false` 时横幅没有 ×、关不掉（强制升级、停服公告用）。 |

## 硬限制

| 项 | 上限 | 越界时 |
|---|---|---|
| `notices` 条数 | 20 | **整份清单被丢弃**，客户端不展示任何公告 |
| 响应体大小 | 256 KB | 同上 |
| 横幅同时展示 | 3 条 | 超出部分丢弃（按 `error` → `warning` → `info` 排序后取前 3） |
| 已读记录 | 200 条 | 按标记时间升序淘汰最早的 |

## 校验规则（任一条不合法 → **整批丢弃**）

这是刻意的：半截公告比没有公告更糟。

- `id` 必须匹配 `^[A-Za-z0-9._-]{1,64}$`（它不参与任何路径拼接，但白名单先收窄）
- `link.url` **只允许 `https://`** —— `javascript:` / `data:` / `http:` 一律拒绝
- `type` / `level` 必须是枚举内的值
- `expiresAt` 必须晚于 `startsAt`
- `id` 在同一份清单内不得重复
- 缺 `title` / `body`、超长、非法 JSON、根不是对象、缺 `notices` 数组，全部拒绝

> 校验失败时客户端**不会弹错误框**（启动路径静默，只有用户点标题栏铃铛手动检查时才会看到），
> 详情看主进程日志：`[DSH] 拉取公告失败（startup|periodic|manual）: …`

## 安全约束

| 约束 | 落点 |
|---|---|
| `body` 永不用 `innerHTML` | 页面侧只 `textContent` + `white-space: pre-wrap` |
| 外链走既有 `open-external` IPC | 带 `isTrustedSender` 守卫 + 协议白名单，不新开 `shell.openExternal` |
| 图标路径是主进程常量 | 注入脚本里唯一的 `innerHTML`，不是远端内容 |
| 已读文件写入失败只记日志 | 不影响功能，最坏结果只是下次多显示一次 |

以上四条有**生成期断言**守着：`node scripts/preview-notice.js` 会跑三组自检
（12 类非法输入必须被拒、展示决策、横幅注入的防注入约束），任一不过直接中止生成。

## 已读行为

- 落盘：`%APPDATA%\dsh-web-desktop\notice-read.json`，形状 `{ "read": { "<id>": "<ISO 时间>" } }`
- 横幅点 ×、模态点「我知道了」或 Esc → 记已读，同 `id` 不再展示
- 清空该文件即可让所有公告重新出现（排查用）
- `dismissible: false` 的横幅**关不掉也不会记已读**，会一直显示到 `expiresAt`

## 上传

与 `latest.yml` 同源，但**没有版本号语义**，随时可改。改完直接覆盖上传即可，
不需要重打安装包。注意 CDN 缓存，必要时在文件名后加时间戳绕过。

客户端每 6 小时轮询一次，另外在每次启动、点标题栏铃铛时各拉一次。
