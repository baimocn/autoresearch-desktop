import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative } from 'node:path'

const ROOT = process.argv[2]
if (ROOT === undefined) { console.error('usage: scan-internal.mjs <root>'); process.exit(2) }

const SKIP = new Set(['node_modules', '.git', '__pycache__', '.dsh-home'])

async function walk(dir, out = []) {
  for (const e of await readdir(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue
    const full = join(dir, e.name)
    if (e.isDirectory()) { await walk(full, out); continue }
    try { if ((await stat(full)).size < 4_000_000) out.push(full) } catch { /* skip */ }
  }
  return out
}

const files = await walk(ROOT)
const urlRe = /https:\/\/[A-Za-z0-9.-]*larkoffice\.com\/[^\s)\]"'<>]+/g
const byUrl = new Map()
const internalFiles = new Set()

for (const f of files) {
  let text
  try { text = await readFile(f, 'utf8') } catch { continue }
  const rel = relative(ROOT, f).split('\\').join('/')
  if (/bytedance|larkoffice|feishu/i.test(text)) internalFiles.add(rel)
  for (const m of text.match(urlRe) ?? []) {
    if (!byUrl.has(m)) byUrl.set(m, new Set())
    byUrl.get(m).add(rel)
  }
}

console.log(`扫描 ${files.length} 个文件`)
console.log()
console.log(`=== 公开仓库中暴露的内部协作 URL（${byUrl.size} 个 distinct）===`)
for (const [url, set] of [...byUrl].sort()) {
  console.log(`  ${url}`)
  console.log(`      出现在 ${set.size} 个文件`)
}
console.log()
console.log(`=== 含 bytedance/larkoffice/feishu 字样的文件（${internalFiles.size} 个）===`)
for (const f of [...internalFiles].sort()) console.log(`  ${f}`)

// 按来源归类：教程附件 0.3.2 还是上游 0.3.4
const t = [...internalFiles].filter((f) => f.includes('skills-0.3.2'))
const u = [...internalFiles].filter((f) => f.includes('skills-upstream-0.3.4'))
console.log()
console.log(`归属：教程附件 0.3.2 = ${t.length} 个；上游 0.3.4 = ${u.length} 个`)
