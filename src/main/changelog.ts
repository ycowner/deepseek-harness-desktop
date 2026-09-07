import { net } from 'electron'
import { isValidVersion, DSH_UPSTREAM_OWNER, DSH_UPSTREAM_REPO, DSH_RELEASE_TAG_PREFIX } from './dsh-version'

/**
 * 更新日志模块（数据获取 + 安全 markdown 渲染）
 *
 * 数据源均为 GitHub Releases：
 * - DSH 运行包：上游 monorepo deepseek-ai/deepseek-harness，tag 前缀 'dsh-v'（需过滤其他包的 release）
 * - DSH Desktop 客户端：本项目仓库 ycowner/deepseek-harness-desktop
 *
 * 安全约定（AGENTS.md §12.2 第 15/16 条）：
 * - 远端 tag 去前缀后必须过 isValidVersion() 白名单，不合法条目直接跳过；
 * - release body 是不可信远端文本，渲染前先完整 HTML 转义再做受限标签转换，
 *   链接 URL 仅允许 http(s)，防止注入 DSH 页面的 XSS。
 */

// 上游 DSH monorepo 常量（owner/repo/tag 前缀）定义在 dsh-version.ts，本模块导入复用

// 本项目（DSH Desktop 客户端）仓库
const APP_OWNER = 'ycowner'
const APP_REPO = 'deepseek-harness-desktop'

// 单次展示的日志条数上限
const CHANGELOG_LIMIT = 10

// 远程请求超时（毫秒）
const REQUEST_TIMEOUT = 30_000

// API 请求头（GitHub API 要求 User-Agent，否则 403）
const REQUEST_HEADERS = {
  'User-Agent': 'DSH-Desktop-Updater/1.0.0',
  'Accept': 'application/vnd.github+json'
}

/**
 * 单条更新日志
 */
export interface ChangelogEntry {
  /** 版本号（已去 tag 前缀并通过白名单校验） */
  version: string
  /** 发布日期（YYYY-MM-DD，本地时区） */
  publishedAt: string
  /** release notes 原始 markdown 文本 */
  notes: string
}

/**
 * 通过 Electron net.fetch 请求 JSON（自动遵循系统代理、自动跟随重定向）
 */
