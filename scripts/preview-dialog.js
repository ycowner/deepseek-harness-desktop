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
const dialog = loadTs('src/main/dsh-dialog.ts', {
  electron: {},
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme
})
const modal = loadTs('src/main/injected-modal.ts', {
  electron: {},
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme
})

const hostScript = dialog.buildHostScript()
const buildDialogSpec = dialog.buildDialogSpec

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
  // 玻璃降档参数（模态框比对话框弱一档，见 AGENTS.md §6.7）
  if (!/blur\(12px\)/.test(modal.MODAL_CSS) || !/var\(--dsh-dlg-glass-strong\)/.test(modal.MODAL_CSS)) {
    throw new Error('模态框玻璃参数回归：应为 blur(12px) + --dsh-dlg-glass-strong')
  }
  return '模态框结构自检通过：append 层级 / 锚点查询 / 对外入口 / 正文替换 / 玻璃参数'
}

const modalReport = assertModalStructure()

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
      <button class="about-repo" style="display:inline-flex;align-items:center;gap:6px;padding:9px 18px;border-radius:12px;background:var(--dsh-dlg-primary-bg);color:var(--dsh-dlg-primary-fg);border:1px solid transparent;font-size:12.5px;font-weight:600;font-family:inherit;cursor:pointer;">GitHub 仓库</button>
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

// spec 一律经 buildDialogSpec 生成；vars 稍后按当前主题覆盖
const SPECS = {}
for (const [key, c] of Object.entries(CASES)) {
  const spec = buildDialogSpec(c.options)
  spec.label = c.label
  spec.vars = {}
  SPECS[key] = spec
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
    样式（DIALOG_CSS）、图标与 DOM 结构全部直接取自 <code>src/main/dsh-dialog.ts</code>，
    点按钮走的就是生产同一条 <code>window.__dshDialogHost.open()</code> 路径。<br>
    每个 spec 都经**真实的 <code>buildDialogSpec()</code>** 推导 defaultId / primaryId /
    detailTone——不是手写 variant。<br>
    Esc = 取消按钮；回车 = 初始焦点按钮；点遮罩 = 取消。
    下方是模拟的 DSH 聊天页——玻璃需要背后有内容才能判断真实观感。
  </p>
  <div id="derive" class="derive"></div>
  <div class="derive" style="background:rgba(56,189,248,.12);color:#0369a1;border-left-color:#0ea5e9">
    下面四个按钮走的是**注入式模态框**（injected-modal.ts），与「检查更新…」走的对话框层是两套独立实现。
  </div>
  <div class="bar">
    <button class="trigger" id="theme">切换明暗</button>
    <button class="trigger" data-open="sample">对话框：风险类 detail</button>
    <button class="trigger" data-open="meta">对话框：版本信息类</button>
    <button class="trigger" data-open="failed">对话框：更新失败（3 按钮）</button>
    <button class="trigger" data-open="picker">对话框：检查更新（4 按钮）</button>
    <button class="trigger" data-open="quit">对话框回归：退出确认</button>
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
var MODAL_SCRIPTS = ${JSON.stringify(MODAL_SCRIPTS)};
var result = document.getElementById('result');
document.getElementById('derive').textContent = ${JSON.stringify(derivationReport + ' ｜ ' + modalReport)};

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

// 页面侧 open() 会调 window.dsh.dialogResult；预览环境没有 preload，打桩记录选择结果
window.dsh = {
  dialogResult: function (id, index) {
    result.textContent = 'dialogResult(id=' + id + ', index=' + index + ')'
  }
}

function openSpec (key) {
  try {
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

// 模态框：eval 的就是真机注入的那段 buildModalHostScript 产物
function openModal (key) {
  try {
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
  b.addEventListener('click', function () { openSpec(b.getAttribute('data-open')) })
})
document.querySelectorAll('[data-modal]').forEach(function (b) {
  b.addEventListener('click', function () { openModal(b.getAttribute('data-modal')) })
})
document.getElementById('theme').addEventListener('click', function () {
  document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'
})

// hash 深链：#sample / #meta / #failed / #picker / #quit / #modal-about /
// #modal-changelog 直接打开对应形态；任意形态加 -dark 后缀则先切深色主题
// （#modal-changelog-dark）。同文档片段导航不会重新执行脚本，所以从 A 形态切到
// B 形态需要手动刷新（或加 ?v=N 强制重载）。
try {
  var hash = (location.hash || '').replace('#', '')
  if (/-dark$/.test(hash)) {
    document.body.dataset.theme = 'dark'
    hash = hash.replace(/-dark$/, '')
  }
  if (SPECS[hash]) openSpec(hash)
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
console.log(derivationReport)
console.log(modalReport)
