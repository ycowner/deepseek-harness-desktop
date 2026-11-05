/**
 * 版本更新面板（update-panel）的样式与 spec 构造器
 *
 * 为什么是「dsh-dialog 的一种变体」而不是独立的第三个注入层：
 * dsh-dialog.ts 已经独占三件极关键的事——① 单一队列保证任意时刻只有一个浮层
 * （面板与旧对话框不会叠在一起）；② dsh-dialog-response 的发送方守卫
 * （严格比对 event.sender === dshView.webContents）；③ 导航打断收敛
 * （did-start-loading 时按 cancelId 主动 resolve，否则等待中的 Promise 会永久
 * 挂起，AGENTS.md §12.1 #39）。另起一层等于把这三件事复制一遍，还会出现
 * 「两个浮层各有一个队列」的竞态。
 *
 * 所以本模块只负责面板**自己的**东西：CSS、spec 类型、纯函数构造器。队列、
 * 宿主脚本、IPC 通道都在 dsh-dialog.ts 里，由它引入本模块。
 *
 * 形态对齐用户提供的参考图：应用图标 + 大标题（版本号内联着色）+ 日历日期行
 * + 复选框 + 底部左右分组按钮（左「跳过此版本」/ 右「稍后 + 主按钮」）。
 *
 * 本模块刻意**不 import electron**，只依赖 injected-theme 与 theme-manager，
 * 这样 scripts/preview-dialog.js 能在沙箱里加载它、驱动真实的构造器做断言
 * （AGENTS.md §12.1 #41：预览必须与生产同源）。
 */
import { INJECTED_THEME_VARS, ICONS, FONT_STACK } from './injected-theme'
import { getEffectiveTheme } from './theme-manager'

/**
 * 按钮变体。沿用 dsh-dialog 的三档语义，视觉尺寸由 DIALOG_CSS 的 .btn 家族提供：
 *
 *   'lead'   主按钮（填色 + 最大）
 *   'minor'  次级操作（描边 + 小一号）
 *   'ghost'  纯文字（取消）
 */
export type UpdatePanelButtonVariant = 'lead' | 'minor' | 'ghost'

/**
 * 按钮所在分组。参考图里「跳过此版本」孤零零落在左下角，「稍后」与主按钮
 * 并排落在右下角——这与旧卡片「全部右对齐」不同，故显式建模。
 */
export type UpdatePanelAlign = 'left' | 'right'

export interface UpdatePanelButton {
  label: string
  variant: UpdatePanelButtonVariant
  align: UpdatePanelAlign
  /**
   * true = 放到底栏上方的独立一行（该行内按钮等宽并排），而不是挤进左右两组。
   *
   * 「检查更新」四个按钮装不进 480px 卡宽，右组换行后主按钮会被甩到第二行
   * 最右、与上面两枚错位。把两个单项检查提到上排，底栏恢复成「左取消 /
   * 右主按钮」的干净两列。
   */
  block?: boolean
}

/** 复选框（仅客户端「发现新版本」面板有，DSH 运行包全程手动确认故没有） */
export interface UpdatePanelCheckbox {
  label: string
  checked: boolean
}

/**
 * 面板调用点选项
 *
 * defaultId / cancelId **必填**：面板的按钮顺序与视觉分组是刻意设计的，
 * 键盘语义（初始焦点与回车、Esc）必须由调用点逐个显式声明，不能依赖推导。
 * 推导一旦出错就是「回车即误触发」这类事故（AGENTS.md §12.1 #38）。
 */
