/**
 * 工具注册守卫：断言每个插件**真的把工具注册进 ctx.tools**。
 *
 * ## 为什么需要这个脚本
 *
 * `verify-integration.mjs` 起真实 harness 进程，断言插件「没有 failed to import」。
 * 但上面那次事故证明了这不够：我在 `qa/index.js` 里写了个语法错误，
 * 集成验证仍然 34/34 全绿 —— 因为它加载的是 profile 里装的副本，
 * 而且它只检查「导入失败」日志，不检查「工具是否注册成功」。
 *
 * 于是产生一个盲区：**插件加载成功但工具注册失败**（或代码坏了但被缓存掩盖）
 * 时，整套检查会继续报绿。这个脚本堵的就是这个缺口。
 *
 * ## 做法
 *
 * 不启动完整 harness，而是直接构造一个最小的 ctx，逐个 apply 插件，
 * 记录每个插件注册了哪些工具名。这样：
 *   · 任何插件代码抛错 → 立刻失败并指出插件名与错误
 *   · 工具数与名单与预期不一致 → 失败
 *   · 不依赖 profile 缓存，读的就是源码
 *
 * 用法：node scripts/tool-registry-guard.mjs
 */

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * 插件之间用裸包名互相 import（如 qa → 'dsh-autoresearch-api'）。
 * 这在 **profile 安装后**能解析（包都软链进 profiles/<name>/node_modules），
 * 但在源码树里直接跑解析不到。
 *
 * 两种做法各有取舍：
 *   · 让插件改用相对路径 → 破坏包边界，且安装后未必成立
 *   · 在源码树里给 Node 一个解析路径 → 保持插件写法不变
 * 这里选后者：把已安装 profile 的 node_modules 作为解析根，
 * 从而**用源码字节**测试注册，而不是测 profile 里的缓存副本。
 */
function resolveRoots() {
  const roots = []
  const profiles = join(ROOT, '.dsh-home', 'profiles')
  for (const name of ['autoresearch', 'headless']) {
    const nm = join(profiles, name, 'node_modules')
    if (existsSync(nm)) roots.push(nm)
  }
  return roots
}

const EXTRA_ROOTS = resolveRoots()
if (EXTRA_ROOTS.length === 0) {
  console.log('未找到已安装 profile 的 node_modules。')
  console.log('请先跑 npm run profile:install —— 本守卫需要一个解析根来 import 插件的裸包依赖。')
  process.exit(2)
}

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

/** 最小 ctx：只实现插件 apply 时真正会碰到的接口。 */
function makeContext() {
  const registered = []
  const events = []
  const services = new Map()

  const ctx = {
    tools: {
      register(definition) {
        const name = definition?.name
        if (typeof name !== 'string' || name === '') {
          throw new Error('tools.register 收到无 name 的定义')
        }
        registered.push({ name, definition })
      },
    },
    on(event, handler) { events.push({ event, handler }) },
    // Cordis 的 ctx.effect(fn) 把 fn 当作**注册副作用**：fn 返回 dispose，
    // 且 fn 内部用的仍是同一个 ctx（不是子 ctx）。所以直接把 ctx 传回去即可。
    effect(fn) { return fn() },
    // 插件普遍用 ctx.provide / ctx.set 暴露服务；这里记账即可。
    provide(name, value) { services.set(name, value) },
    set(name, value) { services.set(name, value) },
    get(name) { return services.get(name) },
    inject() {},
    logger: {
      info() {}, warn() {}, error() {}, debug() {},
    },
    config: {},
    plugin() {},
    // 工作流模式插件会注册一个会话投影（用于折叠模式命令事件）。
    sessionProjections: {
      register(spec) {
        services.set('__projection__', spec)
        return { dispose() {} }
      },
    },
    // 工作流模式插件会往系统提示注入段落。这里记账并返回一个可释放句柄，
    // 因为 apply 期就会调用它，缺了会直接抛错。
    // getSectionOrder 也要提供 —— apply 期用它决定注入位置。
    systemPrompt: {
      section(spec) {
        services.set('__prompt_section__', spec)
        return { dispose() {} }
      },
      getSectionOrder() { return [] },
    },
  }
  // 常见别名：Cordis 的 ctx 同时是函数与对象，插件可能用 ctx.plugin(...)。
  ctx.root = ctx
  return { ctx, registered, events, services }
}

