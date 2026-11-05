/**
 * 生成自绘对话框的样式预览页（node scripts/preview-dialog.js）
 *
 * 用途：改 `dsh-dialog.ts` 的样式后想立刻看效果，不必去凑一次真实的 DSH
 * 运行包更新来触发弹窗。产物 docs/dialog-preview.html 直接双击打开即可。
 *
 * 关键点：样式（DIALOG_CSS）、图标、DOM 结构全部**从 src/main/dsh-dialog.ts
 * 现场抽取**，不是另画的静态图——预览看到的就是生产那一份，不会漂移。
 * 更重要的是：spec 走**真实的 buildDialogSpec()** 推导 defaultId / cancelId /
 * primaryId。此前预览页的 spec 手写 variant 字段、完全绕过推导，导致
 * pickIndex 的上界 bug（退出确认回车即退出、主按钮画错）在预览里毫无痕迹。
 * 抽取方式是用项目自带的 esbuild 把 TS 转成 CJS 后在沙箱里跑（require 打桩），
 * 比手写正则剥类型可靠。
 */
const fs = require('fs')
const path = require('path')
const esbuild = require('esbuild')

const root = path.resolve(__dirname, '..')

function loadTs(file, stubs) {
  const src = fs.readFileSync(path.join(root, file), 'utf8')
  const code = esbuild.transformSync(src, { loader: 'ts', format: 'cjs', target: 'es2022' }).code
  const mod = { exports: {} }
  const req = (id) => {
    if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id]
    throw new Error(`unexpected require("${id}") in ${file}`)
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports)
  return mod.exports
}

const theme = loadTs('src/main/injected-theme.ts', { './theme-manager': {} })
// 面板模块必须先加载：dsh-dialog.ts 会 import 它，两者是同一份生产代码
const panel = loadTs('src/main/update-panel.ts', {
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme
})
const dialog = loadTs('src/main/dsh-dialog.ts', {
  electron: {},
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme,
  './update-panel': panel
})
const modal = loadTs('src/main/injected-modal.ts', {
  electron: {},
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme
})

const hostScript = dialog.buildHostScript()
const buildDialogSpec = dialog.buildDialogSpec
const buildUpdatePanelSpec = panel.buildUpdatePanelSpec

// 预览用的应用图标占位（真机走 nativeImage 读 build/icon.ico 转 data URL）。
// 这里只需要一个 1:1 的方形图来验版式，真实图标由 .picon 的 object-fit 裁切。
const PREVIEW_ICON = 'data:image/svg+xml;utf8,' + encodeURIComponent(
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">' +
  '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">' +
  '<stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#4d6bfe"/>' +
  '</linearGradient></defs>' +
  '<rect width="64" height="64" rx="14" fill="url(#g)"/>' +
  '<path d="M17 41c9 7 23 7 30-2-4 11-25 13-30 2z" fill="#ffffff" opacity=".92"/>' +
  '<circle cx="25" cy="28" r="3" fill="#ffffff" opacity=".92"/>' +
  '</svg>'
)

// 与 index.ts 的调用点一一对应。**只写声明式字段**（buttons / defaultId /
// cancelId / primaryId / detailTone），variant 与按钮尺寸全部由生产代码推导。
const CASES = {
  sample: {
    label: '样板：更新运行包（风险类 detail）',
    options: {
      type: 'question',
      title: '更新 DSH 运行包',
      message: 'DSH 运行包有更新 v0.1.7-rc.2 → v0.2.0-rc.2',
      detail: '更新过程中 DSH 服务会停止，下载并安装新运行包后自动重启。当前进行中的会话会中断。',
      detailTone: 'notice',
      buttons: ['确定更新', '取消'],
      defaultId: 1,
      cancelId: 1,
      primaryId: 0
    }
  },
  meta: {
    label: '版本信息类 detail',
    options: {
      type: 'info',
      title: '发现新版本',
      message: 'DSH 运行包有新版本可用',
      detail: '当前版本: v0.1.7-rc.2\n最新版本: v0.2.0-rc.2\n\n顶部蓝色横幅已显示，点击横幅中的「更新 DSH」即可执行更新。',
      buttons: ['确定'],
      defaultId: 0
    }
  },
  failed: {
    label: '确认：更新失败（3 按钮）',
    options: {
      type: 'warning',
      title: '更新未完成',
      message: 'DSH Desktop 客户端更新包下载失败',
      detail: '连接被重置\n\n可重试下载；若源站持续不可用，也可用浏览器直接下载安装包自行安装。',
      detailTone: 'notice',
      buttons: ['重试下载', '浏览器下载', '取消'],
      defaultId: 0,
      cancelId: 2
    }
  },
  picker: {
    label: '选择：检查更新（4 按钮同行）',
    options: {
      type: 'question',
      title: '检查更新',
      message: '请选择要检查的项目',
      buttons: ['全部检查', '检查DSH运行包', '检查客户端', '取消'],
      defaultId: 0,
      cancelId: 3,
      primaryId: 0
    }
  },
  // 回归守卫：defaultId=1 + cancelId=1 曾经被 pickIndex 悄悄降级成 0，
  // 导致「回车直接退出应用」。这里保留一个专门的样例盯着它。
  quit: {
    label: '回归：退出确认（焦点必须在取消）',
    options: {
      type: 'question',
      title: '退出确认',
      message: '确定要退出 DSH Desktop 吗？',
      buttons: ['退出', '取消'],
      defaultId: 1,
      cancelId: 1,
      primaryId: 0
    }
  }
}

