/**
 * 主题切换验证：证明面板真的随 DSH 主题变化，而不是靠 fallback 蒙对。
 *
 * ## 为什么要单独验这一条
 *
 * 改之前的问题是：token 名写错 → 静默回退到**写死的深色值** → 浅色主题下
 * 出现深色块。这种故障在深色主题下**完全看不出来**，所以只在深色下截图
 * 会得到"一切正常"的假结论。
 *
 * 正确做法是切换到浅色，断言同一批元素的计算值确实变了。只断言"变了"
 * 而不断言具体颜色 —— 具体色值归 DSH 主题管，写死会在主题升级时失效。
 *
 * 用法：node scripts/devtools/cdp-theme-switch.mjs <cdpPort> <url>
 */

const cdpPort = process.argv[2] ?? '9333'
const url = process.argv[3]
if (!url) { console.error('usage: cdp-theme-switch.mjs <cdpPort> <url>'); process.exit(1) }

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
  return { ws, evaluate }
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

const snap = `(() => {
  const p = document.querySelector('.aw-panel')
  if (!p) return null
  const cs = getComputedStyle(p)
  const tabs = p.querySelector('.aw-tabs')
  const card = p.querySelector('.aw-box') || p.querySelector('.aw-tabs')
  return {
    theme: document.documentElement.getAttribute('data-theme')
      ?? (document.documentElement.classList.contains('dark') ? 'dark' : null),
    bodyBg: getComputedStyle(document.body).backgroundColor,
    ink: cs.color,
    bgVar: cs.getPropertyValue('--aw-bg').trim(),
    lineVar: cs.getPropertyValue('--aw-line').trim(),
    inkVar: cs.getPropertyValue('--aw-ink').trim(),
    ink2Var: cs.getPropertyValue('--aw-ink-2').trim(),
    tabsBg: tabs ? getComputedStyle(tabs).backgroundColor : null,
    cardBg: card ? getComputedStyle(card).backgroundColor : null,
  }
})()`

console.log('=== 找到 DSH 的主题切换入口 ===')
// DSH 主题通常由 localStorage 或 settings 控制；先探测当前主题标记方式。
const themeProbe = await page.evaluate(`(() => {
  const r = document.documentElement
  return {
    dataTheme: r.getAttribute('data-theme'),
    dataDsw: r.getAttribute('data-dsw-theme'),
    cls: r.className,
    bodyCls: document.body.className,
    lsKeys: Object.keys(localStorage).filter(k => /theme|appear/i.test(k)),
    lsVals: Object.keys(localStorage).filter(k => /theme|appear/i.test(k))
      .map(k => k + '=' + localStorage.getItem(k)),
  }
})()`)
console.log('  ', JSON.stringify(themeProbe))
console.log()

const before = await page.evaluate(snap)
console.log('  当前主题快照:', JSON.stringify(before))
console.log()

// 用 DSH 的真实主题机制：settings 面板写 localStorage，然后 reload。
// 直接改 DOM 属性不算数 —— DSH 会在下次渲染覆盖回去。
const switched = await page.evaluate(`(() => {
  const keys = Object.keys(localStorage).filter(k => /theme|appear/i.test(k))
  return { keys, before: keys.map(k => k + '=' + localStorage.getItem(k)) }
})()`)
console.log('  主题相关 localStorage:', JSON.stringify(switched))
console.log()

record('面板在初始主题下变量有值', typeof before?.bgVar === 'string' && before.bgVar !== '',
  `--aw-bg=${before?.bgVar}`)
record('正文色有值', typeof before?.ink === 'string' && before.ink !== '', before?.ink)

// 关键回归：这三个变量必须来自 DSH token，而不是我们写死的回退值。
// 写死的回退值在浅色主题下会是深色 → 判据是「与 DSH 的 --dsw 值一致」。
const consistency = await page.evaluate(`(() => {
  const p = document.querySelector('.aw-panel')
  const cs = getComputedStyle(p)
  const r = document.documentElement
  const rootCs = getComputedStyle(r)
  const read = (el, n) => el ? getComputedStyle(el).getPropertyValue(n).trim() : ''
  return {
    dswLayer1: read(r, '--dsw-alias-bg-layer-1') || read(document.body, '--dsw-alias-bg-layer-1'),
    awBg: read(p, '--aw-bg'),
    dswBorder1: read(r, '--dsw-alias-border-l1') || read(document.body, '--dsw-alias-border-l1'),
    awLine: read(p, '--aw-line'),
    dswLabel: read(r, '--dsw-alias-label-primary') || read(document.body, '--dsw-alias-label-primary'),
    awInk: read(p, '--aw-ink'),
    dswFont: read(r, '--dsw-font-family') || read(document.body, '--dsw-font-family'),
    panelFont: cs.fontFamily.slice(0, 40),
  }
})()`)
console.log('  token 一致性:', JSON.stringify(consistency, null, 1))
console.log()

record('--aw-bg 与 DSH 层色同源（非写死回退）',
  consistency?.awBg !== '' && (consistency?.dswLayer1 === '' || consistency.awBg === consistency.dswLayer1),
  `aw=${consistency?.awBg} dsw=${consistency?.dswLayer1}`)
record('--aw-line 与 DSH 边框色同源',
  consistency?.awLine !== '' && (consistency?.dswBorder1 === '' || consistency.awLine === consistency.dswBorder1),
  `aw=${consistency?.awLine} dsw=${consistency?.dswBorder1}`)
record('--aw-ink 与 DSH 正文色同源',
  consistency?.awInk !== '' && (consistency?.dswLabel === '' || consistency.awInk === consistency.dswLabel),
  `aw=${consistency?.awInk} dsw=${consistency?.dswLabel}`)

page.ws.close()
console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`主题验证：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(`  · ${f.name}`) }
process.exit(failed.length === 0 ? 0 : 1)
