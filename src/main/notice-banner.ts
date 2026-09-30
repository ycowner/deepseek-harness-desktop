/**
 * 公告横幅的注入层（渲染侧）
 *
 * 与 notice.ts（数据侧）分开：那个管拉取/校验/已读，这个只管把给定的一批公告
 * 渲染成 DSH 页顶部的横幅。样式与宿主脚本都在本模块内，供预览脚本抽取——
 * 见 AGENTS.md §12.1 第 45 条（注入式 UI 的实现不得留在 index.ts）。
 *
 * 与客户端更新横幅（#dsh-ub）**都贴顶**，必须错开：更新横幅在上（本模块的
 * top 随它是否可见动态计算），公告横幅在其下方。两套注入互不知晓对方存在，
 * 靠读 `#dsh-ub` 的实际布局来避让，不引入共享状态。
 *
 * 文案一律 textContent + pre-wrap，**不做任何 innerHTML**（见 notice.ts 的安全基线）。
 */
import type { WebContents } from 'electron'
import { getEffectiveTheme } from './theme-manager'
import { INJECTED_THEME_VARS, ICONS, FONT_STACK } from './injected-theme'
import { MAX_BANNER_STACK, type Notice } from './notice'

export const NOTICE_BANNER_CSS = `
:host { all: initial; }
* { box-sizing: border-box; }
#dsh-notice-bar {
  position: fixed; left: 0; right: 0; z-index: 2147482999;
  display: flex; flex-direction: column; gap: 8px;
  padding: 10px 16px 12px;
  font-family: ${FONT_STACK};
  pointer-events: none;
}
#dsh-notice-bar[hidden] { display: none; }
#dsh-notice-bar .n-item {
  pointer-events: auto;
  display: flex; align-items: flex-start; gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  border: 1px solid var(--dsh-dlg-glass-border);
  background: var(--dsh-dlg-glass-strong);
  -webkit-backdrop-filter: blur(12px) saturate(180%);
  backdrop-filter: blur(12px) saturate(180%);
  box-shadow: var(--dsh-dlg-shadow);
  color: var(--dsh-dlg-body);
  font-size: 13px; line-height: 1.6;
  animation: n-slide 180ms cubic-bezier(.2, .8, .2, 1);
}
#dsh-notice-bar .n-item[data-level="warning"] { border-left: 3px solid var(--dsh-dlg-notice-bar); }
#dsh-notice-bar .n-item[data-level="error"] { border-left: 3px solid #b42318; }
#dsh-notice-bar .n-item[data-level="info"] { border-left: 3px solid var(--dsh-dlg-primary-bg); }
#dsh-notice-bar .n-icon { flex: none; width: 16px; height: 16px; margin-top: 2px; color: var(--dsh-dlg-muted); }
#dsh-notice-bar .n-item[data-level="warning"] .n-icon { color: var(--dsh-dlg-icon-warning); }
#dsh-notice-bar .n-item[data-level="error"] .n-icon { color: var(--dsh-dlg-icon-error); }
#dsh-notice-bar .n-item[data-level="info"] .n-icon { color: var(--dsh-dlg-icon-info); }
#dsh-notice-bar .n-text { min-width: 0; flex: 1; }
#dsh-notice-bar .n-title { font-weight: 600; color: var(--dsh-dlg-fg); }
#dsh-notice-bar .n-body { margin-top: 2px; white-space: pre-wrap; color: var(--dsh-dlg-muted); }
#dsh-notice-bar .n-actions { display: flex; align-items: center; gap: 6px; flex: none; }
#dsh-notice-bar .n-btn {
  height: 28px; padding: 0 12px; border-radius: 8px; cursor: pointer;
  font-family: inherit; font-size: 12px; font-weight: 500;
  border: 1px solid var(--dsh-dlg-glass-border);
  background: var(--dsh-dlg-btn-surface); color: var(--dsh-dlg-body);
}
#dsh-notice-bar .n-btn:hover { background: var(--dsh-dlg-btn-surface-hover); }
#dsh-notice-bar .n-btn:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dsh-dlg-ring); }
#dsh-notice-bar .n-close {
  width: 28px; height: 28px; border: 1px solid transparent; border-radius: 8px;
  background: transparent; color: var(--dsh-dlg-muted);
  font-size: 16px; line-height: 1; cursor: pointer; font-family: inherit;
}
#dsh-notice-bar .n-close:hover { background: var(--dsh-dlg-hover); color: var(--dsh-dlg-fg); }
#dsh-notice-bar .n-close:focus-visible { outline: none; box-shadow: 0 0 0 3px var(--dsh-dlg-ring); }
@keyframes n-slide { from { opacity: 0; transform: translateY(-4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) { #dsh-notice-bar .n-item { animation: none; } }
`

const LEVEL_ICON: Record<Notice['level'], string> = {
  info: 'info',
  warning: 'warning',
  error: 'error'
}

