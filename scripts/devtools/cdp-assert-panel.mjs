/**
 * 面板 DOM 断言：不靠截图看，直接读渲染后的计算样式与结构。
 *
 * 相比截图，DOM 断言的能量化之处在于能给出**具体数值**：
 * 「浅色下正文对比度 12.6:1」比「看起来还行」可检验得多。
 *
 * 用法：node scripts/devtools/cdp-assert-panel.mjs <cdpPort> <url>
 */

const cdpPort = process.argv[2] ?? '9333'
const url = process.argv[3]
if (!url) { console.error('usage: cdp-assert-panel.mjs <cdpPort> <url>'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function openTarget(targetUrl) {
  // 先试新建标签页（Chrome 可用）；Electron 默认拒绝建新 target（返回
  // "Could not create new page"），此时**回落到已存在的页面** ——
  // 桌面壳才是我们的实际部署形态，脚本必须能在它上面跑。
  let wsUrl = null
  try {
    const response = await fetch(
      `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' })
    const text = await response.text()
    const created = JSON.parse(text)
    wsUrl = created.webSocketDebuggerUrl
  } catch {
    const targets = await (await fetch(`http://127.0.0.1:${cdpPort}/json`)).json()
    const page = targets.find((t) => t.type === 'page' && t.url.includes('4314'))
      ?? targets.find((t) => t.type === 'page')
    if (page === undefined) throw new Error('既无法新建 target，也没有可附着的页面')
    wsUrl = page.webSocketDebuggerUrl
    console.log('（Electron 不允许多开标签页，改为附着到现有页面）')
  }
  const ws = new WebSocket(wsUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
  let seq = 0
  const pending = new Map()
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data)
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id) }
  }
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((res) => { pending.set(id, res); ws.send(JSON.stringify({ id, method, params })) })
  }
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
    if (r.result?.exceptionDetails) return { __exception: r.result.exceptionDetails.exception?.description }
    return r.result?.result?.value
  }
  return { ws, send, evaluate }
}

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const page = await openTarget(url)
await sleep(4500)

