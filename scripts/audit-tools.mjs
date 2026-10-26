/** 列出每个包注册的工具（用于架构审查）。 */
import { pathToFileURL } from 'node:url'
import { join, resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const packages = [
  'dsh-autoresearch',
  'dsh-autoresearch-skills',
  'dsh-autoresearch-gates',
  'dsh-autoresearch-qa',
  'dsh-autoresearch-remote',
  'dsh-autoresearch-api',
  'dsh-autoresearch-autodl',
  'dsh-autoresearch-lark',
]

const registered = []
const ctx = {
  logger: { info: () => {}, warn: () => {}, error: () => {} },
  effect: (fn) => { fn(); return () => {} },
  on: () => () => {},
  inject: (_services, fn) => { fn(ctx); return () => {} },
  tools: { register: (definition) => { registered.push({ pkg: '', name: definition.name }); return () => {} } },
  skills: { registerProvider: () => () => {} },
  sessionProjections: { register: () => () => {}, stateOf: () => undefined },
  commands: { register: () => () => {} },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 3000 },
  connection: { fetch: { register: () => () => {} } },
  workingDirectory: { path: ROOT },
}

for (const pkg of packages) {
  try {
    const before = registered.length
    const module = await import(pathToFileURL(join(ROOT, 'packages', pkg, 'index.js')).href)
    module.apply(ctx, undefined)
    for (let index = before; index < registered.length; index++) registered[index].pkg = pkg
  } catch (error) {
    // 需要真实服务的包跳过（注册的仍被记录）
    console.log(`  [${pkg}] apply 需要真实服务：${error.message.slice(0, 60)}`)
  }
}

console.log(`\n共 ${registered.length} 个工具：\n`)
let current = ''
for (const tool of registered) {
  if (tool.pkg !== current) { current = tool.pkg; console.log(`  [${current}]`) }
  console.log(`    ${tool.name}`)
}

// 按「谁用」分类：模式驱动 / 独立操作 / 查询
console.log('\n=== 工具分类（按用途）===')
const modeDriven = registered.filter((t) => t.name.startsWith('autoresearch_') && !t.name.includes('remote') && !t.name.includes('api') && !t.name.includes('qa_') && !t.name.includes('skill'))
const remote = registered.filter((t) => t.name.includes('remote'))
const api = registered.filter((t) => t.name.includes('api'))
const qa = registered.filter((t) => t.name.includes('qa_') || t.name.includes('skill'))
console.log(`  工作流驱动（模式使用）：${modeDriven.length}`)
console.log(`  远端执行：${remote.length}`)
console.log(`  自定义 API：${api.length}`)
console.log(`  技能浏览：${qa.length}`)
