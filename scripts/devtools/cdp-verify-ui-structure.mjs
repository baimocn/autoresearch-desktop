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

// 两级导航：一级是「推进 / 核查 / 任务组合 / API 配置」，二级（模式/四阶段/…）
// 只在所属分组被选中时才出现在 DOM 里。所以点二级标签前必须先把它的分组点亮 ——
// 早期版本只找 `.aw-tab`，于是「模式」永远点不到（返回 false），
// 而巡检又拿同一个页面量了七次、全部报 OK（典型的假通过）。
const GROUP_OF = {
  '模式': '推进', '四阶段': '推进', '门禁': '推进',
  '轨迹': '核查', '双路质检': '核查', '远端实验': '核查', '证据浏览': '核查',
}
const tabClick = (label) => `(() => {
  const byText = (sel) => [...document.querySelectorAll(sel)]
    .find((b) => b.textContent.trim() === ${JSON.stringify(label)})
  const top = byText('.aw-tab:not(.aw-tab-sub)')
  if (top) { top.click(); return 'top' }
  const sub = byText('.aw-tab-sub')
  if (sub) { sub.click(); return 'sub' }
  const group = [...document.querySelectorAll('.aw-tab:not(.aw-tab-sub)')]
    .find((g) => g.textContent.trim() === ${JSON.stringify(GROUP_OF[label] ?? '__none__')})
  if (!group) return false
  group.click()
  return 'group-only'
})()`

/** 二级标签要点两次：先切分组（渲染出二级行），再点子标签。 */
async function clickTab(label) {
  const first = await evaluate(tabClick(label))
  if (first === 'group-only') {
    await sleep(800)
    return evaluate(tabClick(label))
  }
  return first
}

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
console.log('click 模式:', await clickTab('模式'))
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
  await clickTab(label)
  await sleep(1600)
  const state = await evaluate(`(() => {
    const panel = document.querySelector('.autoresearch-panel')
    const text = panel ? panel.innerText.trim() : ''
    // 同时取「当前点亮的标签」—— 用它证明**确实切过去了**。
    // 只断言"页面非空"是不够的：七个页面量到同一份内容也会全部报 OK。
    const on = [...document.querySelectorAll('.aw-tab-sub, .aw-tab')]
      .filter((b) => b.getAttribute('data-on') === '1')
      .map((b) => b.textContent.trim())
    return { len: text.length, on }
  })()`)
  const switched = (state?.on ?? []).includes(label)
  report.push(`${label}: ${switched && state.len > 0 ? 'OK' : 'FAIL(未切换)'} (${state?.len})`)
}
console.log(report.join(' | '))

const errors = await evaluate(`window.__awErrors ?? null`)
console.log('page errors:', JSON.stringify(errors))
ws.close()
