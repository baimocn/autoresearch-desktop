/**
 * 面板视觉验证：在浅色与深色主题下各截一张图，并断言关键结构存在。
 *
 * ## 为什么需要这个脚本
 *
 * 主题适配的坑（写错 token 名）**静态检查抓不全** —— token 名可以全部正确，
 * 但某个组件仍然用了写死的颜色。而构建、类型检查、单元测试都不会提示。
 * 所以需要真的把页面渲染出来看。
 *
 * 用法：
 *   node scripts/devtools/cdp-theme-shots.mjs <cdpPort> <url> <outDir>
 */

import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const cdpPort = process.argv[2] ?? '9333'
const url = process.argv[3]
const outDir = process.argv[4] ?? '.tmp-cdp'
if (!url) {
  console.error('usage: cdp-theme-shots.mjs <cdpPort> <url> <outDir>')
  process.exit(1)
}
mkdirSync(outDir, { recursive: true })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 打开一个新标签页并连上它的 WebSocket。 */
async function openTarget(targetUrl) {
  const created = await (await fetch(
    `http://127.0.0.1:${cdpPort}/json/new?${encodeURIComponent(targetUrl)}`,
    { method: 'PUT' },
  )).json()
  const ws = new WebSocket(created.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject })

  let seq = 0
  const pending = new Map()
  ws.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id) }
  }
  const send = (method, params = {}) => {
    const id = ++seq
    return new Promise((resolve) => { pending.set(id, resolve); ws.send(JSON.stringify({ id, method, params })) })
  }
  const evaluate = async (expression) => {
    const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    if (res.result?.exceptionDetails) {
      return { __exception: res.result.exceptionDetails.exception?.description ?? 'eval error' }
    }
    return res.result?.result?.value
  }
  return { ws, send, evaluate, targetId: created.id }
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

const page = await openTarget(url)
await sleep(4500)

// 1. 点击侧边栏的 AutoResearch 入口
const nav = await page.evaluate(`(() => {
  const labels = [...new Set([...document.querySelectorAll('button[aria-label]')].map(b => b.getAttribute('aria-label')))]
  return labels
})()`)
console.log('  侧边栏按钮:', JSON.stringify(nav).slice(0, 200))

const clicked = await page.evaluate(`(() => {
  const row = [...document.querySelectorAll('button[aria-label]')].find(b => b.getAttribute('aria-label') === 'AutoResearch')
  if (!row) return { clicked: false }
  row.click()
  return { clicked: true }
})()`)
record('找到并点击 AutoResearch 入口', clicked?.clicked === true)
await sleep(3000)

/** 强制切换主题：DSH 用 data-theme 属性驱动 token。 */
async function setTheme(theme) {
  return page.evaluate(`(() => {
    const root = document.documentElement
    root.setAttribute('data-theme', ${JSON.stringify(theme)})
    // 有些实现用 class 而不是属性，两个都设上更稳。
    root.classList.toggle('dark', ${JSON.stringify(theme)} === 'dark')
    return { theme: root.getAttribute('data-theme'), cls: root.className }
  })()`)
}

async function shoot(name) {
  const shot = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
  if (shot.result?.data) {
    const p = join(outDir, name)
    writeFileSync(p, Buffer.from(shot.result.data, 'base64'))
    console.log(`  截图: ${p}`)
    return p
  }
  console.log('  截图失败')
  return null
}

// 2. 结构断言
const structure = await page.evaluate(`(() => {
  const panel = document.querySelector('.autoresearch-panel')
  if (!panel) return { hasPanel: false }
  const q = (s) => !!panel.querySelector(s)
  return {
    hasPanel: true,
    hasBreadcrumb: q('.aw-breadcrumb'),
    hasTabs: q('.aw-tabs'),
    hasTabset: q('.aw-tabset'),
    hasSubTab: q('.aw-tab-sub'),
    hasSkip: q('.aw-skip'),
    hasContent: q('#aw-content'),
    tabLabels: [...panel.querySelectorAll('.aw-tab')].map(b => b.textContent.trim()),
    breadcrumb: panel.querySelector('.aw-breadcrumb')?.textContent ?? null,
  }
})()`)
record('面板挂载', structure?.hasPanel === true)
record('面包屑存在', structure?.hasBreadcrumb === true, structure?.breadcrumb ?? '')
record('分组标签栏存在', structure?.hasTabset === true)
record('二级标签存在', structure?.hasSubTab === true)
record('跳转链接存在', structure?.hasSkip === true)
record('内容区可聚焦', structure?.hasContent === true)
console.log('  标签:', JSON.stringify(structure?.tabLabels))

// 3. 双主题对比：读关键元素的实际计算色，判断是否真的随主题变化
async function probeColors(label) {
  const c = await page.evaluate(`(() => {
    const panel = document.querySelector('.autoresearch-panel')
    if (!panel) return null
    const cs = getComputedStyle(panel)
    const tab = panel.querySelector('.aw-tab')
    const tabs = panel.querySelector('.aw-tabs')
    return {
      panelInk: cs.color,
      panelFont: cs.fontFamily,
      tabColor: tab ? getComputedStyle(tab).color : null,
      tabsBg: tabs ? getComputedStyle(tabs).backgroundColor : null,
      bgVar: cs.getPropertyValue('--aw-bg').trim(),
      lineVar: cs.getPropertyValue('--aw-line').trim(),
      monoVar: cs.getPropertyValue('--aw-mono').trim(),
    }
  })()`)
  console.log(`  [${label}]`, JSON.stringify(c))
  return c
}

await setTheme('light')
await sleep(600)
const light = await probeColors('light')
const lightShot = await shoot('panel-light.png')

await setTheme('dark')
await sleep(600)
const dark = await probeColors('dark')
const darkShot = await shoot('panel-dark.png')

// 4. 主题适配断言：深色与浅色下，面板底色变量必须真的不同。
//    只断言「不相等」而不是断言具体颜色 —— 具体颜色归 DSH 主题管，我们不写死。
const bgDiffers = light?.bgVar !== dark?.bgVar || light?.tabsBg !== dark?.tabsBg
record('背景随主题变化（未静默用写死色）', bgDiffers === true,
  `light=${light?.tabsBg} dark=${dark?.tabsBg}`)
record('前景色随主题变化', light?.panelInk !== dark?.panelInk,
  `light=${light?.panelInk} dark=${dark?.panelInk}`)
record('等宽字体已解析（非空且非 inherit）',
  typeof light?.monoVar === 'string' && light.monoVar !== '',
  String(light?.monoVar).slice(0, 60))

page.ws.close()
console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`视觉验证：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length) {
  console.log('失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
console.log(`截图：${lightShot} / ${darkShot}`)
process.exit(failed.length === 0 ? 0 : 1)
