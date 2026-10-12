// 工作台验收：API 路由（组合层/探测）+ UI 交互（卡片/详情切换）+ 截图。
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9222'
const outPrefix = process.argv[3] ?? '_vision_test/wb'
const alphaPath = process.argv[4] ?? ''

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('43141')) ?? targets.find(t => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
function send(method, params = {}) {
  const id = ++seq
  return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
}
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    return { __exception: res.result.exceptionDetails.exception?.description ?? JSON.stringify(res.result.exceptionDetails) }
  }
  return res.result?.result?.value
}
async function screenshot(path) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) { writeFileSync(path, Buffer.from(shot.result.data, 'base64')); console.log('shot:', path) }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

await sleep(4000)

// 0. 面板是 keyed 槽：先点侧边栏 AutoResearch 行才会挂载。
const open = await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label') === 'AutoResearch')
  if (!row) return { opened: false }
  row.click()
  return { opened: true }
})()`)
console.log('open panel:', JSON.stringify(open))
await sleep(2500)

// 1. 宿主路由验收（在已认证页面上下文里 fetch）
const api = await evaluate(`(async () => {
  const out = {}
  const alpha = ${JSON.stringify(alphaPath)}
  const get = async (p) => { const r = await fetch('/api/autoresearch' + p, { credentials: 'same-origin' }); return { status: r.status, body: await r.json() } }
  const tasks = await get('/tasks')
  out.tasksStatus = tasks.status
  out.cards = (tasks.body.cards ?? []).map(c => ({ name: c.name, phase: c.phase?.id, blocking: c.gates?.blocking?.length ?? 0, missing: c.missingRequiredCount, cal: c.calibration ? { B: c.calibration.baseline, R: c.calibration.reference, U: c.calibration.upper, dir: c.calibration.direction } : null, recent: c.trajectory?.codex?.recent ?? null, err: c.error }))
  out.defaultRoot = tasks.body.defaultTaskRoot
  out.modeAlpha = alpha ? (await get('/mode?task=' + encodeURIComponent(alpha))).body.phase : 'skipped'
  return out
})()`)
console.log('API:', JSON.stringify(api, null, 1))

// 2. 登记 alpha 任务（若提供路径且尚未登记）
if (alphaPath) {
  const added = await evaluate(`(async () => {
    const r = await fetch('/api/autoresearch/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'same-origin', body: JSON.stringify({ action: 'add', path: ${JSON.stringify(alphaPath)} }) })
    return { status: r.status, body: await r.json() }
  })()`)
  console.log('add:', JSON.stringify(added).slice(0, 200))
  await sleep(800)
}

// 3. UI：等面板渲染，截图任务列表
await sleep(2500)
const ui1 = await evaluate(`(() => ({
  panel: !!document.querySelector('.autoresearch-panel'),
  cards: [...document.querySelectorAll('.aw-card h3')].map(e => e.textContent),
  tabs: [...document.querySelectorAll('.aw-tab')].map(e => e.textContent),
}))()`)
console.log('UI tasks:', JSON.stringify(ui1))
await screenshot(`${outPrefix}-tasks.png`)

// 4. 点开第一张卡进详情（模式页）
await evaluate(`(() => { document.querySelector('.aw-card .aw-btn[data-kind="primary"]')?.click(); return true })()`)
await sleep(2500)
const ui2 = await evaluate(`(() => ({
  tab: [...document.querySelectorAll('.aw-tab[data-on="1"]')].map(e => e.textContent),
  strip: document.querySelector('.aw-box code')?.textContent?.slice(0, 80) ?? null,
  stepper: document.querySelectorAll('.aw-step').length,
  gateRows: [...document.querySelectorAll('.aw-row')].length,
}))()`)
console.log('UI detail:', JSON.stringify(ui2))
await screenshot(`${outPrefix}-detail.png`)

// 5. 切到远端实验页
await evaluate(`(() => { [...document.querySelectorAll('.aw-tab')].find(e => e.textContent === '远端实验')?.click(); return true })()`)
await sleep(2000)
const ui3 = await evaluate(`(() => ({
  empty: document.querySelector('.aw-empty b')?.textContent ?? null,
  scopeButtons: [...document.querySelectorAll('.aw-btn')].slice(0, 4).map(e => e.textContent),
}))()`)
console.log('UI remote:', JSON.stringify(ui3))
await screenshot(`${outPrefix}-remote.png`)

ws.close()
process.exit(0)
