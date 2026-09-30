/**
 * 生成公告横幅的样式预览页（node scripts/preview-notice.js）
 *
 * 与 preview-dialog.js 同源思路：样式与注入脚本**从 src/main/notice-banner.ts
 * 现场抽取**，预览看到的就是生产那一份。
 *
 * 这个模块的重点不在"好看"，而在把 notice.ts 的校验规则变成**生成期断言**。
 * 公告内容来自远端、会渲染进页面，校验一旦被改松，后果是 XSS；所以
 * `javascript:` 链接、非法 id、重复 id、超量条数、坏时间窗这些必须在这里
 * 就炸出来，而不是等真机。
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
    // node 内置模块（fs/path/…）放行真实实现：notice.ts 要读写已读文件，
    // 自检里并不依赖它落盘，真实实现反而更接近生产
    if (id.startsWith('node:') || ['fs', 'path', 'url', 'os'].includes(id)) return require(id)
    throw new Error(`unexpected require("${id}") in ${file}`)
  }
  new Function('require', 'module', 'exports', code)(req, mod, mod.exports)
  return mod.exports
}

const theme = loadTs('src/main/injected-theme.ts', { './theme-manager': {} })
const electronStub = { app: { getPath: () => root }, net: {} }
const notice = loadTs('src/main/notice.ts', {
  electron: electronStub,
  './app-update': { UPDATE_FEED_URL: 'https://example.invalid' }
})
const banner = loadTs('src/main/notice-banner.ts', {
  electron: electronStub,
  './theme-manager': { getEffectiveTheme: () => 'light' },
  './injected-theme': theme,
  './notice': notice
})

// ── 校验规则断言（生成期，不过就中止生成）────────────────────────────────

const assertRejects = (label, json, expectSubstr) => {
  let threw = null
  try {
    notice.parseNotices(json)
  } catch (err) {
    threw = err
  }
  if (!threw) throw new Error(`校验回归：${label} 本应被拒绝，实际通过了`)
  if (expectSubstr && !String(threw.message).includes(expectSubstr)) {
    throw new Error(`校验回归：${label} 的报错信息不含「${expectSubstr}」，实际为「${threw.message}」`)
  }
}

const one = (over) => JSON.stringify({ notices: [Object.assign({ id: 'n1', type: 'banner', level: 'info', title: 't', body: 'b' }, over)] })

const assertValidation = () => {
  // 链接协议：javascript: / data: / http: 全部必须被挡
  assertRejects('javascript: 链接', one({ link: { label: 'x', url: 'javascript:alert(1)' } }), '只允许 https:')
  assertRejects('data: 链接', one({ link: { label: 'x', url: 'data:text/html,<script>1</script>' } }), '只允许 https:')
  assertRejects('http: 链接', one({ link: { label: 'x', url: 'http://a.test' } }), '只允许 https:')
  // 非法 id（可能参与路径/文件名拼接）
  assertRejects('id 含斜杠', one({ id: '../../evil' }), '含非法字符')
  assertRejects('id 超长', one({ id: 'a'.repeat(65) }), '超长')
  // 枚举
  assertRejects('type 非法', one({ type: 'popup' }), 'type 只能是')
  assertRejects('level 非法', one({ level: 'fatal' }), 'level 只能是')
  // 时间窗
  assertRejects('expiresAt 早于 startsAt', one({ startsAt: '2026-10-02T00:00:00Z', expiresAt: '2026-10-01T00:00:00Z' }), '必须晚于')
  assertRejects('时间格式非法', one({ startsAt: '下周一' }), '时间格式非法')
  // id 唯一
  assertRejects('id 重复', JSON.stringify({ notices: [
    { id: 'dup', title: 'a', body: 'b' },
    { id: 'dup', title: 'c', body: 'd' }
  ] }), 'id 重复')
  // 量级
  assertRejects('条数超限', JSON.stringify({ notices: Array.from({ length: 21 }, (_, i) => ({ id: 'n' + i, title: 't', body: 'b' })) }), '条数超限')
  assertRejects('标题超长', one({ title: '标'.repeat(61) }), '超长')
  assertRejects('正文超长', one({ body: 'b'.repeat(2001) }), '超长')
  // 结构
  assertRejects('根不是对象', '[]', '根节点必须是对象')
  assertRejects('缺 notices', '{}', '缺少 notices 数组')
  assertRejects('非法 JSON', '{', '不是合法 JSON')
  assertRejects('空 id', one({ id: '' }), '必须是非空字符串')

  // 合法的必须能过
  const ok = notice.parseNotices(JSON.stringify({ notices: [
    { id: 'a-1', type: 'modal', level: 'error', title: '停服维护', body: '今晚 02:00-04:00 维护', link: { label: '查看公告', url: 'https://example.com/n' }, startsAt: '2026-09-30T00:00:00Z', expiresAt: '2026-10-02T00:00:00Z', dismissible: false }
  ] }))
  if (ok.length !== 1 || ok[0].id !== 'a-1' || ok[0].type !== 'modal' || ok[0].dismissible !== false) {
    throw new Error('校验回归：合法公告被误拒')
  }
  return '公告校验自检通过：12 类非法输入全部被拒 / 1 类合法输入通过'
}

// planNotices 是纯函数（不碰网络与 DOM），可以直接断言展示决策
const assertPlan = () => {
  // 注意：startsAt / expiresAt 在生产里由 parseNotices 解析成 epoch 毫秒，
  // 这里也必须传毫秒——传 ISO 字符串会被静默当成"未生效"，夹具必须对齐
  const iso = (s) => Date.parse(s)
  const mk = (id, type, level, startsAt) => ({ id, type, level, title: 't', body: 'b', dismissible: true, ...(startsAt ? { startsAt: iso(startsAt) } : {}) })
  const all = [
    mk('err', 'banner', 'error'),
    mk('warn', 'banner', 'warning'),
    mk('info1', 'banner', 'info'),
    mk('info2', 'banner', 'info'),
    mk('info3', 'banner', 'info'),
    mk('info4', 'banner', 'info'),
    mk('mod', 'modal', 'warning')
  ]
  const p1 = notice.planNotices(all, new Set())
  if (p1.banner.length !== 3) throw new Error(`plan 回归：横幅应截断到 3，实际 ${p1.banner.length}`)
  if (p1.banner[0].id !== 'err') throw new Error('plan 回归：error 级应排最前')
  if (p1.modals.length !== 1) throw new Error('plan 回归：模态数不对')

  const p2 = notice.planNotices(all, new Set(['err', 'warn']))
  if (p2.banner[0].id !== 'info1') throw new Error('plan 回归：已读项应被过滤')

  // 生效窗口：未到 startsAt 的不展示，过期的不展示
  const now = iso('2026-10-01T12:00:00Z')
  const p3 = notice.planNotices([
    mk('past', 'banner', 'info', '2026-09-30T00:00:00Z'),
    mk('future', 'banner', 'info', '2026-10-05T00:00:00Z'),
    { ...mk('expired', 'banner', 'info'), expiresAt: iso('2026-09-30T00:00:00Z') }
  ], new Set(), now)
  if (p3.banner.length !== 1 || p3.banner[0].id !== 'past') {
    throw new Error(`plan 回归：生效窗口过滤不对，实际 ${JSON.stringify(p3.banner.map((n) => n.id))}`)
  }
  return '展示决策自检通过：严重度排序 / 3 条截断 / 已读过滤 / 生效窗口'
}

// 横幅注入脚本的防注入断言：文案必须走 textContent，绝不能有 innerHTML 拼正文
const assertBannerSafety = () => {
  const code = banner.buildNoticeBannerScript([
    { id: 'x', type: 'banner', level: 'info', title: 't', body: 'b', dismissible: true }
  ])
  if (!/\.textContent\s*=\s*n\.(title|body)/.test(code)) {
    throw new Error('横幅安全回归：标题/正文必须用 textContent 赋值')
  }
  // innerHTML 只允许出现在图标路径上（ICONS 常量，非远端内容）
  const innerHtmlHits = code.match(/\.innerHTML\s*=/g) || []
  if (innerHtmlHits.length !== 1) {
    throw new Error(`横幅安全回归：innerHTML 只应出现在图标处，实际 ${innerHtmlHits.length} 处`)
  }
  if (!/openExternal\(n\.link\.url\)/.test(code)) {
    throw new Error('横幅安全回归：外链必须走 window.dsh.openExternal')
  }
  if (!/noticeRead\(n\.id\)/.test(code)) {
    throw new Error('横幅安全回归：关闭必须回传 noticeRead')
  }
  return '横幅注入自检通过：textContent 渲染 / innerHTML 仅图标 / 外链走 open-external / 关闭回传已读'
}

const reports = [assertValidation(), assertPlan(), assertBannerSafety()]

// ── 预览页 ────────────────────────────────────────────────────────────────

const SAMPLES = {
  stack: [
    { id: 'n-warn', type: 'banner', level: 'warning', title: '今晚 02:00–04:00 服务维护', body: '维护期间 DSH 服务会短暂不可用，正在进行的会话会中断。', link: { label: '查看详情', url: 'https://example.com/maint' }, dismissible: true },
    { id: 'n-err', type: 'banner', level: 'error', title: 'API Key 已失效', body: '检测到 DeepSeek API Key 返回 401，请在设置中重新配置。未配置前无法使用对话功能。', dismissible: true },
    { id: 'n-lock', type: 'banner', level: 'info', title: '客户端 1.0.17 已发布', body: '本次更新修复了…\n并新增了公告功能。', dismissible: false }
  ]
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>DSH Desktop — 公告横幅预览</title>
<style>
  body {
    margin: 0; min-height: 100vh;
    font-family: -apple-system, 'Segoe UI Variable Text', 'Segoe UI', system-ui, 'Microsoft YaHei UI', sans-serif;
    background: #eef0f3; color: #111827;
    transition: background-color 160ms ease, color 160ms ease;
  }
  body[data-theme="dark"] { background: #0b1220; color: #f9fafb; }
  .page { padding: 24px 32px 64px; }
  h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
  p.sub { margin: 0 0 20px; font-size: 13px; line-height: 1.7; color: #6b7280; }
  body[data-theme="dark"] p.sub { color: #9ca3af; }
  .bar { display: flex; flex-wrap: wrap; gap: 8px; margin-bottom: 20px; }
  button.trigger {
    height: 32px; padding: 0 14px; border-radius: 8px; cursor: pointer;
    font: inherit; font-size: 13px; font-weight: 500;
    border: 1px solid rgba(0,0,0,.12); background: #fff; color: #111827;
  }
  button.trigger:hover { background: #f9fafb; }
  body[data-theme="dark"] button.trigger { border-color: rgba(255,255,255,.16); background: #1f2937; color: #f9fafb; }
  .reports { margin-bottom: 20px; display: flex; flex-direction: column; gap: 6px; }
  .report {
    padding: 8px 12px; border-radius: 8px; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px;
    background: rgba(22,163,74,.12); color: #15803d; border-left: 3px solid #16a34a;
  }
  /* 模拟客户端更新横幅（#dsh-ub），用来验证两条横幅的错开 */
  #fake-ub {
    position: fixed; top: 0; left: 0; right: 0; z-index: 2147483000;
    padding: 10px 16px 12px; font-size: 13px;
    background: var(--dsh-modal-bg); border-bottom: 1px solid var(--dsh-modal-border);
  }
  #fake-ub[hidden] { display: none; }
  .mock { border-radius: 14px; overflow: hidden; border: 1px solid rgba(0,0,0,.08); background: #fff; }
  body[data-theme="dark"] .mock { border-color: rgba(255,255,255,.1); background: #0f172a; }
  .mock-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; background: rgba(0,0,0,.03); }
  body[data-theme="dark"] .mock-bar { background: rgba(255,255,255,.04); }
  .mock-body { padding: 18px; display: flex; flex-direction: column; gap: 14px; }
  .bubble { max-width: 78%; padding: 10px 13px; border-radius: 14px; font-size: 13px; line-height: 1.6; }
  .bubble--me { align-self: flex-end; background: #0369a1; color: #fff; border-bottom-right-radius: 4px; }
  .bubble--ai { align-self: flex-start; background: #f1f5f9; color: #334155; border-bottom-left-radius: 4px; }
  body[data-theme="dark"] .bubble--ai { background: #1e293b; color: #cbd5e1; }
  .mock-code { align-self: flex-start; padding: 10px 12px; border-radius: 10px; font-family: ui-monospace, Consolas, monospace; font-size: 11.5px; background: #0f172a; color: #a5b4fc; }
</style>
</head>
<body data-theme="light">
<div id="fake-ub" hidden>正在下载客户端更新包 42%</div>
<div class="page">
  <h1>公告横幅预览</h1>
  <p class="sub">
    样式与注入脚本全部取自 <code>src/main/notice-banner.ts</code>；三条自检在生成预览时已跑过（见下方绿条）。<br>
    点「叠加更新横幅」可以验证公告横幅与客户端更新横幅（<code>#dsh-ub</code>）的错开——公告会在它下面，不重叠。
  </p>
  <div class="reports">
${reports.map((r) => `    <div class="report">${r}</div>`).join('\n')}
  </div>
  <div class="bar">
    <button class="trigger" id="theme">切换明暗</button>
    <button class="trigger" id="show">显示公告横幅（3 条堆叠）</button>
    <button class="trigger" id="toggle-ub">叠加更新横幅</button>
  </div>
  <div class="mock">
    <div class="mock-bar">DSH 会话</div>
    <div class="mock-body">
      <div class="bubble bubble--me">看下今晚的维护公告</div>
      <div class="bubble bubble--ai">维护窗口是 02:00–04:00，期间会话会中断，其它不受影响。</div>
      <div class="mock-code">Error: 401 Unauthorized — API key invalid</div>
    </div>
  </div>
</div>

<script>
var VARS = ${JSON.stringify(theme.INJECTED_THEME_VARS)};
var BANNER_SCRIPT = ${JSON.stringify(banner.buildNoticeBannerScript(SAMPLES.stack))};

function applyVars () {
  var v = VARS[document.body.dataset.theme] || VARS.light
  for (var k in v) document.documentElement.style.setProperty(k, v[k])
}

document.getElementById('show').addEventListener('click', function () {
  applyVars()
  ;(0, eval)(BANNER_SCRIPT)
  applyVars()
})
document.getElementById('toggle-ub').addEventListener('click', function () {
  var ub = document.getElementById('fake-ub')
  ub.hidden = !ub.hidden
  // 重新投影以验证 top 偏移随 #dsh-ub 可见性变化
  applyVars()
  ;(0, eval)(BANNER_SCRIPT)
})
document.getElementById('theme').addEventListener('click', function () {
  document.body.dataset.theme = document.body.dataset.theme === 'dark' ? 'light' : 'dark'
  applyVars()
  ;(0, eval)(BANNER_SCRIPT)
})
try {
  if ((location.hash || '').replace('#', '') === 'dark') {
    document.body.dataset.theme = 'dark'
    applyVars()
  }
  if (location.hash && location.hash.indexOf('show') >= 0) {
    applyVars(); (0, eval)(BANNER_SCRIPT)
  }
} catch (e) { /* 预览失败不阻塞 */ }
</script>
</body>
</html>
`

const out = path.join(root, 'docs', 'notice-preview.html')
fs.mkdirSync(path.dirname(out), { recursive: true })
fs.writeFileSync(out, html, 'utf8')
console.log('written:', path.relative(root, out), `(${html.length} bytes)`)
for (const r of reports) console.log(r)
