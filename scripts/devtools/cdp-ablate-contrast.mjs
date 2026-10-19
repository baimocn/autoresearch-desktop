/**
 * 对比度断言的**消融实验** —— 证明它不是摆设。
 *
 * ## 为什么要做这个
 *
 * `cdp-assert-panel.mjs` 的对比度检查曾经有一个致命缺陷：它拿元素的文字色去比
 * **面板的背景色**，而不是元素**自己的**背景。于是 `.aw-btn[data-kind="primary"]`
 * （白底 + 白字）算出 17.45:1 判「通过」—— 而那个按钮在屏幕上完全是空白的。
 *
 * 修好参照系之后，还要证明这个检查真的抓得住这类缺陷，否则它可能只是换了个
 * 姿势继续骗自己。做法：往真实页面里注入一个**白底白字**的按钮，跑与断言
 * 完全相同的扫描逻辑，看它是否被抓出来。
 *
 * 一个永远返回「全部通过」的检查器，和一个没有检查器，效果是一样的。
 *
 * ## 用法
 *
 *   node scripts/devtools/cdp-ablate-contrast.mjs [cdpPort]
 *
 * 需要应用带 `--remote-debugging-port` 启动（Electron 默认不允许新建 target，
 * 本脚本附着到现有页面）。
 */

const port = process.argv[2] ?? '9223'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('4314'))
  ?? targets.find((t) => t.type === 'page')
if (page === undefined) {
  console.error('找不到可附着的页面；应用是否带 --remote-debugging-port 启动？')
  process.exit(1)
}

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: method }) }, 20000)
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    return { __exception: String(res.result.exceptionDetails.exception?.description).slice(0, 200) }
  }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 确保工作台面板已挂载：面板不在时所有元素 rect 为 0，扫描结果会是 0 个 ——
// 那是**假阴性**，会让人误以为「没问题」。
await evaluate(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const row = [...document.querySelectorAll('button[aria-label]')]
    .find((b) => b.getAttribute('aria-label') === 'AutoResearch')
  if (row) row.click()
  return true
})()`)
await sleep(2500)

const mounted = await evaluate(`document.querySelectorAll('.aw-panel button').length`)
if (!mounted || mounted === 0) {
  console.error('工作台面板未挂载（0 个按钮）—— 先打开侧边栏的 AutoResearch 再跑本脚本。')
  process.exit(1)
}
console.log(`面板已挂载，含 ${mounted} 个按钮\n`)

// 与 cdp-assert-panel.mjs 的扫描逻辑保持一致：文字色 vs **自身**背景色。
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
  const invisible = []
  let scanned = 0
  for (const el of p.querySelectorAll('button, .aw-tab, .aw-tab-sub, .aw-badge, .aw-metric')) {
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
      invisible.push({ text: text.slice(0, 16), color: cs.color, bg: cs.backgroundColor, ratio: +r.toFixed(2) })
    }
  }
  return { scanned, invisible }
})()`

// 1) 基线：真实页面不应有看不见的文字
const baseline = await evaluate(SCAN)
console.log('基线扫描:', JSON.stringify(baseline))

// 2) 注入白底白字按钮，同一个扫描必须抓出来
const injected = await evaluate(`(() => {
  const p = document.querySelector('.aw-panel')
  const probe = document.createElement('button')
  probe.className = 'aw-btn'
  probe.id = 'aw-ablation-probe'
  probe.textContent = '隐身按钮'
  // 直接写死内联样式，绕开 token —— 要复现的正是「填充色与文字色相同」这一形态。
  probe.style.background = 'rgb(249, 250, 251)'
  probe.style.color = 'rgb(249, 250, 251)'
  p.appendChild(probe)
  return true
})()`)
console.log('注入白底白字按钮:', injected)

const after = await evaluate(SCAN)
console.log('注入后扫描:', JSON.stringify(after))

// 清理：不留下测试元素
await evaluate(`(() => { const el = document.getElementById('aw-ablation-probe'); if (el) el.remove(); return true })()`)
const cleaned = await evaluate(`document.getElementById('aw-ablation-probe') === null`)

// ── 判定 ────────────────────────────────────────────────────────────────────
const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

console.log()
record('基线：真实页面没有看不见的文字', (baseline?.invisible ?? []).length === 0,
  (baseline?.invisible ?? []).map((i) => `"${i.text}" ${i.ratio}:1`).join('; ') || `${baseline?.scanned} 个按钮全部可见`)
record('消融：注入的白底白字被抓到',
  (after?.invisible ?? []).some((i) => i.text === '隐身按钮'),
  (after?.invisible ?? []).map((i) => `"${i.text}" ${i.ratio}:1 (${i.color} on ${i.bg})`).join('; '))
record('消融：扫描确实覆盖了注入的元素', (after?.scanned ?? 0) === (baseline?.scanned ?? 0) + 1,
  `${baseline?.scanned} → ${after?.scanned}`)
record('清理：测试元素已移除', cleaned === true)

const failed = results.filter((r) => !r.ok)
console.log(`\n对比度消融：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
ws.close()
process.exitCode = failed.length === 0 ? 0 : 1
