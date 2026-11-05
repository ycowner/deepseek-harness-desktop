/**
 * 自绘对话框层（dsh-dialog）
 *
 * 为什么不用 dialog.showMessageBox：那是最接近"没有样式接口"的方案——按钮、
 * 颜色、字体、圆角全由 Windows 自己画，Electron 的 MessageBoxOptions 只暴露
 * type/message/detail/buttons/defaultId/cancelId 这几个语义参数。想做现代化
 * 就只能自绘。
 *
 * 承载位置：注入 dshView（覆盖标题栏以下全部区域的 WebContentsView）。
 * dshView 叠在主 webContents 之上，所以对话框只能活在 dshView 内——标题栏页
 * 的 DOM 在被覆盖区域永远不可见。宿主在 dshView 每次文档加载完成后注入，
 * loading / error / DSH 三种页面都覆盖（退出确认恰恰最常发生在 error 页）。
 *
 * 样式隔离：对话框挂在 Shadow DOM 里，样式与宿主页面（DSH 自己的 UI，可能是
 * 带 Tailwind 预处理的）完全隔离，不受其全局 reset / 基础样式影响。
 *
 * 语义保真（迁移时最容易丢的东西，逐条对齐原生行为）：
 *   - defaultId 决定**初始焦点与回车**，与视觉强调解耦（primaryId 管视觉）。
 *     现有代码里有四处刻意把 defaultId 给「取消 / 继续下载」——运行包更新会
 *     打断会话、下载中误按回车会丢掉已下的 251MB。自绘层若把 defaultId 当成
 *     "主按钮"来画，这些决策会被改掉。
 *   - cancelId 决定 Esc 行为。
 *   - 按钮顺序与原生一致（按数组顺序，不做左右翻转），不改变用户肌肉记忆。
 *
 * 兜底：dshView 不可用 / 页面正在导航 / 注入失败 → 回落系统 dialog。
 */
import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'
import { getEffectiveTheme } from './theme-manager'
import { INJECTED_THEME_VARS, ICONS, FONT_STACK } from './injected-theme'
import {
  buildUpdatePanelSpec,
  UPDATE_PANEL_CSS,
  UPDATE_PANEL_SCRIPT,
  type UpdatePanelOptions,
  type UpdatePanelResult
} from './update-panel'

// ICONS / FONT_STACK 定义在 injected-theme，与模态框层（injected-modal）共用，
// 也让预览脚本只加载那一个文件就拿得到全部注入式资产。

/** 与 MessageBoxOptions['type'] 对齐，'none' 表示不画图标 */
export type DshDialogType = 'none' | 'info' | 'error' | 'question' | 'warning'

/**
 * detail 的两个视觉层级（每级各带一个图标）
 *
 * 19 处调用点的 detail 实际只有两类内容，硬塞进同一个样式会两头不讨好：
 *   - 'notice' 风险 / 错误 / 后果（更新会中断会话、下载失败原因、取消会删已下部分）
 *     → 琥珀竖条 + 淡琥珀底 + 警示三角，13px 深色正文
 *   - 'meta'   版本信息与操作引导（当前版本 vX / 最新版本 vY / 下一步点哪）
 *     → 淡中性底 + tag 标签图标，12.5px 次级色
 * 缺省 'meta'（多数调用点是版本信息）。这是纯展示字段，不进任何分支逻辑。
 */
export type DshDialogDetailTone = 'notice' | 'meta'

export interface DshDialogOptions {
  type?: DshDialogType
  title?: string
  message: string
  detail?: string
  /** detail 的视觉层级，缺省 'meta'（版本信息类）。风险/错误类须显式传 'notice' */
  detailTone?: DshDialogDetailTone
  /** 按钮文案，按数组顺序渲染；缺省为单个「确定」 */
  buttons?: string[]
  /** 初始焦点 / 回车触发的按钮下标，缺省 0 */
  defaultId?: number
  /** Esc 触发的按钮下标，缺省最后一个 */
  cancelId?: number
  /**
   * 视觉强调（主按钮）下标，与 defaultId 解耦。
   *
   * 缺省推导：第一个非 cancelId 的按钮。多数场景这个推导是对的（主操作在
   * 前、取消在后）。但当"主操作"恰好就是 cancelId 时推导会反过来——例如
   * 客户端更新下载中那个框 ['取消下载', '继续下载'] + cancelId=1，推出主按钮
   * 是「取消下载」。这类语义冲突的调用点必须显式传 primaryId。
   */
  primaryId?: number
}

