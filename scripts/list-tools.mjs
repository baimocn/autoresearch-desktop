/** 列出五个插件的注册名、注入依赖与工具清单（用于交付核对）。 */
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'

const packages = [
  'dsh-autoresearch',
  'dsh-autoresearch-skills',
  'dsh-autoresearch-gates',
  'dsh-autoresearch-ui',
  'dsh-autoresearch-qa',
  'dsh-autoresearch-remote',
  'dsh-autoresearch-api',
]

const registered = []
const ctx = {
  logger: { info: () => {} },
  effect: (fn) => { fn() },
  tools: { register: (definition) => { registered.push(definition.name); return () => {} } },
  skills: { registerProvider: () => () => {} },
  systemPrompt: { section: () => () => {}, getSectionOrder: () => 3000 },
  connection: { fetch: { register: () => () => {} } },
}

for (const name of packages) {
  const url = pathToFileURL(join(process.cwd(), 'packages', name, 'index.js')).href
  let module
  try {
    module = await import(url)
  } catch (error) {
    // UI 插件在 profile 外导入 dsh-autoresearch/lib/*；profile 内由 pnpm 解析，这里如实跳过。
    console.log(`${name.padEnd(26)} 无法在 profile 外导入（依赖 profile 内解析）：${error.code}`)
    continue
  }
  console.log(`${name.padEnd(26)} name=${String(module.name).padEnd(20)} inject=${JSON.stringify(module.inject)}`)
  try {
    module.apply(ctx, undefined)
  } catch (error) {
    console.log(`   apply 需要真实服务：${error.message.slice(0, 70)}`)
  }
}

console.log(`\n注册工具数：${registered.length}`)
for (const name of registered) console.log(`  ${name}`)
