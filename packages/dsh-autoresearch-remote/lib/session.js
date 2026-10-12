/**
 * 持久化远端执行 —— 让长跑任务在 SSH 断开后仍然继续，并可随时续接。
 *
 * 设计依据（SOP 实战教训 L8 行 110 与编排器三条硬规则）：
 *   · SSH 门户不稳 → 远端脚本 + `setsid nohup`；**关键链路自驱动，不依赖控制端**
 *   · 幂等 —— 每个阶段可重复执行，不产生重复任务（flock 加进程 cwd 检测）
 *   · 缺证据不推进 —— 完成度用 run.log 的完成标记判断，不用文件扩展名猜测
 *   · 绝不静默成功 —— 评分结果必须回读断言，失败写标志文件而非沉默退出
 *
 * 核心思想：**控制端只负责投递与查询，不负责持有进程。**
 * SSH 连接随时断开都不影响远端任务，因为：
 *   1. 脚本先落盘，再以 setsid 脱离会话启动
 *   2. 状态写在文件里（状态/日志/标记），不写在连接里
 *   3. 每次查询都是重新读文件，与上次连接无关
 *
 * @module dsh-autoresearch-remote/session
 */

import { spawn } from 'node:child_process'
import { writeFile, readFile, mkdir, access } from 'node:fs/promises'
import { join, dirname } from 'node:path'

export class RemoteError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'RemoteError'
    this.detail = detail ?? null
  }
}

/** 一次远端调用的超时与重试策略。SSH 不稳时的默认值偏保守。 */
export const DEFAULT_POLICY = Object.freeze({
  /** 单次 SSH 命令墙钟上限（毫秒）。查询类命令应当很短。 */
  commandTimeoutMs: 60_000,
  /** 投递类命令允许更久（要传输脚本与启动进程）。 */
  submitTimeoutMs: 180_000,
  /** 连接失败重试次数。 */
  retries: 3,
  /** 重试间隔基数（毫秒），按指数退避。 */
  retryBackoffMs: 2_000,
  /** SSH 保活：每 15 秒发一次 keepalive，最多 3 次无响应即断开重连。 */
  serverAliveInterval: 15,
  serverAliveCountMax: 3,
  /** 连接建立超时（秒）。 */
  connectTimeoutSeconds: 20,
})

/** 远端工作目录布局。所有状态都在文件里，因此与连接无关。 */
export const REMOTE_LAYOUT = Object.freeze({
  root: '.autoresearch-remote',
  scripts: 'scripts',
  state: 'state',
  logs: 'logs',
  markers: 'markers',
  snapshots: 'snapshots',
  reports: 'reports',
})

/**
 * 构造 SSH 公共参数。
 * 保活参数是关键：它们让控制端在链路抖动时尽快发现并重连，而不是挂死。
 */
export function sshCommonArguments(target, policy = DEFAULT_POLICY) {
  const args = [
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    `-o`, `ConnectTimeout=${policy.connectTimeoutSeconds}`,
    '-o', `ServerAliveInterval=${policy.serverAliveInterval}`,
    '-o', `ServerAliveCountMax=${policy.serverAliveCountMax}`,
    '-o', 'TCPKeepAlive=yes',
  ]
  if (target.port !== undefined && target.port !== null) {
    args.push('-p', String(target.port))
  }
  if (typeof target.identityFile === 'string' && target.identityFile !== '') {
    args.push('-i', target.identityFile)
  }
  return args
}

/** 目标描述串，如 user@host。 */
export function describeTarget(target) {
  return target.user === undefined ? target.host : `${target.user}@${target.host}`
}

/** 运行本地进程并收集输出。 */
function runProcess(command, argv, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, argv, {
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
        ...(options.input === undefined ? {} : { stdio: ['pipe', 'pipe', 'pipe'] }),
      })
    } catch (error) {
      resolve({ spawnError: error.message, stdout: '', stderr: '', exitCode: null, durationMs: 0 })
      return
    }
    let stdout = ''
    let stderr = ''
    const limit = options.maxOutputChars ?? 200_000
    const append = (current, chunk) => (current.length >= limit ? current : (current + chunk).slice(0, limit))
    child.stdout.on('data', (chunk) => { stdout = append(stdout, String(chunk)) })
    child.stderr.on('data', (chunk) => { stderr = append(stderr, String(chunk)) })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 可能已退出 */ }
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ spawnError: error.message, stdout, stderr, exitCode: null, durationMs: Date.now() - startedAt })
    })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        exitCode: code, signal, stdout, stderr,
        durationMs: Date.now() - startedAt,
        timedOut: code === null && signal === 'SIGKILL',
      })
    })

    if (options.input !== undefined) child.stdin.write(options.input)
    child.stdin?.end?.()
  })
}

