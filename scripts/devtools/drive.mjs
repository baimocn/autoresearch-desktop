/**
 * AutoResearch 平台驱动 —— 用 CDP 操作 Electron 应用界面。
 *
 * 本会话没有 computer-use 的 MCP 工具（get_app_state / left_click 等），
 * 因此用 CDP 直接驱动应用页面：点击、输入、读 DOM、截图。
 * 对这个应用来说与像素级电脑控制等效，而且更可靠（不受窗口遮挡/焦点影响）。
 *
 * 用法：
 *   node scripts/devtools/drive.mjs shot <输出路径>
 *   node scripts/devtools/drive.mjs eval "<表达式>"
 *   node scripts/devtools/drive.mjs state
 *   node scripts/devtools/drive.mjs ask "<发给对话的消息>"      # 输入并回车
 *   node scripts/devtools/drive.mjs wait-idle [毫秒上限]        # 等 agent 跑完
 *   node scripts/devtools/drive.mjs last-reply [字符数]         # 读最后一条助手回复
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const PORT = process.env.AR_CDP_PORT ?? '9223'

async function attach() {
  const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()
  const page = targets.find((t) => t.type === 'page' && t.url.includes('4314'))
    ?? targets.find((t) => t.type === 'page')
  if (page === undefined) throw new Error('找不到应用页面；应用是否带 --remote-debugging-port 启动？')
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
    const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: method }) }, 30000)
    pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
    ws.send(JSON.stringify({ id, method, params }))
  })
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) {
      return { __exception: String(res.result.exceptionDetails.exception?.description).slice(0, 300) }
    }
    return res.result?.result?.value
  }
  return { ws, send, evaluate }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/**
 * 输入并回车。
 *
 * 输入框是 **contenteditable div**（富文本编辑器），不是 textarea ——
 * 直接改 textContent 或设 value 都不会触发它的内部状态，回车也就发不出去。
 * 可靠做法是聚焦后 `document.execCommand('insertText', ...)`：
 * 它会走浏览器的编辑命令路径，产生编辑器真正监听的 beforeinput/input 事件。
 */
const SEND = (text) => `(() => {
  const el = document.querySelector('[contenteditable="true"]')
    || document.querySelector('textarea')
  if (!el) return { error: '找不到输入框' }
  el.focus()
  const sel = window.getSelection()
  const range = document.createRange()
  range.selectNodeContents(el)
  range.collapse(false)
  sel.removeAllRanges()
  sel.addRange(range)
  // 清掉可能存在的占位内容
  if (el.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(text)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    document.execCommand('insertText', false, ${JSON.stringify(text)})
  }
  const now = (el.tagName === 'TEXTAREA' ? el.value : el.innerText) || ''
  // 不因"读不到内容"就提前返回：富文本编辑器写入后 DOM 更新是异步的，
  // 立刻读 innerText 可能是空的，但内容其实已经进去了（实测踩过）。
  // 照常发回车，由调用方用 last-reply / 截图核对结果。
  // 回车提交：三种事件都发，覆盖只监听其中之一的实现
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }))
  }
  return { ok: true, tag: el.tagName, readLen: now.length }
})()`

/** 只发回车（内容已在输入框里时用）。 */
const ENTER = `(() => {
  const el = document.querySelector('[contenteditable="true"]') || document.querySelector('textarea')
  if (!el) return { error: '找不到输入框' }
  el.focus()
  for (const type of ['keydown', 'keypress', 'keyup']) {
    el.dispatchEvent(new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13, bubbles: true, cancelable: true,
    }))
  }
  return { ok: true, content: ((el.tagName === 'TEXTAREA' ? el.value : el.innerText) || '').slice(0, 80) }
})()`



/** 是否还在生成：找停止按钮 / 流式指示。 */
const BUSY = `(() => {
  const stop = [...document.querySelectorAll('button')]
    .find((b) => /停止|Stop/i.test(b.getAttribute('aria-label') || b.textContent || ''))
  const streaming = document.querySelector('[data-streaming="1"], [aria-busy="true"]')
  return { busy: stop !== undefined || streaming !== null, stopLabel: stop ? (stop.getAttribute('aria-label') || stop.textContent || '').trim().slice(0, 20) : null }
})()`