// 派生正确性自检：这些断言全绿，才说明 pickIndex / primaryId 推导没退化
const assertDerivation = () => {
  const s = buildDialogSpec(CASES.sample.options)
  if (s.defaultId !== 1) throw new Error(`sample defaultId 应为 1，实际 ${s.defaultId}`)
  if (s.buttons[0].variant !== 'lead') throw new Error('sample 主按钮应为 lead')
  if (s.buttons[1].variant !== 'ghost') throw new Error('sample 取消应为 ghost')

  const q = buildDialogSpec(CASES.quit.options)
  if (q.defaultId !== 1) throw new Error(`quit defaultId 应为 1（焦点在取消），实际 ${q.defaultId}`)
  if (q.buttons[0].variant !== 'lead') throw new Error('quit 主按钮应为「退出」')

  const p = buildDialogSpec(CASES.picker.options)
  if (p.buttons[0].variant !== 'lead') throw new Error('picker 「全部检查」应为 lead')
  if (p.buttons[1].variant !== 'minor' || p.buttons[2].variant !== 'minor') {
    throw new Error('picker 两个次级检查项应为 minor')
  }
  if (p.buttons[3].variant !== 'ghost') throw new Error('picker 「取消」应为 ghost')
  if (!p.tight) throw new Error('picker 应切紧凑排布（tight）')

  const f = buildDialogSpec(CASES.failed.options)
  if (f.detailTone !== 'notice') throw new Error('failed detailTone 应为 notice')

  const m = buildDialogSpec(CASES.meta.options)
  if (m.detailTone !== 'meta') throw new Error('meta detailTone 缺省应为 meta')

  return '派生自检通过：5 个用例 × defaultId/primaryId/detailTone/tight'
}

const derivationReport = assertDerivation()

// ── 面板用例 ────────────────────────────────────────────────────────────────
//
// 面板的按钮布局与键盘语义（defaultId / cancelId）全部引用 update-panel.ts 里的
// **真实预设**，与 index.ts 的调用点同源——预览补的只有「这一屏显示什么文案」。
//
// 面板 spec 走真实的 buildUpdatePanelSpec()，与对话框 spec 走真实的
// buildDialogSpec() 是同一条原则（AGENTS.md §12.1 #41）：预览必须驱动真实推导，
// 否则按钮下标推导一旦退化，预览里完全看不出来。
const PANEL_CASES = {
  panel: {
    label: '面板：客户端发现新版本（图标 + 日期 + 复选框）',
    options: {
      title: '发现新版本',
      version: 'v1.0.20',
      appIcon: PREVIEW_ICON,
      releaseDate: '2026-10-13T15:41:28.667Z',
      message: '当前版本 v1.0.19',
      detail: '点击「下载更新」开始下载，下载期间 DSH 页面顶部会显示进度。',
      checkbox: { label: '以后自动下载并安装更新', checked: false },
      buttons: panel.PANEL_CLIENT_AVAILABLE.buttons,
      defaultId: panel.PANEL_CLIENT_AVAILABLE.defaultId,
      cancelId: panel.PANEL_CLIENT_AVAILABLE.cancelId
    }
  },
  'panel-runtime': {
    label: '面板：DSH 运行包发现新版本（无图标 / 无日期 / 无复选框）',
    options: {
      title: '发现新版本',
      version: 'v0.2.0-rc.2',
      message: 'DSH 运行包当前版本 v0.1.7-rc.2',
      detail: '更新过程中 DSH 服务会停止，下载并安装新运行包后自动重启。当前进行中的会话会中断。',
      detailTone: 'notice',
      buttons: panel.PANEL_DSH_AVAILABLE.buttons,
      defaultId: panel.PANEL_DSH_AVAILABLE.defaultId,
      cancelId: panel.PANEL_DSH_AVAILABLE.cancelId
    }
  },
  'panel-downloading': {
    label: '面板：客户端下载中',
    options: {
      title: '正在下载更新包',
      version: 'v1.0.20',
      appIcon: PREVIEW_ICON,
      message: 'DSH Desktop 客户端更新包下载中（63%）',
      detail: '取消后已下载的部分会被删除，下次点「更新」将从头开始。',
      detailTone: 'notice',
      buttons: panel.PANEL_CLIENT_DOWNLOADING.buttons,
      defaultId: panel.PANEL_CLIENT_DOWNLOADING.defaultId,
      cancelId: panel.PANEL_CLIENT_DOWNLOADING.cancelId
    }
  },
  'panel-downloaded': {
    label: '面板：客户端已下载完成',
    options: {
      title: '更新已就绪',
      version: 'v1.0.20',
      appIcon: PREVIEW_ICON,
      message: '当前版本 v1.0.19',
      detail: '可立即重启安装，也可等下次退出 DSH Desktop 时静默安装。\n安装时 Windows 会请求管理员授权（UAC）。',
      buttons: panel.PANEL_CLIENT_DOWNLOADED.buttons,
      defaultId: panel.PANEL_CLIENT_DOWNLOADED.defaultId,
      cancelId: panel.PANEL_CLIENT_DOWNLOADED.cancelId
    }
  },
  'panel-error': {
    label: '面板：客户端下载失败',
    options: {
      title: '更新未完成',
      version: 'v1.0.20',
      appIcon: PREVIEW_ICON,
      message: 'DSH Desktop 客户端更新包下载失败',
      detail: '连接被重置\n\n可重试下载；若源站持续不可用，也可用浏览器直接下载安装包自行安装。',
      detailTone: 'notice',
      buttons: panel.PANEL_CLIENT_ERROR.buttons,
      defaultId: panel.PANEL_CLIENT_ERROR.defaultId,
      cancelId: panel.PANEL_CLIENT_ERROR.cancelId
    }
  },
  'panel-picker': {
    label: '面板：检查更新（四项选择）',
    options: {
      title: '检查更新',
      message: '请选择要检查的项目',
      buttons: panel.PANEL_CHECK_PICKER.buttons,
      defaultId: panel.PANEL_CHECK_PICKER.defaultId,
      cancelId: panel.PANEL_CHECK_PICKER.cancelId
    }
  }
}

