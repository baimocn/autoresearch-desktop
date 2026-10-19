/**
 * 检查：autoresearch_init 的任务根解析是否会发生「路径漂移」。
 *
 * ## 为什么需要这道检查
 *
 * 实测事故：在一个 `process.cwd()` 指向 `.dsh-home/launch-root` 的会话里调用
 * `autoresearch_init`，并明确传了 `taskId: 'AutoRe1853'`，脚手架**仍然**落在
 * launch-root —— 题包写进了工作台默认启动目录，而不是任务 ID 目录。
 *
 * 两个缺陷叠加：
 *   1. `makeRootResolver` 在 `config.taskRoot === '.'` 时返回 `process.cwd()`，
 *      而桌面壳的 cwd 是 launch-root。
 *   2. 更根本的：`taskId` 只被写进状态，**从不参与寻址**。所以"已知任务身份"
 *      在路径解析里被静默丢弃，解析链（显式参数 > 会话绑定 > 配置根）三级全落空。
 *
 * 本脚本驱动**真实的 init 工具**（不是复刻它的逻辑），在临时 cwd 下验证：
 *   A. 传 taskId 且同名目录已存在 → 必须落在该目录，且不得在 cwd 留任何东西
 *   B. 传 taskId 但目录不存在     → 回退到 cwd，但必须**明确报告**未命中及搜索范围
 *   C. 传显式 task 路径           → 该路径优先，taskId 不得覆盖它
 *
 * 只测解析落点，不测题包内容（那是 selftest.mjs 的覆盖范围）。
 *
 * 用法：node scripts/check-init-root-drift.mjs
 */

import { mkdtemp, mkdir, rm, readdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '..', 'packages')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

/**
 * 造一个极简 ctx，足以让 apply() 注册工具并让我们取到 init。
 *
 * 刻意不 mock 工具实现：取到的是 index.js 里那个真实的 execute，
 * 这样测的就是生产路径，而不是我对它的理解。
 */
function makeCtx() {
  const registered = new Map()
  const ctx = {
    tools: {
      register: (tool) => { registered.set(tool.name, tool) },
      guard: () => {},
      restrict: () => {},
    },
    systemPrompt: { section: () => {}, getSectionOrder: () => 0 },
    effect: () => {},
    // mode.js / 其它子模块会注入 commands、agents 等服务；本检查只要 init，
    // 于是给一个空实现的 inject（不调用回调 = 不安装那些附加功能）。
    inject: () => {},
    on: () => {},
    logger: { info: () => {}, warn: () => {}, error: () => {} },
  }
  return { ctx, registered }
}

/** 建一个"根目录 + 若干子任务目录"，模拟真实的多任务并列布局。 */
async function makeFixture() {
  const base = await mkdtemp(join(tmpdir(), 'ars-drift-'))
  const cwd = join(base, 'launch-root')          // 模拟工作台默认启动目录
  const tasksDir = join(base, '任务区')            // 模拟任务存放地
  const existingTask = join(tasksDir, 'AutoRe9001')
  await mkdir(cwd, { recursive: true })
  await mkdir(existingTask, { recursive: true })
  // 任务根标记：让 isTaskRoot 认得出来
  await writeFile(join(existingTask, 'autoresearch-state.json'),
    JSON.stringify({ version: 1, taskId: 'AutoRe9001', phase: 'intake' }), 'utf8')
  return { base, cwd, tasksDir, existingTask }
}

const moduleUrl = new URL(`file://${join(PACKAGES, 'dsh-autoresearch', 'index.js').replace(/\\/g, '/')}`).href
const plugin = await import(moduleUrl)

console.log('=== autoresearch_init 任务根解析漂移检查 ===')
console.log()

// ── 场景 A：taskId 命中既有目录（事故的正面复现）──────────────────────────
{
  const fx = await makeFixture()
  const originalCwd = process.cwd()
  try {
    process.chdir(fx.cwd)
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx, {
      taskRoot: '.',                       // 生产默认值
      taskSearchRoots: [fx.tasksDir],      // 让定位能发现任务区
      dshHome: join(fx.base, 'home'),
    })
    const init = registered.get('autoresearch_init')
    if (init === undefined) throw new Error('autoresearch_init 未注册')

    const out = await init.execute(
      { title: '漂移检查题', taskId: 'AutoRe9001', taskType: 'S2' },
      { agent: { session: { id: 'session-drift-a' } } },
    )

    const landed = out.taskRoot
    record('A1 taskId 命中时落在任务 ID 目录',
      landed === fx.existingTask,
      `landed=${landed}`)
    record('A2 未在 cwd(launch-root) 写任何题包',
      (await readdir(fx.cwd)).length === 0,
      `cwd 内容=${(await readdir(fx.cwd)).join(',') || '(空)'}`)
    record('A3 返回里明确交代解析依据',
      typeof out.rootResolution === 'string' && out.rootResolution.includes('taskId'),
      out.rootResolution)
    record('A4 骨架确实建在任务目录内',
      (await readdir(fx.existingTask)).includes('workspace'),
      `任务目录内容=${(await readdir(fx.existingTask)).join(',')}`)
  } finally {
    process.chdir(originalCwd)
    await rm(fx.base, { recursive: true, force: true })
  }
}