await page.evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label') === 'AutoResearch')
  if (row) row.click()
})()`)
await sleep(3000)

console.log('=== 1. 结构 ===')
const s = await page.evaluate(`(() => {
  const p = document.querySelector('.autoresearch-panel')
  if (!p) return { hasPanel: false }
  const q = (sel) => !!p.querySelector(sel)
  return {
    hasPanel: true,
    hasBreadcrumb: q('.aw-breadcrumb'),
    hasTabset: q('.aw-tabset'),
    hasSubTab: q('.aw-tab-sub'),
    hasSkip: q('.aw-skip'),
    hasContent: q('#aw-content'),
    hasTaskbar: q('.aw-taskbar'),
    labels: [...p.querySelectorAll('.aw-tab')].map(b => b.textContent.trim()),
    breadcrumb: p.querySelector('.aw-breadcrumb')?.textContent,
  }
})()`)
record('面板挂载', s?.hasPanel === true)
record('面包屑', s?.hasBreadcrumb === true, s?.breadcrumb)
record('一级分组栏', s?.hasTabset === true)
record('跳转链接', s?.hasSkip === true)
record('内容区可聚焦', s?.hasContent === true)
console.log('  一级标签:', JSON.stringify(s?.labels))
console.log('  二级标签数:', (s?.labels ?? []).length)
console.log()

console.log('=== 2. 主题适配：变量定义在 .aw-panel，且必须向下继承 ===')
// 关键点：--aw-* 定义在 .aw-panel 上，而 .autoresearch-panel 是它的**父层**。
// 所以探测必须打在内层；打在外层会读到空值 —— 这正是第一次误判的原因。
const probe = `(() => {
  const outer = document.querySelector('.autoresearch-panel')
  const inner = document.querySelector('.aw-panel')
  if (!inner) return null
  const cs = getComputedStyle(inner)
  const get = (n) => cs.getPropertyValue(n).trim()
  // 子元素是否继承了变量（继承断了的话子元素会拿到空值 → 静默用 fallback）
  const child = inner.querySelector('.aw-tabs')
  const childCs = child ? getComputedStyle(child) : null
  return {
    outerExists: !!outer,
    innerExists: !!inner,
    bg: get('--aw-bg'), line: get('--aw-line'), ink: get('--aw-ink'),
    mono: get('--aw-mono'), overlay: get('--aw-overlay'),
    accent: get('--aw-accent'), radius: get('--aw-r-box'),
    inkResolved: cs.color, fontResolved: cs.fontFamily,
    tabsBg: childCs ? childCs.backgroundColor : null,
    childSeesBg: childCs ? childCs.getPropertyValue('--aw-bg').trim() : null,
    bodyBg: getComputedStyle(document.body).backgroundColor,
  }
})()`

const light = await page.evaluate(probe)
console.log('  light:', JSON.stringify(light))

record('--aw-* 变量已解析（非空）', typeof light?.bg === 'string' && light.bg !== '', `--aw-bg=${light?.bg}`)
record('--aw-mono 已解析', typeof light?.mono === 'string' && light.mono !== '', String(light?.mono).slice(0, 70))
record('--aw-ink 已解析', typeof light?.ink === 'string' && light.ink !== '', light?.ink)
record('--aw-line 已解析', typeof light?.line === 'string' && light.line !== '', light?.line)
record('--aw-accent 已解析', typeof light?.accent === 'string' && light.accent !== '', light?.accent)
record('--aw-r-box 已解析', typeof light?.radius === 'string' && light.radius !== '', light?.radius)
// 变量必须能继承到子元素，否则子元素会静默用 fallback。
record('变量继承到子元素', light?.childSeesBg === light?.bg && light?.bg !== '',
  `child=${light?.childSeesBg}`)
console.log()

// 测量前必须**关掉过渡**。
//
// 实测：`.aw-btn` 等元素带 `transition: background .15s`，切换主题后
// `getComputedStyle().backgroundColor` 会停在**过渡起点**（上一个主题的值），
// 于是对比度断言量到的是"上一主题"的颜色，报出成片假失败。
// 关掉过渡后读数立刻正确 —— 这也是真实绘制最终呈现的值。
const killTransitions = () => ev(`(() => {
  let s = document.getElementById('aw-measure-no-transition')
  if (!s) {
    s = document.createElement('style')
    s.id = 'aw-measure-no-transition'
    s.textContent = '*{transition:none !important;animation:none !important}'
    document.head.appendChild(s)
  }
  return true
})()`)
const restoreTransitions = () => ev(`(() => {
  const s = document.getElementById('aw-measure-no-transition')
  if (s) s.remove()
  return true
})()`)

console.log('=== 3. 对比度：文字必须与其**自身背景**达标（WCAG AA 4.5:1） ===')
const contrast = await page.evaluate(`(() => {
  // 解析颜色。现代 Chrome 的 computed color 可能是 rgb()/rgba()，也可能是
  // color(srgb r g b)（token 用 color-mix 派生时就会出现）。两种都要认；
  // 认不出的返回 null 并**跳过**该元素，而不是抛异常把整段断言带崩
  // （早期版本就在这里抛了 TypeError，导致"0 个元素被检查"却只报一条失败）。
  const parse = (c) => {
    if (typeof c !== 'string' || c === '') return null
    let m = c.match(/rgba?\\(\\s*(\\d+)[,\\s]+(\\d+)[,\\s]+(\\d+)(?:\\s*[,/]\\s*([\\d.]+%?))?\\s*\\)/)
    if (m) return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : (String(m[4]).endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]) }
    m = c.match(/color\\(srgb\\s+([\\d.]+)\\s+([\\d.]+)\\s+([\\d.]+)(?:\\s*\\/\\s*([\\d.]+))?\\)/)
    if (m) return { r: +m[1] * 255, g: +m[2] * 255, b: +m[3] * 255, a: m[4] === undefined ? 1 : +m[4] }
    return null
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  // 任一参数解析不出就返回 null，调用方跳过。
  const ratio = (a, b) => {
    if (a === null || b === null) return null
    const l1 = lum(a), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  // 从**该元素自身**开始向上找第一个不透明背景。
  //
  // 这一步是关键：早期版本从 .aw-panel 开始找背景，于是「白底白字」的主按钮
  // 拿到的"背景"是深色面板，算出 17.45:1 判通过 —— 而按钮实际完全看不见。
  // 断言的参照系必须是元素自己的背景，不是面板的背景。
  const ownBg = (el) => {
    let cur = el
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor)
      if (c && c.a >= 0.95) return c
      cur = cur.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  const p = document.querySelector('.aw-panel')
  if (!p) return null
  const out = []
  for (const sel of ['.aw-head h2', '.aw-breadcrumb', '.aw-tab', '.aw-btn', '.aw-sub', '.aw-card']) {
    const el = p.querySelector(sel)
    if (!el) { out.push({ sel, missing: true }); continue }
    const r = ratio(parse(getComputedStyle(el).color), ownBg(el))
    out.push({ sel, fg: getComputedStyle(el).color, bg: getComputedStyle(el).backgroundColor,
      ratio: r === null ? null : +r.toFixed(2) })
  }
  // 全量护栏：面板里**每一个**按钮/标签的文字都要看得见。
  // 这条才是真正的保险 —— 上面具名清单漏掉哪个控件，它照样抓得住。
  const invisible = []
  let scanned = 0
  let skipped = 0
  for (const el of // 徽章与指标 chip 也承载信息（不是装饰），同样要能读 ——
    // 早期只扫按钮，于是浅色下几乎看不见的「非任务」徽章没人发现。
    p.querySelectorAll('button, .aw-tab, .aw-tab-sub, a.aw-skip, .aw-badge, .aw-metric')) {
    const text = (el.textContent || '').trim()
    if (text === '') continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0) continue
    // skip-link 平时在屏幕外（left:-9999px），不算可见控件。
    if (rect.left < 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue
    const fg = parse(cs.color)
    if (fg === null) { skipped++; continue }
    scanned++
    const r = ratio(fg, ownBg(el))
    if (r === null) { skipped++; continue }
    if (r < 4.5) invisible.push({ text: text.slice(0, 14), cls: String(el.className).slice(0, 30),
      color: cs.color, bg: cs.backgroundColor, ratio: +r.toFixed(2) })
  }
  return { bg: getComputedStyle(p).backgroundColor, items: out, invisible, scanned, skipped }
})()`)
console.log('  ', JSON.stringify(contrast))
let checked = 0
for (const item of contrast?.items ?? []) {
  if (item.missing) { console.log(`  --  ${item.sel} 不在当前页，跳过`); continue }
  if (item.ratio === null) { console.log(`  --  ${item.sel} 颜色无法解析，跳过（${item.fg}）`); continue }
  checked++
  record(`对比度 ${item.sel} ≥ 4.5`, item.ratio >= 4.5, `${item.ratio}:1`)
}
record('对比度至少检查了 2 个元素', checked >= 2, `实际 ${checked}`)
// 全量护栏：任何按钮/标签的文字看不见都是缺陷（白底白字、同色前景等）。
record(`面板内所有按钮文字可见（扫了 ${contrast?.scanned ?? 0} 个）`,
  (contrast?.invisible ?? []).length === 0,
  (contrast?.invisible ?? []).map((i) => `"${i.text}" ${i.ratio}:1 (${i.color} on ${i.bg})`).join('; ') || '无')
console.log()

console.log('=== 4. 键盘可达性 ===')
const kb = await page.evaluate(`(() => {
  const p = document.querySelector('.autoresearch-panel')
  const tabs = [...p.querySelectorAll('.aw-tab')]
  return {
    tabIsButton: tabs.every(b => b.tagName === 'BUTTON'),
    hasAriaCurrent: tabs.some(b => b.hasAttribute('aria-current')),
    navHasLabel: !!p.querySelector('.aw-tabs[aria-label]'),
    skipIsAnchor: p.querySelector('.aw-skip')?.tagName === 'A',
    contentTabIndex: p.querySelector('#aw-content')?.getAttribute('tabindex'),
  }
})()`)
console.log('  ', JSON.stringify(kb))
record('标签是真 button（可 Tab 可达）', kb?.tabIsButton === true)
record('当前页有 aria-current', kb?.hasAriaCurrent === true)
record('导航区有 aria-label', kb?.navHasLabel === true)
record('跳转链接是 <a>', kb?.skipIsAnchor === true)
console.log()

page.ws.close()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`DOM 断言：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(`  · ${f.name}`) }
process.exit(failed.length === 0 ? 0 : 1)