/** 读最后一条助手消息文本。 */
const LAST_REPLY = `(() => {
  const nodes = [...document.querySelectorAll('[data-message-role="assistant"], .dsh-message-assistant, [class*="assistant"]')]
  if (nodes.length === 0) {
    // 退化：取页面主内容区的最后一段
    const main = document.querySelector('main') || document.body
    return { fallback: true, text: (main.innerText || '').trim().slice(-4000) }
  }
  const last = nodes[nodes.length - 1]
  return { fallback: false, count: nodes.length, text: (last.innerText || '').trim() }
})()`

const [command, ...rest] = process.argv.slice(2)
const { ws, send, evaluate } = await attach()

if (command === 'shot') {
  const out = rest[0] ?? '_vision_test/drive/shot.png'
  mkdirSync(dirname(out), { recursive: true })
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) { writeFileSync(out, Buffer.from(shot.result.data, 'base64')); console.log('shot:', out) }
  else console.log('截图失败:', JSON.stringify(shot).slice(0, 200))
} else if (command === 'eval') {
  console.log(JSON.stringify(await evaluate(rest.join(' ')), null, 1))
} else if (command === 'state') {
  const state = await evaluate(`JSON.stringify({
    url: location.href,
    title: document.title,
    busy: document.querySelector('[aria-busy="true"]') !== null,
    composer: (document.querySelector('textarea')?.placeholder || '(无输入框)').slice(0, 40),
    tabs: [...document.querySelectorAll('.aw-tab, .aw-tab-sub')].map(b => b.textContent.trim() + (b.getAttribute('data-on')==='1'?'*':'')),
    hasWorkbench: document.querySelector('.aw-panel') !== null,
  })`)
  console.log(state)
} else if (command === 'ask') {
  const text = rest.join(' ')
  // 工作台面板占着 main 槽时没有输入框 —— 先切回对话，否则 ask 永远失败。
  const hasComposer = await evaluate(`document.querySelector('[contenteditable="true"]') !== null`)
  if (hasComposer !== true) {
    const switched = await evaluate(`(() => {
      const span = [...document.querySelectorAll('span')]
        .find((s) => s.className && String(s.className).indexOf('_title') !== -1
          && (s.textContent || '').trim() !== '')
      if (!span) return 'no-session-span'
      let el = span
      for (let i = 0; i < 6 && el; i++) {
        if (el.getAttribute && el.getAttribute('role') === 'treeitem') break
        el = el.parentElement
      }
      const target = el ?? span
      const r = target.getBoundingClientRect()
      const o = { bubbles: true, cancelable: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, button: 0 }
      for (const t of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) target.dispatchEvent(new MouseEvent(t, o))
      return 'clicked'
    })()`)
    console.log('切回对话:', switched)
    await sleep(2000)
  }
  console.log('发送:', text.slice(0, 80) + (text.length > 80 ? '…' : ''))
  console.log(JSON.stringify(await evaluate(SEND(text))))
} else if (command === 'enter') {
  console.log(JSON.stringify(await evaluate(ENTER)))
} else if (command === 'busy') {
  console.log(JSON.stringify(await evaluate(BUSY)))
} else if (command === 'wait-idle') {
  const maxMs = Number(rest[0] ?? 600000)
  const started = Date.now()
  let last = null
  while (Date.now() - started < maxMs) {
    const b = await evaluate(BUSY)
    if (last === null || b?.busy !== last) {
      console.log(`  [${Math.round((Date.now() - started) / 1000)}s] busy=${b?.busy}`)
      last = b?.busy
    }
    if (b?.busy === false) break
    await sleep(3000)
  }
  console.log(`等空闲结束，用时 ${Math.round((Date.now() - started) / 1000)}s，最终 busy=${last}`)
} else if (command === 'last-reply') {
  const limit = Number(rest[0] ?? 3000)
  const r = await evaluate(LAST_REPLY)
  const text = String(r?.text ?? '')
  console.log(r?.fallback ? '(退化读取主内容区)' : `(助手消息 ${r?.count} 条，取最后一条)`)
  console.log(text.length > limit ? text.slice(-limit) : text)
} else {
  console.log('未知命令:', command)
}

ws.close()
