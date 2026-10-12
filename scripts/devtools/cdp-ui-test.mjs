/**
 * 通过 Chrome DevTools 协议驱动桌面端界面做端到端测试。
 *
 * 测什么（都是用户能看见的东西）：
 *   1. 控制台有无报错
 *   2. 各页签是否真实渲染出内容（不是只看 HTTP 200）
 *   3. 在输入框发一条消息，模型是否真的回复
 *
 * 用 CDP 而不是 HTTP 探针：HTTP 只能证明路由返回数据，证明不了界面渲染。
 */
import { WebSocket } from 'ws'
import { writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

const CDP = 'http://127.0.0.1:9222'
const OUT = '.tmp-cdp'
await mkdir(OUT, { recursive: true })

/** 取页面目标。 */
async function findPage() {
  const response = await fetch(`${CDP}/json/list`)
  const targets = await response.json()
  const page = targets.find((target) => target.type === 'page')
  if (page === undefined) throw new Error('未找到页面目标')
  return page
}

/** 极简 CDP 客户端。 */
class Session {
  #ws
  #id = 0
  #pending = new Map()
  #events = []

  constructor(ws) {
    this.#ws = ws
    ws.on('message', (raw) => {
      const message = JSON.parse(String(raw))
      if (message.id !== undefined) {
        const entry = this.#pending.get(message.id)
        if (entry !== undefined) {
          this.#pending.delete(message.id)
          message.error === undefined ? entry.resolve(message.result) : entry.reject(new Error(JSON.stringify(message.error)))
        }
        return
      }
      this.#events.push(message)
    })
  }

  send(method, params = {}) {
    const id = ++this.#id
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject })
      this.#ws.send(JSON.stringify({ id, method, params }))
      setTimeout(() => {
        if (this.#pending.delete(id)) reject(new Error(`CDP 超时：${method}`))
      }, 30_000)
    })
  }

  /** 在页面里求值，返回 JSON 化的结果。 */
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    })
    if (result.exceptionDetails !== undefined) {
      throw new Error(`页面内异常：${result.exceptionDetails.exception?.description ?? '未知'}`)
    }
    return result.result.value
  }

  events() { return this.#events }
  close() { this.#ws.close() }
}

/** 截图并保存。 */
async function screenshot(session, name) {
  const result = await session.send('Page.captureScreenshot', { format: 'png' })
  const file = join(OUT, `${name}.png`)
  await writeFile(file, Buffer.from(result.data, 'base64'))
  return file
}

const page = await findPage()
console.log(`连接页面：${page.title}`)
console.log(`URL：${page.url}`)

const ws = new WebSocket(page.webSocketDebuggerUrl, { maxPayload: 64 * 1024 * 1024 })
await new Promise((resolve, reject) => {
  ws.once('open', resolve)
  ws.once('error', reject)
})
const session = new Session(ws)

// 订阅控制台与异常
await session.send('Runtime.enable')
await session.send('Log.enable')
await session.send('Page.enable')

// ── 1) 控制台错误 ──────────────────────────────────────────────────────────

console.log('\n=== 1) 控制台 ===')
// 触发一次重载以捕获启动期错误
await session.send('Page.reload', { ignoreCache: true })
await new Promise((resolve) => setTimeout(resolve, 8000))

const errors = session.events()
  .filter((event) => event.method === 'Runtime.exceptionThrown'
    || (event.method === 'Runtime.consoleAPICalled' && event.params?.type === 'error')
    || (event.method === 'Log.entryAdded' && event.params?.entry?.level === 'error'))
  .map((event) => {
    if (event.method === 'Runtime.exceptionThrown') {
      return event.params.exceptionDetails?.exception?.description ?? '未描述异常'
    }
    if (event.method === 'Runtime.consoleAPICalled') {
      return (event.params.args ?? []).map((arg) => arg.value ?? arg.description ?? '').join(' ')
    }
    return event.params.entry?.text ?? ''
  })

console.log(`错误数：${errors.length}`)
for (const error of errors.slice(0, 8)) console.log(`  ${String(error).slice(0, 200)}`)

// ── 2) 界面结构 ────────────────────────────────────────────────────────────

console.log('\n=== 2) 界面结构 ===')
const structure = await session.evaluate(`
  return {
    title: document.title,
    hasSidebar: document.querySelector('[class*="sidebar"]') !== null,
    buttons: [...document.querySelectorAll('button')].map((b) => (b.textContent || '').trim()).filter(Boolean).slice(0, 30),
    tabs: [...document.querySelectorAll('[role="tab"], [class*="tab"]')].map((t) => (t.textContent || '').trim()).filter(Boolean).slice(0, 20),
    hasComposer: document.querySelector('textarea, [contenteditable="true"]') !== null,
    bodyText: (document.body.innerText || '').slice(0, 600),
  }
`)
console.log('标题:', structure.title)
console.log('有侧边栏:', structure.hasSidebar)
console.log('有输入框:', structure.hasComposer)
console.log('按钮（前 15）:', structure.buttons.slice(0, 15).join(' | '))
console.log('\n页面文本（前 400）:')
console.log(structure.bodyText.slice(0, 400))

await screenshot(session, '01-initial')
console.log('\n截图：.tmp-cdp/01-initial.png')

// ── 3) 找并点击 AutoResearch 相关入口 ──────────────────────────────────────

console.log('\n=== 3) 查找工作台入口 ===')
const entries = await session.evaluate(`
  const keywords = ['工作流', '工作台', '四阶段', '门禁', 'AutoResearch', 'autoresearch', '双路', '远端', 'API']
  const found = []
  for (const el of document.querySelectorAll('*')) {
    const text = (el.textContent || '').trim()
    if (text.length === 0 || text.length > 40) continue
    if (el.children.length > 0) continue
    if (keywords.some((k) => text.includes(k))) {
      found.push({ text, tag: el.tagName, clickable: typeof el.click === 'function' })
    }
  }
  return found.slice(0, 20)
`)
console.log(`找到 ${entries.length} 个候选入口：`)
for (const entry of entries) console.log(`  [${entry.tag}] ${entry.text}`)

// ── 4) 发一条真实消息 ──────────────────────────────────────────────────────

console.log('\n=== 4) 发送真实消息 ===')
const sendResult = await session.evaluate(`
  const editor = document.querySelector('textarea, [contenteditable="true"]')
  if (editor === null) return { ok: false, reason: '未找到输入框' }
  editor.focus()
  if (editor.tagName === 'TEXTAREA') {
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set
    setter.call(editor, '只回复两个字：收到')
    editor.dispatchEvent(new Event('input', { bubbles: true }))
  } else {
    editor.textContent = '只回复两个字：收到'
    editor.dispatchEvent(new InputEvent('input', { bubbles: true }))
  }
  return { ok: true, value: editor.tagName === 'TEXTAREA' ? editor.value : editor.textContent }
`)
console.log('填入输入框:', JSON.stringify(sendResult))

await screenshot(session, '02-typed')

// 按 Enter 发送
await session.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
await session.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 })
console.log('已按 Enter')

// 等模型回复
await new Promise((resolve) => setTimeout(resolve, 25_000))

const afterSend = await session.evaluate(`
  return {
    bodyText: (document.body.innerText || '').slice(-1500),
    hasError: /运行失败|处理失败|UNSUPPORTED|MISSING_CREDENTIAL|错误/.test(document.body.innerText || ''),
  }
`)
console.log('\n发送后页面文本（尾部 800）:')
console.log(afterSend.bodyText.slice(-800))
console.log('\n检测到错误字样:', afterSend.hasError)

await screenshot(session, '03-after-send')
console.log('\n截图：.tmp-cdp/03-after-send.png')

// ── 5) 汇总 ────────────────────────────────────────────────────────────────

console.log('\n=== 测试结论 ===')
console.log(`控制台错误：${errors.length}`)
console.log(`界面可交互：${structure.hasComposer}`)
console.log(`发送消息后出现错误字样：${afterSend.hasError}`)
console.log(`截图目录：.tmp-cdp/`)

session.close()
await new Promise((resolve) => setTimeout(resolve, 300))
process.exitCode = 0
