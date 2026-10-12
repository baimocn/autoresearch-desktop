/**
 * 启动 AutoResearch harness（网页版入口）。
 *
 * 与桌面壳调用**同一个** HarnessLauncher，因此走的是同一条真实路径；差别只在于
 * 这里不起窗口，而是打印带 token 的 URL 让浏览器打开。DSH_HOME 也共用
 * runtime-paths 的解析（单一真源）—— 曾经这里写死 ~/.dsh、桌面壳用项目
 * .dsh-home，导致「装好的 profile 换个启动方式就看不见」。
 *
 * 用法：
 *   npm run harness                      # 默认端口，本机可访问
 *   npm run harness -- --port 43141      # 指定端口
 *   npm run harness -- --task-root <path># 指定任务根作为 harness 工作目录
 *   npm run harness -- --lan            # 监听 0.0.0.0（局域网内其它机器可连）
 */

import { dirname, join, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { HarnessLauncher, DEFAULT_HARNESS_PORT } from '../src/main/harness-launcher.js'
import { resolveDshHome, resolveProfileRoot, PROFILE_NAME } from '../src/main/runtime-paths.js'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')

function parseArgs(argv) {
  const options = {
    port: DEFAULT_HARNESS_PORT,
    timeoutSeconds: 180,
    profile: PROFILE_NAME,
    taskRoot: null,
    lan: false,
  }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--port') options.port = Number(argv[++index])
    else if (token === '--timeout') options.timeoutSeconds = Number(argv[++index])
    else if (token === '--profile') options.profile = argv[++index]
    else if (token === '--task-root') options.taskRoot = argv[++index]
    else if (token === '--lan') options.lan = true
  }
  return options
}

const options = parseArgs(process.argv.slice(2))

// DSH_HOME：与桌面壳、安装脚本共用同一解析（环境变量 > 项目 .dsh-home）。
const dshHome = resolveDshHome()
const launchRoot = options.taskRoot === null
  ? join(dshHome, 'launch-root')
  : (isAbsolute(options.taskRoot) ? options.taskRoot : resolve(process.cwd(), options.taskRoot))
await mkdir(dshHome, { recursive: true })
await mkdir(launchRoot, { recursive: true })

// 起进程前先给可执行的诊断，而不是让它以晦涩的加载错误退出。
const profileRoot = resolveProfileRoot(dshHome, options.profile)
if (!existsSync(join(profileRoot, 'package.json'))) {
  process.stderr.write([
    `\nprofile "${options.profile}" 未安装：${profileRoot}`,
    `请先执行：npm run profile:install`,
    `（或用 DSH_HOME 指定已有环境；当前解析到 ${dshHome}）\n`,
  ].join('\n'))
  process.exit(1)
}

const launcher = new HarnessLauncher({
  dshEntryPath: join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  patchPath: join(PROJECT_ROOT, 'build', 'autoresearch.patch.yml'),
  buildDir: join(PROJECT_ROOT, 'build'),
  dshHome,
  cwd: launchRoot,
  profile: options.profile,
  host: options.lan ? '0.0.0.0' : '127.0.0.1',
  preferredPort: options.port,
  timeoutMs: options.timeoutSeconds * 1000,
  onLog: (line) => process.stdout.write(`${line}\n`),
})

const shutdown = async () => {
  await launcher.stop()
  process.exit(0)
}
process.on('SIGINT', shutdown)
process.on('SIGTERM', shutdown)

try {
  const { url, token } = await launcher.start()
  const withToken = new URL(url)
  if (token !== undefined) withToken.searchParams.set('token', token)
  process.stdout.write([
    '',
    '════════════════════════════════════════════════════════',
    `  AutoResearch harness 已就绪`,
    '════════════════════════════════════════════════════════',
    `  URL：${withToken.toString()}`,
    '',
    `  工作目录：${launchRoot}`,
    `  DSH_HOME：${dshHome}`,
    `  profile：${options.profile}`,
    '',
    '  把这个 URL 存成浏览器书签，以后一键打开。',
    options.lan ? `  局域网访问：把 127.0.0.1 换成本机 IP（当前监听 0.0.0.0）` : '  （加 --lan 可让局域网内其它机器访问）',
    '',
    '  按 Ctrl+C 停止。',
    '════════════════════════════════════════════════════════',
    '',
  ].join('\n'))
} catch (error) {
  process.stderr.write(`\n启动失败：${error?.message ?? error}\n`)
  await launcher.stop()
  process.exit(1)
}
