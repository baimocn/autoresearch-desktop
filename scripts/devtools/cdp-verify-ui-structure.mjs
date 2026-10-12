// 结构验收：默认根不再以卡片出现（改提示条）+ 未选任务点详情页给选择器。
// 用法：node scripts/devtools/cdp-verify-ui-structure.mjs [port] [outPrefix]
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9223'
const outPrefix = process.argv[3] ?? '_vision_test/ui-structure'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('43141')) ?? targets.find((t) => t.type === 'page')
if (!page) { console.error('no page target'); process.exit(1) }

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
  // 每次调用都要有超时：页面在导航/重渲染时可能永远不回响应，脚本会静默挂死
  // （实测踩过：日志停在某个调用之前，进程还在跑，看现象像「UI 卡住了」）。
  const timer = setTimeout(() => {
    pending.delete(id)
    console.warn(`  [warn] CDP 调用超时：${method}`)
    resolve({ __timeout: method })
  }, 15000)
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
  ws.send(JSON.stringify({ id, method, params }))
})
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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await send('Page.enable')
// 默认不 reload：Electron 页 reload 后 target 会换 execution context，实测还会把
// 整个 app 带走（第一次跑完 9223 直接没了）。新装 profile 后重启 Electron 即可。
if (process.argv.includes('--reload')) {
  await send('Page.reload', { ignoreCache: true })
  await sleep(6000)
}
await sleep(3000)

const open = await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === 'AutoResearch')
  if (!row) return { opened: false }
  row.click()
  return { opened: true }
})()`)
console.log('open panel:', JSON.stringify(open))
await sleep(2500)

const tabClick = (label) => `(() => {
  const btn = [...document.querySelectorAll('.aw-tab')].find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  if (!btn) return false
  btn.click()
  return true
})()`

// ── 1. 任务组合页：默认根应落在提示条里，不出现在卡片网格 ──────────────────
const tasksPage = await evaluate(`(() => {
  const grid = document.querySelector('.aw-grid')
  const cardPaths = grid ? [...grid.querySelectorAll('.aw-card code')].map((c) => c.textContent) : []
  const hint = document.querySelector('.aw-hintbar')
  return {
    cardCount: grid ? grid.querySelectorAll('.aw-card').length : 0,
    cardPaths,
    hintText: hint ? hint.textContent : null,
    pickCount: document.querySelectorAll('.aw-pick').length,
  }
})()`)
console.log('任务组合页:', JSON.stringify(tasksPage, null, 2))
await screenshot(`${outPrefix}-tasks.png`)

// ── 2. 未选任务直接点「模式」：应出现任务选择器，而不是默认根详情 ────────────
console.log('click 模式:', await evaluate(tabClick('模式')))
await sleep(2200)
const modeNoTask = await evaluate(`(() => ({
  pickCount: document.querySelectorAll('.aw-pick').length,
  pickNames: [...document.querySelectorAll('.aw-pick b')].map((b) => b.textContent),
  heading: document.querySelector('.aw-sec h3')?.textContent ?? null,
  hasEmpty: document.querySelector('.aw-empty') !== null,
  emptyTitle: document.querySelector('.aw-empty b')?.textContent ?? null,
  showingTaskBanner: document.body.textContent.includes('查看中的任务'),
}))()`)
console.log('模式页（未选任务）:', JSON.stringify(modeNoTask, null, 2))
await screenshot(`${outPrefix}-pick.png`)

// ── 3. 从选择器点一个任务 → 进入详情 ────────────────────────────────────────
const picked = await evaluate(`(() => {
  const first = document.querySelector('.aw-pick')
  if (!first) return null
  const name = first.querySelector('b')?.textContent ?? null
  first.click()
  return name
})()`)
console.log('pick:', picked)
await sleep(2600)
const detail = await evaluate(`(() => ({
  hasPicker: document.querySelector('.aw-pick') !== null,
  banner: document.querySelector('.aw-box code')?.textContent ?? null,
  sections: [...document.querySelectorAll('.aw-sec h3')].map((h) => h.textContent),
}))()`)
console.log('详情页:', JSON.stringify(detail, null, 2))
await screenshot(`${outPrefix}-detail.png`)

// ── 4. 逐页巡检：每页应有内容且无 JS 异常 ──────────────────────────────────
const report = []
for (const label of ['四阶段', '门禁', '轨迹', '双路质检', '远端实验', '证据浏览', 'API 配置']) {
  await evaluate(tabClick(label))
  await sleep(1600)
  const state = await evaluate(`(() => {
    const panel = document.querySelector('.autoresearch-panel')
    const text = panel ? panel.innerText.trim() : ''
    return { len: text.length, head: text.slice(0, 40).replace(/\\s+/g, ' ') }
  })()`)
  report.push(`${label}: ${state.len > 0 ? 'OK' : 'EMPTY'} (${state.len})`)
}
console.log(report.join(' | '))

const errors = await evaluate(`window.__awErrors ?? null`)
console.log('page errors:', JSON.stringify(errors))
ws.close()