/** 判断一次 SSH 失败是否值得重试。 */
export function isRetryableFailure(outcome) {
  if (outcome.timedOut) return true
  if (outcome.exitCode === 255) return true // ssh 自身错误：连接/认证/链路
  const text = `${outcome.stderr ?? ''}`
  return /Connection (closed|reset|timed out|refused)|Broken pipe|kex_exchange_identification|Operation timed out|Network is unreachable|No route to host|Connection attempt failed/i
    .test(text)
}

/**
 * 一次远端命令执行，带保活与指数退避重试。
 * 返回 { ok, stdout, stderr, exitCode, attempts, durationMs, retryable }。
 */
export async function sshExec(target, remoteCommand, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
  const timeoutMs = options.timeoutMs ?? policy.commandTimeoutMs
  const maxAttempts = (options.retries ?? policy.retries) + 1

  let last = null
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const outcome = await runProcess('ssh', [
      ...sshCommonArguments(target, policy),
      describeTarget(target),
      remoteCommand,
    ], { timeoutMs, maxOutputChars: options.maxOutputChars })

    const ok = outcome.spawnError === undefined && outcome.exitCode === 0 && !outcome.timedOut
    last = { ...outcome, attempts: attempt, ok }
    if (ok) return last

    const retryable = isRetryableFailure(outcome)
    if (!retryable || attempt === maxAttempts) {
      return { ...last, retryable }
    }
    // 指数退避；链路抖动通常几百毫秒到几秒内恢复。
    await new Promise((resolve) => setTimeout(resolve, policy.retryBackoffMs * 2 ** (attempt - 1)))
  }
  return last
}

/** shell 单引号转义。远端脚本内容全部走这个函数，避免注入与解析问题。 */
export function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

/** 确保远端目录布局存在；幂等。 */
export async function ensureLayout(target, remoteRoot, options = {}) {
  const paths = [
    remoteRoot,
    `${remoteRoot}/${REMOTE_LAYOUT.scripts}`,
    `${remoteRoot}/${REMOTE_LAYOUT.state}`,
    `${remoteRoot}/${REMOTE_LAYOUT.logs}`,
    `${remoteRoot}/${REMOTE_LAYOUT.markers}`,
    `${remoteRoot}/${REMOTE_LAYOUT.snapshots}`,
    `${remoteRoot}/${REMOTE_LAYOUT.reports}`,
  ]
  const command = `mkdir -p ${paths.map(shellQuote).join(' ')} && echo LAYOUT_OK`
  const result = await sshExec(target, command, { ...options, timeoutMs: options.commandTimeoutMs ?? 60_000 })
  if (!result.ok || !String(result.stdout).includes('LAYOUT_OK')) {
    throw new RemoteError(`远端目录创建失败：${result.stderr || result.stdout || '无输出'}`, result)
  }
  return paths
}

/**
 * 生成自驱动的任务脚本。
 *
 * 关键点：脚本自身用 `flock` 保证同名任务只有一个实例，
 * 用标记文件表达阶段完成，因此重复投递是安全的。
 */
export function buildSelfDrivingScript(job) {
  const lines = [
    '#!/usr/bin/env bash',
    '# 由 AutoResearch 远端编排生成：自驱动、幂等、可续接。',
    'set -u',
    `ROOT=${shellQuote(job.remoteRoot)}`,
    `JOB=${shellQuote(job.jobId)}`,
    `STATE="$ROOT/${REMOTE_LAYOUT.state}/$JOB.json"`,
    `LOG="$ROOT/${REMOTE_LAYOUT.logs}/$JOB.log"`,
    `DONE="$ROOT/${REMOTE_LAYOUT.markers}/$JOB.done"`,
    `FAIL="$ROOT/${REMOTE_LAYOUT.markers}/$JOB.fail"`,
    `LOCK="$ROOT/${REMOTE_LAYOUT.markers}/$JOB.lock"`,
    '',
    'say() { echo "[$(date +%F_%T)] $*" | tee -a "$LOG"; }',
    '',
    '# 完成标记存在即直接退出：重复投递不会重跑。',
    'if [ -f "$DONE" ]; then say "SKIP: already done"; exit 0; fi',
    '',
    '# flock 独占：同一 job 只有一个实例在跑。',
    'exec 9>"$LOCK"',
    'if ! flock -n 9; then say "SKIP: another instance holds the lock"; exit 0; fi',
    '',
    `cd ${shellQuote(job.workDir)} || { say "FAIL: workDir missing"; touch "$FAIL"; exit 1; }`,
    '',
    'say "START"',
    `echo "{\\"job\\":\\"$JOB\\",\\"phase\\":\\"running\\",\\"pid\\":$$,\\"started\\":\\"$(date -Is)\\"}" > "$STATE"`,
    '',
    '# 真正的工作负载；失败即写 FAIL 标记并退出非零。',
    `if ( ${job.command} ) >> "$LOG" 2>&1; then`,
    `  echo "{\\"job\\":\\"$JOB\\",\\"phase\\":\\"complete\\",\\"finished\\":\\"$(date -Is)\\"}" > "$STATE"`,
    '  touch "$DONE"',
    '  say "DONE"',
    'else',
    '  code=$?',
    `  echo "{\\"job\\":\\"$JOB\\",\\"phase\\":\\"failed\\",\\"exit\\":$code,\\"finished\\":\\"$(date -Is)\\"}" > "$STATE"`,
    '  touch "$FAIL"',
    '  say "FAIL exit=$code"',
    '  exit $code',
    'fi',
    '',
  ]
  return lines.join('\n')
}

