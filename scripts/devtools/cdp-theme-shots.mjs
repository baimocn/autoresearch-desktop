/**
 * 双主题截图留档 —— 直接切 `data-ds-theme-source`，不 reload。
 *
 * ## 为什么不 reload
 *
 * DSH 的设置写入后靠 reload 生效，但对 Electron 页面执行 `Page.reload` 实测会
 * 把整个应用带走（execution context 换掉、进程随后退出）。所以这里直接改
 * `<html data-ds-theme-source>` —— 主题变量按该属性选择，改了立刻生效，
 * 足以做视觉与数值核验。
 *
 * ## 为什么不能只看深色
 *
 * 「token 名写错 → 静默回退到写死的深色值」这类缺陷**只在浅色下暴露**。
 * 深色下截图会得到"一切正常"的假结论。所以两个主题都要看，并且断言
 * `--aw-bg` 在浅色下确实是浅色（不是回退值）。
 *
 * ## 真正的主题开关是 body[data-ds-dark-theme]
 *
 * 排查过程：先试了 `<html data-ds-theme-source>` —— 改了以后 `--aw-bg` 不变，
 * 说明它只是"主题来源"标记（system/user），不是开关；CSS 里也搜不到
 * `data-ds-theme-source` 或 `[data-*=light]` 选择器。
 * 真正的开关在 **body 上**：`body[data-ds-dark-theme]` 存在 = 深色，移除 = 浅色
 * （`--dsw-alias-*` 就定义在 `body` 与 `body[data-ds-dark-theme]` 两组规则里）。
 * 详见 `scripts/devtools/probe-theme-mechanism.mjs`。
 *
 * 用法：node scripts/devtools/cdp-theme-shots.mjs [cdpPort] [outDir]
 */

import { writeFileSync, mkdirSync } from 'node:fs'

const port = process.argv[2] ?? '9223'
const outDir = process.argv[3] ?? '_vision_test/theme'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find((t) => t.type === 'page' && t.url.includes('4314'))
  ?? targets.find((t) => t.type === 'page')
if (page === undefined) { console.error('找不到可附着的页面'); process.exit(1) }

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
  const timer = setTimeout(() => { pending.delete(id); resolve({ __timeout: method }) }, 20000)
  pending.set(id, (msg) => { clearTimeout(timer); resolve(msg) })
  ws.send(JSON.stringify({ id, method, params }))
})
async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.result?.exceptionDetails) {
    return { __exception: String(res.result.exceptionDetails.exception?.description).slice(0, 200) }
  }
  return res.result?.result?.value
}
async function screenshot(path) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (shot.result?.data) {
    writeFileSync(path, Buffer.from(shot.result.data, 'base64'))
    console.log('shot:', path)
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

mkdirSync(outDir, { recursive: true })

await evaluate(`(() => {
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  const row = [...document.querySelectorAll('button[aria-label]')]
    .find((b) => b.getAttribute('aria-label') === 'AutoResearch')
  if (row) row.click()
  return true
})()`)
await sleep(2500)

const results = []
const record = (name, ok, detail) => {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail === undefined ? '' : `  ${detail}`}`)
}

const parseHex = (h) => {
  const raw = String(h).trim()
  // 同时支持 #rgb 与 #rrggbb —— 浅色主题下 --aw-bg 解析出来就是 `#fff`，
  // 只认 6 位会让它变成 null，断言报出 n/a 的假失败（实测踩过）。
  const short = raw.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i)
  if (short !== null) return [1, 2, 3].map((i) => parseInt(short[i] + short[i], 16))
  const long = raw.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i)
  if (long !== null) return [1, 2, 3].map((i) => parseInt(long[i], 16))
  return null
}
const luminance = (rgb) => {
  if (rgb === null) return null
  const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4) }
  return 0.2126 * f(rgb[0]) + 0.7152 * f(rgb[1]) + 0.0722 * f(rgb[2])
}

for (const theme of ['dark', 'light']) {
  // 真正的开关：body 上有 data-ds-dark-theme = 深色，没有 = 浅色。
  await evaluate(`(() => {
    const b = document.body
    if (${JSON.stringify(theme)} === 'dark') b.setAttribute('data-ds-dark-theme', '')
    else b.removeAttribute('data-ds-dark-theme')
    document.documentElement.style.colorScheme = ${JSON.stringify(theme)}
    return true
  })()`)
  await sleep(900)

  const tokens = await evaluate(`(() => {
    const p = document.querySelector('.aw-panel')
    if (!p) return null
    const cs = getComputedStyle(p)
    return {
      applied: document.body.hasAttribute('data-ds-dark-theme') ? 'dark' : 'light',
      bg: cs.getPropertyValue('--aw-bg').trim(),
      ink: cs.getPropertyValue('--aw-ink').trim(),
      accent: cs.getPropertyValue('--aw-accent').trim(),
      fillPrimary: cs.getPropertyValue('--aw-fill-primary').trim(),
      onFill: cs.getPropertyValue('--aw-on-fill-primary').trim(),
      panelBg: getComputedStyle(p).backgroundColor,
    }
  })()`)
  console.log(`\n[${theme}] 令牌:`, JSON.stringify(tokens))
  await screenshot(`${outDir}/${theme}-tasks.png`)

  record(`${theme}：主题属性已生效`, tokens?.applied === theme, tokens?.applied)
  const bgLum = luminance(parseHex(tokens?.bg))
  if (theme === 'light') {
    // 这条是核心：浅色下 --aw-bg 若仍是深色，说明回退值写死了深色（曾经的真实缺陷）。
    record('light：--aw-bg 是浅色（未回退到写死的深色）', bgLum !== null && bgLum > 0.5,
      `--aw-bg=${tokens?.bg} luminance=${bgLum === null ? 'n/a' : bgLum.toFixed(3)}`)
  } else {
    record('dark：--aw-bg 是深色', bgLum !== null && bgLum < 0.2,
      `--aw-bg=${tokens?.bg} luminance=${bgLum === null ? 'n/a' : bgLum.toFixed(3)}`)
  }
  // 主按钮填充与文字同色就是「白底白字」缺陷的形态，必须不同。
  record(`${theme}：主按钮填充色 ≠ 其上文字色`, tokens?.fillPrimary !== tokens?.onFill,
    `${tokens?.fillPrimary} vs ${tokens?.onFill}`)
}

await evaluate(`(() => {
  document.body.setAttribute('data-ds-dark-theme', '')
  document.documentElement.style.colorScheme = 'dark'
  return true
})()`)

const failed = results.filter((r) => !r.ok)
console.log(`\n双主题留档：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
ws.close()
process.exitCode = failed.length === 0 ? 0 : 1
