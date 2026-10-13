/**
 * 检查：UI 引用的 --dsw-* 主题 token 名是否真实存在。
 *
 * ## 为什么需要这道检查
 *
 * CSS 自定义属性写错名字**不会报错**，只会静默回退到 fallback。我们踩过
 * 这个坑：client.js 写了 `--dsw-alias-bg-elevated` 和
 * `--dsw-alias-border-secondary`，而 DSH 实际定义的是 `bg-layer-1` 和
 * `border-l1/l2`。结果是浅色主题下面板出现深色块，但构建、类型检查、
 * 单元测试全都不会提示。
 *
 * 所以把"DSH 实际定义了哪些 token"作为事实来源，逐个比对引用。
 * token 清单直接从随包 CSS 里抠出来，不写死在脚本里 —— 写死的话
 * DSH 升级后这份清单会过期，检查又会变成骗人的。
 *
 * 用法：node scripts/check-ui-tokens.mjs
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const PKG_ROOT = join(ROOT, 'node_modules', '@deepseek-ai')
const UI_FILE = join(ROOT, 'packages', 'dsh-autoresearch-ui', 'client.js')

/** 递归收集目录下的所有文件（限定体积，跳过超大 bundle）。 */
async function walk(dir, out = [], depth = 0) {
  if (depth > 10) return out
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue
      await walk(full, out, depth + 1)
    } else if (['.css', '.js', '.mjs', '.ts'].includes(extname(entry.name))) {
      out.push(full)
    }
  }
  return out
}

/** 从随包产物里抠出所有**被定义**的 --dsw-* token 名。 */
async function collectDefinedTokens() {
  const files = await walk(PKG_ROOT)
  const defined = new Set()
  for (const file of files) {
    let text
    try {
      text = await readFile(file, 'utf8')
    } catch {
      continue
    }
    if (!text.includes('--dsw-')) continue
    // 匹配 `--dsw-xxx:` 形式（定义处），排除 var(--dsw-xxx) 形式（引用处）。
    for (const match of text.matchAll(/(--dsw-[a-z0-9-]+)\s*:/g)) {
      defined.add(match[1])
    }
  }
  return defined
}

/** 从 UI 源码里抠出所有被引用的 --dsw-* token 名。 */
function collectReferencedTokens(text) {
  const referenced = new Map()
  const lines = text.split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    for (const match of lines[i].matchAll(/var\((--dsw-[a-z0-9-]+)/g)) {
      if (!referenced.has(match[1])) referenced.set(match[1], i + 1)
    }
  }
  return referenced
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

console.log('=== UI 主题 token 名校验 ===')
console.log()

const defined = await collectDefinedTokens()
console.log(`  从随包产物抠出 ${defined.size} 个已定义的 --dsw-* token`)
if (defined.size === 0) {
  console.log('  FAIL 抠不到 token 清单 —— 检查 node_modules/@deepseek-ai 是否存在')
  process.exit(1)
}

const uiText = await readFile(UI_FILE, 'utf8')
const referenced = collectReferencedTokens(uiText)
console.log(`  UI 源码引用了 ${referenced.size} 个 --dsw-* token`)
console.log()

// 逐个比对：引用的每个 token 都必须在 DSH 里真实存在。
const bogus = []
for (const [token, line] of referenced) {
  if (!defined.has(token)) bogus.push({ token, line })
}

record('所有引用的 token 名都真实存在', bogus.length === 0,
  bogus.length === 0 ? `${referenced.size} 个全部命中` : `${bogus.length} 个不存在`)
if (bogus.length > 0) {
  console.log()
  console.log('  不存在的 token（会被静默回退，主题适配失效）：')
  for (const b of bogus) console.log(`    client.js:${b.line}  ${b.token}`)
}
console.log()

// 反向检查：确认脚本本身有鉴别力 —— 故意造一个假 token 必须被判不存在。
record('校验器有鉴别力（假 token 会被判不存在）', !defined.has('--dsw-alias-bg-elevated'))
record('校验器能认出真 token', defined.has('--dsw-alias-bg-layer-1'))
console.log()

// 关键 token 是否都被用到（漏了就说明主题适配不完整）。
const REQUIRED = [
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-border-l1',
  '--dsw-alias-bg-layer-1',
  '--dsw-font-family',
]
for (const token of REQUIRED) {
  record(`关键 token 已被引用：${token}`, referenced.has(token))
}
console.log()

console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`token 校验：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
process.exit(failed.length === 0 ? 0 : 1)
