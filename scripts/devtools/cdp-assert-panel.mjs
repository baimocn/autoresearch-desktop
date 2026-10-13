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
  const created = await (await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`, { method: 'PUT' },
  )).json()
  const ws = new WebSocket(created.webSocketDebuggerUrl)
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

console.log('=== 3. 对比度：正文可读性必须达标（WCAG AA 4.5:1） ===')
const contrast = await page.evaluate(`(() => {
  const parse = (c) => {
    const m = c.match(/rgba?\\((\\d+),\\s*(\\d+),\\s*(\\d+)(?:,\\s*([\\d.]+))?\\)/)
    return m ? { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] } : null
  }
  const lum = ({ r, g, b }) => {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
  }
  const ratio = (a, b) => {
    const l1 = lum(a), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
  // 找到面板背后真实的不透明背景
  const opaqueBg = (el) => {
    let cur = el
    while (cur) {
      const c = parse(getComputedStyle(cur).backgroundColor)
      if (c && c.a >= 0.95) return c
      cur = cur.parentElement
    }
    return { r: 255, g: 255, b: 255, a: 1 }
  }
  const p = document.querySelector('.aw-panel')
  const bg = opaqueBg(p)
  const out = []
  // 只断言**当前页面确实存在**的元素。.aw-sub 只出现在阶段/门禁页，
  // 在任务组合页不存在 —— 断言不存在的元素会得到假失败。
  for (const sel of ['.aw-head h2', '.aw-breadcrumb', '.aw-tab', '.aw-btn']) {
    const el = document.querySelector('.aw-panel ' + sel)
    if (!el) { out.push({ sel, missing: true }); continue }
    const fg = parse(getComputedStyle(el).color)
    out.push({ sel, fg: getComputedStyle(el).color, ratio: +ratio(fg, bg).toFixed(2) })
  }
  return { bg: getComputedStyle(p).backgroundColor, items: out }
})()`)
console.log('  ', JSON.stringify(contrast))
let checked = 0
for (const item of contrast?.items ?? []) {
  if (item.missing) { console.log(`  --  ${item.sel} 不在当前页，跳过`); continue }
  checked++
  record(`对比度 ${item.sel} ≥ 4.5`, item.ratio >= 4.5, `${item.ratio}:1`)
}
record('对比度至少检查了 2 个元素', checked >= 2, `实际 ${checked}`)
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