/** 与 MessageBoxResult 对齐，让调用点迁移时 r.response 的写法保持不变 */
export interface DshDialogResult {
  response: number
}

interface DshDialogHost {
  /** 取内容视图的 webContents（不可用时返回 null） */
  getWebContents: () => WebContents | null
  /** 取主窗口，用作系统弹窗的 parent（窗口已销毁时返回 null） */
  getParentWindow: () => BrowserWindow | null
}

/**
 * 按钮变体（与参考图对齐：三档同高同圆角、全部实底）
 *
 * 'lead'   主按钮：白底深字 / 浅色反转的近黑底白字，min-width 撑成全组最宽
 * 'minor'  次级操作：浅灰实底
 * 'ghost'  取消：浅灰实底（参考图里不再有纯文字按钮）
 * 层级只靠填充色表达，尺寸不再做人为不对称。
 */
export type DshDialogButtonVariant = 'lead' | 'minor' | 'ghost'

/** 页面侧渲染用的完整 spec（由 buildDialogSpec 生成） */
export interface DialogSpec {
  id: number
  type: DshDialogType
  title: string
  message: string
  detail: string
  detailTone: DshDialogDetailTone
  buttons: { label: string; variant: DshDialogButtonVariant }[]
  defaultId: number
  cancelId: number
  /** 四个按钮时切紧凑排布（禁止换行 + 8px 间距） */
  tight: boolean
  vars: Record<string, string>
}

/**
 * 队列内部统一的结果形状
 *
 * 面板比消息框多带一个复选框勾选态（checked）。两者走同一个队列，队列必须用
 * 同一个 resolve 签名，所以这里定义一份内部形状，由 showDshMessageBox /
 * showUpdatePanel 各自裁剪成对外的返回类型。
 */
interface OverlayResult {
  response: number
  checked: boolean
}

/**
 * 等待展示的请求
 *
 * kind 区分两种形态：'messagebox'（旧卡片）与 'panel'（更新面板）。二者共用
 * 同一条队列，保证任意时刻只有一个浮层——面板与旧对话框不会叠在一起。
 */
interface Pending {
  kind: 'messagebox' | 'panel'
  options: DshDialogOptions | UpdatePanelOptions
  resolve: (result: OverlayResult) => void
}

/** 正在显示中的一个（页面侧已渲染，尚未收到用户选择） */
type ActiveDialog = Pending & { id: number; buttonCount: number }

let host: DshDialogHost | null = null

/** 宿主是否已注入且页面未在导航中（决定走自绘还是系统弹窗） */
let hostReady = false

let active: ActiveDialog | null = null
const queue: Pending[] = []
let seq = 0

/** 等待宿主注入完成的回调（见 waitForNextDialogHost） */
const hostWaiters: ((ready: boolean) => void)[] = []

/**
 * 对话框样式
 *
 * 浅色：磨砂玻璃卡片（半透明底 + 背后高斯模糊 + 通透高光边），16px 圆角。
 * 深色：按参考图改为**不透明纯黑实心 + 一圈极淡描边、无内高光**，卡片级
 * 模糊由 --dsh-dlg-blur 置为 none；遮罩层的 6px 模糊两层都保留。
 *
 * 两层 backdrop-filter 是刻意叠加，不是重复：
 *   - `.backdrop` blur(6px) 让整屏背景"化开"；
 *   - `.card` 的模糊由令牌控制（light 20px / dark none）。
 * 描边、外阴影、inset 高光三行必须保留结构：深色的「淡描边 / 透明高光」
 * 是靠令牌值实现的，删掉 CSS 行会让浅色一起丢。
 * 整段作为 Shadow Root 内的 <style> 注入，与宿主页面样式完全隔离。
 */