/**
 * 面板 spec 自检：断言跑在**真实的 buildUpdatePanelSpec()** 上
 *
 * 断言的是「产品决策」而不是实现细节：按钮顺序、谁是主按钮、回车落点、
 * Esc 落点、以及运行包面板与客户端面板的形态差异（无图标/无日期/无复选框）。
 * 这几项一旦被改错，用户侧就是「回车直接跳过一次打断会话的更新」。
 */
const assertUpdatePanelSpec = () => {
  const client = buildUpdatePanelSpec(PANEL_CASES.panel.options, 1)
  const labels = client.buttons.map((b) => b.label)
  if (labels.join('|') !== '跳过此版本|稍后|下载更新') {
    throw new Error(`面板按钮顺序应为 跳过此版本|稍后|下载更新，实际 ${labels.join('|')}`)
  }
  if (client.buttons[0].align !== 'left') throw new Error('「跳过此版本」应在左组')
  if (client.buttons[1].align !== 'right' || client.buttons[2].align !== 'right') {
    throw new Error('「稍后」「下载更新」应在右组')
  }
  if (client.buttons[2].variant !== 'lead') throw new Error('「下载更新」应是主按钮（lead）')
  if (client.buttons[0].variant !== 'ghost') throw new Error('「跳过此版本」应是 ghost')
  if (client.defaultId !== 2) throw new Error(`面板 defaultId 应指向「下载更新」(2)，实际 ${client.defaultId}`)
  if (client.cancelId !== 1) throw new Error(`面板 cancelId 应指向「稍后」(1)，实际 ${client.cancelId}`)
  if (!client.checkbox) throw new Error('客户端面板应带复选框')
  if (client.checkbox.checked !== false) throw new Error('复选框初始勾选态应取入参')
  if (client.releaseDate !== '2026年10月13日') {
    throw new Error(`面板日期格式化错误：${client.releaseDate}`)
  }
  if (client.kind !== 'panel') throw new Error('面板 spec 的 kind 应为 panel')

  const runtime = buildUpdatePanelSpec(PANEL_CASES['panel-runtime'].options, 2)
  if (runtime.checkbox) throw new Error('DSH 运行包面板不应有复选框')
  if (runtime.releaseDate !== '') throw new Error('DSH 运行包面板不应有日期行')
  if (runtime.appIcon !== '') throw new Error('DSH 运行包面板不应有应用图标')
  if (runtime.defaultId !== 1 || runtime.cancelId !== 1) {
    throw new Error(`运行包面板 defaultId/cancelId 都应指向「稍后」(1)，实际 ${runtime.defaultId}/${runtime.cancelId}`)
  }

  // 下载中：回车与 Esc 都必须落在「继续下载」，否则会丢掉已下的 251MB
  const downloading = buildUpdatePanelSpec(PANEL_CASES['panel-downloading'].options, 3)
  if (downloading.buttons[0].label !== '取消下载' || downloading.buttons[0].variant !== 'ghost') {
    throw new Error('下载中面板的「取消下载」应是左组 ghost')
  }
  if (downloading.defaultId !== 1 || downloading.cancelId !== 1) {
    throw new Error(`下载中面板 defaultId/cancelId 都应指向「继续下载」(1)，实际 ${downloading.defaultId}/${downloading.cancelId}`)
  }

  // 下载完成：回车落在「立即重启安装」，Esc 落在「取消」
  const downloaded = buildUpdatePanelSpec(PANEL_CASES['panel-downloaded'].options, 4)
  if (downloaded.buttons[downloaded.defaultId].label !== '立即重启安装') {
    throw new Error('下载完成面板的 defaultId 应指向「立即重启安装」')
  }
  if (downloaded.buttons[downloaded.cancelId].label !== '取消') {
    throw new Error('下载完成面板的 cancelId 应指向「取消」')
  }

  // 失败态：回车落在「重试下载」
  const error = buildUpdatePanelSpec(PANEL_CASES['panel-error'].options, 5)
  if (error.buttons[error.defaultId].label !== '重试下载') {
    throw new Error('失败面板的 defaultId 应指向「重试下载」')
  }

  // 四项选择：回车落在「全部检查」，Esc 落在「取消」
  const picker = buildUpdatePanelSpec(PANEL_CASES['panel-picker'].options, 6)
  if (picker.buttons[picker.defaultId].label !== '全部检查') {
    throw new Error('选择面板的 defaultId 应指向「全部检查」')
  }
  if (picker.buttons[picker.cancelId].label !== '取消') {
    throw new Error('选择面板的 cancelId 应指向「取消」')
  }

  // 日期格式化：非法输入返回 null（整行不渲染），不编造日期
  if (panel.formatReleaseDate('2026-10-13T15:41:28.667Z') !== '2026年10月13日') {
    throw new Error('formatReleaseDate 应输出「2026年10月13日」')
  }
  if (panel.formatReleaseDate('not-a-date') !== null) throw new Error('非法日期应返回 null')
  if (panel.formatReleaseDate(null) !== null) throw new Error('null 日期应返回 null')

  return '面板 spec 自检通过：6 个面板 × 按钮顺序/分组/变体/defaultId/cancelId/复选框/日期'
}

/**
 * 面板结构自检
 *
 * 与模态框结构自检同一性质：把「必须这么写」变成生成期的硬断言。
 * ① card 必须在 backdrop 内部（AGENTS.md §12.1 #43，同一个坑在两层各踩过一次）；
 * ② 面板与旧对话框共用同一个宿主入口 __dshDialogHost.open()，靠 spec.kind 分流；
 * ③ 复选框勾选态必须随回传 payload 一起回主进程；
 * ④ 图标走 data URL，页面 CSP 可能拦下，必须有 onerror 兜底（否则标题左侧留个空坑）。
 */
