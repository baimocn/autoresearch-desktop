/**
 * 源码语法守卫 —— 每个包入口与 lib 下的每个模块都必须能被解析。
 *
 * ## 为什么需要这个（本轮实测暴露的缺口）
 *
 * 我在改造 `qa/index.js` 时误用了动态 `await import()`（`apply()` 不是 async），
 * 造成 `SyntaxError: Unexpected reserved word`。
 * 此时 `npm run check` **仍然 264 项全绿** —— 因为集成验证加载的是
 * `profile:install` 装进 profile 的**旧副本**，没读这个源文件。
 *
 * 也就是说：改坏源码后，全套测试可以继续骗人。
 * 这个脚本堵住它 —— 在跑任何逻辑测试之前，先证明源码是合法 JS。
 *
 * 用法：node scripts/syntax-guard.mjs
 * 退出码：0 = 全部可解析；1 = 有文件解析失败
 */

import { readdir, stat } from 'node:fs/promises'
import { join, dirname, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/** 递归收集 .js 文件，跳过依赖与产物目录。 */
async function collectJs(dir, out = []) {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '__pycache__') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      await collectJs(full, out)
      continue
    }
    if (entry.name.endsWith('.js') || entry.name.endsWith('.mjs')) out.push(full)
  }
  return out
}

const targets = []
// 最要紧的：包入口与它们的库模块。
await collectJs(join(ROOT, 'packages'), targets)
// 项目自身的脚本（含本文件）。
await collectJs(join(ROOT, 'scripts'), targets)
// Electron 主进程。
await collectJs(join(ROOT, 'src'), targets)

const failures = []
let checked = 0
for (const file of targets) {
  // 跳过 devtools：一次性调试脚本，不属于产品路径。
  if (file.includes(`${'scripts'}`) && file.includes('devtools')) continue
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  checked += 1
  if (result.status !== 0) {
    const firstError = (result.stderr ?? '')
      .split(/\r?\n/)
      .find((line) => line.includes('SyntaxError') || line.trim().startsWith('^')) ?? ''
    failures.push({
      path: relative(ROOT, file).split('\\').join('/'),
      error: `${(result.stderr ?? '').split(/\r?\n/).slice(0, 3).join(' ').trim()}`,
      hint: firstError,
    })
  }
}

console.log('=== 源码语法守卫 ===')
console.log(`已检查 ${checked} 个 JS 模块（packages/ + scripts/ + src/）`)
if (failures.length === 0) {
  console.log('全部可解析')
  process.exit(0)
}
console.log()
console.log(`${failures.length} 个文件解析失败：`)
for (const f of failures) {
  console.log(`  ${f.path}`)
  console.log(`    ${f.error}`)
}
console.log()
console.log('注意：语法错误会让整套 check 失去意义 —— 集成验证读的是 profile 里的安装副本，')
console.log('      不会因为源码坏掉而失败。修好语法后再跑 npm run check。')
process.exit(1)
