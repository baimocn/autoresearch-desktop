// 验证「模型议会」独立面板：导航行存在 → 点击 → .model-council-panel 挂载 →
// 配置页/议事厅切换 → 成员陈述 markdown 渲染 → 无控制台错误 → 截图。
//
// 用法：node scripts/devtools/cdp-verify-council.mjs [port] [shot.png]
//
// 只读用户的议会配置与会话；第 5 节会建一个临时会话用于渲染验收，结束时删掉。
import { writeFileSync } from 'node:fs'

const port = process.argv[2] ?? '9222'
const shotPath = process.argv[3] ?? 'council-shot.png'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && !t.url.startsWith('devtools://'))
if (!page) {
  console.error('no page target:', targets.map((t) => `${t.type} ${t.url}`).join('\n'))
  process.exit(1)
}

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function check(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : ` — ${detail}`}`)
}

await send('Runtime.enable')
await sleep(4500)

console.log('=== 1) 导航行是否出现（sidebar.panellist 注册）===')
const nav = await evaluate(`(() => {
  const labels = [...document.querySelectorAll('button[aria-label]')].map((b) => b.getAttribute('aria-label'))
  return [...new Set(labels)]
})()`)
check('侧边栏出现「模型议会」入口', Array.isArray(nav) && nav.includes('模型议会'),
  Array.isArray(nav) ? nav.join(' / ') : JSON.stringify(nav))
check('AutoResearch 入口仍在（两面板独立共存）', Array.isArray(nav) && nav.includes('AutoResearch'))

console.log('\n=== 2) 点击后是否挂载（main keyed 槽）===')
const clicked = await evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find((b) => b.getAttribute('aria-label') === '模型议会')
  if (!row) return { clicked: false }
  row.click()
  return { clicked: true }
})()`)
check('点击导航行成功', clicked?.clicked === true)
await sleep(1200)

const mounted = await evaluate(`(() => {
  const panel = document.querySelector('.model-council-panel')
  return {
    hasPanel: !!panel,
    scrollable: panel ? getComputedStyle(panel).overflowY : null,
    ariaCurrent: [...document.querySelectorAll('button[aria-current="page"]')].map((b) => b.getAttribute('aria-label')),
    text: panel ? panel.textContent.slice(0, 200) : null,
  }
})()`)
check('面板挂载 .model-council-panel', mounted?.hasPanel === true)
check('承载层自带滚动（ui-layout 契约）', mounted?.scrollable === 'auto', mounted?.scrollable)
check('导航行标记为当前页', Array.isArray(mounted?.ariaCurrent) && mounted.ariaCurrent.includes('模型议会'),
  (mounted?.ariaCurrent ?? []).join(','))
check('面板内容已渲染（标题「模型议会」）', typeof mounted?.text === 'string' && mounted.text.includes('模型议会'),
  mounted?.text?.slice(0, 60))

console.log('\n=== 3) 议事厅 / 议会配置 两页切换 ===')
const tabs = await evaluate(`(() => {
  const names = [...document.querySelectorAll('.mc-tab')].map((b) => b.textContent)
  return names
})()`)
check('两个分区标签存在', Array.isArray(tabs) && tabs.includes('议事厅') && tabs.includes('议会配置'),
  (tabs ?? []).join(' / '))

const configView = await evaluate(`(async () => {
  const tab = [...document.querySelectorAll('.mc-tab')].find((b) => b.textContent === '议会配置')
  if (!tab) return { ok: false }
  tab.click()
  await new Promise((r) => setTimeout(r, 900))
  const main = document.querySelector('.mc-content')
  return { ok: true, text: main ? main.textContent.slice(0, 300) : null }
})()`)
check('切到配置页成功', configView?.ok === true)
check('配置页给出三身份与协议说明',
  typeof configView?.text === 'string' && configView.text.includes('裁决者') && configView.text.includes('探测'),
  configView?.text?.slice(0, 80))

console.log('\n=== 4) 控制台错误 ===')
const realErrors = consoleErrors.filter((line) => line && !line.includes('DevTools'))
check('无未捕获异常', realErrors.length === 0, realErrors.slice(0, 3).join(' | '))

