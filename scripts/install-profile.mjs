/**
 * 把本项目的插件安装进 harness profile，并确保 profile 声明正确。
 *
 * 做两件事：
 *   1. 用 dsh 自带的 `plugin add` 把本地包装进 profile（pnpm 走 file: 本地依赖）
 *   2. 校验 profile 的 dsh.profile.bundles 含全部包、且 dsh-ars-brand 排在末尾
 *
 * 不修改 harness 自身，不覆盖已有 profile 文件内容以外的任何东西。
 *
 * 用法：
 *   node scripts/install-profile.mjs [--profile autoresearch] [--dsh-home <path>] [--dry-run]
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, access, rm } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
// 安装目标必须与桌面壳、启动脚本解析到同一个 DSH_HOME（单一真源），
// 否则会出现「装到 ~/.dsh、桌面壳读 .dsh-home」的分叉 —— 踩过一次。
import { resolveDshHome } from '../src/main/runtime-paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')

const PACKAGES = [
  'dsh-autoresearch',
  'dsh-autoresearch-skills',
  'dsh-autoresearch-gates',
  'dsh-autoresearch-ui',
  'dsh-autoresearch-qa',
  'dsh-autoresearch-remote',
  'dsh-autoresearch-api',
  // 模型议会是**独立工作台**：自己的面板、自己的路由前缀、自己的配置文件，
  // 与 dsh-autoresearch-ui 不共用任何东西 —— 所以它不依赖 UI 包的顺序。
  'dsh-model-council',
  // 身份层必须排在最后：它按 id 禁用 dsh-web-app 声明的 ui-brand-official 占位行，
  // 而 profile 的 patch 层是后者覆盖前者 —— 排在 dsh-web-app 之前就不生效。
  // 见 packages/dsh-ars-brand/README.md「顺序约束」。
  'dsh-ars-brand',
]

/**
 * 双路质检跑在 headless profile 上（一次性任务、无 Host/HTTP，天然隔离），
 * 因此 skills 插件也要装进那个 profile —— 否则两路读不到质检技能。
 */
const HEADLESS_PACKAGES = [
  // 双路质检需要质检技能（技能供应）
  'dsh-autoresearch-skills',
  // 无人值守场景同样需要门禁纪律与状态机（工作流模式所在）
  'dsh-autoresearch',
  // 双路质检自身由本插件编排
  'dsh-autoresearch-qa',
  // qa 直接 import 本包的 lib/tools.js（resolveUpstreamAsset）。
  // 它是 qa 的传递依赖，pnpm 会把它链进来 —— 但下面那轮 rm 只清本清单里的包，
  // 于是它的副本永远停在首次安装的版本：实测 headless 侧的 tools.js 比
  // autoresearch 侧旧了一个版本，而两边跑的是同一份 qa 代码。
  // 必须显式列出来，才会被强制重新链接。
  'dsh-autoresearch-gates',
  // 同理：qa 还 import 本包的 lib/profile-patch.js 与 lib/providers.js
  // （读 provider 声明与凭据引用）。漏了它同样会留下陈旧副本 ——
  // 实测 headless 侧三个文件都落后于源码。
  'dsh-autoresearch-api',
]

function parseArgs(argv) {
  const options = { profile: 'autoresearch', dshHome: null, dryRun: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--profile') options.profile = argv[++index]
    else if (token === '--dsh-home') options.dshHome = argv[++index]
    else if (token === '--dry-run') options.dryRun = true
  }
  return options
}