const assertUpdatePanelStructure = () => {
  const s = hostScript
  if (!/__dshDialogHost\s*=/.test(s)) throw new Error('面板结构回归：缺少 __dshDialogHost 对外入口')
  if (!/spec\.kind\s*===\s*'panel'/.test(s)) throw new Error("面板结构回归：宿主脚本未按 spec.kind === 'panel' 分流")
  if (!/buildPanelCard/.test(s)) throw new Error('面板结构回归：宿主脚本未调用 buildPanelCard')
  if (!/backdrop\.appendChild\(built\.card\)/.test(s)) {
    throw new Error('面板结构回归：面板 card 必须挂在 backdrop 内部（否则不居中且被遮罩糊住）')
  }
  if (/root\.appendChild\(card\)/.test(s)) {
    throw new Error('面板结构回归：面板 card 不应与 backdrop 平级')
  }
  if (!/checked:\s*!!panelState\.checked/.test(s)) {
    throw new Error('面板结构回归：复选框勾选态必须随 payload 回传主进程')
  }
  if (!/addEventListener\('error'/.test(s)) {
    throw new Error('面板结构回归：图标必须有 onerror 兜底（data URL 被 CSP 拦下时会留空坑）')
  }
  if (!/initialFocus\s*=\s*built\.buttons\[spec\.defaultId\]/.test(s)) {
    throw new Error('面板结构回归：初始焦点必须落在 defaultId 指定的按钮上')
  }
  // 面板样式：底部左右分组 + 复选框 + 卡片宽度
  const css = panel.UPDATE_PANEL_CSS
  if (!/\.pfoot\s*\{[^}]*justify-content:\s*space-between/.test(css)) {
    throw new Error('面板样式回归：.pfoot 必须左右分组（space-between）')
  }
  if (!/\.pfoot-block\s*\{[^}]*justify-content:\s*space-between/.test(css)) {
    throw new Error('面板样式回归：block 行按钮必须间距均分（space-between）')
  }
  if (!/pfoot-block/.test(s)) {
    throw new Error('面板结构回归：block 按钮必须渲染到 .pfoot-block 独立行')
  }
  // 「检查更新」四个按钮装不进 480px：三个检查项走上排独立行，取消留在底栏右侧
  const pickerPreset = panel.PANEL_CHECK_PICKER
  if (pickerPreset.buttons.filter((b) => b.block).length !== 3) {
    throw new Error('面板预设回归：检查更新应有三个 block 按钮（检查项同排）')
  }
  if (pickerPreset.buttons[pickerPreset.cancelId].block ||
      pickerPreset.buttons[pickerPreset.cancelId].align !== 'right') {
    throw new Error('面板预设回归：「取消」必须留在底栏右侧，不参与 block 行')
  }
  if (pickerPreset.buttons[pickerPreset.defaultId].label !== '全部检查' ||
      pickerPreset.buttons[pickerPreset.cancelId].label !== '取消') {
    throw new Error('面板预设回归：检查更新的 defaultId / cancelId 必须仍指向「全部检查」/「取消」')
  }
  if (!/\.pcheck\b/.test(css)) throw new Error('面板样式回归：缺少复选框样式 .pcheck')
  if (!/width:\s*min\(480px/.test(css)) throw new Error('面板样式回归：卡片宽度应为 min(480px, 100%)')
  return '面板结构自检通过：宿主分流 / append 层级 / block 行 / 勾选态回传 / 图标兜底 / 初始焦点 / 样式骨架'
}

const panelSpecReport = assertUpdatePanelSpec()
const panelStructureReport = assertUpdatePanelStructure()

/**
 * 模态框结构自检 —— 上一轮的真机回归就是死在这一条上。
 *
 * 当时 card 被挂到了 root（与 backdrop 平级）而不是 backdrop 内部，症状是
 * 「卡片顶到左上角 + 被带 z-index 的模糊遮罩糊住」，而这个层既不在 dsh-dialog.ts
 * 里、也没有任何预览，所以只能在真机上发现。现在它和对话框层一样能被预览加载，
 * 于是把「必须这么写」变成生成期的硬断言：任一条不过直接抛错、中止生成。
 */
const assertModalStructure = () => {
  const s = modal.buildModalHostScript('info', 'T', '<p>B</p>')
  if (!/backdrop\.appendChild\(\s*card\s*\)/.test(s)) {
    throw new Error('模态框结构回归：card 必须挂在 backdrop 内部（否则不居中且被遮罩糊住）')
  }
  if (/root\.appendChild\(\s*card\s*\)/.test(s)) {
    throw new Error('模态框结构回归：card 不应与 backdrop 平级')
  }
  if (!/root\.getElementById\(/.test(s)) {
    throw new Error('模态框结构回归：锚点滚动必须用 root.getElementById（目标在 shadow 树内）')
  }
  if (!/window\.__dshModal\s*=/.test(s)) {
    throw new Error('模态框结构回归：缺少 window.__dshModal 对外入口（updateModalBody 依赖它）')
  }
  if (!/buildModalUpdateScript|__dshModal\.update/.test(modal.buildModalUpdateScript('<p>X</p>'))) {
    throw new Error('模态框结构回归：正文替换必须走 __dshModal.update')
  }
  // 卡片玻璃走令牌（模态框比对话框弱一档，见 AGENTS.md §6.7）。
  // 不能写字面量 blur(12px)：深色下 --dsh-dlg-blur-strong 会被置为 none。
  if (
    !/var\(--dsh-dlg-blur-strong\)/.test(modal.MODAL_CSS) ||
    !/var\(--dsh-dlg-glass-strong\)/.test(modal.MODAL_CSS)
  ) {
    throw new Error('模态框玻璃参数回归：应为 var(--dsh-dlg-blur-strong) + --dsh-dlg-glass-strong')
  }
  return '模态框结构自检通过：append 层级 / 锚点查询 / 对外入口 / 正文替换 / 玻璃参数'
}

const modalReport = assertModalStructure()

/**
 * 参考图样式回归自检
 *
 * 用户要求全部拟态浮层按参考图统一：卡片 16px 圆角、按钮三档同高同圆角
 * 全部实底、深色卡片不透明纯黑（模糊用令牌关闭，而不是删掉 backdrop-filter
 * 那一行，删了浅色就没玻璃了）。
 *
 * 这些是跨文件的成组约束，单看某一个文件改没改很容易漏（例如只改卡片圆角
 * 忘了按钮高度），所以在这里对**抽取出来的真实 CSS**做硬断言，任一条不过
 * 直接抛错中止生成。
 */
const assertReferenceStyling = () => {
  const dlg = dialog.DIALOG_CSS

  // 卡片：圆角 16px + 卡片级模糊走令牌
  if (!/\.card\s*\{[^}]*border-radius:\s*16px/.test(dlg)) {
    throw new Error('参考图样式回归：对话框卡片圆角应为 16px')
  }
  if (!/\.card\s*\{[^}]*backdrop-filter:\s*var\(--dsh-dlg-blur\)/.test(dlg)) {
    throw new Error('参考图样式回归：对话框卡片模糊应走 var(--dsh-dlg-blur)（深色置 none）')
  }

  // 按钮：三档同高同圆角，各自只负责填充色
  if (!/\.btn\s*\{[^}]*height:\s*34px/.test(dlg) || !/\.btn\s*\{[^}]*border-radius:\s*10px/.test(dlg)) {
    throw new Error('参考图样式回归：.btn 基础尺寸应为 height: 34px + border-radius: 10px')
  }
  if (!/\.btn--lead\s*\{[^}]*var\(--dsh-dlg-primary-bg\)/.test(dlg)) {
    throw new Error('参考图样式回归：.btn--lead 必须用主按钮令牌填充')
  }
  if (!/\.btn--ghost\s*\{[^}]*var\(--dsh-dlg-btn-surface\)/.test(dlg)) {
    throw new Error('参考图样式回归：.btn--ghost 必须改为实底（--dsh-dlg-btn-surface）')
  }
  if (!/\.btn--minor[^{]*\{[^}]*var\(--dsh-dlg-btn-surface\)/.test(dlg)) {
    throw new Error('参考图样式回归：.btn--minor 必须用实底（--dsh-dlg-btn-surface）')
  }
  // 次级/取消不再有独立描边（描边只在 .btn 基础样式里留 transparent 占位，
  // 防止 hover 时尺寸跳动）
  if (/\.btn--(?:minor|ghost)[^{]*\{[^}]*border-color:/.test(dlg)) {
    throw new Error('参考图样式回归：次级/取消按钮不应再有独立描边')
  }

  // 更新面板：与对话框同一档圆角与模糊
  const pn = panel.UPDATE_PANEL_CSS
  if (!/\.pcard\s*\{[^}]*border-radius:\s*16px/.test(pn)) {
    throw new Error('参考图样式回归：更新面板卡片圆角应为 16px')
  }
  if (!/\.pcard\s*\{[^}]*backdrop-filter:\s*var\(--dsh-dlg-blur\)/.test(pn)) {
    throw new Error('参考图样式回归：更新面板卡片模糊应走 var(--dsh-dlg-blur)')
  }

  // 令牌：深色 #202020 实心 + 去高光 + 关闭模糊 + 白底主按钮；浅色主按钮反转
  const dark = theme.INJECTED_THEME_VARS.dark
  const light = theme.INJECTED_THEME_VARS.light
  const eq = (actual, expected, what) => {
    if (actual !== expected) {
      throw new Error(`参考图令牌回归：${what} 应为 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`)
    }
  }
  eq(dark['--dsh-dlg-glass'], '#202020', '深色卡片底色')
  eq(dark['--dsh-dlg-glass-strong'], '#202020', '深色模态框/公告条底色')
  eq(dark['--dsh-dlg-highlight'], 'transparent', '深色内高光（应去掉）')
  eq(dark['--dsh-dlg-blur'], 'none', '深色卡片模糊（应关闭）')
  eq(dark['--dsh-dlg-blur-strong'], 'none', '深色模态框模糊（应关闭）')
  eq(dark['--dsh-dlg-blur-tooltip'], 'none', '深色 tooltip 模糊（应关闭）')
  eq(dark['--dsh-dlg-primary-bg'], '#ffffff', '深色主按钮底（白底）')
  eq(dark['--dsh-dlg-primary-fg'], '#0b1220', '深色主按钮字（深字）')
  eq(dark['--dsh-modal-bg'], '#000000', '#dsh-ub 深色底（纯黑）')
  // 黑底上再叠黑色透明层等于隐形：代码块与面板图标占位底必须翻成白色层
  if (!/^rgba\(255,\s*255,\s*255,[^)]+\)$/.test(dark['--dsh-dlg-code-bg'])) {
    throw new Error('参考图令牌回归：深色 --dsh-dlg-code-bg 必须为白色透明层（黑底上看不见黑色层）')
  }

  eq(light['--dsh-dlg-primary-bg'], '#111827', '浅色主按钮底（黑底白字反转）')
  eq(light['--dsh-dlg-btn-surface'], 'rgba(17, 24, 39, 0.06)', '浅色次级/取消实底')
  if (!/^rgba\(255,\s*255,\s*255,\s*0?\.\d+\)$/.test(light['--dsh-dlg-glass'])) {
    throw new Error('参考图令牌回归：浅色卡片仍应是半透明白（保留磨砂玻璃）')
  }
  return '参考图样式自检通过：卡片 16px / 按钮 34px+10px 三档实底 / 深色 #202020+无模糊 / 主按钮反色'
}

const referenceReport = assertReferenceStyling()

// ── 模态框样例 ────────────────────────────────────────────────────────────────
// 注入代码由**真实的 buildModalHostScript / buildModalUpdateScript** 生成，
// 与真机走的是同一段代码；正文是手写的代表性 markdown（这次要验的是 CSS，
// 不是 renderMarkdownToHtml 本身）。
const ABOUT_BODY = `
  <div style="display:flex;flex-direction:column;gap:10px;min-width:320px">
    <div style="font-size:16px;font-weight:600;color:var(--dsh-dlg-fg)">DSH Desktop</div>
    <div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
      <div><span style="color:var(--dsh-dlg-muted)">客户端版本：</span><strong>v1.0.17</strong></div>
      <div><span style="color:var(--dsh-dlg-muted)">DSH 运行包版本：</span><strong>v0.1.7-rc.2</strong></div>
      <div><span style="color:var(--dsh-dlg-muted)">内置 Node 运行时：</span><strong>v24.21.0（ABI 137）</strong></div>
    </div>
    <div style="margin-top:6px">
      <button class="about-repo" style="display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:10px;background:var(--dsh-dlg-primary-bg);color:var(--dsh-dlg-primary-fg);border:1px solid transparent;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;">GitHub 仓库</button>
    </div>
  </div>
`

const CHANGELOG_BODY = `
  <div class="log-entry">
    <div class="log-head"><span class="log-ver">v0.2.0-rc.2</span><span class="log-date">2026-09-29</span></div>
    <p><a href="#cn">中文</a> | <a href="#en">English</a></p>
    <h3 id="cn">新增功能</h3>
    <ul>
      <li>桌面端可在菜单栏管理和安装 <code>dsh</code> 命令，支持理插件，无需另装 Node 或 pnpm。</li>
      <li>修复新建终端菜单重复出现同名 shell 的问题。</li>
    </ul>
    <h4>问题修复</h4>
    <ul>
      <li>修复设置页关闭「显示代码工作视图」后无法调整 Agent 预设的限制。</li>
      <li>修复持久 PowerShell 在完成状态后带有空格时无法正确判断命令结束的问题。</li>
    </ul>
    <h5>安装包</h5>
    <pre><code>| DSH-Desktop-Setup-1.0.17.exe | Windows x64 安装程序 |</code></pre>
  </div>
  <hr class="log-divider">
  <div class="log-entry">
    <div class="log-head"><span class="log-ver">v0.1.7-rc.2</span><span class="log-date">2026-09-20</span></div>
    <h3>问题修复</h3>
    <ul>
      <li>修复从图形入口启动桌面端时缺少登录 shell 环境的问题。</li>
    </ul>
  </div>
  <p style="color:var(--dsh-dlg-muted);font-size:12px;margin-top:4px">数据来自 GitHub Releases</p>
`

const MODAL_SCRIPTS = {
  about: modal.buildModalHostScript('info', '关于 DSH Desktop', ABOUT_BODY),
  changelog: modal.buildModalHostScript(
    'doc',
    'DSH 运行包更新日志',
    '<p style="color:var(--dsh-dlg-muted)">正在加载更新日志，请稍候...</p>'
  ),
  changelogBody: modal.buildModalUpdateScript(CHANGELOG_BODY)
}

// spec 一律经 buildDialogSpec / buildUpdatePanelSpec 生成；vars 稍后按当前主题覆盖
const SPECS = {}
for (const [key, c] of Object.entries(CASES)) {
  const spec = buildDialogSpec(c.options)
  spec.label = c.label
  spec.vars = {}
  SPECS[key] = spec
}
let panelSeq = 0
for (const [key, c] of Object.entries(PANEL_CASES)) {
  const spec = buildUpdatePanelSpec(c.options, ++panelSeq)
  spec.label = c.label
  spec.vars = {}
  SPECS[key] = spec
}

// 「三个阶段」深链按顺序连播：下载中 → 已下载完成 → 下载失败。
// 面板与旧对话框共用一个宿主，任意时刻只有一个浮层，所以只能一个接一个演。
const SEQUENCES = {
  'panel-phases': ['panel-downloading', 'panel-downloaded', 'panel-error']
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Desktop — 对话框样式预览</title>
<style>
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Microsoft YaHei UI', sans-serif;
    background: #eef0f3; color: #111827;
    transition: background-color 160ms ease, color 160ms ease;
  }
  body[data-theme="dark"] { background: #0b1220; color: #f9fafb; }
  .page { padding: 40px 32px 64px; max-width: 880px; }
  h1 { margin: 0 0 6px; font-size: 19px; font-weight: 600; }
  p.sub { margin: 0 0 24px; font-size: 13px; line-height: 1.7; color: #6b7280; }
  body[data-theme="dark"] p.sub { color: #9ca3af; }
  code { font-family: ui-monospace, Consolas, monospace; font-size: 12px; }
  .bar {
    display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 32px;
    position: sticky; top: 0; z-index: 10; padding: 8px 0;
    background: #eef0f3;
  }
  body[data-theme="dark"] .bar { background: #0b1220; }
  button.trigger {
    height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 500;
    border: 1px solid rgba(0,0,0,.12); background: #fff; color: #111827;
  }
  button.trigger:hover { background: #f9fafb; }
  body[data-theme="dark"] button.trigger {
    border-color: rgba(255,255,255,.16); background: #1f2937; color: #f9fafb;
  }
  body[data-theme="dark"] button.trigger:hover { background: #273140; }
  #result {
    margin-bottom: 28px; padding: 10px 14px; border-radius: 8px;
    font-family: ui-monospace, Consolas, monospace; font-size: 12px;
    background: rgba(0,0,0,.05); color: #6b7280; display: inline-block;
  }
  body[data-theme="dark"] #result { background: rgba(255,255,255,.06); color: #9ca3af; }
  .derive {
    margin: 0 0 20px; padding: 8px 12px; border-radius: 8px;
    font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
    background: rgba(22,163,74,.12); color: #15803d;
    border-left: 3px solid #16a34a;
  }
  body[data-theme="dark"] .derive { background: rgba(34,197,94,.14); color: #86efac; }

  /* ── 模拟 DSH 聊天页：玻璃必须有东西可折射，纯色底上判断不出真实观感 ── */
  .mock { border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08); }
  body[data-theme="dark"] .mock { border-color: rgba(255,255,255,.1); }
  .mock-bar {
    display: flex; align-items: center; gap: 10px; padding: 10px 14px;
    background: rgba(255,255,255,.72); border-bottom: 1px solid rgba(0,0,0,.06);
  }
  body[data-theme="dark"] .mock-bar {
    background: rgba(31,41,55,.72); border-bottom-color: rgba(255,255,255,.08);
  }
  .mock-dot { width: 10px; height: 10px; border-radius: 50%; background: #22c55e; }
  .mock-title { font-size: 12.5px; font-weight: 600; }
  .mock-body { padding: 18px; display: flex; flex-direction: column; gap: 14px; background: #fff; }
  body[data-theme="dark"] .mock-body { background: #0f172a; }
  .bubble { max-width: 78%; padding: 10px 13px; border-radius: 14px; font-size: 13px; line-height: 1.6; }
  .bubble--me {
    align-self: flex-end; background: #0369a1; color: #fff; border-bottom-right-radius: 4px;
  }
  .bubble--ai {
    align-self: flex-start; background: #f1f5f9; color: #334155; border-bottom-left-radius: 4px;
  }
  body[data-theme="dark"] .bubble--ai { background: #1e293b; color: #cbd5e1; }
  .mock-art {
    align-self: flex-start; width: 240px; height: 96px; border-radius: 12px;
    background: linear-gradient(135deg, #0ea5e9, #6366f1 55%, #ec4899);
  }
  .mock-code {
    align-self: flex-start; padding: 10px 12px; border-radius: 10px;
    font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; line-height: 1.7;
    background: #0f172a; color: #a5b4fc;
  }
</style>
</head>
<body data-theme="light">
<div class="page">
  <h1>自绘对话框样式预览</h1>
  <p class="sub">
    样式（DIALOG_CSS / UPDATE_PANEL_CSS）、图标与 DOM 结构全部直接取自 <code>src/main/dsh-dialog.ts</code>
    与 <code>src/main/update-panel.ts</code>，点按钮走的就是生产同一条
    <code>window.__dshDialogHost.open()</code> 路径。<br>
    每个 spec 都经**真实的 <code>buildDialogSpec()</code> / <code>buildUpdatePanelSpec()</code>**
    推导 defaultId / cancelId / 按钮变体——不是手写 variant。<br>
    Esc = 取消按钮；回车 = 初始焦点按钮；点遮罩 = 取消。<br>
    下方是模拟的 DSH 聊天页——玻璃需要背后有内容才能判断真实观感。
  </p>
  <div id="derive" class="derive"></div>
  <div class="derive" style="background:rgba(56,189,248,.12);color:#0369a1;border-left-color:#0ea5e9">
    下面四个按钮走的是**注入式模态框**（injected-modal.ts），与「检查更新…」走的对话框层是两套独立实现。
  </div>
  <div class="derive" style="background:rgba(168,85,247,.12);color:#7e22ce;border-left-color:#a855f7">
    标「面板：」的按钮走的是**版本更新面板**（update-panel.ts）——它是 dsh-dialog 的一种变体，
    共用同一条队列、同一段宿主脚本、同一条 IPC 通道，因此面板与对话框不会同时出现。
  </div>
  <div class="bar">
    <button class="trigger" id="theme">切换明暗</button>
    <button class="trigger" data-open="sample">对话框：风险类 detail</button>
    <button class="trigger" data-open="meta">对话框：版本信息类</button>
    <button class="trigger" data-open="failed">对话框：更新失败（3 按钮）</button>
    <button class="trigger" data-open="picker">对话框：检查更新（4 按钮）</button>
    <button class="trigger" data-open="quit">对话框回归：退出确认</button>
    <button class="trigger" data-open="panel">面板：客户端发现新版本</button>
    <button class="trigger" data-open="panel-runtime">面板：DSH 运行包</button>
    <button class="trigger" data-open="panel-picker">面板：检查更新（四项）</button>
    <button class="trigger" data-open="panel-phases">面板：三阶段连播</button>
    <button class="trigger" data-modal="about">模态框：关于（info 图标）</button>
    <button class="trigger" data-modal="changelog">模态框：更新日志（含正文替换）</button>
  </div>
  <div id="result">尚未做出选择</div>

  <div class="mock">
    <div class="mock-bar"><span class="mock-dot"></span><span class="mock-title">DSH 会话</span></div>
    <div class="mock-body">
      <div class="bubble bubble--me">帮我看下这个更新包为什么装不上</div>
      <div class="bubble bubble--ai">我先看一下日志。dsh-repair 报的是 npm install 阶段 EPERM，通常是 resources 目录只读导致的。</div>
      <div class="mock-art"></div>
      <div class="mock-code">Error: EPERM: operation not permitted, rename 'C:\\\\Program Files\\\\dsh-cache'</div>
      <div class="bubble bubble--me">那要怎么修</div>
      <div class="bubble bubble--ai">把缓存目录指到 %LOCALAPPDATA% 就行，我已经改好了，重新试一次。</div>
    </div>
  </div>
</div>

<script>${hostScript}</script>
<script>
var VARS = ${JSON.stringify(theme.INJECTED_THEME_VARS)};
var SPECS = ${JSON.stringify(SPECS)};
var SEQUENCES = ${JSON.stringify(SEQUENCES)};
var MODAL_SCRIPTS = ${JSON.stringify(MODAL_SCRIPTS)};
var result = document.getElementById('result');
document.getElementById('derive').textContent = ${JSON.stringify(
  derivationReport +
    ' ｜ ' +
    modalReport +
    ' ｜ ' +
    panelSpecReport +
    ' ｜ ' +
    panelStructureReport +
    ' ｜ ' +
    referenceReport
)};

function vars () {
  var v = VARS[document.body.dataset.theme] || VARS.light, o = {}
  for (var k in v) o[k] = v[k]
  return o
}

// 注入脚本在生成时按 light 主题写了令牌，这里按预览当前主题覆盖回去
function applyVars () {
  var v = vars()
  for (var k in v) document.documentElement.style.setProperty(k, v[k])
}

// 连播状态：面板与旧对话框共用一个宿主，任意时刻只有一个浮层，
// 「三阶段」只能一个接一个演。
var seq = null
var seqIndex = 0
// 最近一次打开的形态：切换明暗时需要重开它——浮层里的令牌是 open() 时
// 按当时主题写下的，不重开的话深色永远看不到真实配色
var lastOverlay = null

// 页面侧 open() 会调 window.dsh.dialogResult；预览环境没有 preload，打桩记录选择结果
window.dsh = {
  dialogResult: function (id, index, payload) {
    result.textContent = 'dialogResult(id=' + id + ', index=' + index +
      ', payload=' + JSON.stringify(payload === undefined ? null : payload) + ')'
    if (seq) {
      seqIndex++
      var next = seq[seqIndex]
      if (next) {
        setTimeout(function () { openSpec(next) }, 400)
      } else {
        seq = null
        result.textContent += ' → 连播结束'
      }
    }
  }
}

function openSpec (key) {
  try {
    if (!seq) lastOverlay = { kind: 'spec', key: key }
    var spec = JSON.parse(JSON.stringify(SPECS[key]))
    spec.vars = vars()
    spec.id = Date.now()
    window.__dshDialogHost.open(spec)
  } catch (e) {
    // 预览页是开发工具：把失败原因直接显示出来，不要静默吞掉
    result.textContent = 'openSpec(' + key + ') 失败：' + (e && e.stack ? e.stack : e)
    result.style.background = 'rgba(220,38,38,.12)'
    result.style.color = '#b42318'
  }
}

// 连播入口：先记住序列，再打开第一个
function openSequence (key) {
  seq = SEQUENCES[key]
  seqIndex = 0
  lastOverlay = { kind: 'sequence', key: key }
  if (seq && seq.length) openSpec(seq[0])
}

// 模态框：eval 的就是真机注入的那段 buildModalHostScript 产物
function openModal (key) {
  try {
    lastOverlay = { kind: 'modal', key: key }
    applyVars()
    ;(0, eval)(MODAL_SCRIPTS[key])
    applyVars()
    result.textContent = '已打开模态框：' + key
    // 覆盖「先弹壳 → 数据到达 → 替换正文」这条最容易静默失效的链路
    if (key === 'changelog') {
      setTimeout(function () {
        try {
          ;(0, eval)(MODAL_SCRIPTS.changelogBody)
          result.textContent = '已打开模态框：changelog（600ms 后正文已替换）'
        } catch (e2) {
          result.textContent = 'updateModalBody 失败：' + (e2 && e2.message ? e2.message : e2)
        }
      }, 600)
    }
  } catch (e) {
    result.textContent = 'openModal(' + key + ') 失败：' + (e && e.stack ? e.stack : e)
    result.style.background = 'rgba(220,38,38,.12)'
    result.style.color = '#b42318'
  }
}

document.querySelectorAll('[data-open]').forEach(function (b) {
  b.addEventListener('click', function () {
    var key = b.getAttribute('data-open')
    seq = null
    if (SEQUENCES[key]) openSequence(key)
    else openSpec(key)
  })
})
document.querySelectorAll('[data-modal]').forEach(function (b) {
  b.addEventListener('click', function () { openModal(b.getAttribute('data-modal')) })
})
document.getElementById('theme').addEventListener('click', function () {
  document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'
  // 浮层里的令牌是 open() 时按当时主题写下的：不重新下发并重开，
  // 深色下看到的还是浅色那一套，深色验证就是假的
  applyVars()
  if (!lastOverlay) return
  if (lastOverlay.kind === 'sequence') openSequence(lastOverlay.key)
  else if (lastOverlay.kind === 'modal') openModal(lastOverlay.key)
  else openSpec(lastOverlay.key)
})

// hash 深链：#sample / #meta / #failed / #picker / #quit / #panel /
// #panel-runtime / #panel-phases / #modal-about / #modal-changelog 直接打开对应形态；
// 任意形态加 -dark 后缀则先切深色主题（#panel-dark）。同文档片段导航不会重新执行脚本，
// 所以从 A 形态切到 B 形态需要手动刷新（或加 ?v=N 强制重载）。
try {
  var hash = (location.hash || '').replace('#', '')
  if (/-dark$/.test(hash)) {
    document.body.dataset.theme = 'dark'
    hash = hash.replace(/-dark$/, '')
  }
  if (SEQUENCES[hash]) openSequence(hash)
  else if (SPECS[hash]) openSpec(hash)
  else if (hash === 'modal-about') openModal('about')
  else if (hash === 'modal-changelog') openModal('changelog')
} catch (e) {
  document.getElementById('derive').textContent = '深链打开失败：' + (e && e.message ? e.message : e)
}
</script>
</body>
</html>
`

const out = path.join(root, 'docs', 'dialog-preview.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log('written:', path.relative(root, out), `(${html.length} bytes)`)
console.log('DIALOG_CSS:', dialog.DIALOG_CSS.length, 'bytes; ICONS:', Object.keys(theme.ICONS).join(','))
console.log('UPDATE_PANEL_CSS:', panel.UPDATE_PANEL_CSS.length, 'bytes')
console.log(derivationReport)
console.log(modalReport)
console.log(panelSpecReport)
console.log(panelStructureReport)
console.log(referenceReport)
