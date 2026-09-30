/**
 * 公告（notice）拉取与已读状态
 *
 * 与客户端更新同源：`{UPDATE_FEED_URL}/notifications.json`。放在同一个分发源上
 * 是刻意的——发布链路已经跑通（latest.yml 的上传顺序、校验脚本都已验证），
 * 公告只是多一个静态 JSON，改内容不需要发版。
 *
 * ── 安全基线（远端内容要进到页面里，这几条是硬约束）────────────────────────
 * 1. body 永不 innerHTML：页面侧只用 textContent + white-space: pre-wrap。
 * 2. link.url 只允许 https:，且页面侧走**既有的** window.dsh.openExternal
 *    （受 isTrustedSender 守卫 + 协议白名单），不新开 shell.openExternal。
 * 3. **任一条字段非法 → 整批丢弃**，不做部分渲染：半截通知比没有通知更糟。
 * 4. id 严格白名单字符，且不参与任何文件名/路径拼接。
 * 5. 条数与响应体大小都有上限。
 */
import { app, net } from 'electron'
import { readFileSync, writeFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'
import { UPDATE_FEED_URL } from './app-update'

/** 展示形态：横幅（不打断）/ 模态（打断） */
export type NoticeType = 'banner' | 'modal'
/** 语义级别：决定配色与图标 */
export type NoticeLevel = 'info' | 'warning' | 'error'

export interface Notice {
  id: string
  type: NoticeType
  level: NoticeLevel
  title: string
  body: string
  link?: { label: string; url: string }
  /** 最早生效时间（epoch ms），未设置则立即生效 */
  startsAt?: number
  /** 过期时间（epoch ms），过期后自动不再展示 */
  expiresAt?: number
  /** 横幅是否可关闭。false = 一直挂在顶部直到过期（强制升级、停服公告） */
  dismissible: boolean
}

const NOTICES_FILE = 'notifications.json'
const REQUEST_TIMEOUT_MS = 8000
/** 单次响应体上限 256KB，够写十几条公告了 */
const MAX_RESPONSE_CHARS = 256 * 1024
const MAX_NOTICES = 20
/** 横幅最多同时堆叠几条，超出的丢弃并记日志 */
export const MAX_BANNER_STACK = 3
const ID_RE = /^[a-zA-Z0-9._-]{1,64}$/
const MAX_TITLE = 60
const MAX_BODY = 2000
const MAX_LINK_LABEL = 24
/** 已读记录上限，超出按时间升序淘汰最早的 */
const MAX_READ_ENTRIES = 200

// ── 解析与校验 ───────────────────────────────────────────────────────────

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function requireString(v: unknown, field: string, max: number): string {
  if (typeof v !== 'string' || !v.trim()) throw new Error(`${field} 必须是非空字符串`)
  const s = v.trim()
  if (s.length > max) throw new Error(`${field} 超长（${s.length} > ${max}）`)
  return s
}

/** ISO 时间字符串 → epoch ms；缺省返回 undefined */
function parseTime(v: unknown, field: string): number | undefined {
  if (v === undefined || v === null) return undefined
  if (typeof v !== 'string') throw new Error(`${field} 必须是 ISO 时间字符串`)
  const t = Date.parse(v)
  if (!Number.isFinite(t)) throw new Error(`${field} 时间格式非法: ${v}`)
  return t
}

function parseLink(v: unknown): Notice['link'] {
  if (v === undefined || v === null) return undefined
  if (!isRecord(v)) throw new Error('link 必须是对象或缺省')
  const label = requireString(v.label, 'link.label', MAX_LINK_LABEL)
  const url = requireString(v.url, 'link.url', 2048)
  if (!/^https:\/\//i.test(url)) {
    // 只放行 https：。javascript: / data: / file: 都在这里被挡掉
    throw new Error(`link.url 只允许 https:，收到 ${url.slice(0, 40)}`)
  }
  return { label, url }
}

function parseOne(raw: unknown, index: number): Notice {
  const at = `notices[${index}]`
  if (!isRecord(raw)) throw new Error(`${at} 必须是对象`)

  const id = requireString(raw.id, `${at}.id`, 64)
  if (!ID_RE.test(id)) {
    throw new Error(`${at}.id 含非法字符（只允许 A-Za-z0-9._-）: ${id.slice(0, 40)}`)
  }

  const type = raw.type ?? 'banner'
  if (type !== 'banner' && type !== 'modal') {
    throw new Error(`${at}.type 只能是 banner | modal，收到 ${JSON.stringify(type)}`)
  }
  const level = raw.level ?? 'info'
  if (level !== 'info' && level !== 'warning' && level !== 'error') {
    throw new Error(`${at}.level 只能是 info | warning | error，收到 ${JSON.stringify(level)}`)
  }

  const notice: Notice = {
    id,
    type,
    level,
    title: requireString(raw.title, `${at}.title`, MAX_TITLE),
    body: requireString(raw.body, `${at}.body`, MAX_BODY),
    dismissible: raw.dismissible === undefined ? true : raw.dismissible === true
  }
  if (raw.dismissible !== undefined && typeof raw.dismissible !== 'boolean') {
    throw new Error(`${at}.dismissible 必须是布尔值`)
  }

  const link = parseLink(raw.link)
  if (link) notice.link = link
  const startsAt = parseTime(raw.startsAt, `${at}.startsAt`)
  if (startsAt !== undefined) notice.startsAt = startsAt
  const expiresAt = parseTime(raw.expiresAt, `${at}.expiresAt`)
  if (expiresAt !== undefined) notice.expiresAt = expiresAt
  if (notice.startsAt !== undefined && notice.expiresAt !== undefined && notice.expiresAt <= notice.startsAt) {
    throw new Error(`${at}.expiresAt 必须晚于 startsAt`)
  }
  return notice
}

/**
 * 解析并校验整份清单。**任一条非法即抛错、整批丢弃**。
 */
export function parseNotices(text: string): Notice[] {
  if (text.length > MAX_RESPONSE_CHARS) {
    throw new Error(`通知清单过大（${text.length} > ${MAX_RESPONSE_CHARS} 字符）`)
  }
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    throw new Error('通知清单不是合法 JSON')
  }
  if (!isRecord(data)) throw new Error('通知清单根节点必须是对象')
  const list = data.notices
  if (!Array.isArray(list)) throw new Error('通知清单缺少 notices 数组')
  if (list.length > MAX_NOTICES) throw new Error(`通知条数超限（${list.length} > ${MAX_NOTICES}）`)

  const out = list.map(parseOne)
  const seen = new Set<string>()
  for (const n of out) {
    if (seen.has(n.id)) throw new Error(`通知 id 重复: ${n.id}`)
    seen.add(n.id)
  }
  return out
}