export interface UpdatePanelOptions {
  /** 主标题，如「发现新版本」 */
  title: string
  /** 标题右侧内联版本号（如 v1.0.20）；为空则不渲染 */
  version?: string | null
  /** 应用图标（data URL）；为空则不渲染图标位 */
  appIcon?: string | null
  /** 发布日期（ISO-8601，如 2026-10-13T15:41:28.667Z）；解析失败则整行不渲染 */
  releaseDate?: string | null
  /** 正文行，如「当前版本 v1.0.19」 */
  message?: string | null
  /** 提示块：风险类传 'notice'，版本信息类留空（按 'meta' 处理） */
  detail?: string | null
  detailTone?: 'notice' | 'meta'
  /** 复选框；null 则不渲染整行 */
  checkbox?: UpdatePanelCheckbox | null
  /**
   * 按钮，**数组顺序 = 视觉顺序（左 → 右）**。
   * 每个按钮自带 variant（视觉）与 align（分组）。
   */
  buttons: UpdatePanelButton[]
  /** 初始焦点 / 回车触发的按钮下标 */
  defaultId: number
  /** Esc 触发的按钮下标 */
  cancelId: number
}

/** 面板返回值：response 是按钮下标，checked 是复选框勾选态 */
export interface UpdatePanelResult {
  response: number
  checked: boolean
}

/** 页面侧渲染用的完整 spec（由 buildUpdatePanelSpec 生成） */
export interface UpdatePanelSpec {
  kind: 'panel'
  id: number
  title: string
  version: string
  appIcon: string
  releaseDate: string
  message: string
  detail: string
  detailTone: 'notice' | 'meta'
  checkbox: UpdatePanelCheckbox | null
  buttons: UpdatePanelButton[]
  defaultId: number
  cancelId: number
  vars: Record<string, string>
}

/**
 * 面板的按钮布局预设
 *
 * 每个预设是一组**产品决策**：哪些按钮在左、哪些在右、谁是主按钮、回车落在
 * 哪个按钮上、Esc 落在哪个按钮上。集中在这里而不是散落在 19 个调用点，是
 * 为了让「键盘语义」这一层只有一处真相——迁移时最容易丢的就是它
 * （AGENTS.md §12.1 #38：defaultId 是键盘语义，不是视觉强调）。
 *
 * 数组顺序 = 视觉顺序（左 → 右），下标即 defaultId / cancelId 的取值。
 */
export interface UpdatePanelPreset {
  buttons: UpdatePanelButton[]
  /** 初始焦点 / 回车触发的按钮下标 */
  defaultId: number
  /** Esc 触发的按钮下标 */
  cancelId: number
}

/**
 * 客户端「发现新版本」：左「跳过此版本」，右「稍后 + 下载更新」
 *
 * defaultId 落在「下载更新」上（与迁移前 defaultId:0 指向「下载并更新」一致）。
 * Esc 落在「稍后」上——按 Esc 只是不下载，不该顺手把这个版本记成已跳过。
 */
export const PANEL_CLIENT_AVAILABLE: UpdatePanelPreset = {
  buttons: [
    { label: '跳过此版本', variant: 'ghost', align: 'left' },
    { label: '稍后', variant: 'minor', align: 'right' },
    { label: '下载更新', variant: 'lead', align: 'right' }
  ],
  defaultId: 2,
  cancelId: 1
}

/**
 * 客户端「下载中」：左「取消下载」，右「继续下载」
 *
 * defaultId 与 cancelId **都**落在「继续下载」上（与迁移前一致）：误按回车或
 * 想关掉对话框都不应该丢掉已经下了一半的 251MB。主按钮也是「继续下载」，
 * 破坏性的「取消下载」不占视觉主位。
 */
export const PANEL_CLIENT_DOWNLOADING: UpdatePanelPreset = {
  buttons: [
    { label: '取消下载', variant: 'ghost', align: 'left' },
    { label: '继续下载', variant: 'lead', align: 'right' }
  ],
  defaultId: 1,
  cancelId: 1
}

/**
 * 客户端「已下载完成」：左「取消」，右「下次启动时安装 + 立即重启安装」
 *
 * defaultId 落在「立即重启安装」上（与迁移前 defaultId:0 一致）。
 */
export const PANEL_CLIENT_DOWNLOADED: UpdatePanelPreset = {
  buttons: [
    { label: '取消', variant: 'ghost', align: 'left' },
    { label: '下次启动时安装', variant: 'minor', align: 'right' },
    { label: '立即重启安装', variant: 'lead', align: 'right' }
  ],
  defaultId: 2,
  cancelId: 0
}

