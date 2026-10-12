/**
 * 工作台启动器 —— 双击 .bat 调用的入口。
 *
 * 与 run-harness.mjs 的差别：这个是**日常使用**入口，做三件额外的事：
 *   1. 自动挑空闲端口（不撞已占用的 43141）
 *   2. 就绪后自动打开系统默认浏览器
 *   3. 单实例保护：已有工作台在跑时直接打开它，不重复起服务
 *
 * 与 run-harness.mjs 共用同一个 HarnessLauncher 与 runtime-paths 解析
 * （单一真源），因此行为和桌面壳、自检完全一致。
 */

import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { createServer } from 'node:net'
import { spawn } from 'node:child_process'
import { HarnessLauncher, DEFAULT_HARNESS_PORT } from '../src/main/harness-launcher.js'
import { resolveDshHome, resolveProfileRoot, PROFILE_NAME } from '../src/main/runtime-paths.js'

const HERE = resolve(fileURLToPath(import.meta.url), '..')
const PROJECT_ROOT = resolve(HERE, '..')
const dshHome = resolveDshHome()
const launchRoot = join(dshHome, 'launch-root')
const LOCK_FILE = join(dshHome, 'workbench.lock.json')

/** 找空闲端口：先试首选端口，被占用则让系统分配。 */
function findFreePort(preferred) {
  return new Promise((resolvePromise) => {
    const tryPort = (port) => {
      const server = createServer()
      server.once('error', () => {
        if (port === 0) { resolvePromise(null); return }
        tryPort(0)
      })
      server.once('listening', () => {
        const actual = server.address().port
        server.close(() => resolvePromise(actual))
      })
      server.listen(port, '127.0.0.1')
    }
    tryPort(preferred)
  })
}

/** 已有实例在跑？返回它的 URL。 */
async function existingInstance() {
  try {
    const lock = JSON.parse(await readFile(LOCK_FILE, 'utf8'))
    if (typeof lock?.url !== 'string') return null
    const response = await fetch(lock.url, { signal: AbortSignal.timeout(3000) }).catch(() => null)
    // 401 = harness 活着（需要 token）；其它状态也说明端口有东西。连接失败 = 已停。
    return response === null ? null : lock.url
  } catch {
    return null
  }
}

/** 用系统默认浏览器打开 URL（Windows/macOS/Linux 通吃）。 */
function openBrowser(url) {
  const command = process.platform === 'win32' ? 'cmd' : (process.platform === 'darwin' ? 'open' : 'xdg-open')
  const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
  try {
    spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } catch { /* 打不开浏览器不影响服务；URL 已打印 */ }
}

await mkdir(dshHome, { recursive: true })
await mkdir(launchRoot, { recursive: true })

// ── 单实例：已有在跑就直接打开 ────────────────────────────────────────────
const running = await existingInstance()
if (running !== null) {
  process.stdout.write(`\n  工作台已在运行：${running}\n  正在打开浏览器...\n`)
  openBrowser(running)
  // 不用 process.exit：spawn 出去的浏览器进程句柄尚未完全分离，强杀会触发
  // libuv 断言（UV_HANDLE_CLOSING）。事件循环里没有其它活动句柄，自然退出即可。
}

if (running === null) {
  // ── 环境检查（给出可执行的修复指引，而不是晦涩的加载错误）──────────────
  const profileRoot = resolveProfileRoot(dshHome, PROFILE_NAME)
  if (!existsSync(join(profileRoot, 'package.json'))) {
    process.stderr.write([
      `\n  profile "${PROFILE_NAME}" 未安装：${profileRoot}`,
      '  请先执行：npm run profile:install\n',
    ].join('\n'))
    process.exit(1)
  }

  const port = await findFreePort(DEFAULT_HARNESS_PORT)
  if (port === null) {
    process.stderr.write('\n  找不到可用端口。\n')
    process.exit(1)
  }

  const launcher = new HarnessLauncher({
    dshEntryPath: join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    patchPath: join(PROJECT_ROOT, 'build', 'autoresearch.patch.yml'),
    buildDir: join(PROJECT_ROOT, 'build'),
    dshHome,
    cwd: launchRoot,
    profile: PROFILE_NAME,
    host: '127.0.0.1',
    preferredPort: port,
    timeoutMs: 180_000,
    onLog: (line) => process.stdout.write(`${line}\n`),
  })

  const shutdown = async () => {
    try { await unlink(LOCK_FILE) } catch { /* 锁文件可能已不在 */ }
    await launcher.stop()
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  try {
    const { url, token } = await launcher.start()
    const target = new URL(url)
    if (token !== undefined) target.searchParams.set('token', token)
    const finalUrl = target.toString()

    await writeFile(LOCK_FILE, JSON.stringify({ url: finalUrl, pid: process.pid, at: new Date().toISOString() }), 'utf8')
    openBrowser(finalUrl)

    process.stdout.write([
      '',
      '  ═══════════════════════════════════════════════════',
      '    工作台已启动，浏览器正在打开',
      '  ═══════════════════════════════════════════════════',
      `    ${finalUrl}`,
      '',
      '    没自动打开？把上面这行复制到浏览器地址栏。',
      '    这个窗口 = 服务本体，关掉它工作台就停了。',
      '  ═══════════════════════════════════════════════════',
      '',
    ].join('\n'))
  } catch (error) {
    process.stderr.write(`\n  启动失败：${error?.message ?? error}\n`)
    await launcher.stop()
    process.exit(1)
  }
}
