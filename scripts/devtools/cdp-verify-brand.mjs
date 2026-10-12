// 身份层验收：侧边栏品牌位是否已接管 + 「关于」设置页是否注册 + 截图。
// 用法：node scripts/devtools/cdp-verify-brand.mjs [port] [outPrefix]
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9223'
const outPrefix = process.argv[3] ?? '_vision_test/brand'

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
  // 每次调用都要有超时：点开设置可能触发导航/上下文重建，此时 CDP 的响应永远
  // 不会回来，脚本会静默挂死（实测踩过 —— 日志停在调用之前，进程却还在）。
  const timer = setTimeout(() => {
    pending.delete(id)
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

await sleep(5000)

// ── 1. 模块是否被加载 ───────────────────────────────────────────────────────
const mod = await evaluate(`(() => {
  const boot = window.__DSH_BOOT__
  const entries = boot?.entries ?? []
  const row = entries.find((e) => String(e.id ?? '').includes('ars-brand'))
  return { found: row !== undefined, ids: entries.map((e) => e.id).filter((id) => String(id).includes('ars') || String(id).includes('brand')) }
})()`)
console.log('模块注册:', JSON.stringify(mod))

// ── 2. 侧边栏品牌位 ────────────────────────────────────────────────────────
const brand = await evaluate(`(() => {
  const main = document.querySelector('.ars-wordmark-main')
  const chip = document.querySelector('.ars-wordmark-chip')
  const sidebar = document.querySelector('aside, nav, [class*="sidebar"]')
  const text = sidebar ? sidebar.innerText.split('\\n').slice(0, 6).join(' | ') : null
  return {
    markPresent: document.querySelector('.ars-wordmark') !== null,
    main: main ? main.textContent : null,
    chip: chip ? chip.textContent : null,
    stillOfficial: /deepseek|HARNESS/i.test(sidebar ? sidebar.innerText : ''),
    sidebarHead: text,
  }
})()`)
console.log('侧边栏品牌:', JSON.stringify(brand, null, 2))
await screenshot(`${outPrefix}-sidebar.png`)

// ── 3. 「关于」设置页 ──────────────────────────────────────────────────────
const opened = await evaluate(`(() => {
  // 精确定位侧栏底部的设置触发器：先按 aria-label 全等，再退化为文本全等。
  // 用「包含」匹配会命中对话流里带「设置」字样的按钮（实测踩过）。
  const all = [...document.querySelectorAll('button')]
  const btn = all.find((b) => b.getAttribute('aria-label') === '设置')
    ?? all.find((b) => b.textContent.trim() === '设置')
    ?? all.find((b) => /^(设置|Settings)$/.test((b.getAttribute('aria-label') ?? '').trim()))
  if (!btn) return { clicked: false, candidates: all.map((b) => (b.getAttribute('aria-label') ?? b.textContent).trim()).filter((t) => t.includes('设置')).slice(0, 5) }
  btn.click()
  return { clicked: true, label: (btn.getAttribute('aria-label') ?? btn.textContent).trim() }
})()`)
console.log('打开设置:', JSON.stringify(opened))
await sleep(2200)

const nav = await evaluate(`(() => {
  const items = [...document.querySelectorAll('[role="tab"], button, li')]
    .map((n) => n.textContent.trim()).filter((t) => t.length > 0 && t.length < 12)
  return { hasAbout: items.includes('关于'), sample: [...new Set(items)].slice(0, 18) }
})()`)
console.log('设置导航:', JSON.stringify(nav, null, 2))

const clicked = await evaluate(`(() => {
  const el = [...document.querySelectorAll('[role="tab"], button, li')].find((n) => n.textContent.trim() === '关于')
  if (!el) return false
  el.click()
  return true
})()`)
console.log('点击「关于」:', clicked)
await sleep(2000)

const about = await evaluate(`(() => {
  const root = document.querySelector('.ars-about')
  return {
    present: root !== null,
    title: document.querySelector('.ars-about-title')?.textContent ?? null,
    lead: document.querySelector('.ars-about-lead')?.textContent ?? null,
    facts: [...document.querySelectorAll('.ars-facts dt')].map((dt, i) => {
      const dd = document.querySelectorAll('.ars-facts dd')[i]
      return dt.textContent + '：' + (dd ? dd.textContent : '')
    }),
    mentionsBase: root ? /DeepSeek Harness/.test(root.innerText) : false,
  }
})()`)
console.log('关于页:', JSON.stringify(about, null, 2))
await screenshot(`${outPrefix}-about.png`)

ws.close()
