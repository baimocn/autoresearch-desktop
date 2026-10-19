/**
 * 双主题对比度体检 —— 扫面板里所有承载信息的元素（按钮、标签、徽章、指标 chip）。
 *
 * 用法：node scripts/devtools/cdp-contrast-both-themes.mjs [cdpPort]
 */
const port = process.argv[2] ?? '9223'
const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('4314'))
const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j })
let seq = 0
const pending = new Map()
ws.onmessage = (e) => { const m = JSON.parse(e.data); if (m.id && pending.has(m.id)) pending.get(m.id)(m) }
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq
  const t = setTimeout(() => { pending.delete(id); res({}) }, 20000)
  pending.set(id, (m) => { clearTimeout(t); res(m) })
  ws.send(JSON.stringify({ id, method, params }))
})
const ev = async (x) => {
  const r = await send('Runtime.evaluate', { expression: x, awaitPromise: true, returnByValue: true })
  if (r.result?.exceptionDetails) return { __exc: String(r.result.exceptionDetails.exception?.description).slice(0, 180) }
  return r.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

const SCAN = `(() => {
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
  const ratio = (a, b) => {
    if (a === null || b === null) return null
    const l1 = lum(a), l2 = lum(b)
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05)
  }
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
  if (!p) return { missing: true }
  const low = []
  let scanned = 0
  for (const el of p.querySelectorAll('button, .aw-tab, .aw-tab-sub, .aw-badge, .aw-metric, .aw-hintbar code')) {
    const text = (el.textContent || '').trim()
    if (text === '') continue
    const rect = el.getBoundingClientRect()
    if (rect.width === 0 || rect.height === 0 || rect.left < 0) continue
    const cs = getComputedStyle(el)
    if (cs.visibility === 'hidden' || cs.opacity === '0') continue
    const fg = parse(cs.color)
    if (fg === null) continue
    scanned++
    const r = ratio(fg, ownBg(el))
    if (r !== null && r < 4.5) {
      low.push({ text: text.slice(0, 16), cls: String(el.className).slice(0, 26),
        color: cs.color, bg: cs.backgroundColor, ratio: +r.toFixed(2) })
    }
  }
  return { scanned, low, theme: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light' }
})()`

await ev(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const row = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === 'AutoResearch')
  if (row) row.click()
  return true
})()`)
await sleep(2500)

const results = []
for (const theme of ['dark', 'light']) {
  await ev(`(() => {
    if (${JSON.stringify(theme)} === 'dark') document.body.setAttribute('data-ds-dark-theme', '')
    else document.body.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)}
    return true
  })()`)
  await sleep(900)
  await killTransitions()
  await sleep(200)
  const out = await ev(SCAN)
  console.log(`\n[${theme}] 扫描 ${out?.scanned ?? 0} 个元素`)
  if ((out?.low ?? []).length === 0) {
    console.log('  全部 ≥ 4.5:1')
    results.push({ theme, ok: true })
  } else {
    for (const i of out.low) {
      console.log(`  ✗ "${i.text}" ${i.ratio}:1  ${i.color} on ${i.bg}  (${i.cls})`)
    }
    results.push({ theme, ok: false, count: out.low.length })
  }
}

await ev(`(() => { document.body.setAttribute('data-ds-dark-theme', ''); document.documentElement.style.colorScheme = 'dark'; return true })()`)
await restoreTransitions()
const bad = results.filter((r) => !r.ok)
console.log(`\n双主题对比度：${results.length - bad.length} 通过，${bad.length} 失败，共 ${results.length} 项`)
ws.close()