export const DIALOG_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--dsh-dlg-backdrop);
  -webkit-backdrop-filter: blur(6px);
  backdrop-filter: blur(6px);
  animation: dlg-fade 140ms ease-out;
}
.card {
  width: min(460px, 100%); max-height: min(76vh, 560px);
  display: flex; flex-direction: column;
  background: var(--dsh-dlg-glass);
  -webkit-backdrop-filter: var(--dsh-dlg-blur);
  backdrop-filter: var(--dsh-dlg-blur);
  border: 1px solid var(--dsh-dlg-glass-border);
  border-radius: 16px;
  /* 外阴影托住卡片（脱离页面平面），inset 高光模拟顶部受光 */
  box-shadow: var(--dsh-dlg-shadow), inset 0 1px 0 0 var(--dsh-dlg-highlight);
  color: var(--dsh-dlg-body);
  overflow: hidden;
  font-family: ${FONT_STACK};
  animation: dlg-pop 160ms cubic-bezier(.2, .8, .2, 1);
}
.head { display: flex; align-items: flex-start; gap: 10px; padding: 22px 24px 0; }
.head[hidden] { display: none; }
.icon { flex: none; width: 18px; height: 18px; margin-top: 1px; color: var(--dsh-dlg-icon-info); }
.icon[data-type="warning"] { color: var(--dsh-dlg-icon-warning); }
.icon[data-type="error"] { color: var(--dsh-dlg-icon-error); }
.title { margin: 0; font-size: 15px; font-weight: 600; line-height: 1.45; color: var(--dsh-dlg-fg); }
.body { padding: 10px 24px 0; overflow-y: auto; min-height: 0; }

/* ── 三段文字层级：每级各带一个图标，样式互不混淆 ──
   ① 提示语    13.5px 正文色 + 中性提示符图标
   ② 风险类    13px 正文色 + 琥珀竖条/淡底 + 警示三角
   ③ 版本信息  12.5px 次级色 + 淡中性底 + tag 标签
   ② 与 ③ 的底色都是半透明的，叠在玻璃卡上不会像"补丁"。 */
.tier { display: flex; align-items: flex-start; gap: 9px; }
.tier__icon { flex: none; width: 16px; height: 16px; margin-top: 2px; }
.tier__text { min-width: 0; }

.message { font-size: 13.5px; line-height: 1.65; color: var(--dsh-dlg-body); }
.message .tier__icon { color: var(--dsh-dlg-muted); }

.detail--notice {
  margin-top: 12px; padding: 10px 12px 10px 11px;
  border-left: 3px solid var(--dsh-dlg-notice-bar);
  border-radius: 0 10px 10px 0;
  background: var(--dsh-dlg-notice-bg);
  font-size: 13px; line-height: 1.65; color: var(--dsh-dlg-body);
  white-space: pre-wrap;
}
.detail--notice .tier__icon { color: var(--dsh-dlg-icon-warning); }

.detail--meta {
  margin-top: 10px; padding: 8px 12px;
  border-radius: 10px;
  background: var(--dsh-dlg-meta-bg);
  font-size: 12.5px; line-height: 1.7; color: var(--dsh-dlg-muted);
  white-space: pre-wrap;
}
.detail--meta .tier__icon { color: var(--dsh-dlg-muted); }

.foot {
  display: flex; justify-content: flex-end; flex-wrap: wrap;
  gap: 10px; row-gap: 10px; padding: 18px 24px 22px;
}
/* 四个中英混排按钮单行放不下时用这个变体：禁止换行 + 更紧的间距，
   宁可让按钮横向压缩也不能退回"两行按钮"的难看排布 */
.card[data-tight="1"] .foot { flex-wrap: nowrap; gap: 8px; }
/* 两个及以上按钮时加一条发丝线，把"内容"与"动作"分层 */
.card[data-split="1"] .foot { border-top: 1px solid var(--dsh-dlg-hairline); margin-top: 18px; }
/* 按钮规格对齐参考图：三档同高（34px）、同圆角（10px）、**全部实底**，
   层级只靠填充色区分（主按钮白/黑，次级与取消为浅灰实底）。 */
.btn {
  flex: none; white-space: nowrap;
  height: 34px; padding: 0 18px; border-radius: 10px;
  cursor: pointer; border: 1px solid transparent;
  font-family: inherit; font-size: 13px; font-weight: 500; line-height: 1;
  background: transparent; color: var(--dsh-dlg-body);
  transition: background-color 120ms ease, border-color 120ms ease, color 120ms ease;
}
/* 主按钮：min-width 把它撑成全组最宽——4 按钮时另外三个按钮里有 5 汉字 +
   拉丁字母的（如「检查DSH运行包」），纯内容排版下它会比 4 汉字主按钮更宽，
   "主按钮最大"就不成立了 */