// ── 场景 B：taskId 未命中 → 允许回退，但必须显式报告 ───────────────────────
{
  const fx = await makeFixture()
  const originalCwd = process.cwd()
  try {
    process.chdir(fx.cwd)
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx, {
      taskRoot: '.',
      taskSearchRoots: [fx.tasksDir],
      dshHome: join(fx.base, 'home'),
    })
    const init = registered.get('autoresearch_init')

    const out = await init.execute(
      { title: '未命中题', taskId: 'AutoRe9999', taskType: 'S2' },
      { agent: { session: { id: 'session-drift-b' } } },
    )

    record('B1 未命中时回退到配置根（不静默乱选别的任务）',
      out.taskRoot === fx.cwd, `landed=${out.taskRoot}`)
    record('B2 未命中时报告明说"未找到"与搜索范围',
      typeof out.rootResolution === 'string'
        && out.rootResolution.includes('未找到')
        && out.rootResolution.includes(fx.tasksDir),
      out.rootResolution)
    record('B3 未污染既有任务目录',
      !(await readdir(fx.existingTask)).includes('workspace'),
      `既有任务目录=${(await readdir(fx.existingTask)).join(',')}`)
  } finally {
    process.chdir(originalCwd)
    await rm(fx.base, { recursive: true, force: true })
  }
}

// ── 场景 C：显式 task 路径优先于 taskId ────────────────────────────────────
{
  const fx = await makeFixture()
  const originalCwd = process.cwd()
  try {
    process.chdir(fx.cwd)
    const explicit = join(fx.tasksDir, 'ExplicitTarget')
    await mkdir(explicit, { recursive: true })
    // 显式 task 路径走 assertTaskRoot：它要求目录已是任务根（有意为之的护栏，
    // 防止把题包写进任意目录）。故这里先放标记，再验证「显式优先」这一件事。
    await writeFile(join(explicit, 'autoresearch-state.json'),
      JSON.stringify({ version: 1, taskId: 'ExplicitTarget', phase: 'intake' }), 'utf8')
    const { ctx, registered } = makeCtx()
    plugin.apply(ctx, { taskRoot: '.', taskSearchRoots: [fx.tasksDir], dshHome: join(fx.base, 'home') })
    const init = registered.get('autoresearch_init')

    const out = await init.execute(
      { title: '显式优先题', task: explicit, taskId: 'AutoRe9001', taskType: 'S2' },
      { agent: { session: { id: 'session-drift-c' } } },
    )

    record('C1 显式 task 路径优先，taskId 不覆盖它',
      out.taskRoot.toLowerCase() === explicit.toLowerCase(),
      `landed=${out.taskRoot}`)
  } finally {
    process.chdir(originalCwd)
    await rm(fx.base, { recursive: true, force: true })
  }
}

// ── 场景 D：locateTaskRootById 的纯函数行为 ────────────────────────────────
{
  const fx = await makeFixture()
  try {
    const st = await import(new URL(
      `file://${join(PACKAGES, 'dsh-autoresearch', 'lib', 'session-tasks.js').replace(/\\/g, '/')}`).href)
    const hit = await st.locateTaskRootById('AutoRe9001', [fx.tasksDir])
    const miss = await st.locateTaskRootById('NoSuchTask', [fx.tasksDir])
    record('D1 命中返回绝对路径', hit.found === fx.existingTask, `${hit.found}`)
    record('D2 未命中返回 null 且带搜索范围',
      miss.found === null && miss.searched.includes(fx.tasksDir),
      `searched=${miss.searched.join(';')}`)
    record('D3 大小写不敏感',
      (await st.locateTaskRootById('autore9001', [fx.tasksDir])).found === fx.existingTask, '')
    record('D4 空 taskId 不猜测',
      (await st.locateTaskRootById('', [fx.tasksDir])).found === null, '')
  } finally {
    await rm(fx.base, { recursive: true, force: true })
  }
}

const failed = results.filter((item) => !item.ok)
console.log()
console.log(`汇总：${results.length - failed.length}/${results.length} 通过`)
if (failed.length > 0) {
  console.log('失败项：')
  for (const item of failed) console.log(`  - ${item.name}`)
  process.exit(1)
}
console.log('✓ 任务根解析无漂移')