/**
 * 生成横幅注入代码
 *
 * @param notices 已过滤（生效窗口 + 未读）并截断到 MAX_BANNER_STACK 的横幅型公告
 */
export function buildNoticeBannerScript(notices: Notice[]): string {
  const list = notices.slice(0, MAX_BANNER_STACK)
  return `
    (function () {
      var NOTICES = ${JSON.stringify(list)}
      var LEVEL_ICON = ${JSON.stringify(LEVEL_ICON)}
      var ICONS = ${JSON.stringify(ICONS)}
      var vars = ${JSON.stringify(INJECTED_THEME_VARS[getEffectiveTheme()])}
      for (var k in vars) document.documentElement.style.setProperty(k, vars[k])

      // 幂等重建：dshView 每次导航后节点都会随文档消失，这里保证始终只有一个
      var prev = document.querySelector('[data-dsh-notice]')
      if (prev) prev.remove()
      if (!NOTICES.length) return

      function icon (name) {
        var el = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
        el.setAttribute('viewBox', '0 0 24 24')
        el.setAttribute('fill', 'none')
        el.setAttribute('stroke', 'currentColor')
        el.setAttribute('stroke-width', '1.75')
        el.setAttribute('stroke-linecap', 'round')
        el.setAttribute('stroke-linejoin', 'round')
        el.setAttribute('aria-hidden', 'true')
        el.setAttribute('class', 'n-icon')
        // 图标路径是主进程注入的常量，不是远端内容
        el.innerHTML = ICONS[name] || ''
        return el
      }

      // 与客户端更新横幅（#dsh-ub）错开：它可见时公告横幅下移。
      // 直接读它的实际布局，两套注入无需共享状态。
      var ub = document.getElementById('dsh-ub')
      var ubVisible = !!ub && !ub.hidden && ub.offsetHeight > 0
      var top = ubVisible ? ub.offsetHeight : 0

      var hostEl = document.createElement('div')
      hostEl.setAttribute('data-dsh-notice', '')
      hostEl.style.cssText = 'position:fixed;inset:0;z-index:2147482999;display:block;pointer-events:none;'
      var root = hostEl.attachShadow({ mode: 'open' })
      var style = document.createElement('style')
      style.textContent = ${JSON.stringify(NOTICE_BANNER_CSS)}

      var bar = document.createElement('div')
      bar.id = 'dsh-notice-bar'
      bar.style.top = top + 'px'

      NOTICES.forEach(function (n) {
        var item = document.createElement('div')
        item.className = 'n-item'
        item.setAttribute('data-level', n.level)
        item.setAttribute('data-notice-id', n.id)
        item.appendChild(icon(LEVEL_ICON[n.level] || 'info'))

        var text = document.createElement('div')
        text.className = 'n-text'
        var title = document.createElement('div')
        title.className = 'n-title'
        title.textContent = n.title
        var body = document.createElement('div')
        body.className = 'n-body'
        body.textContent = n.body
        text.appendChild(title)
        text.appendChild(body)

        var actions = document.createElement('div')
        actions.className = 'n-actions'
        if (n.link) {
          var link = document.createElement('button')
          link.type = 'button'
          link.className = 'n-btn'
          link.textContent = n.link.label
          link.addEventListener('click', function () {
            // 复用既有 open-external 通道（受 isTrustedSender 守卫 + 协议白名单），
            // 不在这里直接调 shell.openExternal
            if (window.dsh && typeof window.dsh.openExternal === 'function') {
              window.dsh.openExternal(n.link.url)
            }
          })
          actions.appendChild(link)
        }
        if (n.dismissible) {
          var close = document.createElement('button')
          close.type = 'button'
          close.className = 'n-close'
          close.setAttribute('aria-label', '关闭公告')
          close.textContent = '×'
          close.addEventListener('click', function () {
            item.remove()
            if (window.dsh && typeof window.dsh.noticeRead === 'function') {
              window.dsh.noticeRead(n.id)
            }
          })
          actions.appendChild(close)
        }
        item.appendChild(text)
        item.appendChild(actions)
        bar.appendChild(item)
      })

      root.appendChild(style)
      root.appendChild(bar)
      ;(document.body || document.documentElement).appendChild(hostEl)
    })()
  `
}

/**
 * 把当前该展示的横幅公告投影到 DSH 页
 *
 * 与 syncAppUpdateBanner 同一套调用时机（did-finish-load / 主题切换 / 状态变化），
 * 失败一律记日志：公告挂不上只是少看到一条，绝不能因此打断更新或启动流程。
 */
export function syncNoticeBanner(wc: WebContents | null, notices: Notice[]): void {
  if (!wc || wc.isDestroyed()) return
  void wc.executeJavaScript(buildNoticeBannerScript(notices), true).catch((err: Error) => {
    console.warn(`[DSH] 公告横幅注入失败: ${err.message}`)
  })
}