// ── 5) markdown 渲染（真实渲染路径） ────────────────────────────────────────
//
// 面板的成员陈述用 shell 的 MarkdownText 渲染。表格糊成一行、粗体显示成星号，
// 正是纯文本渲染的症状 —— 所以必须让**面板真的渲染一条含表格的发言**，
// 而不是断言源码里写了 MarkdownText。
//
// 安全前提：**绝不碰用户的议会配置**。做法是用**已配置的**成员建一个临时会话，
// 只插一条主持人发言（不发任何模型请求），验完删掉。
// 配置不足 3 位时如实跳过 —— 不改成假配置去凑，那会短暂覆盖用户的真实配置。
//
// 为什么必须用 API 建会话、不能写盘：会话列表在进程内缓存（loadSessions 只装载
// 一次），写盘要重启进程才可见。

console.log('\n=== 5) 成员陈述的 markdown 渲染 ===')

/** 在页面内发同源请求：自动带 cookie，不需要在这里搬鉴权。 */
async function call(path, method = 'GET', body) {
  return evaluate(`(async () => {
    const response = await fetch(${JSON.stringify(path)}, {
      method: ${JSON.stringify(method)},
      headers: { 'content-type': 'application/json' },
      ${body === undefined ? '' : `body: ${JSON.stringify(JSON.stringify(body))},`}
    })
    return { status: response.status, body: await response.json().catch(() => null) }
  })()`)
}

const MARKDOWN_TEXT = '**粗体结论**\n\n| 方案 | 代价 |\n|---|---|\n| A | 低 |\n| B | 高 |'

const created = await call('/api/model-council/session', 'POST', { topic: 'markdown 渲染验收（临时）' })
const createdSession = created.body?.created ?? null

if (createdSession === null) {
  console.log(`  skip  markdown 渲染验收需要 ≥3 位已配置成员 — ${created.body?.error ?? `HTTP ${created.status}`}`)
  console.log('        到「模型议会 → 议会配置」配好成员后重跑本节。')
} else {
  try {
    const said = await call('/api/model-council/session/say', 'POST', { id: createdSession, text: MARKDOWN_TEXT })
    check('临时会话中插入含表格的发言', said.status === 200, `status=${said.status}`)

    // 面板：切到议事厅并点开该会话。
    await evaluate(`(() => {
      const tab = [...document.querySelectorAll('.mc-tab')].find((b) => b.textContent === '议事厅')
      tab?.click()
      return true
    })()`)
    await sleep(700)
    const opened = await evaluate(`(() => {
      const row = [...document.querySelectorAll('.mc-session')].find((b) => b.textContent.includes('markdown 渲染验收（临时）'))
      if (row === undefined) return { opened: false }
      row.click()
      return { opened: true }
    })()`)
    check('面板中可点开该会话', opened?.opened === true)
    await sleep(1200)

    const dom = await evaluate(`(() => {
      const body = document.querySelector('.mc-turn-body')
      if (body === null) return null
      return {
        strong: body.querySelectorAll('strong').length,
        table: body.querySelectorAll('table').length,
        rawStars: body.textContent.includes('**'),
        html: body.innerHTML.slice(0, 200),
      }
    })()`)
    check('成员陈述渲染出 <strong>', dom?.strong === 1, dom?.html)
    check('成员陈述渲染出 <table>（纯文本会糊成一行）', dom?.table === 1)
    check('不再出现裸的 ** 记号', dom?.rawStars === false)
  } finally {
    // 只删自己造的会话；用户配置与既有会话一律不动。
    await call(`/api/model-council/session?id=${encodeURIComponent(createdSession)}`, 'DELETE')
    console.log(`  （已删除临时会话 ${createdSession}）`)
  }
}

const shot = await send('Page.captureScreenshot', { format: 'png' })
if (shot.result?.data) {
  writeFileSync(shotPath, Buffer.from(shot.result.data, 'base64'))
  console.log(`\n截图：${shotPath}`)
}
ws.close()

const failed = results.filter((r) => !r.ok)
console.log(`\n议会面板验收：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