function run(command, args, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, { stdio: 'inherit', ...options })
    child.on('error', (error) => resolvePromise({ code: null, error }))
    child.on('close', (code) => resolvePromise({ code, error: null }))
  })
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshHome = resolveDshHome({ explicit: options.dshHome })
  const profileRoot = join(dshHome, 'profiles', options.profile)
  const dshEntry = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  console.log(`项目根：${PROJECT_ROOT}`)
  console.log(`DSH_HOME：${dshHome}`)
  console.log(`profile：${options.profile}`)

  if (!await exists(dshEntry)) {
    console.error(`\n找不到 dsh 入口：${dshEntry}`)
    console.error('请先在项目根执行 npm install（或 pnpm install）安装 @deepseek-ai/dsh。')
    process.exit(1)
  }

  if (options.dryRun) {
    console.log('\n[dry-run] 将执行：')
    for (const name of PACKAGES) {
      console.log(`  dsh plugin --profile ${options.profile} add file:${join(PROJECT_ROOT, 'packages', name)}`)
    }
    return
  }

  // 首次使用时 profile 目录可能还不存在：先让 dsh 用 web 模板初始化它。
  if (!await exists(join(profileRoot, 'package.json'))) {
    console.log(`\nprofile ${options.profile} 不存在，从 web 模板初始化…`)
    const init = await run(process.execPath, [
      dshEntry, options.profile, '--from-default-profile', 'web', '--dump-config',
    ], { env: { ...process.env, DSH_HOME: dshHome } })
    if (init.code !== 0 && init.error === null) {
      console.error('初始化 profile 失败（--from-default-profile 返回非零）。')
      process.exit(1)
    }
  }

  console.log('\n安装插件：')
  const specs = PACKAGES.map((name) => `file:${join(PROJECT_ROOT, 'packages', name)}`)

  // pnpm 对 file: 本地依赖会缓存副本：源码改了但版本号没变时，profile 里的副本可能仍是旧的。
  // 先删除 profile 中的既有副本，强制重新链接，避免「改了源码却跑了旧代码」。
  //
  // 这个坑踩过两次：第一次是 UI 插件改了源码但 profile 里是旧版，
  // 第二次是主插件重构后 profile 未刷新，导致插件加载失败被误判为代码缺陷。
  // 因此这一步不是优化，是正确性要求 —— 每次改 packages/ 下的源码都必须重跑本脚本。
  for (const name of PACKAGES) {
    await rm(join(profileRoot, 'node_modules', name), { recursive: true, force: true })
  }

  // 宿主提供的包必须全进程唯一实例：`@deepseek-ai/dsh-tools` 里的
  // TOOL_RUNTIME_SCHEDULER 是模块级 Symbol，两份物理副本会让
  // agent-loop 取不到调度器（工具调用全部崩：Cannot read properties of
  // undefined (reading 'prepare')）。实测踩过。插件已改为 peerDependencies，
  // 这里把 profile 里遗留的副本清掉，让它解析回项目侧的同一份。
  const HOST_PROVIDED = ['@deepseek-ai/dsh-tools']
  for (const name of HOST_PROVIDED) {
    for (const base of [join(profileRoot, 'node_modules'), join(profileRoot, 'node_modules', '@deepseek-ai')]) {
      const scoped = name.startsWith('@') ? join(base, name.split('/')[1]) : join(base, name)
      try {
        await rm(scoped, { recursive: true, force: true })
      } catch { /* 不存在即已唯一 */ }
    }
  }

  const add = await run(process.execPath, [
    dshEntry, 'plugin', '--profile', options.profile, 'add', ...specs,
  ], { env: { ...process.env, DSH_HOME: dshHome } })
  if (add.code !== 0) {
    console.error('\n插件安装失败。')
    process.exit(add.code ?? 1)
  }

  // headless profile：给双路质检准备技能
  const headlessRoot = join(dshHome, 'profiles', 'headless')
  if (!await exists(join(headlessRoot, 'package.json'))) {
    console.log('\nheadless profile 不存在，初始化…')
    await run(process.execPath, [
      dshEntry, 'headless', '--from-default-profile', 'headless', '--dump-config',
    ], { env: { ...process.env, DSH_HOME: dshHome } })
  }
  if (await exists(join(headlessRoot, 'package.json'))) {
    console.log('\n为双路质检准备 headless profile：')
    for (const name of HEADLESS_PACKAGES) {
      await rm(join(headlessRoot, 'node_modules', name), { recursive: true, force: true })
    }
    const headlessAdd = await run(process.execPath, [
      dshEntry, 'plugin', '--profile', 'headless', 'add',
      ...HEADLESS_PACKAGES.map((name) => `file:${join(PROJECT_ROOT, 'packages', name)}`),
    ], { env: { ...process.env, DSH_HOME: dshHome } })
    if (headlessAdd.code !== 0) {
      console.error('\nheadless profile 插件安装失败；双路质检将无法读取技能。')
    }
  }

  // 校验 bundles 声明
  const manifestPath = join(profileRoot, 'package.json')
  let manifest
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  } catch (error) {
    console.error(`\n无法读取 profile manifest：${error.message}`)
    process.exit(1)
  }

  manifest.dsh ??= {}
  manifest.dsh.profile ??= {}
  const bundles = Array.isArray(manifest.dsh.profile.bundles) ? manifest.dsh.profile.bundles : []
  const missing = PACKAGES.filter((name) => !bundles.includes(name))

  // 身份层必须排最后（它要覆盖 dsh-web-app 声明的品牌占位行）。仅靠「追加缺失项」
  // 在正常情况下就够，但如果 bundles 里已经有它却不在末尾（手工调整过、或旧版
  // 安装器留下的顺序），覆盖就会失效且没有任何报错。这里显式归位。
  const LAST = 'dsh-ars-brand'
  const nextBundles = [...bundles, ...missing].filter((name, index, all) => all.indexOf(name) === index)
  const ordered = [...nextBundles.filter((name) => name !== LAST), LAST].filter((name) => nextBundles.includes(name))

  const changed = JSON.stringify(ordered) !== JSON.stringify(bundles)
  if (changed) {
    manifest.dsh.profile.bundles = ordered
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    if (missing.length > 0) console.log(`\n已补入 bundles：${missing.join(', ')}`)
    console.log(`bundles 顺序已归一（${LAST} 归位到末尾）。`)
  } else {
    console.log('\nbundles 声明已完整且顺序正确。')
  }

  console.log(`\n完成。启动方式：`)
  console.log(`  DSH_HOME=${dshHome} node scripts/run-harness.mjs`)
  console.log(`  或桌面壳：npm run desktop`)
}

await main()
