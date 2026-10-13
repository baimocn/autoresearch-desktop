/**
 * 消融实验：证明「修 token 名」这个改动是**因果必要**的，不是装饰。
 *
 * ## 要证伪的假设
 *
 * 「token 名写错没什么影响，反正有 fallback」。
 *
 * 做法：在真实页面上，把对的 token 定义换成**改之前那份错的**，
 * 再读 --aw-bg / --aw-line 的实际解析值。如果错的名字会让变量退回到
 * 写死的值，就证明这个修复真的改变了行为。
 *
 * 这是本项目一贯的做法：不能只说「我修好了」，要说清「不修会怎样」。
 *
 * 用法：node scripts/devtools/cdp-ablate-tokens.mjs <cdpPort> <url>
 */

const cdpPort = process.argv[2] ?? '9333'
const url = process.argv[3]
if (!url) { console.error('usage: cdp-ablate-tokens.mjs <cdpPort> <url>'); process.exit(1) }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const created = await (await fetch(
  `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(url)}`, { method: 'PUT' },
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

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

await sleep(4500)
await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label') === 'AutoResearch')
  if (row) row.click()
})()`)
await sleep(3000)

console.log('=== 消融：把 token 名换回改之前那份错的 ===')
const data = await evaluate(`(() => {
  const p = document.querySelector('.aw-panel')
  if (!p) return { error: 'panel not found' }

  // 1) 现状（修复后）
  const read = () => {
    const cs = getComputedStyle(p)
    return {
      bg: cs.getPropertyValue('--aw-bg').trim(),
      line: cs.getPropertyValue('--aw-line').trim(),
      ink: cs.getPropertyValue('--aw-ink').trim(),
    }
  }
  const fixed = read()

  // 2) DSH 是否真的定义了那几个错名字？
  const rcs = getComputedStyle(document.documentElement)
  const bcs = getComputedStyle(document.body)
  const readRoot = (n) => (rcs.getPropertyValue(n) || bcs.getPropertyValue(n) || '').trim()
  const defined = {
    'alias-bg-elevated': readRoot('--dsw-alias-bg-elevated'),
    'alias-border-secondary': readRoot('--dsw-alias-border-secondary'),
    'alias-bg-layer-1': readRoot('--dsw-alias-bg-layer-1'),
    'alias-border-l1': readRoot('--dsw-alias-border-l1'),
  }

  // 3) 在元素上覆盖成改之前的错误定义，观察解析结果
  p.style.setProperty('--aw-bg', 'var(--dsw-alias-bg-elevated, rgba(148,163,184,.055))')
  p.style.setProperty('--aw-line', 'var(--dsw-alias-border-secondary, rgba(148,163,184,.18))')
  const broken = read()

  // 4) 还原
  p.style.removeProperty('--aw-bg')
  p.style.removeProperty('--aw-line')
  const restored = read()

  return { fixed, broken, restored, defined }
})()`)

console.log('  ', JSON.stringify(data, null, 1))
console.log()

const d = data?.defined ?? {}
record('DSH 未定义 --dsw-alias-bg-elevated（名字是错的）', d['alias-bg-elevated'] === '',
  `解析值="${d['alias-bg-elevated']}"`)
record('DSH 未定义 --dsw-alias-border-secondary（名字是错的）', d['alias-border-secondary'] === '',
  `解析值="${d['alias-border-secondary']}"`)
record('DSH 定义了 --dsw-alias-bg-layer-1（名字是对的）', d['alias-bg-layer-1'] !== '',
  d['alias-bg-layer-1'])
record('DSH 定义了 --dsw-alias-border-l1（名字是对的）', d['alias-border-l1'] !== '',
  d['alias-border-l1'])
console.log()

record('修复后 --aw-bg 取到主题色', data?.fixed?.bg !== '' && data.fixed.bg === d['alias-bg-layer-1'],
  `${data?.fixed?.bg}`)
record('换回错名字后 --aw-bg 退化为写死值（证明修复必要）',
  data?.broken?.bg !== data?.fixed?.bg,
  `broken=${data?.broken?.bg} vs fixed=${data?.fixed?.bg}`)
record('换回错名字后 --aw-line 退化为写死值',
  data?.broken?.line !== data?.fixed?.line,
  `broken=${data?.broken?.line} vs fixed=${data?.fixed?.line}`)
record('还原后恢复主题色（无残留副作用）', data?.restored?.bg === data?.fixed?.bg,
  data?.restored?.bg)
console.log()

// 写死回退值的样子：不是主题色，而是那个 rgba(...) 字面量。
const brokenBg = String(data?.broken?.bg ?? '')
record('退化值确实是写死的浅灰（rgba 字面量）而非主题色',
  brokenBg.includes('148') || /rgba?\(/.test(brokenBg), brokenBg)

ws.close()
console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`token 消融：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) { console.log('失败项：'); for (const f of failed) console.log(`  · ${f.name}`) }
process.exit(failed.length === 0 ? 0 : 1)