/**
 * 投递任务：先写脚本落盘，再用 setsid 脱离会话启动。
 *
 * 这是持久化的关键：脚本与进程都在远端，控制端断开后任务继续跑。
 * 投递本身可重复执行（脚本自带幂等守卫）。
 */
export async function submitJob(target, job, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
  const script = buildSelfDrivingScript(job)
  const remoteScript = `${job.remoteRoot}/${REMOTE_LAYOUT.scripts}/${job.jobId}.sh`

  // 用 base64 传输脚本，避免引号、换行与 CRLF 在多层 shell 中被改写。
  const encoded = Buffer.from(script, 'utf8').toString('base64')
  const writeCommand = [
    `printf %s ${shellQuote(encoded)} | base64 -d > ${shellQuote(remoteScript)}`,
    `&& sed -i 's/\\r$//' ${shellQuote(remoteScript)}`,
    `&& chmod 700 ${shellQuote(remoteScript)}`,
    `&& echo WRITE_OK`,
  ].join(' ')

  const written = await sshExec(target, writeCommand, {
    ...options, policy, timeoutMs: options.submitTimeoutMs ?? policy.submitTimeoutMs,
  })
  if (!written.ok || !String(written.stdout).includes('WRITE_OK')) {
    throw new RemoteError(`脚本投递失败：${written.stderr || written.stdout || '无输出'}`, written)
  }

  // setsid + nohup + 输入重定向到 /dev/null：彻底脱离控制端会话。
  const launchCommand = [
    `cd ${shellQuote(job.workDir)}`,
    `&& setsid nohup bash ${shellQuote(remoteScript)} </dev/null >> ${shellQuote(`${job.remoteRoot}/${REMOTE_LAYOUT.logs}/${job.jobId}.log`)} 2>&1 &`,
    'echo LAUNCHED',
  ].join(' ')

  const launched = await sshExec(target, launchCommand, {
    ...options, policy, timeoutMs: options.submitTimeoutMs ?? policy.submitTimeoutMs,
  })
  if (!launched.ok) {
    throw new RemoteError(`任务启动失败：${launched.stderr || launched.stdout || '无输出'}`, launched)
  }

  return {
    jobId: job.jobId,
    remoteScript,
    scriptBytes: Buffer.byteLength(script, 'utf8'),
    scriptSha256: (await import('node:crypto')).createHash('sha256').update(script).digest('hex'),
    attempts: written.attempts + launched.attempts,
  }
}

/**
 * 查询任务状态：每次都重新读文件，因此与上次连接无关。
 * 返回 { phase, marker, logTail, state }，phase ∈ pending|running|complete|failed。
 */