/** 生效窗口过滤 + 排序（紧急在前，紧急同级按发布时间新的在前） */
export function selectLive(notices: Notice[], now = Date.now()): Notice[] {
  const LEVEL_WEIGHT: Record<NoticeLevel, number> = { error: 0, warning: 1, info: 2 }
  return notices
    .filter((n) => (n.startsAt === undefined || now >= n.startsAt) && (n.expiresAt === undefined || now < n.expiresAt))
    .sort((a, b) => {
      const w = LEVEL_WEIGHT[a.level] - LEVEL_WEIGHT[b.level]
      if (w !== 0) return w
      return (b.startsAt ?? 0) - (a.startsAt ?? 0)
    })
}

// ── 已读状态 ──────────────────────────────────────────────────────────────
// 落盘位置与 settings.json 同级（%APPDATA%/dsh-web-desktop/notice-read.json），
// 读写策略照抄 theme-store：读失败当空、写失败只记日志，都不打断主流程。

type ReadState = Record<string, string> // id -> ISO 标记时间

/** 已读判定用的只读集合（避免调用方拿到可变的内部状态） */
export type ReadSet = ReadonlySet<string>

function getReadStatePath(): string {
  // app.getPath 必须在 app ready 之后调用，故延迟到函数内求值
  return join(app.getPath('userData'), 'notice-read.json')
}

