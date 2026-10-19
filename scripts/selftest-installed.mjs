/**
 * 安装副本自检 —— 验证「装进 profile 的那份代码」真的能用。
 *
 * ## 为什么必须有这个脚本
 *
 * 其余所有测试（selftest / verify-integration / tool-registry-guard / ablation-*）
 * 都 import 仓库里的 `packages/` 源码。而**实际运行的是 profile 里的安装副本**
 * （`<DSH_HOME>/profiles/<name>/node_modules/<pkg>`）。两者是两份物理文件，
 * 于是出现过这样的组合：
 *
 *   · 仓库侧 229 项测试全绿；
 *   · 装好的应用里，14 个门禁工具中 4 个（发布门那 4 个）解析为 null，
 *     双路质检恒返回 BLOCKED，API 校验恒报假阴性。
 *
 * 根因是 `join(HERE,'..','..','..')` 这类路径算术只在源码仓库里成立，
 * 装进 profile 后指向 profile 目录。这个脚本专门盯住这一类「只在安装后才暴露」
 * 的缺陷：它加载安装副本、跑真实解析，而不是读源码。
 *
 * ## 判定
 *
 * profile 未安装时**大声跳过**（打印醒目横幅），因为此时没有可验证的产物；
 * profile 存在时严格判定，任何一项解析失败即退出码 1。
 *
 * 用法：
 *   node scripts/selftest-installed.mjs [--profile autoresearch] [--dsh-home <path>]
 */

import { access, readFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { resolveDshHome } from '../src/main/runtime-paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const options = { profile: 'autoresearch', dshHome: null }
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--profile') options.profile = argv[++index]
    else if (argv[index] === '--dsh-home') options.dshHome = argv[++index]
  }
  return options
}

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

let passed = 0
let failed = 0

