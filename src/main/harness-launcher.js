/**
 * harness 启动器 —— 启动 AutoResearch profile 的 dsh 进程并等待就绪。
 *
 * 流程对齐 dsh-desktop 的做法，但保持最小：
 *   1. 解析 dsh CLI 入口与本项目的 profile 补丁路径
 *   2. spawn 子进程（--profile autoresearch --patch <patch> --no-open --host 127.0.0.1 --port <n>）
 *   3. 从 stdout 抓取 launch token，用带 token 的 GET / 探测就绪
 *   4. 就绪后把带 token 的 URL 交给窗口；退出时先 SIGTERM 再 SIGKILL
 *
 * 不做的事：不改动 harness 内部、不代理 API、不隐藏 token。
 *
 * @module desktop/harness-launcher
 */

import { spawn } from 'node:child_process'
import { createServer } from 'node:net'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 默认端口：与 dsh-desktop 的 43129/43127 错开，避免同时运行时抢占。 */
export const DEFAULT_HARNESS_PORT = 43140

const LAUNCH_TOKEN_PATTERN = /\bdsh web:\s*(\S+)/u

/** 探测端口是否可用；不可用时返回 0 让系统分配临时端口。 */
export function reserveLoopbackPort(preferred) {
  return new Promise((resolve) => {
    const server = createServer()
    server.once('error', () => resolve(0))
    server.once('listening', () => {
      server.close(() => resolve(preferred))
    })
    server.listen(preferred, '127.0.0.1')
  })
}

/**
 * 构造 dsh 参数。
 *
 * patch 层的叠加顺序即优先级：前者先应用，后者可覆盖。顺序为
 *   1. 桌面壳 patch（挂载 AutoResearch 插件）
 *   2. 自定义 API 的 provider 声明（用户配置，必须能覆盖默认）
 *   3. 默认模型指向
 * 已存在的路径才会被加上，避免 harness 因找不到 overlay 而拒绝启动。
 */
export function buildHarnessArguments(port, patchPaths, profile = 'autoresearch', options = {}) {
  const patches = (Array.isArray(patchPaths) ? patchPaths : [patchPaths])
    .filter((path) => typeof path === 'string' && path !== '')
  // host 默认回环；网页版传 0.0.0.0 可让局域网访问。--no-open 由调用方决定：
  // 桌面壳自带窗口（不额外开浏览器），网页版反而希望开浏览器。
  const host = typeof options.host === 'string' && options.host !== '' ? options.host : '127.0.0.1'
  return [
    '--profile', profile,
    ...patches.flatMap((path) => ['--patch', path]),
    ...(options.noOpen === false ? [] : ['--no-open']),
    '--host', host,
    '--port', String(port),
  ]
}

/**
 * 解析本次启动要叠加的 patch 列表。
 *
 * 只叠加桌面壳 patch。**不再叠加自定义 API 的生成 patch**：那些文件指向与
 * 内置设置页相同的 loader 条目（llm-pi-ai / agent-default-model），而补丁的
 * config 是整体替换 —— 叠加它们会把设置页写好的 providers 整个抹掉。
 *
 * 自定义 API 现在合并进 profile 自己的 cordis.patch.yml（设置页也写那份），
 * 因此天然生效，无需叠加任何额外层。
 *
 * @param basePatch 桌面壳 patch
 */
export function resolvePatchList(basePatch) {
  return [basePatch].filter((path) => typeof path === 'string' && path !== '' && existsSync(path))
}

/** 从一行 stdout 里抓 launch token 与 URL。 */
export function extractLaunchTarget(line) {
  const match = LAUNCH_TOKEN_PATTERN.exec(line)
  if (match === null) return undefined
  const url = match[1]
  try {
    const parsed = new URL(url)
    return { url, token: parsed.searchParams.get('token') ?? undefined, port: Number(parsed.port) }
  } catch {
    return undefined
  }
}

/** 就绪判定：有 token 且根路径返回 2xx–4xx（401 也算服务已起来）。 */
export function isStartupHealthy(status, token) {
  return token !== undefined && status >= 200 && status < 500
}

export class HarnessLauncher {
  #child = null
  #token = null
  #url = null
  #listeners = new Set()
  #logLines = []
  #maxLogLines = 400
  #stopping = false

  constructor(options) {
    this.options = options
  }

  get state() {
    return {
      running: this.#child !== null && this.#child.exitCode === null,
      url: this.#url,
      token: this.#token,
      pid: this.#child?.pid ?? null,
      logs: this.#logLines,
    }
  }

  /** 订阅状态变化；返回取消订阅函数。 */
  onChange(listener) {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event) {
    for (const listener of this.#listeners) {
      try {
        listener(event)
      } catch (error) {
        this.options.onLog?.(`launcher: listener failed: ${error?.message ?? error}`)
      }
    }
  }

  #record(line) {
    this.#logLines.push(line)
    if (this.#logLines.length > this.#maxLogLines) this.#logLines.shift()
    this.options.onLog?.(line)
  }