function loadReadState(): ReadState {
  try {
    const raw = readFileSync(getReadStatePath(), 'utf-8')
    const data = JSON.parse(raw) as { read?: unknown }
    if (!isRecord(data) || !isRecord(data.read)) return {}
    const out: ReadState = {}
    for (const [id, at] of Object.entries(data.read)) {
      if (ID_RE.test(id) && typeof at === 'string') out[id] = at
    }
    return out
  } catch {
    return {}
  }
}

/** 超上限时按标记时间升序淘汰最早的 */
function pruneReadState(state: ReadState): ReadState {
  const entries = Object.entries(state)
  if (entries.length <= MAX_READ_ENTRIES) return state
  entries.sort((a, b) => (a[1] < b[1] ? -1 : 1))
  return Object.fromEntries(entries.slice(entries.length - MAX_READ_ENTRIES))
}

export function markNoticeRead(id: string): void {
  if (!ID_RE.test(id)) {
    console.warn(`[DSH] 忽略非法公告 id 的已读标记: ${id.slice(0, 40)}`)
    return
  }
  try {
    const state = pruneReadState(loadReadState())
    state[id] = new Date().toISOString()
    const path = getReadStatePath()
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, JSON.stringify({ read: state }, null, 2), 'utf-8')
  } catch (err) {
    // 写入失败只记录：已读标记丢失的代价只是下次多显示一次，不该影响功能
    console.error(`[DSH] 保存公告已读状态失败: ${(err as Error).message}`)
  }
}

export function isNoticeRead(id: string, state: ReadState = loadReadState()): boolean {
  return Object.prototype.hasOwnProperty.call(state, id)
}

/** 已读 id 集合（供编排层过滤用） */
export function getReadNoticeIds(): Set<string> {
  return new Set(Object.keys(loadReadState()))
}

/**
 * 决定这一轮要展示什么：横幅若干 + 模态若干。
 *
 * 纯函数——不碰网络、不碰 DOM，所以能在预览/自检里直接断言。
 * 顺序由 selectLive 决定（error → warning → info，同级新的在前）。
 */
export function planNotices(
  notices: Notice[],
  readIds: ReadSet,
  now = Date.now()
): { banner: Notice[]; modals: Notice[] } {
  const live = selectLive(notices, now)
  const unread = live.filter((n) => !readIds.has(n.id))
  return {
    banner: unread.filter((n) => n.type === 'banner').slice(0, MAX_BANNER_STACK),
    modals: unread.filter((n) => n.type === 'modal')
  }
}

// ── 拉取 ──────────────────────────────────────────────────────────────────

/**
 * 从分发源拉取公告清单
 *
 * 404 视为「没有公告」并返回空数组——发布顺序上客户端可能先于
 * notifications.json 上线（首发时源站根本没有这个文件），这不是错误。
 * 其余非 200 / 网络失败 / 格式非法一律抛错，由调用方决定是否打扰用户。
 */
export async function fetchNotices(): Promise<Notice[]> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS)
  try {
    const res = await net.fetch(`${UPDATE_FEED_URL}/${NOTICES_FILE}`, {
      headers: { 'User-Agent': 'DSH-Desktop-Updater/1.0.0', Accept: 'application/json, text/plain, */*' },
      signal: controller.signal
    })
    if (res.status === 404) return []
    if (!res.ok) throw new Error(`请求失败 (状态码 ${res.status})`)
    return parseNotices(await res.text())
  } finally {
    clearTimeout(timer)
  }
}
