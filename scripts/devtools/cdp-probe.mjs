// 运行态取证：连 CDP，查 __DSH_BOOT__ / __ModuleLoader__ / 控制台错误 / DOM。
const port = process.argv[2] ?? '9222'

const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = targets.find(t => t.type === 'page' && t.url.includes('43141'))
  ?? targets.find(t => t.type === 'page')
if (!page) { console.error('no page target', targets.map(t => `${t.type} ${t.url}`)); process.exit(1) }
console.error(`target: ${page.url}`)

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

const report = await evaluate(`(async () => {
  const out = {}
  out.href = location.href

  // 1. boot graph
  const boot = window.__DSH_BOOT__
  if (!boot) { out.boot = 'MISSING' } else {
    out.bootEntries = boot.entries.map(e => ({ id: e.id, rev: (e.rev ?? '').slice(0, 6), inject: e.inject, immediately: e.immediately }))
    out.myEntry = boot.entries.find(e => e.id === 'dsh-autoresearch-ui') ?? null
    out.myBatch = boot.batches.filter(b => b.entries.includes('dsh-autoresearch-ui'))
  }

  // 2. module loader facade state
  const ml = window.__ModuleLoader__
  if (!ml) { out.loader = 'MISSING' } else {
    out.loaderMode = ml.mode
    out.pendingQueueIds = (ml.pendingQueue ?? []).map(r => r.id)
    out.loaderOwnKeys = Object.getOwnPropertyNames(ml)
  }

  // 3. materialization evidence
  const sys = window.__DSH_MODULES_SYSTEM__ ?? null
  out.systemGlobal = sys ? 'present' : 'absent'
  // loadCache is a property of ClientModuleSystem; find it via the facade? The facade isn't the system.
  // Try to reach through cordis client context via DOM heuristics instead:
  out.hasPanel = !!document.querySelector('.autoresearch-panel')
  out.styleTag = !!document.getElementById('dsh-autoresearch-ui-style')

  // 4. which scripts executed
  out.scripts = [...document.querySelectorAll('script[src]')].map(s => s.getAttribute('src')).filter(s => s.includes('/plugins'))
  out.preloads = [...document.querySelectorAll('link[rel=modulepreload],link[rel=preload]')].map(l => l.getAttribute('href')).filter(s => s && s.includes('/plugins'))

  // 5. import my bundle directly to see if node half serves it
  const myEntry = window.__DSH_BOOT__?.entries.find(e => e.id === 'dsh-autoresearch-ui')
  if (myEntry) {
    const res = await fetch(myEntry.url, { credentials: 'same-origin' })
    out.bundleFetchStatus = res.status
    if (res.ok) {
      const text = await res.text()
      out.bundleBytes = text.length
      out.bundleRegistersMe = text.includes('__ModuleLoader__.load')
      out.bundleRegistersRightId = text.includes('id:"dsh-autoresearch-ui"') || text.includes("id: 'dsh-autoresearch-ui'") || text.includes('id: "dsh-autoresearch-ui"') || /id:\\s*['"]dsh-autoresearch-ui['"]/.test(text)
      out.bundleHead = text.slice(0, 300)
    }
  }
  return out
})()`)

console.log(JSON.stringify(report, null, 2))
ws.close()
process.exit(0)