export async function probeJob(target, remoteRoot, jobId, options = {}) {
  const stateFile = `${remoteRoot}/${REMOTE_LAYOUT.state}/${jobId}.json`
  const doneFile = `${remoteRoot}/${REMOTE_LAYOUT.markers}/${jobId}.done`
  const failFile = `${remoteRoot}/${REMOTE_LAYOUT.markers}/${jobId}.fail`
  const logFile = `${remoteRoot}/${REMOTE_LAYOUT.logs}/${jobId}.log`

  // 一条命令取齐所有信息：减少往返，避免多次连接各自失败。
  const command = [
    `echo "=== DONE ==="; [ -f ${shellQuote(doneFile)} ] && echo yes || echo no`,
    `echo "=== FAIL ==="; [ -f ${shellQuote(failFile)} ] && echo yes || echo no`,
    `echo "=== STATE ==="; cat ${shellQuote(stateFile)} 2>/dev/null || echo '{}'`,
    `echo "=== LOGTAIL ==="; tail -n 40 ${shellQuote(logFile)} 2>/dev/null || echo ''`,
  ].join('; ')

  const result = await sshExec(target, command, { ...options, timeoutMs: options.commandTimeoutMs ?? 60_000 })
  if (!result.ok) {
    // 查询失败不等于任务失败：如实返回 unknown，让调用方决定是否重试。
    return {
      jobId,
      reachable: false,
      phase: 'unknown',
      error: result.stderr || result.stdout || '连接失败',
      retryable: result.retryable === true,
      attempts: result.attempts,
    }
  }

  const text = String(result.stdout)
  const section = (name) => {
    const pattern = new RegExp(`=== ${name} ===\\n([\\s\\S]*?)(?=\\n=== |$)`)
    const match = pattern.exec(text)
    return match === null ? '' : match[1].trim()
  }

  const done = section('DONE') === 'yes'
  const failed = section('FAIL') === 'yes'
  let state = {}
  try {
    state = JSON.parse(section('STATE') || '{}')
  } catch { /* 状态文件可能正被写入；保持空对象并标记 */ }

  let phase = 'pending'
  if (done) phase = 'complete'
  else if (failed) phase = 'failed'
  else if (state.phase === 'running') {
    // 状态说在跑，但进程可能已死（例如机器被回收）。用 pid 存活复核。
    const alive = await sshExec(target,
      `kill -0 ${Number(state.pid) || 0} 2>/dev/null && echo alive || echo dead`,
      { ...options, timeoutMs: 30_000 })
    phase = String(alive.stdout).includes('alive') ? 'running' : 'stalled'
  }

  return {
    jobId,
    reachable: true,
    phase,
    state,
    logTail: section('LOGTAIL'),
    attempts: result.attempts,
  }
}

/**
 * 快照：把远端产物打包带回控制端，附 SHA-256 清单。
 *
 * 对应教程 M4 的 `snapshot_restore_probe`：机外快照与恢复证据。
 * 用 tar 流经 stdin 传输，避免在远端留下中间文件。
 */
export async function captureSnapshot(target, remotePaths, localDir, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
  await mkdir(localDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const localArchive = join(localDir, `snapshot-${stamp}.tar.gz`)

  const { createWriteStream } = await import('node:fs')
  const { createHash } = await import('node:crypto')

  const remoteCommand = `tar -czf - -- ${remotePaths.map(shellQuote).join(' ')} 2>/dev/null`
  const hash = createHash('sha256')
  let bytes = 0

  const outcome = await new Promise((resolve) => {
    const child = spawn('ssh', [
      ...sshCommonArguments(target, policy),
      describeTarget(target),
      remoteCommand,
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })

    const stream = createWriteStream(localArchive)
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } },
      options.snapshotTimeoutMs ?? 30 * 60 * 1000)

    child.stdout.on('data', (chunk) => {
      bytes += chunk.length
      hash.update(chunk)
      stream.write(chunk)
    })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.on('error', (error) => {
      clearTimeout(timer)
      stream.end(() => resolve({ ok: false, error: error.message, stderr, bytes }))
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      stream.end(() => resolve({ ok: code === 0, exitCode: code, stderr, bytes }))
    })
  })

  if (!outcome.ok || bytes === 0) {
    return {
      captured: false,
      localArchive: null,
      error: outcome.error ?? outcome.stderr ?? '归档为空（远端路径可能不存在）',
      bytes,
    }
  }

  // 清单做机器校验用；清单与归档一起留痕。
  const manifest = {
    capturedAt: new Date().toISOString(),
    target: describeTarget(target),
    remotePaths,
    localArchive,
    bytes,
    sha256: hash.digest('hex'),
  }
  await writeFile(`${localArchive}.manifest.json`, JSON.stringify(manifest, null, 2), 'utf8')
  return { captured: true, localArchive, ...manifest }
}

/**
 * 恢复：把本地快照送回远端并展开。
 * 用于机器被回收后在新实例上续接。
 */