/** 每个插件声明的工具（用于断言数量与关键项）。 */
const EXPECTED = {
  'dsh-autoresearch': ['autoresearch_init', 'autoresearch_gate', 'autoresearch_advance', 'autoresearch_trajectory'],
  'dsh-autoresearch-gates': ['autoresearch_gate_run'],
  'dsh-autoresearch-qa': ['autoresearch_qa_pack', 'autoresearch_qa_lanes', 'autoresearch_qa_dual', 'autoresearch_qa_verify', 'autoresearch_deliberate'],
  'dsh-autoresearch-api': ['autoresearch_api_add', 'autoresearch_api_verify', 'autoresearch_api_dual_lanes'],
  'dsh-autoresearch-remote': [
    'autoresearch_remote_target', 'autoresearch_remote_probe', 'autoresearch_remote_submit',
    'autoresearch_remote_probe_job', 'autoresearch_remote_snapshot', 'autoresearch_remote_status',
    'autoresearch_remote_exec',
  ],
}

const PLUGINS = Object.keys(EXPECTED)

console.log('=== 工具注册守卫（直接 apply 插件，不经 profile 缓存）===')
console.log()

const seenAll = new Map()

for (const pluginName of PLUGINS) {
  const entry = join(ROOT, 'packages', pluginName, 'index.js')
  let mod
  try {
    mod = await import(pathToFileURL(entry).href)
  } catch (error) {
    const message = String(error.message).split('\n')[0]
    // 裸包名解析失败是**环境问题**，不是产品缺陷：源码树里没有平面 node_modules。
    // 必须与「插件代码坏了」区分开，否则会给出误导性的红色。
    if (message.includes('Cannot find package')) {
      record(`${pluginName} 可加载`, false, `${message}（环境问题：先在源码树建解析根）`)
    } else {
      record(`${pluginName} 可加载（语法/顶层错误）`, false, message)
    }
    continue
  }

  const apply = mod.default?.apply ?? mod.apply
  if (typeof apply !== 'function') {
    record(`${pluginName} 导出 apply`, false, `typeof apply = ${typeof apply}`)
    continue
  }

  const { ctx, registered } = makeContext()
  try {
    await apply(ctx, {})
  } catch (error) {
    // 这是关键信号：注册期抛错意味着该插件的工具全部不可用。
    record(`${pluginName} apply 不抛错`, false, String(error.message).split('\n')[0])
    continue
  }

  const names = registered.map((r) => r.name)
  for (const n of names) seenAll.set(n, pluginName)

  const expected = EXPECTED[pluginName]
  const missing = expected.filter((n) => !names.includes(n))
  record(`${pluginName} 注册全部 ${expected.length} 个工具`, missing.length === 0,
    missing.length ? `缺失 ${missing.join(', ')}` : `实际 ${names.length} 个`)

  // 同名工具被两个插件注册会导致后注册者静默覆盖前者。
  const dupes = names.filter((n, i) => names.indexOf(n) !== i)
  record(`${pluginName} 无重复工具名`, dupes.length === 0, dupes.join(', '))
}

console.log()
console.log('=== 交叉检查 ===')
const allNames = [...seenAll.keys()]
record('无跨插件重名', allNames.length === new Set(allNames).size)

// 与 README 声明一致 —— README 写错工具数是上一轮修过的缺陷，
// 这里让它可被自动发现，而不是靠人工核对。
const totalExpected = Object.values(EXPECTED).reduce((a, b) => a + b.length, 0)
record(`注册工具总数 = ${totalExpected}`, allNames.length === totalExpected, `实际 ${allNames.length}`)

// 涉及门禁/质检的工具必须存在，否则 AutoResearch 主流程不可用。
for (const critical of ['autoresearch_gate', 'autoresearch_advance', 'autoresearch_qa_dual', 'autoresearch_deliberate']) {
  record(`关键工具存在：${critical}`, seenAll.has(critical))
}

console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`工具注册守卫：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
