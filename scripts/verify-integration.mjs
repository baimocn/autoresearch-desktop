/**
 * 端到端集成验证 —— 对真实 harness 进程验证交付物确实生效。
 *
 * 与 selftest.mjs 的分工：
 *   selftest.mjs         纯逻辑单测，不起进程
 *   verify-integration   起真实 dsh 进程，验证插件加载、工具注册、技能解析、HTTP 路由
 *
 * 本脚本不伪造结论：任一检查失败即非零退出，并如实打印失败原因。
 *
 * 用法：node scripts/verify-integration.mjs [--port 43150] [--timeout 200]
 */

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { homedir } from 'node:os'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { HarnessLauncher } from '../src/main/harness-launcher.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')

const options = { port: 43150, timeoutSeconds: 200 }
for (let index = 2; index < process.argv.length; index += 1) {
  if (process.argv[index] === '--port') options.port = Number(process.argv[index + 1])
  if (process.argv[index] === '--timeout') options.timeoutSeconds = Number(process.argv[index + 1])
}

const results = []
const check = (name, ok, detail) => {
  results.push({ name, ok, detail })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const dshHome = join(PROJECT_ROOT, '.dsh-home')
const launchRoot = await mkdtemp(join(tmpdir(), 'autoresearch-verify-'))
const launcher = new HarnessLauncher({
  dshEntryPath: join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  patchPath: join(PROJECT_ROOT, 'build', 'autoresearch.patch.yml'),
  dshHome,
  cwd: launchRoot,
  profile: 'autoresearch',
  preferredPort: options.port,
  timeoutMs: options.timeoutSeconds * 1000,
  onLog: () => {},
})

let exitCode = 0
try {
  console.log('启动 harness（真实进程）…')
  const { url, token } = await launcher.start()
  console.log(`就绪：${url}\n`)

  const log = launcher.state.logs.join('\n')

  console.log('=== 1) 插件加载 ===')
  check('全部 AutoResearch 行激活（无 did not activate 警告）',
    !log.includes('did not activate'),
    log.includes('did not activate') ? log.split('\n').find((line) => line.includes('did not activate')) : '无警告')
  for (const name of ['autoresearch', 'autoresearch-skills', 'autoresearch-gates', 'autoresearch-ui', 'autoresearch-qa', 'autoresearch-remote', 'autoresearch-api']) {
    check(`  ${name} 未出现在失败列表`,
      !new RegExp(`${name}[^\\n]*failed to import`).test(log))
  }

  console.log('\n=== 2) HTTP 路由（带 token 换取 cookie）===')
  const cookieJar = new Map()
  const response = await fetch(url, { redirect: 'manual' })
  const setCookie = response.headers.getSetCookie?.() ?? []
  for (const cookie of setCookie) {
    const [pair] = cookie.split(';')
    const [name, value] = pair.split('=')
    cookieJar.set(name, value)
  }
  const cookieHeader = [...cookieJar.entries()].map(([name, value]) => `${name}=${value}`).join('; ')
  check('根路径返回重定向且下发鉴权 cookie', cookieJar.size > 0, `cookie 数 ${cookieJar.size}`)

  const api = async (path) => {
    const apiResponse = await fetch(new URL(path, url), { headers: { cookie: cookieHeader } })
    const text = await apiResponse.text()
    let body
    try { body = JSON.parse(text) } catch { body = text }
    return { status: apiResponse.status, body }
  }

  const overview = await api('/api/autoresearch/overview')
  check('GET /api/autoresearch/overview 返回 200', overview.status === 200, `status=${overview.status}`)
  check('  overview 含四阶段', Array.isArray(overview.body?.phases) && overview.body.phases.length === 4,
    `phases=${overview.body?.phases?.length}`)
  check('  overview 含九道门禁目录', overview.body?.gateCatalog?.length === 9,
    `gates=${overview.body?.gateCatalog?.length}`)
  check('  overview 含评分标定常量', overview.body?.calibration?.referenceRange?.[0] === 0.15
    && overview.body?.calibration?.requiredSigmaMultiple === 3,
    JSON.stringify(overview.body?.calibration?.referenceRange))

  const gate = await api('/api/autoresearch/gate?gate=G-SELECT')
  check('GET /api/autoresearch/gate 返回 200', gate.status === 200, `status=${gate.status}`)

  const trajectory = await api('/api/autoresearch/trajectory?track=codex')
  check('GET /api/autoresearch/trajectory 返回 200', trajectory.status === 200, `status=${trajectory.status}`)
  check('  轨迹返回八字段定义', Array.isArray(trajectory.body?.fields) && trajectory.body.fields.length === 8,
    `fields=${trajectory.body?.fields?.length}`)

  const browseRoot = await api('/api/autoresearch/browse?path=')
  check('GET /api/autoresearch/browse 返回 200', browseRoot.status === 200, `status=${browseRoot.status}`)

  const dualQa = await api('/api/autoresearch/dual-qa')
  check('GET /api/autoresearch/dual-qa 返回 200', dualQa.status === 200, `status=${dualQa.status}`)
  check('  未运行时如实返回 ran=false', dualQa.body?.ran === false, `ran=${dualQa.body?.ran}`)

  const remoteView = await api('/api/autoresearch/remote')
  check('GET /api/autoresearch/remote 返回 200', remoteView.status === 200, `status=${remoteView.status}`)
  check('  未登记时如实返回 registered=false', remoteView.body?.registered === false,
    `registered=${remoteView.body?.registered}`)

  const modeView = await api('/api/autoresearch/mode')
  check('GET /api/autoresearch/mode 返回 200', modeView.status === 200, `status=${modeView.status}`)
  check('  mode 含当前阶段与门禁', modeView.body?.phase?.id !== undefined
    && Array.isArray(modeView.body?.gates), `phase=${modeView.body?.phase?.id}`)
  check('  mode 给出进入/退出命令与下一步', typeof modeView.body?.enterCommand === 'string'
    && typeof modeView.body?.nextAction === 'string')
  check('  mode 报告阻塞门禁', Array.isArray(modeView.body?.blocking),
    `blocking=${modeView.body?.blocking?.length}`)

  const apiView = await api('/api/autoresearch/api')
  check('GET /api/autoresearch/api 返回 200', apiView.status === 200, `status=${apiView.status}`)
  check('  未回显任何密钥值', JSON.stringify(apiView.body).includes('local-no-key-needed') === false,
    '响应体不含密钥本体')
  check('  显示的是 profile 用户层（与设置页同一份）',
    typeof apiView.body?.profilePatchPath === 'string'
      && apiView.body.profilePatchPath.includes('cordis.patch.yml'),
    apiView.body?.profilePatchPath ?? '（缺字段）')

  console.log('\n=== 4) 只读边界（越界必须被拒绝）===')
  const escaped = await api('/api/autoresearch/browse?path=../../etc/passwd')
  check('越界路径被拒绝（403）', escaped.status === 403, `status=${escaped.status}`)
  const disallowed = await api('/api/autoresearch/browse?path=node_modules')
  check('白名单外路径被拒绝（403）', disallowed.status === 403, `status=${disallowed.status}`)

  console.log('\n=== 5) 无凭据访问被拒绝 ===')
  const unauthenticated = await fetch(new URL('/api/autoresearch/overview', url))
  check('无 cookie 返回 401', unauthenticated.status === 401, `status=${unauthenticated.status}`)

  console.log('\n=== 6) 客户端插件资源可达 ===')
  // 客户端 bundle 的 URL 由宿主组合的启动图决定（含组合 hash），必须从页面读取，
  // 不能凭包名猜路径。
  const page = await fetch(url, { headers: { cookie: cookieHeader } })
  const pageHtml = await page.text()
  const bundleMatch = /"url":"(plugins\/\?\?dsh-autoresearch-ui\/client\.js[^"]*)"/.exec(pageHtml)
  check('启动图包含 AutoResearch 客户端插件', bundleMatch !== null,
    bundleMatch === null ? '未在 __DSH_BOOT__ 中找到该条目' : bundleMatch[1])
  if (bundleMatch !== null) {
    const bundlePath = bundleMatch[1].replace(/&amp;/g, '&')
    const clientBundle = await fetch(new URL(bundlePath, url), { headers: { cookie: cookieHeader } })
    check('客户端 bundle 可获取（200）', clientBundle.status === 200, `status=${clientBundle.status}`)
    if (clientBundle.status === 200) {
      const source = await clientBundle.text()
      check('  bundle 含模块自注册与面板键',
        source.includes('__ModuleLoader__.load') && source.includes('autoresearch'),
        `${source.length} 字节`)
    }
  }

  const failures = results.filter((entry) => !entry.ok)
  console.log(`\n集成验证：${results.length - failures.length} 通过，${failures.length} 失败，共 ${results.length} 项`)
  exitCode = failures.length === 0 ? 0 : 1
} catch (error) {
  console.error(`\n集成验证异常：${error?.message ?? error}`)
  exitCode = 1
} finally {
  await launcher.stop()
  await rm(launchRoot, { recursive: true, force: true })
}

process.exit(exitCode)
