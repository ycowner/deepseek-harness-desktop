/**
 * 注入式模态框层（injected-modal）
 *
 * 与 dsh-dialog 的对话框层对称：各自自带 CSS + 宿主脚本 + 构建器，共用
 * injected-theme 的 `--dsh-dlg-*` 玻璃令牌、ICONS 与 FONT_STACK。区别只有形态：
 *
 *   对话框（dsh-dialog）    460px 小卡  + 类型图标 + 三段文字层级 + 按钮行 + 焦点陷阱
 *   模态框（本模块）        720px 大卡  + 类型图标 + 独立头部(×) + 可滚动 markdown 正文
 *
 * 两层保持独立、不合并：模态框装的是"文档"（更新日志几十行 markdown、关于框的
 * 版本清单），按钮行与三段文字层级对它没有意义。
 *
 * ── 为什么单独一个文件（而不是留在 index.ts 里）───────────────────────────
 * 曾在 index.ts 内联实现，代价是**这个层没有任何预览或自动化覆盖**：对话框层的
 * DIALOG_CSS 在 dsh-dialog.ts 里，预览页能加载并验证它；模态框的 CSS 在
 * index.ts 里，预览脚本 import 它会拉进 electron 副作用、根本跑不起来。结果就是
 * Shadow DOM 迁移时把 card 挂到了 backdrop 外面（内容被玻璃层糊住、且不居中）
 * 这类结构回归只能在真机上发现。抽出来之后，scripts/preview-dialog.js 用与
 * 对话框层完全相同的方式加载本模块，并跑 assertModalStructure() 在**生成期**
 * 就把结构错误炸出来。
 */
import type { WebContents } from 'electron'
import { getEffectiveTheme } from './theme-manager'
import { INJECTED_THEME_VARS, ICONS, FONT_STACK } from './injected-theme'

/** 模态框头部类型图标：关于框用 info，两个更新日志用 doc */
export type ModalKind = 'info' | 'doc'

const KIND_ICON: Record<ModalKind, string> = { info: 'info', doc: 'doc' }

/**
 * 模态框样式
 *
 * 玻璃参数**比对话框弱一档**（对话框 blur 20px / 0.72，本模块 12px / 0.82）：
 * 模态框面积大得多且装长文档，两层大面积 backdrop-filter 叠加时弱显卡上开销明显，
 * 长文在半透明卡片上滚动也更吃力。降档后对比度反而更宽松（muted 从 4.78:1
 * 升到 5.7:1），不需要动 --dsh-dlg-muted。
 *
 * 遮罩与卡片的结构是**父子**（card 在 backdrop 内）：backdrop 才是那个负责
 * flex 居中的容器，卡片若与它平级，就会顶到左上角；而 backdrop 带 z-index，
 * 还会盖在 z-index 为 auto 的卡片上，把内容糊掉。这两个症状来自同一个错误。
 */