/**
 * 客户端「下载失败」：左「取消」，右「浏览器下载 + 重试下载」
 *
 * defaultId 落在「重试下载」上（与迁移前 defaultId:0 一致）。
 */
export const PANEL_CLIENT_ERROR: UpdatePanelPreset = {
  buttons: [
    { label: '取消', variant: 'ghost', align: 'left' },
    { label: '浏览器下载', variant: 'minor', align: 'right' },
    { label: '重试下载', variant: 'lead', align: 'right' }
  ],
  defaultId: 2,
  cancelId: 0
}

/**
 * DSH 运行包「发现新版本」：左「跳过此版本」，右「稍后 + 确定更新」
 *
 * defaultId 与 cancelId **都**落在「稍后」上（与迁移前 defaultId:1/cancelId:1
 * 一致）：运行包更新会停服务、装 518 个包、重启会话，回车不该直接触发它。
 * 视觉主按钮仍是「确定更新」。
 */
export const PANEL_DSH_AVAILABLE: UpdatePanelPreset = {
  buttons: [
    { label: '跳过此版本', variant: 'ghost', align: 'left' },
    { label: '稍后', variant: 'minor', align: 'right' },
    { label: '确定更新', variant: 'lead', align: 'right' }
  ],
  defaultId: 1,
  cancelId: 1
}

/**
 * 手动「检查更新」的四项选择：三个检查项同排（后两项靠行末），取消单独一行右对齐
 *
 * 四个按钮装不进 480px 卡宽，塞进右组会让主按钮孤立换行并错位。
 * 单项检查标 block: true 进上方的独立行：第一个贴左，后两个紧跟行末；
 * 取消不标 block，留在底栏右侧。
 *
 * 数组顺序仍按回传下标排列（index.ts 的 response 分支依赖该下标），
 * 视觉位置由 block / align 决定，与数组顺序无关。
 *
 * defaultId 落在「全部检查」上（与迁移前 defaultId:0 一致）。
 */
export const PANEL_CHECK_PICKER: UpdatePanelPreset = {
  buttons: [
    { label: '取消', variant: 'ghost', align: 'right' },
    { label: '检查DSH运行包', variant: 'minor', align: 'right', block: true },
    { label: '检查客户端', variant: 'minor', align: 'right', block: true },
    { label: '全部检查', variant: 'lead', align: 'right', block: true }
  ],
  defaultId: 3,
  cancelId: 0
}

/**
 * 单按钮信息态（已是最新 / 检查失败 / 开发环境提示等）
 */
export const PANEL_SINGLE_OK: UpdatePanelPreset = {
  buttons: [{ label: '确定', variant: 'lead', align: 'right' }],
  defaultId: 0,
  cancelId: 0
}

/**
 * 把发布日期格式化成「2026年10月13日」
 *
 * 取 ISO 字符串的日期部分直接用，**不做时区换算**：latest.yml 里的
 * releaseDate 是构建时刻的 UTC 时间，换算成本地时区会让同一份安装包在不同
 * 时区的用户眼里变成不同日期。这里要表达的是「这个版本是哪天发布的」，
 * 跨时区保持一致比「换算成本地」更重要。
 *
 * 月日不补零，与参考图的「2026年11月2日」一致。
 */
export function formatReleaseDate(iso: string | null | undefined): string | null {
  if (typeof iso !== 'string') return null
  const matched = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso.trim())
  if (!matched) return null
  const year = Number(matched[1])
  const month = Number(matched[2])
  const day = Number(matched[3])
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null
  if (month < 1 || month > 12 || day < 1 || day > 31) return null
  return `${year}年${month}月${day}日`
}

/**
 * 钳位一个按钮下标
 *
 * 与 dsh-dialog 的 pickIndex 同思路但独立实现：本模块不能 import dsh-dialog
 * （那会形成循环依赖）。合法整数钳位到 [0, max]；非数字/非整数落到 fallback。
 */
function clampIndex(value: number, fallback: number, maxIndex: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(Math.max(value, 0), maxIndex)
}

