// 验证轨迹页的四项修复在真实渲染中生效。
// 用法：node scripts/devtools/cdp-verify-trajectory.mjs [port] [shot.png]
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9222'
const shotPath = process.argv[3] ?? 'trajectory-shot.png'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) { console.error('no page target'); process.exit(1) }

const ws = new WebSocket(page.webSocketDebuggerUrl)
await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })
let seq = 0
const pending = new Map()
const consoleErrors = []
ws.onmessage = (event) => {
  const msg = JSON.parse(event.data)
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push(msg.params.args?.map((a) => a.value ?? a.description ?? '').join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(msg.params?.exceptionDetails?.exception?.description ?? 'exception')
  }
  if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
}
const send = (method, params = {}) => new Promise((resolve) => {
  const id = ++seq
  pending.set(id, resolve)
  ws.send(JSON.stringify({ id, method, params }))
})
const evaluate = async (expression) => {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) return { __exception: res.result.exceptionDetails.exception?.description }
  return res.result?.result?.value
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

await send('Runtime.enable')
await sleep(4500)

console.log('=== 打开工作台 → 核查 → 轨迹 ===')
// 一级导航：侧边栏行
await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === 'AutoResearch')
  row?.click(); return true
})()`)
await sleep(2000)

// 先回到「任务组合」列表，保证从确定状态出发 ——
// 面板可能停在上一次验收留下的详情页，那时没有 .aw-card，脚本会误判失败。
await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.aw-tab')].find((b) => b.textContent === '任务组合')
  tab?.click(); return true
})()`)
await sleep(1800)

// 打开 AutoRe1841 任务（它有三项要验的：标定常数 / 双轨未开跑 / 未出分）
const opened = await evaluate(`(() => {
  const card = [...document.querySelectorAll('.aw-card')].find((c) => c.textContent.includes('AutoRe1841'))
  if (card === undefined) return { opened: false, titles: [...document.querySelectorAll('.aw-card h3')].map((h) => h.textContent) }
  const btn = [...card.querySelectorAll('button')].find((b) => b.textContent === '查看详情')
  if (btn === undefined) return { opened: false, why: 'no 查看详情 button' }
  btn.click(); return { opened: true }
})()`)
check('打开 AutoRe1841 详情', opened?.opened === true,
  opened?.opened === false ? JSON.stringify(opened).slice(0, 240) : undefined)
await sleep(1500)

// 标签是**两级**：先「核查」分组，再其下的「轨迹」子页。
// 只点一级不会出现二级标签 —— 早先的脚本漏了这一步。
const groupClicked = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.aw-tab')].find((b) => b.textContent === '核查')
  if (tab === undefined) return false
  tab.click(); return true
})()`)
check('切到「核查」分组', groupClicked === true)
await sleep(900)

const tabbed = await evaluate(`(() => {
  const tab = [...document.querySelectorAll('.aw-tab')].find((b) => b.textContent === '轨迹')
  if (tab === undefined) return { ok: false, tabs: [...document.querySelectorAll('.aw-tab')].map((b) => b.textContent) }
  tab.click(); return { ok: true }
})()`)
check('切到「轨迹」子页', tabbed?.ok === true,
  tabbed?.ok === false ? JSON.stringify(tabbed.tabs) : undefined)
await sleep(2000)

// 默认轨是 codex；AutoRe1841 的 codex 是空文件，轮次全在 seed 轨。
// 不切轨就只会看到「暂无轮次记录」，验不到计数与表格。
const switched = await evaluate(`(() => {
  const btn = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Seed 2.1 Turbo'))
  if (btn === undefined) return { ok: false, buttons: [...document.querySelectorAll('button')].map((b) => b.textContent).slice(0, 20) }
  btn.click(); return { ok: true }
})()`)
check('切到 seed 轨（轮次在该轨）', switched?.ok === true,
  switched?.ok === false ? JSON.stringify(switched.buttons).slice(0, 200) : undefined)
await sleep(2500)

const view = await evaluate(`(() => {
  const main = document.querySelector('.aw-content')
  return main === null ? null : main.innerText
})()`)
const text = typeof view === 'string' ? view : ''

// 这些文件**正在被出题会话实时改写**（实测：验收过程中轨迹从 10 轮变 11 轮、
// 标定常数被清成 null）。所以断言必须**以接口返回为准**，不能写死数据条件 ——
// 否则数据一变，测试就从「验证 UI」变成「验证某个快照」。
const routeData = await evaluate(`(async () => {
  const task = document.querySelector('.aw-taskbar code')?.textContent ?? ''
  const track = [...document.querySelectorAll('button')].find((b) => b.textContent.includes('Seed 2.1 Turbo'))
    ? 'seed' : 'codex'
  const res = await fetch('/api/autoresearch/trajectory?track=' + track + '&task=' + encodeURIComponent(task),
    { credentials: 'same-origin' })
  return await res.json()
})()`)
const stats = routeData?.stats ?? {}
const calibrationCount = Object.keys(routeData?.calibrationFlags ?? {}).length

check('① 双轨未开跑时标注「双轨尚未开跑」',
  routeData?.dualTrack?.started === false ? text.includes('双轨尚未开跑') : true,
  `接口 started=${routeData?.dualTrack?.started}`)
check('② 「未出分」作为独立指标（不与失败混同）',
  text.includes('未出分'), `接口 noScore=${stats.noScore}`)
// failed=0 时页面不应出现红色「失败」指标 —— 这正是本次修复的核心：
// blocked_no_compute / *_no_run 这类诚实状态不再被计成失败。
check('② 诚实状态不再计成失败', stats.failed === 0 ? !text.includes('失败') : text.includes('失败'),
  `接口 failed=${stats.failed}`)
check('③ 展示轮次状态分布', text.includes('轮次状态'),
  Object.keys(stats.statusKinds ?? {}).length + ' 种状态')
check('④ 最佳分标注指标方向', /最佳分（(maximize|minimize|方向未知)）/.test(text),
  (text.match(/最佳分（[^）]*）/) ?? ['(未找到)'])[0])

// 标定常数标注：仅当接口确实报了标定常数时才要求页面标出；
// 否则要求**不出现**该标注（避免无中生有）。
if (calibrationCount > 0) {
  check('⑤ 标出 score 是标定常数（接口报了 ' + calibrationCount + ' 轮）',
    text.includes('标定常数'))
  check('⑤ 提示该轨无真实得分', routeData?.calibrationOnly === true ? text.includes('无真实得分') : true)
} else {
  console.log(`  skip  ⑤ 标定常数标注 —— 当前数据无标定常数（接口 calibrationFlags=0）`)
  console.log('        （机制由 scripts/selftest-trajectory.mjs 用合成数据覆盖）')
  check('⑤ 无标定常数时不得无中生有', !text.includes('无真实得分'))
}

console.log('\n=== 控制台错误 ===')
const real = consoleErrors.filter((l) => l && !l.includes('DevTools'))
check('无未捕获异常', real.length === 0, real.slice(0, 2).join(' | '))

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  console.log(`\n截图：${shotPath}`)
}
ws.close()
const failed = results.filter((r) => !r.ok)
console.log(`\n轨迹页验收：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
