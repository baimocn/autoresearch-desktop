// 验证面板入口与挂载：查侧边栏行 → 点击 → 查 .autoresearch-panel → 截图。
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9222'
const shotPath = process.argv[3] ?? 'panel-shot.png'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('43141'))
  ?? targets.find(t => t.type === 'page')
if (!page) { console.error('no page target', targets.map(t => `${t.type} ${t.url}`)); process.exit(1) }

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
const sleep = (ms) => new Promise(r => setTimeout(r, ms))

// 1. 等待应用挂载完成，列出侧边栏面板行
await sleep(4000)
const nav = await evaluate(`(() => {
  const rows = [...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label'))
  return { rows: [...new Set(rows)], hasPanel: !!document.querySelector('.autoresearch-panel') }
})()`)
console.log('sidebar rows:', JSON.stringify(nav))

// 2. 点击 AutoResearch 行
const clicked = await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label') === 'AutoResearch')
  if (!row) return { clicked: false, why: 'row not found' }
  row.click()
  return { clicked: true }
})()`)
console.log('click:', JSON.stringify(clicked))

await sleep(3500)
const after = await evaluate(`(() => {
  const panel = document.querySelector('.autoresearch-panel')
  return {
    hasPanel: !!panel,
    panelText: panel ? panel.textContent.slice(0, 400) : null,
    activeAria: [...document.querySelectorAll('button[aria-current="page"]')].map(b => b.getAttribute('aria-label')),
  }
})()`)
console.log('after click:', JSON.stringify(after, null, 2))

// 3. 截图
const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  console.log('screenshot:', shotPath)
}
ws.close()
process.exit(0)
