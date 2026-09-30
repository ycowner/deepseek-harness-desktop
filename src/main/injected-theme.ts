/**
 * 注入式 UI 的共享资产：设计令牌 + 图标集 + 字体栈
 *
 * 覆盖三类注入组件：下载进度横幅、注入式模态框（injected-modal）、自绘对话框
 * （dsh-dialog）。注入代码一律引用 var(--dsh-*) 而非硬编码色值；主题切换时由
 * 主进程的 syncInjectedTheme 更新 :root 上的变量值，新注入的组件在注入时即按
 * 当前主题写入变量，保证首次渲染就拿到正确色板（不依赖"之前是否有人注入过"）。
 *
 * 令牌分组：
 *   --dsh-modal-*  旧实色令牌。**唯一在用的是客户端更新下载进度横幅 #dsh-ub**
 *                  （APP_UPDATE_BANNER_CSS）。模态框已改用 --dsh-dlg-*，别顺手
 *                  玻璃化这一组——横幅是通栏贴顶的，玻璃化并不合适。
 *   --dsh-dlg-*    对话框层与模态框层共用的玻璃令牌。
 *   --dsh-dlg-glass-strong  模态框专用：面积大、装长文档，比对话框降一档模糊
 *                  半径并提高不透明度（见 AGENTS.md §6.7 的性能与可读性取舍）。
 *
 * ICONS / FONT_STACK 放在这里而不是各自的层里，是为了让两层共用同一份图标与
 * 字体，并让 scripts/preview-dialog.js 只加载这一个文件就拿到全部注入式资产。
 */
import type { EffectiveTheme } from './theme-manager'

/** 字体栈：所有注入式 UI 共用 */
export const FONT_STACK =
  "-apple-system, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Microsoft YaHei UI', sans-serif"

/**
 * 页面侧图标（内联 SVG 线性图标，无 emoji）
 *
 * 24×24 viewBox、渲染尺寸 16–18px、stroke 1.75、`stroke: currentColor`，
 * 颜色由 --dsh-dlg-icon-* 按用途决定。刻意不画彩色圆底徽章：层级靠图标形状 +
 * 一处克制的颜色区分即可。
 *
 *   info / question / warning / error → 对话框标题旁，按弹窗 type
 *   notice → 风险类 detail 的警示三角
 *   meta   → 版本信息类 detail 的 tag 标签
 *   bullet → 对话框 message 行的中性提示符
 *   doc    → 模态框头部（更新日志）
 */
export const ICONS: Record<string, string> = {
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.2v5"/><path d="M12 7.8h.01"/>',
  question:
    '<circle cx="12" cy="12" r="9"/><path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.6.3-1 .9-1 1.6v.3"/><path d="M12 16.8h.01"/>',
  warning: '<path d="M12 3.6 21.4 19.4H2.6z"/><path d="M12 9.8v4"/><path d="M12 17h.01"/>',
  error: '<circle cx="12" cy="12" r="9"/><path d="M15 9l-6 6"/><path d="M9 9l6 6"/>',
  // 对话框 message 行：中性横杠提示符，视觉重量刻意低于标题图标
  bullet: '<path d="M5 12h9"/><path d="M17.5 12h.01"/>',
  // 风险类 detail：复用警示三角
  notice: '<path d="M12 3.6 21.4 19.4H2.6z"/><path d="M12 9.8v4"/><path d="M12 17h.01"/>',
  // 版本信息类 detail：tag 标签
  meta:
    '<path d="M3.5 11.2V4.8a1.3 1.3 0 0 1 1.3-1.3h6.4a1.3 1.3 0 0 1 .92.38l8.2 8.2a1.3 1.3 0 0 1 0 1.84l-6.4 6.4a1.3 1.3 0 0 1-1.84 0l-8.2-8.2a1.3 1.3 0 0 1-.38-.92z"/><path d="M7.8 7.8h.01"/>',
  // 模态框头部（更新日志）：文档轮廓 + 两条横线
  doc:
    '<path d="M6.5 3.5h7L18 8v12.5H6.5z"/><path d="M13.5 3.5V8H18"/><path d="M9.2 12.5h5.6"/><path d="M9.2 16h5.6"/>'
}

