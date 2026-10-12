/**
 * 导出全部已注册的 autoresearch_* 工具名 —— 以**运行时注册表**为准。
 *
 * 为什么不 grep 源码：工具名由 `TOOL_PREFIX`、共享常量与辅助函数拼出，
 * 字面搜索既会漏（模板字符串）也会多（注释里提到的旧名）。
 * 唯一权威来源是 `ctx.tools.register()` 实际收到的 name。
 *
 * 用法：node scripts/list-tool-names.mjs
 */
import { readdir } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const packagesDir = join(ROOT, 'packages')

const names = new Map()

/** 造一个刚好够用的假 ctx，把注册到的工具名收集起来。 */
function fakeContext(pkgName) {
  const ctx = {
    tools: {
      register(tool) {
        const key = `${tool.name}`
        if (!names.has(key)) names.set(key, pkgName)
      },
    },
    logger: { info() {}, warn() {}, debug() {}, error() {} },
    slots: { inject() {}, register() {} },
    effect() {},
    on() {},
    command() {},
    layout: { selectPanel() {} },
    config: {},
    get() { return undefined },
    inject() { return [] },
    provide() {},
  }
  return ctx
}

const entries = await readdir(packagesDir, { withFileTypes: true })
const problems = []
for (const entry of entries) {
  if (!entry.isDirectory()) continue
  if (!entry.name.startsWith('dsh-autoresearch')) continue
  const entryFile = join(packagesDir, entry.name, 'index.js')
  let mod
  try {
    mod = await import(pathToFileURL(entryFile).href)
  } catch (error) {
    problems.push(`${entry.name}: 导入失败 — ${error.message}`)
    continue
  }
  const factory = mod.default
  const plugins = Array.isArray(factory) ? factory : [factory]
  for (const plugin of plugins) {
    if (plugin === undefined || plugin === null) continue
    // 形态 1：{ name, factory }
    if (typeof plugin.factory === 'function') {
      try { await plugin.factory(fakeContext(entry.name)) } catch (error) {
        problems.push(`${entry.name}: factory 抛错 — ${error.message}`)
      }
      continue
    }
    // 形态 2：直接是函数
    if (typeof plugin === 'function') {
      try { await plugin(fakeContext(entry.name)) } catch (error) {
        problems.push(`${entry.name}: 直接调用抛错 — ${error.message}`)
      }
    }
  }
}

const list = [...names.entries()].sort((a, b) => a[0].localeCompare(b[0]))
console.log(`已注册工具总数：${list.length}`)
console.log()
for (const [name, pkg] of list) console.log(`${name.padEnd(38)} ${pkg}`)
if (problems.length > 0) {
  console.log()
  console.log('未能枚举的包（这些包的工具数未计入上面的总数）：')
  for (const p of problems) console.log(`  ${p}`)
  process.exitCode = 2
}