export const MODAL_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
.backdrop {
  position: fixed; inset: 0; z-index: 2147483647;
  display: flex; align-items: center; justify-content: center; padding: 24px;
  background: var(--dsh-dlg-backdrop);
  -webkit-backdrop-filter: blur(4px);
  backdrop-filter: blur(4px);
  animation: dsh-modal-fade 140ms ease-out;
}
.card {
  position: relative;
  width: min(720px, 92vw); max-height: 80vh;
  display: flex; flex-direction: column;
  background: var(--dsh-dlg-glass-strong);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  backdrop-filter: blur(12px) saturate(180%);
  border: 1px solid var(--dsh-dlg-glass-border);
  border-radius: 24px;
  box-shadow: var(--dsh-dlg-shadow), inset 0 1px 0 0 var(--dsh-dlg-highlight);
  color: var(--dsh-dlg-body);
  overflow: hidden;
  font-family: ${FONT_STACK};
  animation: dsh-modal-pop 160ms cubic-bezier(.2, .8, .2, 1);
}
.head {
  display: flex; align-items: center; gap: 10px;
  padding: 16px 20px 16px 24px; flex: none;
  border-bottom: 1px solid var(--dsh-dlg-hairline);
}
.head-icon { flex: none; width: 18px; height: 18px; color: var(--dsh-dlg-muted); }
.head-icon[data-kind="info"] { color: var(--dsh-dlg-icon-info); }
.head-title { font-size: 15px; font-weight: 600; color: var(--dsh-dlg-fg); }
.close {
  width: 28px; height: 28px; margin-left: auto;
  border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsh-dlg-muted);
  font-size: 18px; line-height: 1; cursor: pointer;
}
.close:hover { background: var(--dsh-dlg-hover); color: var(--dsh-dlg-fg); }
.close:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dsh-dlg-ring); }
.body { padding: 18px 24px 22px; overflow-y: auto; min-height: 0; font-size: 13px; line-height: 1.65; }
.body h3 { font-size: 15px; margin: 14px 0 6px; color: var(--dsh-dlg-fg); }
.body h4 { font-size: 14px; margin: 12px 0 5px; color: var(--dsh-dlg-fg); }
.body h5 { font-size: 13px; margin: 10px 0 4px; color: var(--dsh-dlg-body); }
.body p { margin: 6px 0; }
.body ul { margin: 6px 0; padding-left: 22px; }
.body li { margin: 3px 0; }
.body pre {
  background: var(--dsh-dlg-code-bg); border-radius: 10px;
  padding: 10px 12px; overflow-x: auto; margin: 8px 0; font-size: 12px;
}
.body code {
  background: var(--dsh-dlg-code-bg); border-radius: 5px; padding: 1px 5px;
  font-family: ui-monospace, Consolas, monospace; font-size: 12px;
}
.body pre code { background: transparent; padding: 0; }
.body a { color: var(--dsh-dlg-link); }
.body hr { border: none; border-top: 1px solid var(--dsh-dlg-hairline); margin: 12px 0; }
.body .log-entry { margin: 0 0 14px; }
.body .log-head { display: flex; align-items: baseline; gap: 10px; margin-bottom: 4px; }
.body .log-ver { font-size: 14px; font-weight: 600; color: var(--dsh-dlg-fg); }
.body .log-date { font-size: 12px; color: var(--dsh-dlg-muted); }
.body .log-divider { border: none; border-top: 1px solid var(--dsh-dlg-hairline); margin: 0 0 14px; }
@keyframes dsh-modal-fade { from { opacity: 0; } to { opacity: 1; } }
@keyframes dsh-modal-pop {
  from { opacity: 0; transform: translateY(4px) scale(.985); }
  to { opacity: 1; transform: none; }
}
@media (prefers-reduced-motion: reduce) { .backdrop, .card { animation: none; } }
`

/**
 * 生成模态框的注入代码
 *
 * 挂载后对外只暴露 `window.__dshModal = { shadow, update, cleanup }`：
 * 内容区、关于框的按钮绑定、锚点滚动目标都在 Shadow Root 内，**document 级选择器
 * 一律查不到**，这是 Shadow DOM 迁移的必要代价。
 */
export function buildModalHostScript(kind: ModalKind, title: string, bodyHtml: string): string {
  return `
    (function () {
      // 清理旧模态框（跨多次注入保持单一实例）
      if (window.__dshModal) { try { window.__dshModal.cleanup() } catch (e) {} }
      var prev = document.querySelector('[data-dsh-modal]')
      if (prev) prev.remove()

      // 注入时按当前生效主题写入令牌，不依赖"之前是否有人注入过"
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

      var ICONS = ${JSON.stringify(ICONS)}
      function icon (name, cls) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        el.setAttribute('viewBox', '0 0 24 24')
        el.setAttribute('fill', 'none')
        el.setAttribute('stroke', 'currentColor')
        el.setAttribute('stroke-width', '1.75')
        el.setAttribute('stroke-linecap', 'round')
        el.setAttribute('stroke-linejoin', 'round')
        el.setAttribute('aria-hidden', 'true')
        el.setAttribute('class', cls)
        el.setAttribute('data-kind', ${JSON.stringify(kind)})
        el.innerHTML = ICONS[name] || ''
        return el
      }

      var hostEl = document.createElement('div')
      hostEl.setAttribute('data-dsh-modal', '')
      // display:block 显式写出：:host { all: initial } 会把 display 重置为 inline
      // （fixed 定位虽会块化，但不该依赖这个细节）
      hostEl.style.cssText = 'position:fixed;inset:0;z-index:2147483647;display:block;'

      var root = hostEl.attachShadow({ mode: 'open' })
      var style = document.createElement('style')
      style.textContent = ${JSON.stringify(MODAL_CSS)}

      var backdrop = document.createElement('div')
      backdrop.className = 'backdrop'

      var card = document.createElement('div')
      card.className = 'card'
      card.setAttribute('role', 'dialog')
      card.setAttribute('aria-modal', 'true')
      card.setAttribute('aria-labelledby', 'dsh-modal-title')

      var head = document.createElement('div')
      head.className = 'head'
      // 头部类型图标：与对话框层对齐，扫一眼就能区分信息 / 文档
      head.appendChild(icon(${JSON.stringify(KIND_ICON[kind])}, 'head-icon'))
      var titleEl = document.createElement('span')
      titleEl.className = 'head-title'
      titleEl.id = 'dsh-modal-title'
      titleEl.textContent = ${JSON.stringify(title)}
      var closeBtn = document.createElement('button')
      closeBtn.className = 'close'
      closeBtn.setAttribute('aria-label', '关闭')
      closeBtn.textContent = '×'
      head.appendChild(titleEl)
      head.appendChild(closeBtn)

      var body = document.createElement('div')
      body.className = 'body'
      body.setAttribute('data-dsh-modal-body', '')
      body.innerHTML = ${JSON.stringify(bodyHtml)}

      // 模态框内 fragment 锚点导航委托：更新日志的 [中文](#cn-...) 目录链接
      // 命中后拦截默认行为（防止整个 DSH 页面被 fragment 导航），改为在内容区
      // 滚动到目标标题。目标也在 shadow root 内，必须用 root.getElementById
      body.addEventListener('click', function (e) {
        var el = e.target
        while (el && el.nodeType === 1 && el.tagName !== 'A') el = el.parentNode
        if (!el || el.nodeType !== 1) return
        var href = el.getAttribute('href') || ''
        if (href.charAt(0) !== '#') return
        e.preventDefault()
        var target = root.getElementById(href.slice(1))
        if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' })
      })

      card.appendChild(head)
      card.appendChild(body)
      // ★ card 必须在 backdrop 内部：backdrop 才是负责 flex 居中的容器。
      //   若与 backdrop 平级，卡片会顶到左上角，且被 backdrop 的 z-index +
      //   半透明 + backdrop-filter 盖住，内容会糊成一片。
      backdrop.appendChild(card)
      root.appendChild(style)
      root.appendChild(backdrop)

      // 全部构建完成再挂载：中途抛错不会留下半截遮罩
      ;(document.body || document.documentElement).appendChild(hostEl)

      function cleanup() {
        hostEl.remove()
        document.removeEventListener('keydown', onKey, true)
        window.__dshModal = null
      }
      function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cleanup() }
      }
      document.addEventListener('keydown', onKey, true)
      closeBtn.addEventListener('click', cleanup)
      backdrop.addEventListener('click', function (e) {
        if (e.target === backdrop) cleanup()
      })

      // 外部唯一的入口：updateModalBody 与关于框的 GitHub 按钮绑定都走这里
      window.__dshModal = {
        shadow: root,
        update: function (html) { body.innerHTML = html },
        cleanup: cleanup
      }
    })()
  `
}

/** 生成正文替换代码（无模态框时返回 'no-modal'，不静默） */
export function buildModalUpdateScript(bodyHtml: string): string {
  return `
    (function () {
      if (!window.__dshModal) return 'no-modal'
      window.__dshModal.update(${JSON.stringify(bodyHtml)})
      return 'updated'
    })()
  `
}

/**
 * 注入模态框外壳（标题 + 初始内容），并接管 Esc / 遮罩 / × 关闭
 *
 * 同一时间只允许一个模态框。所有拼入 HTML 的变量均经 JSON.stringify 处理，
 * 防注入断裂。
 */
export async function injectModalShell(
  wc: WebContents,
  title: string,
  bodyHtml: string,
  kind: ModalKind
): Promise<void> {
  try {
    await wc.executeJavaScript(buildModalHostScript(kind, title, bodyHtml), true)
  } catch (err) {
    console.warn(`[DSH] 注入模态框失败: ${(err as Error).message}`)
  }
}

/**
 * 替换当前模态框的内容区 HTML（「先弹壳 → 数据到达 → 替换正文」两段式的第二步）
 *
 * catch 里保留 warn 日志，不要改回空 catch：它静默失败的表现是"更新日志一直
 * 转圈"，没有日志就只能靠猜。
 */
export async function updateModalBody(wc: WebContents, bodyHtml: string): Promise<void> {
  try {
    await wc.executeJavaScript(buildModalUpdateScript(bodyHtml), true)
  } catch (err) {
    console.warn(
      `[DSH] 替换模态框正文失败（模态框可能已被关闭或页面正在导航）: ${(err as Error).message}`
    )
  }
}