/**
 * 构造面板 spec（纯函数）
 *
 * id 由调用方传入（与旧对话框共用同一个自增序列，保证两种 spec 的 id 不相撞，
 * 过期点击的 id 比对才不会误判）。
 */
export function buildUpdatePanelSpec(options: UpdatePanelOptions, id: number): UpdatePanelSpec {
  const buttons = options.buttons && options.buttons.length ? options.buttons : []
  const last = buttons.length - 1
  const defaultId = clampIndex(options.defaultId, 0, last)
  const cancelId = clampIndex(options.cancelId, last, last)

  return {
    kind: 'panel',
    id,
    title: options.title ?? '',
    version: options.version ?? '',
    appIcon: options.appIcon ?? '',
    releaseDate: formatReleaseDate(options.releaseDate) ?? '',
    message: options.message ?? '',
    detail: options.detail ?? '',
    detailTone: options.detailTone ?? 'meta',
    checkbox: options.checkbox ?? null,
    buttons,
    defaultId,
    cancelId,
    vars: INJECTED_THEME_VARS[getEffectiveTheme()]
  }
}

/**
 * 面板样式
 *
 * 表面、圆角、阴影全部复用 dsh-dialog 的 --dsh-dlg-* 令牌：浅色是磨砂玻璃，
 * 深色是参考图形态的不透明纯黑 + 极淡描边、无内高光（卡片级模糊走
 * --dsh-dlg-blur，深色下为 none）。令牌值只在 injected-theme 里改，本模块
 * 不覆盖，避免两处色源分叉（AGENTS.md §12.1 #40）。
 *
 * 与旧卡片的差异只有三处：
 *   ① 卡片宽 480px（旧 460px）；
 *   ② 头部是「图标 + 大标题组」的横向布局，日期行缩进到标题左侧对齐；
 *   ③ 底部左右两组按钮，右组允许整体换行（宁可换行也不压缩按钮文字）。
 */
export const UPDATE_PANEL_CSS = `
.pcard {
  width: min(480px, 100%); max-height: min(76vh, 560px);
  display: flex; flex-direction: column;
  background: var(--dsh-dlg-glass);
  -webkit-backdrop-filter: var(--dsh-dlg-blur);
  backdrop-filter: var(--dsh-dlg-blur);
  border: 1px solid var(--dsh-dlg-glass-border);
  border-radius: 16px;
  box-shadow: var(--dsh-dlg-shadow), inset 0 1px 0 0 var(--dsh-dlg-highlight);
  color: var(--dsh-dlg-body);
  overflow: hidden;
  font-family: ${FONT_STACK};
  animation: dlg-pop 160ms cubic-bezier(.2,.8,.2,1);
}

/* ── 头部：应用图标 + 标题组（大标题内联版本号 + 日期行） ── */
.phead { display: flex; align-items: flex-start; gap: 16px; padding: 26px 24px 0; }
.picon {
  flex: none; width: 56px; height: 56px; border-radius: 14px;
  object-fit: cover; background: var(--dsh-dlg-code-bg);
}
.picon[hidden] { display: none; }
.ptitles { flex: 1; min-width: 0; padding-top: 2px; }
.ptitle-row { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; }
.ptitle { margin: 0; font-size: 20px; font-weight: 600; line-height: 1.3; color: var(--dsh-dlg-fg); }
.pversion { font-size: 20px; font-weight: 600; line-height: 1.3; color: var(--dsh-dlg-link); }
.pmeta { display: flex; align-items: center; gap: 7px; margin-top: 8px; }
.pmeta .tier__icon { width: 14px; height: 14px; margin-top: 0; color: var(--dsh-dlg-muted); }
.pdate { font-size: 13px; line-height: 1.5; color: var(--dsh-dlg-muted); }

/* ── 正文 ── */
.pbody { padding: 16px 24px 0; overflow-y: auto; min-height: 0; }
.pbody .tier { margin-top: 14px; }
.pmessage { font-size: 13.5px; line-height: 1.65; color: var(--dsh-dlg-body); white-space: pre-wrap; }

/* ── 复选框 ── */
.pcheck {
  display: flex; align-items: center; gap: 10px;
  margin: 20px 24px 0; padding: 0; border: 0; background: transparent;
  cursor: pointer; font-family: inherit; text-align: left; color: inherit;
}
.pcheck-box {
  flex: none; width: 20px; height: 20px; border-radius: 6px; position: relative;
  border: 1.5px solid var(--dsh-dlg-muted); background: transparent;
  transition: background-color 120ms ease, border-color 120ms ease;
}
.pcheck[aria-checked="true"] .pcheck-box { background: var(--dsh-dlg-primary-bg); border-color: var(--dsh-dlg-primary-bg); }
.pcheck-box::after {
  content: ''; position: absolute; left: 6px; top: 2px;
  width: 6px; height: 10px; opacity: 0;
  border-right: 2px solid var(--dsh-dlg-primary-fg);
  border-bottom: 2px solid var(--dsh-dlg-primary-fg);
  transform: rotate(42deg);
  transition: opacity 120ms ease;
}
.pcheck[aria-checked="true"] .pcheck-box::after { opacity: 1; }
.pcheck-label { font-size: 15px; line-height: 1.5; color: var(--dsh-dlg-link); }
.pcheck:focus-visible { outline: none; }
.pcheck:focus-visible .pcheck-box { box-shadow: 0 0 0 3px var(--dsh-dlg-ring); }

/* ── 底部：左右两组按钮 ── */
.pfoot { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 20px 24px 24px; }
.pfoot-left { display: flex; align-items: center; gap: 8px; }
.pfoot-right { display: flex; align-items: center; justify-content: flex-end; gap: 8px; flex-wrap: wrap; }

/*
 * 底栏上方的独立按钮行（如「检查更新」的三个检查项）：按钮间距均分整行。
 */
.pfoot-block { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 20px 24px 0; }
.pfoot-block + .pfoot { padding-top: 12px; }
`