  /**
   * 启动并等待就绪。返回 { url, token }。
   * 超时或进程提前退出时抛错，错误信息带最后若干行日志。
   */
  async start() {
    const { dshEntryPath, patchPath, dshHome, cwd, timeoutMs = 180_000 } = this.options

    if (!existsSync(dshEntryPath)) {
      throw new Error(`找不到 dsh 入口：${dshEntryPath}`)
    }
    const port = await reserveLoopbackPort(this.options.preferredPort ?? DEFAULT_HARNESS_PORT)
    const patches = resolvePatchList(patchPath)
    this.#record(`launcher: patch 层 ${patches.length} 个：${patches.map((p) => p.split(/[\/]/).pop()).join(' → ')}`)
    const argv = buildHarnessArguments(port, patches, this.options.profile, {
      host: this.options.host,
      noOpen: this.options.noOpen,
    })

    // 打包后的 Electron 主进程用 electron.exe 作为 Node 运行 harness；不设这个变量
    // 会再开一个 Electron 应用实例而不是执行脚本（现象是子进程无输出）。
    // 同时剥掉继承来的干扰变量，避免外层环境把它带进来又没清理。
    const environment = { ...process.env }
    delete environment.ELECTRON_RUN_AS_NODE
    delete environment.ELECTRON_NO_ATTACH_CONSOLE
    environment.DSH_HOME = dshHome
    environment.NO_COLOR = '1'
    environment.PYTHONIOENCODING = 'utf-8'
    environment.PYTHONUTF8 = '1'
    // 文件沙箱模式：桌面端默认完全访问。
    //
    // 原因（实测）：默认的 workspace-write 要在每个会话工作目录上写受限 SID 的
    // ACE，这要求改目录 DACL 的权限；当前用户在多数目录只有 Modify（无 WRITE_DAC），
    // 授予阶段直接以 `SetNamedSecurityInfoW failed (Win32 5)` 失败 —— 后果是所有
    // pwsh 命令都跑不了，每个新会话都要手动切「完全权限」，不可用。
    //
    // 这不会削弱教程要求的隔离：Agent 的任务隔离由 Docker 提供（环境/测试双镜像），
    // 本沙箱是桌面编辑器自身的文件护栏。外部已设置该变量时尊重外部选择。
    environment.DSH_PERMISSION_MODE ??= 'danger-full-access'
    if (process.versions.electron !== undefined) {
      environment.ELECTRON_RUN_AS_NODE = '1'
    }

    this.#record(`launcher: spawn ${process.execPath} ${dshEntryPath} ${argv.join(' ')}`)
    const child = spawn(process.execPath, [dshEntryPath, ...argv], {
      cwd: cwd ?? dirname(dshEntryPath),
      env: environment,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    this.#child = child

    let stdoutBuffer = ''
    let stderrBuffer = ''
    const ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`harness 启动超时（${Math.round(timeoutMs / 1000)}s）。最近日志：\n${this.#logLines.slice(-12).join('\n')}`))
      }, timeoutMs)

      child.on('error', (error) => {
        clearTimeout(timer)
        reject(new Error(`harness 进程启动失败：${error.message}`))
      })

      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (!this.#stopping) {
          reject(new Error(`harness 提前退出（code=${code} signal=${signal}）。最近日志：\n${this.#logLines.slice(-12).join('\n')}`))
        }
      })

      child.stdout.on('data', (chunk) => {
        stdoutBuffer += String(chunk)
        const lines = stdoutBuffer.split(/\r?\n/)
        stdoutBuffer = lines.pop() ?? ''
        for (const line of lines) {
          this.#record(`[stdout] ${line}`)
          const target = extractLaunchTarget(line)
          if (target !== undefined) {
            this.#token = target.token ?? null
            this.#url = target.url
            clearTimeout(timer)
            resolve(target)
          }
        }
      })

      child.stderr.on('data', (chunk) => {
        stderrBuffer += String(chunk)
        const lines = stderrBuffer.split(/\r?\n/)
        stderrBuffer = lines.pop() ?? ''
        for (const line of lines) this.#record(`[stderr] ${line}`)
      })
    })

    const target = await ready
    this.#emit({ kind: 'launch', ...target })
    await this.#waitUntilReady(target, timeoutMs)
    this.#emit({ kind: 'ready', url: this.#url, token: this.#token })
    return { url: this.#url, token: this.#token }
  }

  /** 轮询根路径直到服务就绪。 */
  async #waitUntilReady(target, timeoutMs) {
    const deadline = Date.now() + Math.max(30_000, timeoutMs - 10_000)
    while (Date.now() < deadline) {
      if (this.#child?.exitCode !== null && this.#child !== null) {
        throw new Error(`harness 在就绪探测期间退出。最近日志：\n${this.#logLines.slice(-12).join('\n')}`)
      }
      try {
        const response = await fetch(target.url, { redirect: 'manual', signal: AbortSignal.timeout(1500) })
        if (isStartupHealthy(response.status, target.token)) return
      } catch { /* 还没起来，继续轮询 */ }
      await new Promise((resolve) => setTimeout(resolve, 250))
    }
    throw new Error(`harness 未在预期时间内就绪。最近日志：\n${this.#logLines.slice(-12).join('\n')}`)
  }

  /** 停止：先 SIGTERM，4 秒后 SIGKILL。 */
  async stop() {
    const child = this.#child
    if (child === null || child.exitCode !== null) return
    this.#stopping = true
    const exited = new Promise((resolve) => child.once('exit', () => resolve(true)))
    child.kill('SIGTERM')
    const graceful = await Promise.race([
      exited,
      new Promise((resolve) => setTimeout(() => resolve(false), 4000)),
    ])
    if (!graceful && child.exitCode === null) child.kill('SIGKILL')
    this.#child = null
    this.#emit({ kind: 'stopped' })
  }
}

/** 解析项目内的资源路径。 */
export function resolveProjectPaths(appRoot, isPackaged, resourcesPath) {
  const base = isPackaged ? resourcesPath : appRoot
  return {
    dshEntryPath: join(appRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
    patchPath: join(base, 'autoresearch.patch.yml'),
  }
}