async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT)
  try {
    const res = await net.fetch(url, { headers: REQUEST_HEADERS, signal: controller.signal })
    if (!res.ok) {
      throw new Error(`请求失败 (状态码 ${res.status})`)
    }
    return await res.json()
  } catch (err) {
    if ((err as Error).name === 'AbortError') {
      throw new Error(`请求超时（${REQUEST_TIMEOUT / 1000}秒）`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * 拉取指定仓库的 release 列表并解析为更新日志条目
 *
 * @param owner 仓库 owner
 * @param repo 仓库名
 * @param tagPrefix 需要匹配并剥掉的 tag 前缀（空串表示不过滤）
 */
async function fetchChangelogs(owner: string, repo: string, tagPrefix: string): Promise<ChangelogEntry[]> {
  // 一次请求多拉一些（上游 monorepo 混有其他包的 release，过滤后可能不足 10 条）
  const url = `https://api.github.com/repos/${owner}/${repo}/releases?per_page=30`
  const data = (await fetchJson(url)) as Array<Record<string, unknown>>
  if (!Array.isArray(data)) {
    throw new Error('GitHub Releases 响应格式异常')
  }

  const entries: ChangelogEntry[] = []
  for (const release of data) {
    if (entries.length >= CHANGELOG_LIMIT) break

    const tag = typeof release.tag_name === 'string' ? release.tag_name : ''
    if (!tag || (tagPrefix && !tag.startsWith(tagPrefix))) continue

    // 去前缀后过版本号白名单（防路径/模板注入，纵深防御）
    const version = tagPrefix ? tag.slice(tagPrefix.length) : tag
    if (!isValidVersion(version)) continue

    // published_at 形如 "2026-08-31T16:20:52Z"，截取日期部分
    const publishedRaw = typeof release.published_at === 'string' ? release.published_at : ''
    const publishedAt = publishedRaw.length >= 10 ? publishedRaw.slice(0, 10) : '未知日期'

    const notes = typeof release.body === 'string' ? release.body : ''

    entries.push({ version, publishedAt, notes })
  }
  return entries
}

/**
 * 获取 DSH 运行包更新日志（上游 deepseek-ai/deepseek-harness Releases，tag 前缀 dsh-v）
 */
export function fetchDshChangelogs(): Promise<ChangelogEntry[]> {
  return fetchChangelogs(DSH_UPSTREAM_OWNER, DSH_UPSTREAM_REPO, DSH_RELEASE_TAG_PREFIX)
}

/**
 * 获取 DSH Desktop 客户端更新日志（本项目 Releases）
 *
 * 本仓库 release tag 约定以 'v' 开头（如 v1.0.4，与 app-update.ts 的
 * tag_name 解析规则一致），需剥掉前缀后再过版本号白名单。
 */
export function fetchAppChangelogs(): Promise<ChangelogEntry[]> {
  return fetchChangelogs(APP_OWNER, APP_REPO, 'v')
}

/**
 * 完整 HTML 转义（渲染不可信文本前的第一步）
 *
 * 同时导出给 index.ts 使用（错误信息 / 版本号等文本拼入 HTML 前）
 */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/**
 * 行内 markdown 转换（输入必须已经过 escapeHtml 转义）
 *
 * 支持：**粗体**、*斜体*、`行内代码`、[文字](#锚点)、[文字](https?://链接)
 * 链接 URL 仅允许 http(s)；fragment 锚点的 id 仅允许白名单字符集。
 * 由于原文已转义，这里的正则操作的都是转义后文本，不会产生新标签。
 */
function renderInline(escaped: string): string {
  let html = escaped
  // 行内代码（先处理，避免内部粗体/链接语法被二次转换）
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>')
  // 粗体
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  // 斜体（单个星号，避免与粗体冲突——粗体已先被替换）
  html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>')
  // fragment 锚点链接：[文字](#id)，id 限白名单字符集（无注入面）；
  // 上游 release 常用 [中文](#cn-...) 做双语目录，点击由模态框壳的委托监听
  // 拦截并在内容区内滚动（防止整个 DSH 页面被 fragment 导航）
  html = html.replace(
    /\[([^\]]+)\]\(#([A-Za-z0-9._-]+)\)/g,
    '<a href="#$2">$1</a>'
  )
  // 链接：URL 仅允许 http(s)，target=_blank 交由 setWindowOpenHandler 转发系统浏览器
  html = html.replace(
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>'
  )
  // 其余链接语法（相对路径等）：仅保留文字，不裸露 markdown 语法
  html = html.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
  // 裸 URL（非 markdown 链接语法、非已有 href 的），同样仅 http(s)；
  // (?![^\s<]*<\/a>) 排除已生成锚点内部的文本，避免嵌套 <a>
  html = html.replace(
    /(^|[\s>])(https?:\/\/[^\s<]+)(?![^\s<]*<\/a>)/g,
    '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>'
  )
  return html
}

// 原生 HTML 标题行内的 id 属性白名单（通过才保留为元素 id 供模态框内锚点跳转）
const SAFE_HEADING_ID = /^[A-Za-z0-9._-]+$/

/**
 * 将 release notes（markdown）安全渲染为受限 HTML
 *
 * 策略：按行分类后对各段分别做 escapeHtml + 受限转换（任何远端文本进 HTML 前
 * 必经转义或白名单字符集校验）。上游 release body 是 markdown 与原生 HTML 混合，
 * 小节标题写作 <h3 id="cn-...">体验优化</h3>，需识别该安全子集而非整段转义裸露。
 * 输出仅可能包含：<h3>/<h4>/<h5>、<ul><li>、<pre><code>、<p>、<hr>、<strong>、<em>、
 * <code>、<a>（http(s) 或白名单 fragment 锚点）。
 *
 * @param notes 原始 markdown 文本
 * @returns 可安全插入 innerHTML 的 HTML 字符串
 */
export function renderMarkdownToHtml(notes: string): string {
  const lines = notes.split(/\r?\n/)
  const out: string[] = []

  let inCodeBlock = false
  let codeBlockLines: string[] = []
  let listItems: string[] = []

  // 冲刷累积中的列表（遇到非列表行时输出）
  function flushList(): void {
    if (listItems.length > 0) {
      out.push('<ul>' + listItems.map((item) => `<li>${item}</li>`).join('') + '</ul>')
      listItems = []
    }
  }

  for (const line of lines) {
    // 围栏代码块：``` 开闭（块内文本在冲刷时统一转义）
    if (line.trimStart().startsWith('```')) {
      flushList()
      if (inCodeBlock) {
        out.push('<pre><code>' + escapeHtml(codeBlockLines.join('\n')) + '</code></pre>')
        codeBlockLines = []
        inCodeBlock = false
      } else {
        inCodeBlock = true
      }
      continue
    }
    if (inCodeBlock) {
      // 代码块内保留原始文本，不做任何行内转换（转义推迟到冲刷时）
      codeBlockLines.push(line)
      continue
    }

    const trimmed = line.trim()
    // 空行：段落分隔
    if (trimmed === '') {
      flushList()
      continue
    }

    // 原生 HTML 标题行（上游小节标题的安全子集：仅 h1-h6、可选双引号 id、
    // 内容不含任何标签）。内部文本取出后经转义 + 行内转换；id 过白名单才保留，
    // 供模态框内 [中文](#cn-...) 锚点跳转
    const htmlHeadingMatch = trimmed.match(/^<h([1-6])(?:\s+id="([^"]*)")?\s*>([^<]*)<\/h\1>$/)
    if (htmlHeadingMatch) {
      flushList()
      const srcLevel = Number(htmlHeadingMatch[1])
      const level = srcLevel <= 2 ? 3 : srcLevel === 3 ? 4 : 5
      const rawId = htmlHeadingMatch[2] || ''
      const idAttr = SAFE_HEADING_ID.test(rawId) ? ` id="${escapeHtml(rawId)}"` : ''
      out.push(`<h${level}${idAttr}>${renderInline(escapeHtml(htmlHeadingMatch[3]))}</h${level}>`)
      continue
    }

    // markdown 标题（# 到 ####，渲染为 h3-h5 控制字号）
    const headingMatch = trimmed.match(/^(#{1,4})\s+(.*)$/)
    if (headingMatch) {
      flushList()
      const level = Math.min(headingMatch[1].length + 2, 5) // # → h3, ## → h4, ### → h5
      out.push(`<h${level}>${renderInline(escapeHtml(headingMatch[2]))}</h${level}>`)
      continue
    }

    // 分隔线（先于列表判断，避免 --- 被误判）
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushList()
      out.push('<hr>')
      continue
    }

    // 列表项（- 或 * 开头）
    const listMatch = trimmed.match(/^[-*]\s+(.*)$/)
    if (listMatch) {
      listItems.push(renderInline(escapeHtml(listMatch[1])))
      continue
    }

    // 普通段落（累积列表先冲刷）
    flushList()
    out.push(`<p>${renderInline(escapeHtml(trimmed))}</p>`)
  }

  // 收尾：未闭合的代码块与列表
  if (inCodeBlock && codeBlockLines.length > 0) {
    out.push('<pre><code>' + escapeHtml(codeBlockLines.join('\n')) + '</code></pre>')
  }
  flushList()

  return out.join('\n')
}