export const INJECTED_THEME_VARS: Record<EffectiveTheme, Record<string, string>> = {
  light: {
    '--dsh-modal-bg': '#ffffff',
    '--dsh-modal-text': '#374151',
    '--dsh-modal-heading': '#111827',
    '--dsh-modal-subtext': '#374151',
    '--dsh-modal-muted': '#6b7280',
    '--dsh-modal-border': '#e5e7eb',
    '--dsh-modal-hover': '#f3f4f6',
    '--dsh-modal-code-bg': '#f3f4f6',
    '--dsh-modal-link': '#2563eb',
    '--dsh-banner-btn-bg': '#ffffff',
    // 下载进度横幅的强调色，与标题栏「更新」按钮同系（天蓝）
    '--dsh-accent': '#0369a1',

    // ── 对话框 ──
    // 磨砂玻璃配方：半透明底 + 背后 blur(20px) + saturate(180%)。
    // 透明度是按「文字对比度不塌」反推的，不是随手取的：
    // 0.72 白叠在 0.35 深色遮罩上，合成后的实际底色约 #f0f0f2，
    // muted 必须用 #5b6570（5.2:1）才够 4.5:1 小字门槛——沿用实心卡片时代的
    // #6b7280 会在玻璃上掉到 4.3:1，detail 文字（12.5px）就不达标了。
    '--dsh-dlg-glass': 'rgba(255, 255, 255, 0.72)',
    // 模态框专用：面积大、装长文档，模糊更小 + 更实
    '--dsh-dlg-glass-strong': 'rgba(255, 255, 255, 0.82)',
    '--dsh-dlg-glass-border': 'rgba(255, 255, 255, 0.85)',
    '--dsh-dlg-highlight': 'rgba(255, 255, 255, 0.9)',
    '--dsh-dlg-fg': '#111827',
    '--dsh-dlg-body': '#374151',
    '--dsh-dlg-muted': '#5b6570',
    // 分隔线与 hover 一律用半透明，实体色贴在玻璃上会像一块补丁
    '--dsh-dlg-hairline': 'rgba(17, 24, 39, 0.08)',
    '--dsh-dlg-hover': 'rgba(17, 24, 39, 0.06)',
    '--dsh-dlg-btn-surface': 'rgba(255, 255, 255, 0.55)',
    '--dsh-dlg-btn-surface-hover': 'rgba(255, 255, 255, 0.9)',
    // 风险类 detail 提示条：琥珀竖条 + 极淡琥珀底。
    // 0.08 透明度叠在玻璃合成底色 #f0f0f2 上约得 #eee6df，
    // 正文色 #374151 对它是 8.15:1，远高于门槛
    '--dsh-dlg-notice-bar': 'rgba(180, 83, 9, 0.55)',
    '--dsh-dlg-notice-bg': 'rgba(217, 119, 6, 0.08)',
    // 版本信息类 detail 底：只用 0.04 透明度。再深一点会把 muted 压到
    // 4.5:1 门槛以下（实测 0.05 时为 4.68:1，余量太小）
    '--dsh-dlg-meta-bg': 'rgba(17, 24, 39, 0.04)',
    // 模态框正文的代码/行内代码底色
    '--dsh-dlg-code-bg': 'rgba(17, 24, 39, 0.06)',
    // 模态框正文里的链接（更新日志正文几乎没有链接，保留以防将来）
    '--dsh-dlg-link': '#0369a1',
    // 主按钮与强调色同源，天蓝填充 + 白字
    '--dsh-dlg-primary-bg': '#0369a1',
    '--dsh-dlg-primary-fg': '#ffffff',
    '--dsh-dlg-primary-hover': '#075985',
    '--dsh-dlg-ring': 'rgba(3, 105, 161, 0.28)',
    '--dsh-dlg-backdrop': 'rgba(17, 24, 39, 0.35)',
    // 外阴影托住卡片（脱离页面平面）；顶部受光由 inset 高光单独负责
    '--dsh-dlg-shadow': '0 32px 64px -16px rgba(16, 24, 40, 0.34), 0 8px 16px -8px rgba(16, 24, 40, 0.16)',
    '--dsh-dlg-icon-info': '#0369a1',
    '--dsh-dlg-icon-warning': '#b45309',
    '--dsh-dlg-icon-error': '#b42318'
  },
  dark: {
    '--dsh-modal-bg': '#1f2937',
    '--dsh-modal-text': '#d1d5db',
    '--dsh-modal-heading': '#f9fafb',
    '--dsh-modal-subtext': '#d1d5db',
    '--dsh-modal-muted': '#9ca3af',
    '--dsh-modal-border': '#374151',
    '--dsh-modal-hover': '#374151',
    '--dsh-modal-code-bg': '#111827',
    '--dsh-modal-link': '#60a5fa',
    '--dsh-banner-btn-bg': '#ffffff',
    // 深色下用更亮的同系色，保证在深底上仍达 4.5:1
    '--dsh-accent': '#7dd3fc',

    // ── 对话框 ──
    // 深色主题同样玻璃化：玻璃在深底上的通透感比浅色更明显。
    // 表面色与既有模态框（--dsh-modal-bg）保持同色，保证同一套 UI
    '--dsh-dlg-glass': 'rgba(31, 41, 55, 0.72)',
    // 模态框专用：面积大、装长文档，模糊更小 + 更实
    '--dsh-dlg-glass-strong': 'rgba(31, 41, 55, 0.82)',
    '--dsh-dlg-glass-border': 'rgba(255, 255, 255, 0.14)',
    '--dsh-dlg-highlight': 'rgba(255, 255, 255, 0.1)',
    '--dsh-dlg-fg': '#f9fafb',
    '--dsh-dlg-body': '#d1d5db',
    '--dsh-dlg-muted': '#9ca3af',
    '--dsh-dlg-hairline': 'rgba(255, 255, 255, 0.1)',
    '--dsh-dlg-hover': 'rgba(255, 255, 255, 0.08)',
    '--dsh-dlg-btn-surface': 'rgba(255, 255, 255, 0.08)',
    '--dsh-dlg-btn-surface-hover': 'rgba(255, 255, 255, 0.16)',
    // 风险类 detail 提示条（深色下正文色 #d1d5db 对合成底色约 9:1）
    '--dsh-dlg-notice-bar': 'rgba(251, 191, 36, 0.55)',
    '--dsh-dlg-notice-bg': 'rgba(251, 191, 36, 0.1)',
    // 版本信息类 detail 底（muted #9ca3af 对合成底色约 5.4:1）
    '--dsh-dlg-meta-bg': 'rgba(255, 255, 255, 0.06)',
    // 模态框正文的代码/行内代码底色
    '--dsh-dlg-code-bg': 'rgba(0, 0, 0, 0.28)',
    // 模态框正文里的链接
    '--dsh-dlg-link': '#7dd3fc',
    // 深色下强调色本身够亮，反过来做填充 + 深色文字
    '--dsh-dlg-primary-bg': '#7dd3fc',
    '--dsh-dlg-primary-fg': '#0b1220',
    '--dsh-dlg-primary-hover': '#bae6fd',
    '--dsh-dlg-ring': 'rgba(125, 211, 252, 0.35)',
    '--dsh-dlg-backdrop': 'rgba(0, 0, 0, 0.5)',
    '--dsh-dlg-shadow': '0 32px 64px -16px rgba(0, 0, 0, 0.7), 0 8px 16px -8px rgba(0, 0, 0, 0.45)',
    '--dsh-dlg-icon-info': '#7dd3fc',
    '--dsh-dlg-icon-warning': '#fbbf24',
    '--dsh-dlg-icon-error': '#f87171'
  }
}