async function check(name, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

/** 从安装副本里 import 一个模块（绕过包名解析，直接按路径加载）。 */
async function importInstalled(profileRoot, relative) {
  const absolute = join(profileRoot, 'node_modules', relative)
  if (!await exists(absolute)) {
    throw new Error(`安装副本不存在：${absolute}\n       先运行 npm run profile:install`)
  }
  return import(pathToFileURL(absolute).href)
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const dshHome = resolveDshHome({ explicit: options.dshHome })
  const profileRoot = join(dshHome, 'profiles', options.profile)

  console.log('安装副本自检（验证 profile 里那份代码，不是仓库源码）')
  console.log(`DSH_HOME：${dshHome}`)
  console.log(`profile ：${profileRoot}`)

  if (!await exists(join(profileRoot, 'package.json'))) {
    console.log('\n' + '='.repeat(64))
    console.log('  跳过：profile 尚未安装，没有可验证的安装副本。')
    console.log('  注意这不是「通过」—— 装好之后必须重跑本脚本。')
    console.log(`  安装：node scripts/install-profile.mjs --profile ${options.profile}`)
    console.log('='.repeat(64))
    console.log(`\n安装副本自检：0 通过，0 失败（未安装，已跳过）`)
    return
  }

  // ── 门禁工具解析 ────────────────────────────────────────────────────────
  // 这是踩过的那个坑：路径算术在安装后指向 profile 目录，
  // 14 个工具里 4 个解析为 null，而仓库侧测试看不见。

  await check('安装副本：门禁工具全部可解析（含发布门那 4 个）', async () => {
    const tools = await importInstalled(profileRoot, 'dsh-autoresearch-gates/lib/tools.js')
    const ids = Object.keys(tools.TOOL_REGISTRY)
    assert(ids.length > 0, 'TOOL_REGISTRY 为空')
    const unresolved = []
    for (const id of ids) {
      const resolved = await tools.resolveTool(id)
      if (resolved === undefined || resolved === null) unresolved.push(id)
    }
    assert(unresolved.length === 0,
      `${ids.length} 个工具里有 ${unresolved.length} 个解析失败：${unresolved.join(', ')}\n` +
      '       这通常意味着资产解析用了「往上够仓库根」的路径算术，装进 profile 后失效。')
  })

  await check('安装副本：解析出的脚本路径真实存在且在 profile 内', async () => {
    const tools = await importInstalled(profileRoot, 'dsh-autoresearch-gates/lib/tools.js')
    const samples = ['qa-implementation-review', 'privacy-scan', 'milestone-gate']
    for (const id of samples) {
      // resolveTool 返回 { ...meta, path, bytes }，不是路径字符串。
      const resolved = await tools.resolveTool(id)
      const path = resolved?.path
      assert(typeof path === 'string' && path !== '',
        `${id} 未解析出路径（得到 ${JSON.stringify(resolved?.path ?? resolved)}）`)
      assert(await exists(path), `${id} 解析到不存在的路径：${path}`)
      // 必须落在安装根之内：落到仓库里说明解析又走回了源码路径，
      // 那样「测安装副本」就名不副实了。
      assert(resolve(path).startsWith(resolve(profileRoot)),
        `${id} 解析到了 profile 之外：${path}\n       应当落在 ${profileRoot} 之内`)
    }
  })

  // ── dsh 入口解析 ────────────────────────────────────────────────────────
  // 双路质检与 API 校验都靠它。它由仓库根的 node_modules 提供，
  // 安装副本必须能向上解析到（Node 的模块解析会一路向上找）。

  await check('安装副本：dsh 入口可解析（双路质检 / API 校验依赖它）', async () => {
    const { createRequire } = await import('node:module')
    const anchor = join(profileRoot, 'node_modules', 'dsh-autoresearch-qa', 'index.js')
    assert(await exists(anchor), `找不到 qa 包安装副本：${anchor}`)
    const require_ = createRequire(pathToFileURL(anchor))
    let entry = null
    try {
      entry = require_.resolve('@deepseek-ai/dsh/lib/bin.js')
    } catch (error) {
      throw new Error(`从安装副本无法解析 dsh 入口：${error.code ?? error.message}\n` +
        '       双路质检会恒返回 BLOCKED，API 校验会恒报「配置不可用」。')
    }
    assert(await exists(entry), `解析到的 dsh 入口不存在：${entry}`)
  })

  // ── 两路配置文件名一致性 ────────────────────────────────────────────────
  // api 包为了避开包级环，自己写了一份 lanes 文件写入逻辑；
  // 两地的文件名必须一致，否则「配了却读不到」。

  await check('安装副本：两路配置文件名两处一致', async () => {
    const lanesSource = await readFile(
      join(profileRoot, 'node_modules', 'dsh-autoresearch-qa', 'lib', 'lanes.js'), 'utf8')
    const apiSource = await readFile(
      join(profileRoot, 'node_modules', 'dsh-autoresearch-api', 'index.js'), 'utf8')
    const lanesName = lanesSource.match(/LANES_FILE\s*=\s*'([^']+)'/)?.[1]
    const apiName = apiSource.match(/QA_LANES_FILE\s*=\s*'([^']+)'/)?.[1]
    assert(lanesName !== undefined, 'qa 包里找不到 LANES_FILE')
    assert(apiName !== undefined, 'api 包里找不到 QA_LANES_FILE')
    assert(lanesName === apiName,
      `文件名不一致：qa 用 "${lanesName}"，api 用 "${apiName}" —— 配了两路也读不到`)
  })

  // ── 安装副本不得引用仓库内路径 ──────────────────────────────────────────

  await check('安装副本：不再出现「往上够仓库根」的路径算术', async () => {
    const files = [
      'dsh-autoresearch-gates/lib/tools.js',
      'dsh-autoresearch-qa/index.js',
      'dsh-autoresearch-api/index.js',
    ]
    const offenders = []
    for (const relative of files) {
      const raw = await readFile(join(profileRoot, 'node_modules', relative), 'utf8')
      // 先去掉注释再匹配：修复说明里会引用旧写法，把注释算进来会永远报红。
      const source = raw
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1')
      // 只找「拼仓库内目录」的用法；纯 cwd / 兜底用途不在此列。
      if (/join\(\s*(PROJECT_ROOT|projectRoot)\s*,\s*'(packages|node_modules)'/.test(source)) {
        offenders.push(relative)
      }
    }
    assert(offenders.length === 0,
      `以下文件仍在用路径算术拼仓库内路径：${offenders.join(', ')}\n` +
      '       应改为 Node 模块解析（createRequire().resolve）。')
  })

  // ── 安装副本必须与源码逐字节相同 ────────────────────────────────────────
  //
  // profile 里是**真目录副本**（不是 junction），由 install-profile 重新链接。
  // 曾经存在的漏洞：`install-profile` 的 rm 只清 `HEADLESS_PACKAGES` 清单里的包，
  // 而 qa 直接 import `dsh-autoresearch-gates/lib/tools.js` —— gates 是 qa 的
  // 传递依赖，pnpm 会链进来，但永远不会被重新链接。实测 headless 侧的
  // tools.js 比 autoresearch 侧旧了一个版本，而两边跑同一份 qa 代码。
  //
  // 判据：**同一份源码在每个 profile 里的副本必须哈希相同**，且与源码相同。
  // 这不需要维护任何清单 —— 加了新包也自动覆盖。

  await check('安装副本：与源码逐字节相同（无陈旧副本）', async () => {
    const { readdir: readdirAsync, stat: statAsync } = await import('node:fs/promises')
    const { createHash } = await import('node:crypto')

    /** 这份源码在仓库里该长什么样。 */
    const hashOf = async (path) => {
      const bytes = await readFile(path)
      return createHash('sha256').update(bytes).digest('hex')
    }

    // 只核对「会被执行」的文件：各包的 index.js 与 lib/*.js。
    // 资产（assets/）体量大且由其它检查覆盖，这里不重复。
    const packagesRoot = join(PROJECT_ROOT, 'packages')
    const expected = new Map()
    for (const pkg of await readdirAsync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) continue
      const entry = join(packagesRoot, pkg.name, 'index.js')
      if (await exists(entry)) expected.set(`${pkg.name}/index.js`, await hashOf(entry))
      const libDir = join(packagesRoot, pkg.name, 'lib')
      let libEntries = []
      try { libEntries = await readdirAsync(libDir, { withFileTypes: true }) } catch { /* 无 lib */ }
      for (const file of libEntries) {
        if (!file.isFile() || !file.name.endsWith('.js')) continue
        const path = join(libDir, file.name)
        expected.set(`${pkg.name}/lib/${file.name}`, await hashOf(path))
      }
    }
    assert(expected.size > 0, '没能枚举出任何源码文件 —— 本检查失去意义')

    const profilesDir = join(dshHome, 'profiles')
    const drifts = []
    let compared = 0
    for (const profile of await readdirAsync(profilesDir, { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      for (const [relative, want] of expected) {
        const installed = join(profilesDir, profile.name, 'node_modules', relative)
        if (!await exists(installed)) continue // 该 profile 没装这个包：正常
        const stat = await statAsync(installed)
        if (!stat.isFile()) continue
        compared += 1
        const got = await hashOf(installed)
        if (got !== want) drifts.push(`${profile.name}: ${relative}`)
      }
    }
    assert(compared > 0, '没有任何可核对的安装副本 —— 先跑 npm run profile:install')
    assert(drifts.length === 0,
      `以下安装副本与源码不一致（陈旧副本）：\n         ${drifts.join('\n         ')}\n` +
      '       跑 npm run profile:install 重新链接；若仍不一致，说明该包没进安装清单。')
  })

  console.log(`\n安装副本自检：${passed} 通过，${failed} 失败，共 ${passed + failed} 项`)
  process.exitCode = failed === 0 ? 0 : 1
}

await main()