/**
 * 页面侧的面板 DOM 构造器（源码字符串）
 *
 * 以源码字符串而非函数形式导出，是为了让 dsh-dialog.ts 的宿主脚本能把它
 * 原样拼进同一个 Shadow Root 里——面板与旧对话框共用一个宿主元素、一次注入、
 * 一份样式表，也就不可能出现「两套遮罩互相踩」。
 *
 * 复选框的勾选态放在调用方持有的 state 对象里：宿主脚本要用它处理 Esc /
 * 遮罩点击（这两种关闭方式也要把勾选态回传），把状态藏在闭包里就取不到了。
 *
 * 注入代码统一用 var / function，与既有 buildHostScript 的写法保持一致。
 */
export const UPDATE_PANEL_SCRIPT = `
function buildPanelCard (spec, svg, state, settle) {
  var card = document.createElement('div')
  card.className = 'pcard'
  card.setAttribute('role', 'dialog')
  card.setAttribute('aria-modal', 'true')

  var titleId = 'dsh-panel-title-' + spec.id
  card.setAttribute('aria-labelledby', titleId)

  var head = document.createElement('div')
  head.className = 'phead'

  // 图标在左。data URL 被页面 CSP 拦下时 onerror 隐藏图标位，标题左移即可，
  // 布局不会塌（参考图里图标是「有则更好」的装饰，不是信息载体）。
  if (spec.appIcon) {
    var img = document.createElement('img')
    img.className = 'picon'
    img.alt = ''
    img.addEventListener('error', function () { img.setAttribute('hidden', '') })
    img.src = spec.appIcon
    head.appendChild(img)
  }

  var titles = document.createElement('div')
  titles.className = 'ptitles'

  var titleRow = document.createElement('div')
  titleRow.className = 'ptitle-row'
  var h1 = document.createElement('h1')
  h1.className = 'ptitle'
  h1.id = titleId
  h1.textContent = spec.title
  titleRow.appendChild(h1)
  if (spec.version) {
    var ver = document.createElement('span')
    ver.className = 'pversion'
    ver.textContent = spec.version
    titleRow.appendChild(ver)
  }
  titles.appendChild(titleRow)

  // 日期行缩进到标题左侧对齐；取不到日期则整行不渲染（DSH 运行包即如此）
  if (spec.releaseDate) {
    var meta = document.createElement('div')
    meta.className = 'pmeta'
    var calIcon = svg('calendar')
    calIcon.setAttribute('class', 'tier__icon')
    var dateEl = document.createElement('span')
    dateEl.className = 'pdate'
    dateEl.textContent = spec.releaseDate
    meta.appendChild(calIcon)
    meta.appendChild(dateEl)
    titles.appendChild(meta)
  }
  head.appendChild(titles)
  card.appendChild(head)

  var body = document.createElement('div')
  body.className = 'pbody'
  if (spec.message) {
    var msg = document.createElement('div')
    msg.className = 'pmessage'
    msg.textContent = spec.message
    body.appendChild(msg)
  }
  if (spec.detail) {
    var isNotice = spec.detailTone === 'notice'
    var row = document.createElement('div')
    row.className = 'tier ' + (isNotice ? 'detail--notice' : 'detail--meta')
    var icon = svg(isNotice ? 'notice' : 'meta')
    icon.setAttribute('class', 'tier__icon')
    var text = document.createElement('div')
    text.className = 'tier__text'
    text.textContent = spec.detail
    row.appendChild(icon)
    row.appendChild(text)
    body.appendChild(row)
  }
  if (body.childNodes.length) card.appendChild(body)

  // 复选框：role=checkbox 的 button，勾选态靠 aria-checked 承载。
  // 点击任意位置（方框或文字）都切换。
  var checkEl = null
  if (spec.checkbox) {
    state.checked = !!spec.checkbox.checked
    checkEl = document.createElement('button')
    checkEl.type = 'button'
    checkEl.className = 'pcheck'
    checkEl.setAttribute('role', 'checkbox')
    checkEl.setAttribute('aria-checked', state.checked ? 'true' : 'false')
    var box = document.createElement('span')
    box.className = 'pcheck-box'
    box.setAttribute('aria-hidden', 'true')
    var label = document.createElement('span')
    label.className = 'pcheck-label'
    label.textContent = spec.checkbox.label
    checkEl.appendChild(box)
    checkEl.appendChild(label)
    checkEl.addEventListener('click', function () {
      state.checked = !state.checked
      checkEl.setAttribute('aria-checked', state.checked ? 'true' : 'false')
    })
    card.appendChild(checkEl)
  }

  var foot = document.createElement('div')
  foot.className = 'pfoot'
  var left = document.createElement('div')
  left.className = 'pfoot-left'
  var right = document.createElement('div')
  right.className = 'pfoot-right'
  // 每个按钮记住自己在 spec.buttons 里的下标（回传主进程用的就是它），
  // 但 focusables 按 DOM 顺序收集——Tab 顺序必须与视觉顺序一致。
  var blockRow = null
  var domButtons = []
  var buttonsByIndex = []
  spec.buttons.forEach(function (b, i) {
    var btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'btn btn--' + b.variant
    btn.textContent = b.label
    btn.addEventListener('click', function () { settle(i) })
    if (b.block) {
      if (!blockRow) {
        blockRow = document.createElement('div')
        blockRow.className = 'pfoot-block'
      }
      blockRow.appendChild(btn)
    } else {
      ;(b.align === 'left' ? left : right).appendChild(btn)
    }
    buttonsByIndex[i] = btn
    domButtons.push(btn)
  })
  if (blockRow) card.appendChild(blockRow)
  foot.appendChild(left)
  foot.appendChild(right)
  card.appendChild(foot)

  // 焦点循环的元素：复选框在 DOM 上位于按钮之前，Tab 顺序与视觉顺序一致
  var focusables = checkEl ? [checkEl].concat(domButtons) : domButtons

  // buttons 保持 spec 下标（dsh-dialog 用 built.buttons[spec.defaultId] 定位初始焦点）
  return { card: card, buttons: buttonsByIndex, focusables: focusables }
}
`