export async function restoreSnapshot(target, localArchive, remoteDir, options = {}) {
  const policy = { ...DEFAULT_POLICY, ...(options.policy ?? {}) }
  const { createReadStream } = await import('node:fs')

  const mkdirResult = await sshExec(target, `mkdir -p ${shellQuote(remoteDir)} && echo OK`,
    { ...options, policy, timeoutMs: 60_000 })
  if (!mkdirResult.ok) {
    throw new RemoteError(`远端目录创建失败：${mkdirResult.stderr || mkdirResult.stdout}`, mkdirResult)
  }

  const outcome = await new Promise((resolve) => {
    const child = spawn('ssh', [
      ...sshCommonArguments(target, policy),
      describeTarget(target),
      `tar -xzf - -C ${shellQuote(remoteDir)} && echo RESTORE_OK`,
    ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } },
      options.snapshotTimeoutMs ?? 30 * 60 * 1000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-4000) })
    child.on('error', (error) => { clearTimeout(timer); resolve({ ok: false, error: error.message, stderr }) })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0 && stdout.includes('RESTORE_OK'), exitCode: code, stdout, stderr })
    })
    createReadStream(localArchive).pipe(child.stdin)
  })

  if (!outcome.ok) {
    throw new RemoteError(`快照恢复失败：${outcome.error ?? outcome.stderr ?? '无输出'}`, outcome)
  }
  return { restored: true, remoteDir }
}

/** 探测远端环境能力（用于判断能否构建镜像）。 */
export async function probeRemote(target, options = {}) {
  const command = [
    'echo "=== UNAME ==="; uname -srm',
    'echo "=== DOCKER ==="; docker --version 2>/dev/null || echo NOT_FOUND',
    'echo "=== COMPOSE ==="; docker compose version 2>/dev/null || echo NOT_FOUND',
    'echo "=== BUILDX ==="; docker buildx version 2>/dev/null || echo NOT_FOUND',
    'echo "=== NVIDIA_SMI ==="; nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader 2>/dev/null || echo NOT_FOUND',
    'echo "=== RUNTIME ==="; docker info --format "{{.Runtimes}}" 2>/dev/null || echo NOT_FOUND',
    'echo "=== DISK ==="; df -h / 2>/dev/null | tail -1',
  ].join('; ')

  const result = await sshExec(target, command, { ...options, timeoutMs: options.commandTimeoutMs ?? 90_000 })
  if (!result.ok) {
    return { reachable: false, error: result.stderr || result.stdout || '连接失败', retryable: result.retryable === true }
  }
  const text = String(result.stdout)
  const section = (name) => {
    const match = new RegExp(`=== ${name} ===\\n([\\s\\S]*?)(?=\\n=== |$)`).exec(text)
    return match === null ? '' : match[1].trim()
  }
  return {
    reachable: true,
    platform: section('UNAME'),
    docker: section('DOCKER') === 'NOT_FOUND' ? null : section('DOCKER'),
    compose: section('COMPOSE') === 'NOT_FOUND' ? null : section('COMPOSE'),
    buildx: section('BUILDX') === 'NOT_FOUND' ? null : section('BUILDX'),
    gpus: section('NVIDIA_SMI') === 'NOT_FOUND' ? null : section('NVIDIA_SMI').split('\n').filter(Boolean),
    runtimes: section('RUNTIME') === 'NOT_FOUND' ? null : section('RUNTIME'),
    disk: section('DISK'),
  }
}

/**
 * 由远端探测结果推导「哪些门禁能在远端真跑」。
 * 只做事实判断，不建议也不代替平台审核。
 */
export function capabilitiesFromProbe(probe) {
  if (probe.reachable !== true) {
    return { reachable: false, canBuildImages: false, canRunNopTrial: false, canTrainGpu: false, reasons: ['远端不可达'] }
  }
  const reasons = []
  const canBuildImages = probe.docker !== null && probe.buildx !== null
  if (!canBuildImages) reasons.push('缺少 Docker 或 buildx：双镜像构建与 Harbor 自验不能在本远端完成')
  const runtimesList = typeof probe.runtimes === 'string' ? probe.runtimes : ''
  const hasNvidiaRuntime = /nvidia/i.test(runtimesList)
  const canTrainGpu = Array.isArray(probe.gpus) && probe.gpus.length > 0
  if (!canTrainGpu) reasons.push('未检测到 GPU：只能跑 CPU 任务')
  else if (!hasNvidiaRuntime) reasons.push('nvidia runtime 未注册：容器内可能用不到 GPU（SOP 规则 17 的第一项前提）')
  return {
    reachable: true,
    platform: probe.platform,
    gpuCount: Array.isArray(probe.gpus) ? probe.gpus.length : 0,
    canBuildImages,
    canRunNopTrial: canBuildImages && canTrainGpu && hasNvidiaRuntime,
    canTrainGpu,
    hasNvidiaRuntime,
    disk: probe.disk,
    reasons,
  }
}