.btn--lead { min-width: 112px; background: var(--dsh-dlg-primary-bg); color: var(--dsh-dlg-primary-fg); }
.btn--lead:hover { background: var(--dsh-dlg-primary-hover); }
/* 次级与取消：参考图里两者同为浅灰实底，不再有纯文字按钮 */
.btn--minor,
.btn--ghost { background: var(--dsh-dlg-btn-surface); color: var(--dsh-dlg-body); }
.btn--minor:hover,
.btn--ghost:hover { background: var(--dsh-dlg-btn-surface-hover); }
.btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dsh-dlg-ring); }
@keyframes dlg-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dlg-pop {
  from { opacity: 0; transform: translateY(4px) scale(.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .backdrop, .card { animation: none; } }
`

/**
 * 注入到 dshView 的宿主脚本
 *
 * 在 Shadow DOM 里搭出对话框并接管交互；用户做出选择后调用
 * window.dsh.dialogResult(id, index) 通知主进程，随后立即自行移除。
 *
 * 全部文案走 textContent，页面上不存在 innerHTML 注入面（唯一的 innerHTML
 * 是上面那组常量图标路径）。注入代码统一用 var / function，与既有
 * injectModalShell 的写法保持一致。
 */
export function buildHostScript(): string {
  return `
(function () {
  if (window.__dshDialogHost) return
  var CSS = ${JSON.stringify(DIALOG_CSS + UPDATE_PANEL_CSS)}
  var ICONS = ${JSON.stringify(ICONS)}

  function svg (name) {
    var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    el.setAttribute('viewBox', '0 0 24 24')
    el.setAttribute('fill', 'none')
    el.setAttribute('stroke', 'currentColor')
    el.setAttribute('stroke-width', '1.75')
    el.setAttribute('stroke-linecap', 'round')
    el.setAttribute('stroke-linejoin', 'round')
    el.setAttribute('aria-hidden', 'true')
    el.innerHTML = ICONS[name] || ''
    return el
  }

${UPDATE_PANEL_SCRIPT}

  function open (spec) {
    // 同一时刻只允许一个对话框，与既有模态框的单一实例策略一致
    var prev = document.querySelector('[data-dsh-dialog]')
    if (prev) prev.remove()

    // 令牌随 spec 下发，保证首次渲染就是当前主题（不依赖页面里是否注入过横幅/模态框）
    var vars = spec.vars || {}
    for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

    var hostEl = document.createElement('div')
    hostEl.setAttribute('data-dsh-dialog', '')
    hostEl.style.cssText = 'position:fixed;inset:0;z-index:2147483647;'

    var root = hostEl.attachShadow({ mode: 'open' })
    var style = document.createElement('style')
    style.textContent = CSS

    var backdrop = document.createElement('div')
    backdrop.className = 'backdrop'

    // 面板的复选框勾选态由宿主脚本持有：Esc 与遮罩点击也要把勾选态回传，
    // 状态藏在面板构造器的闭包里就取不到了。
    var panelState = { checked: false }

    var settled = false
    function settle (index) {
      if (settled) return
      settled = true
      document.removeEventListener('keydown', onKey, true)
      hostEl.remove()
      var api = window.dsh
      if (api && typeof api.dialogResult === 'function') {
        // 面板多带一个 checked；消息框不带（payload 为 undefined）
        api.dialogResult(spec.id, index, spec.kind === 'panel' ? { checked: !!panelState.checked } : undefined)
      }
    }

    // 焦点循环元素与初始焦点目标，由两条分支各自填好
    var focusables = []
    var initialFocus = null

    if (spec.kind === 'panel') {
      var built = buildPanelCard(spec, svg, panelState, settle)
      backdrop.appendChild(built.card)
      focusables = built.focusables
      // defaultId 是 spec.buttons 的下标，与面板按钮数组一一对应
      initialFocus = built.buttons[spec.defaultId] || null
    } else {
    var card = document.createElement('div')
    card.className = 'card'
    card.setAttribute('role', 'dialog')
    card.setAttribute('aria-modal', 'true')
    if (spec.buttons.length > 1) card.setAttribute('data-split', '1')
    // 四按钮且总宽接近卡片上限时切紧凑排布：禁止换行 + 更紧间距，
    // 宁可让按钮横向压缩也不能退化成"两行按钮"
    if (spec.tight) card.setAttribute('data-tight', '1')

    var head = document.createElement('div')
    head.className = 'head'
    if (spec.title) {
      var titleId = 'dsh-dlg-title-' + spec.id
      card.setAttribute('aria-labelledby', titleId)
      if (spec.type && spec.type !== 'none') {
        var icon = svg(spec.type)
        icon.setAttribute('class', 'icon')
        icon.setAttribute('data-type', spec.type)
        head.appendChild(icon)
      }
      var h1 = document.createElement('h1')
      h1.className = 'title'
      h1.id = titleId
      h1.textContent = spec.title
      head.appendChild(h1)
    } else {
      head.setAttribute('hidden', '')
    }

    var body = document.createElement('div')
    body.className = 'body'

    // 三段文字层级，每段一个图标。tier() 统一产出「图标 + 文本」的行结构，
    // 图标形状由 data-icon 指向 ICONS 的键。
    function tier (kind, tone, iconName, text) {
      var row = document.createElement('div')
      row.className = 'tier ' + kind
      var icon = svg(iconName)
      icon.setAttribute('class', 'tier__icon')
      var textEl = document.createElement('div')
      textEl.className = 'tier__text'
      textEl.textContent = text
      row.appendChild(icon)
      row.appendChild(textEl)
      return row
    }

    // ① 提示语：中性提示符，视觉重量刻意低于标题图标
    body.appendChild(tier('message', '', 'bullet', spec.message))
    // ②③ detail：风险类提示条 / 版本信息类，按 detailTone 二选一
    if (spec.detail) {
      var isNotice = spec.detailTone === 'notice'
      body.appendChild(tier(
        isNotice ? 'detail--notice' : 'detail--meta',
        spec.detailTone,
        isNotice ? 'notice' : 'meta',
        spec.detail
      ))
    }

    var foot = document.createElement('div')
    foot.className = 'foot'
    var btnEls = []
    spec.buttons.forEach(function (b, i) {
      var btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'btn btn--' + b.variant
      btn.textContent = b.label
      btn.addEventListener('click', function () { settle(i) })
      foot.appendChild(btn)
      btnEls.push(btn)
    })

    card.appendChild(head)
    card.appendChild(body)
    card.appendChild(foot)
    backdrop.appendChild(card)
    focusables = btnEls
    initialFocus = btnEls[spec.defaultId] || null
    }

    root.appendChild(style)
    root.appendChild(backdrop)

    // Esc 走 cancelId；Tab 在可聚焦元素之间闭环（模态必须锁住焦点）
    function onKey (e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settle(spec.cancelId)
        return
      }
      if (e.key !== 'Tab' || !focusables.length) return
      var first = focusables[0]
      var last = focusables[focusables.length - 1]
      var current = root.activeElement
      if (e.shiftKey && (current === first || !current)) {
        e.preventDefault()
        last.focus()
      } else if (!e.shiftKey && current === last) {
        e.preventDefault()
        first.focus()
      }
    }

    // 全部构建完成再挂载：中途抛错不会留下半截遮罩
    var mount = document.body || document.documentElement
    mount.appendChild(hostEl)
    document.addEventListener('keydown', onKey, true)
    // 点击遮罩关闭（与既有模态框一致）
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop) settle(spec.cancelId)
    })
    // 初始焦点给 defaultId（与原生一致：回车即触发它）
    if (initialFocus) initialFocus.focus()
  }

  window.__dshDialogHost = { open: open }
})()
`
}

/**
 * 在内容视图的每个新文档里注入宿主
 *
 * did-finish-load 意味着文档已重建，此时必然不存在宿主，直接注入即可；
 * 注入失败（页面尚未可执行、渲染进程异常）只置标志位，让后续弹窗回落系统弹窗。
 */
export function ensureDialogHost(wc: WebContents): void {
  hostReady = false
  void wc.executeJavaScript(buildHostScript(), true).then(
    () => { hostReady = true; flushHostWaiters(true) },
    (err: Error) => {
      hostReady = false
      flushHostWaiters(false)
      console.warn(`[DSH] 对话框宿主注入失败，本次弹窗回落系统弹窗: ${err.message}`)
    }
  )
}

function flushHostWaiters(ready: boolean): void {
  const waiters = hostWaiters.splice(0, hostWaiters.length)
  for (const w of waiters) w(ready)
}

/**
 * 等待「下一个文档」加载完成后宿主注入就绪
 *
 * 用途：loadErrorPage() 这类是 fire-and-forget（loadURL 不 await），要实现
 * 「先切到错误页、再弹对话框」必须用本函数把两件事串起来。否则弹窗会盖在
 * 旧页上，随后被导航销毁——注入的节点随文档一起消失，还挂着的那次弹窗永远
 * 等不到回传，会被 did-start-loading 钩子当「被中断」收敛掉，用户根本看不到。
 *
 * 必须在触发导航的同一个调用栈内先调用本函数：导航事件 did-start-loading 是
 * 异步派发的，晚于当前调用栈，所以这里立刻作废上一页的 hostReady，否则会读到
 * 残留的 true 而马上返回。
 *
 * 超时或注入失败返回 false——后续 showDshMessageBox 会自动回落系统弹窗。
 */
export function waitForNextDialogHost(timeoutMs = 5000): Promise<boolean> {
  hostReady = false
  // 内容视图已销毁时不会再有 did-finish-load，直接失败让调用方走系统弹窗兜底，
  // 而不是干等满 timeoutMs
  if (!host?.getWebContents()) return Promise.resolve(false)
  return new Promise<boolean>((resolve) => {
    let done = false
    const finish = (ready: boolean): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      const i = hostWaiters.indexOf(finish)
      if (i >= 0) hostWaiters.splice(i, 1)
      resolve(ready)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    if (typeof timer.unref === 'function') timer.unref()
    hostWaiters.push(finish)
  })
}

/**
 * 注册 IPC 与导航钩子（在 dshView 建好之后、首次加载页面之前调用一次）
 */
export function initDshDialog(dialogHost: DshDialogHost): void {
  host = dialogHost

  ipcMain.on('dsh-dialog-response', (event, id: unknown, index: unknown, payload: unknown) => {
    // 严格比对内容视图的 webContents：只有被注入宿主的那个页面能回传按钮结果
    const wc = host?.getWebContents()
    if (!wc || event.sender !== wc) return
    if (typeof id !== 'number' || typeof index !== 'number') return
    if (!active || active.id !== id) return // 过期点击（对话框已被导航销毁或已关闭）
    // 下标必须落在当前活动的按钮数组内。页内是第三方 DSH 内容，
    // 回传值必须当不可信输入校验（比此前只校验类型更严）。
    if (!Number.isInteger(index) || index < 0 || index >= active.buttonCount) return
    const finished = active
    active = null
    finished.resolve({ response: index, checked: readCheckedPayload(payload) })
    void pump()
  })

  // 页面开始导航：注入的节点随文档一起消失，此时还挂着的对话框永远不会回传，
  // 等待它的 Promise 会永久挂起。按 cancelId 主动收敛，并丢弃积压队列
  // （这些弹窗的触发前提往往已被这次导航作废）。
  host.getWebContents()?.on('did-start-loading', () => {
    hostReady = false
    if (!active && !queue.length) return
    const interrupted = active ? [active] : []
    active = null
    queue.length = 0
    for (const p of interrupted) {
      p.resolve({ response: resolveCancelId(p.kind, p.options), checked: false })
    }
  })
}

/**
 * 从回传 payload 里取复选框勾选态
 *
 * 页内是第三方 DSH 内容，payload 必须当不可信输入处理：非对象、或 checked
 * 不是 boolean，一律按 false 处理（等价于用户没勾）。
 */
function readCheckedPayload(payload: unknown): boolean {
  if (typeof payload !== 'object' || payload === null) return false
  const checked = (payload as { checked?: unknown }).checked
  return typeof checked === 'boolean' ? checked : false
}

/** 从队列里取下一个并展示 */
async function pump(): Promise<void> {
  if (active || !queue.length) return
  const next = queue.shift()
  if (!next) return

  const spec = next.kind === 'panel'
    ? buildUpdatePanelSpec(next.options as UpdatePanelOptions, ++seq)
    : buildDialogSpec(next.options as DshDialogOptions)
  const wc = host?.getWebContents()
  const canRender = hostReady && !!wc && !wc.isDestroyed()

  // 先占位再 await：页面侧渲染完成到主进程记下 active 之间有一个微任务窗口，
  // 顺序反了会让这段时间内的点击既没被记录、遮罩又已消失（Promise 永久挂起）
  const token: ActiveDialog = {
    ...next,
    id: spec.id,
    buttonCount: spec.buttons.length
  }
  active = token

  if (canRender) {
    try {
      await wc!.executeJavaScript(
        `window.__dshDialogHost && window.__dshDialogHost.open(${JSON.stringify(spec)})`,
        true
      )
      return
    } catch (err) {
      hostReady = false
      if (active === token) active = null
      console.warn(`[DSH] 自绘对话框展示失败，本次回落系统弹窗: ${(err as Error).message}`)
    }
  }

  // 兜底：系统弹窗。样式退回原生，但返回值形状与语义完全一致
  try {
    const parent = host?.getParentWindow()
    const result = parent
      ? await dialog.showMessageBox(parent, toNativeOptions(next.kind, next.options))
      : await dialog.showMessageBox(toNativeOptions(next.kind, next.options))
    token.resolve({ response: result.response, checked: false })
  } catch (err) {
    console.error(`[DSH] 系统兜底弹窗异常: ${(err as Error).message}`)
    token.resolve({ response: resolveCancelId(next.kind, next.options), checked: false })
  } finally {
    if (active === token) active = null
    void pump()
  }
}

/**
 * 把调用点的选项归一成注入层需要的形状（含 defaultId/cancelId/primaryId 兜底）
 *
 * 导出是为了让 scripts/preview-dialog.js 能驱动**真实**的推导逻辑。此前预览页
 * 的 spec 手写 variant 字段、完全绕过这里，导致 pickIndex 的上界 bug（图 2
 * 现象、退出确认回车即退出）在预览里完全看不出来。预览与实现必须同源。
 */
export function buildDialogSpec(options: DshDialogOptions): DialogSpec {
  const type = options.type ?? 'info'
  const buttons = options.buttons && options.buttons.length ? options.buttons : ['确定']
  const last = buttons.length - 1
  // 三个下标的上界都必须是 last。曾经把 defaultId / primaryId 的上界硬写成 0，
  // 于是任何大于 0 的值都被判越界丢弃、悄悄退回 0（见 pickIndex 的注释）
  const cancelId = pickIndex(options.cancelId, last, last)
  const defaultId = pickIndex(options.defaultId, 0, last)
  // 视觉强调缺省取第一个非取消按钮；全是非取消（即只有一个按钮）时就是它自己
  const derivedPrimary = buttons.findIndex((_, i) => i !== cancelId)
  const primaryId = pickIndex(options.primaryId, derivedPrimary === -1 ? 0 : derivedPrimary, last)

  return {
    id: ++seq,
    type,
    title: options.title ?? '',
    message: options.message,
    detail: options.detail ?? '',
    detailTone: options.detailTone ?? 'meta',
    // 变体：主操作 lead（填色 + 最大）、取消 ghost（纯文字）、其余 minor（描边 + 小一号）
    buttons: buttons.map((label, i) => ({
      label,
      variant: i === primaryId ? 'lead' : i === cancelId ? 'ghost' : 'minor'
    })),
    defaultId,
    cancelId,
    // 四个按钮（检查更新选择框）的中英混排文案总宽接近卡片上限，切紧凑排布
    tight: buttons.length >= 4,
    vars: INJECTED_THEME_VARS[getEffectiveTheme()]
  }
}

/**
 * 导航打断时的收敛值：调用点没给 cancelId 就取最后一个按钮
 *
 * 面板的 cancelId 是必填的（键盘语义必须逐个显式声明），这里仍做一次钳位
 * 兜底，防止调用点传入越界下标导致收敛到不存在的按钮。
 */
function resolveCancelId(kind: 'messagebox' | 'panel', options: DshDialogOptions | UpdatePanelOptions): number {
  if (kind === 'panel') {
    const panelOptions = options as UpdatePanelOptions
    const buttons = panelOptions.buttons && panelOptions.buttons.length ? panelOptions.buttons : []
    return pickIndex(panelOptions.cancelId, buttons.length - 1, buttons.length - 1)
  }
  const dialogOptions = options as DshDialogOptions
  const buttons = dialogOptions.buttons && dialogOptions.buttons.length ? dialogOptions.buttons : ['确定']
  return pickIndex(dialogOptions.cancelId, buttons.length - 1, buttons.length - 1)
}

/**
 * 解析一个按钮下标
 *
 * 合法整数会被**钳位**到 [0, maxIndex]，只有非数字 / 非整数才落到 fallback。
 * 钳位而不是丢弃很关键：早先的实现对越界值直接退回 fallback，而
 * buildDialogSpec 又把 defaultId / primaryId 的 maxIndex 硬写成 0，结果
 * 「退出确认」的 defaultId=1 被判越界 → 悄悄变成 0 → 回车直接退出应用；
 * 「客户端下载中」的 primaryId=1 同理把破坏性的「取消下载」画成了主按钮。
 * 越界本来就不该发生，但发生时要保住调用点的意图，而不是反转它。
 */
function pickIndex(value: number | undefined, fallback: number, maxIndex: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) return fallback
  return Math.min(Math.max(value, 0), maxIndex)
}

/**
 * 系统弹窗兜底用的原生选项
 *
 * 面板回落到原生弹窗时，图标、日期行、复选框这些都表达不了——这是降级路径，
 * 语义（哪个按钮对应什么动作、默认焦点、Esc 行为）必须保持一致，否则用户在
 * 同一个界面里会看到两套不同的键盘行为。
 */
function toNativeOptions(
  kind: 'messagebox' | 'panel',
  options: DshDialogOptions | UpdatePanelOptions
): Electron.MessageBoxOptions {
  if (kind === 'panel') {
    const panelOptions = options as UpdatePanelOptions
    const buttons = panelOptions.buttons.map((b) => b.label)
    return {
      type: 'info',
      title: panelOptions.title,
      message: panelOptions.message || panelOptions.title,
      detail: panelOptions.detail || undefined,
      buttons,
      defaultId: panelOptions.defaultId,
      cancelId: panelOptions.cancelId,
      noLink: true
    }
  }
  const dialogOptions = options as DshDialogOptions
  return {
    type: dialogOptions.type ?? 'info',
    title: dialogOptions.title,
    message: dialogOptions.message,
    detail: dialogOptions.detail,
    buttons: dialogOptions.buttons && dialogOptions.buttons.length ? dialogOptions.buttons : ['确定'],
    defaultId: dialogOptions.defaultId,
    cancelId: dialogOptions.cancelId,
    // 去掉旧版 Windows 弹窗底部的"在线帮助"链接
    noLink: true
  }
}

/**
 * 展示一个对话框，返回值形状与 dialog.showMessageBox 一致
 *
 * 同一时刻只显示一个，多余的请求排队（原生弹窗是系统层叠放，自绘层用队列
 * 复刻同样的"逐个确认"体验，避免两个遮罩互相踩）。
 */
export function showDshMessageBox(options: DshDialogOptions): Promise<DshDialogResult> {
  return new Promise<DshDialogResult>((resolve) => {
    queue.push({
      kind: 'messagebox',
      options,
      resolve: (result) => resolve({ response: result.response })
    })
    void pump()
  })
}

/**
 * 展示一个版本更新面板
 *
 * 与 showDshMessageBox 共用同一条队列、同一份宿主脚本、同一条 IPC 通道，
 * 因此面板与旧对话框不会同时出现（AGENTS.md §6.7 的单浮层约束）。
 *
 * 返回值比消息框多一个 checked：复选框（「以后自动下载并安装更新」）的勾选态。
 * 无复选框的面板该字段恒为 false。
 */
export function showUpdatePanel(options: UpdatePanelOptions): Promise<UpdatePanelResult> {
  return new Promise<UpdatePanelResult>((resolve) => {
    queue.push({
      kind: 'panel',
      options,
      resolve: (result) => resolve({ response: result.response, checked: result.checked })
    })
    void pump()
  })
}
