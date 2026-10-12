/**
 * dsh-autoresearch-remote —— 远端 GPU / Docker 执行与持久化编排。
 *
 * 解决的问题：GPU 与 Docker 在租用的服务器上，而 SSH 连接不稳定。
 * 做法遵循 SOP 实战教训 L8 行 110：「远端脚本 + setsid nohup；短命令探测；
 * **关键链路自驱动，不依赖控制端**」。
 *
 * 三条纪律（来自 SOP 编排器 README，脚本里已实现）：
 *   · 幂等 —— 同名任务只有一个实例（flock），重复投递不重跑
 *   · 缺证据不推进 —— 完成度看标记文件，不看进程或扩展名
 *   · 绝不静默成功 —— 失败写 FAIL 标记；查询失败报 unknown 而非猜测
 *
 * @module dsh-autoresearch-remote
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, writeFile, mkdir, stat } from 'node:fs/promises'
import { join, resolve, isAbsolute, dirname } from 'node:path'
import {
  RemoteError, DEFAULT_POLICY, ensureLayout, submitJob, probeJob,
  captureSnapshot, restoreSnapshot, probeRemote, capabilitiesFromProbe,
  sshExec, describeTarget,
} from './lib/session.js'
import {
  LedgerError, readLedger, writeLedger, registerTarget, registerJob,
  recordProbe, recordSnapshot, summarizePersistence,
} from './lib/ledger.js'

export const name = 'autoresearch-remote'

export const inject = ['tools']

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 任务根目录；相对路径以进程工作目录为基准。 */
  taskRoot: '.',
  /** 本地快照目录（相对任务根）。 */
  snapshotDir: 'expert_evidence/remote-snapshots',
  /** SSH 策略覆盖。 */
  policy: {},
})

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}), policy: { ...DEFAULT_POLICY, ...((rawConfig ?? {}).policy ?? {}) } }
  const resolveRoot = () => {
    const raw = config.taskRoot
    if (raw === '.' || raw === '' || raw === undefined) return process.cwd()
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  }

  /** 由目标 id 或内联描述取目标对象。 */
  const resolveRemoteTarget = async (reference) => {
    const taskRoot = resolveRoot()
    if (typeof reference === 'string') {
      const ledger = await readLedger(taskRoot)
      const registered = ledger.targets[reference]
      if (registered === undefined) {
        throw new LedgerError(`未登记的目标 "${reference}"。先用 autoresearch_remote_target 登记，或直接传 { host, user, port, identityFile, remoteRoot }`)
      }
      return { ledger, target: registered }
    }
    if (typeof reference === 'object' && reference !== null && typeof reference.host === 'string') {
      return { ledger: await readLedger(taskRoot), target: reference }
    }
    throw new LedgerError('目标必须是已登记的目标 id，或含 host 的对象')
  }

  // ── 工具：登记远端目标 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_target',
    description: '登记一个远端执行目标（GPU/Docker 服务器）到本地账本。账本是缓存不是真相；远端状态始终以远端文件为准，因此换机器或重建控制端后重新探测即可恢复视图。',
    parameters: {
      id: { type: 'string', required: true, description: '目标标识，如 gpu-a' },
      host: { type: 'string', required: true, description: '主机名或 IP' },
      user: { type: 'string', description: 'SSH 用户名' },
      port: { type: 'number', description: 'SSH 端口' },
      identityFile: { type: 'string', description: '私钥路径' },
      remoteRoot: { type: 'string', description: '远端工作根目录；默认 .autoresearch-remote' },
      label: { type: 'string', description: '便于识别的标签' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const ledger = await readLedger(taskRoot)
      const next = registerTarget(ledger, args.id, args)
      await writeLedger(taskRoot, next)
      const target = next.targets[args.id]
      return {
        registered: true,
        id: args.id,
        target,
        report: [
          `已登记远端目标：${args.id}`,
          `连接：${describeTarget(target)}${target.port === null ? '' : `:${target.port}`}`,
          `远端根：${target.remoteRoot}`,
          '',
          '下一步：用 autoresearch_remote_probe 探测能力（Docker / GPU / nvidia runtime）。',
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `登记远端目标 ${args.id}`, kind: 'other' }),
  }))

  // ── 工具：探测远端能力 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_probe',
    description: '探测远端环境能力：Docker / compose / buildx / GPU / nvidia runtime / 磁盘，并推导哪些门禁能在远端真跑。只做事实判断，不代替平台审核。',
    parameters: {
      target: { type: 'json', required: true, description: '已登记的目标 id（字符串），或 { host, user, port, identityFile, remoteRoot }' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const { target } = await resolveRemoteTarget(args.target)
      const probe = await probeRemote(target, { policy: config.policy })
      if (probe.reachable !== true) {
        return {
          reachable: false,
          probe,
          report: [
            `远端不可达：${describeTarget(target)}`,
            `原因：${probe.error}`,
            probe.retryable ? '该失败可重试（链路问题）。' : '该失败不可重试（认证或主机配置问题）。',
          ].join('\n'),
        }
      }
      const capabilities = capabilitiesFromProbe(probe)
      const lines = [
        `远端能力：${describeTarget(target)}`,
        `平台：${probe.platform}`,
        `Docker：${probe.docker ?? '不可用'}`,
        `compose：${probe.compose ?? '不可用'}`,
        `buildx：${probe.buildx ?? '不可用'}`,
        `GPU：${capabilities.gpuCount > 0 ? `${capabilities.gpuCount} 张` : '未检测到'}`,
        `nvidia runtime：${capabilities.hasNvidiaRuntime ? '已注册' : '未注册'}`,
        `磁盘：${probe.disk}`,
        '',
        '可执行能力：',
        `  训练 / CPU 任务：${capabilities.canTrainGpu ? '可（含 GPU）' : '仅 CPU'}`,
        `  双镜像构建：${capabilities.canBuildImages ? '可' : '不可'}`,
        `  NOP Trial 全链路：${capabilities.canRunNopTrial ? '可' : '不可'}`,
      ]
      if (capabilities.reasons.length > 0) {
        lines.push('', '限制：', ...capabilities.reasons.map((reason) => `  - ${reason}`))
      }
      if (capabilities.canRunNopTrial) {
        lines.push('', '提示：跑 NOP 前仍必须先执行 nop-preflight（SOP 规则 17 的五项前提），' +
          '本探测只覆盖其中的 Docker/GPU/runtime 三项。')
      }
      return { reachable: true, probe, capabilities, report: lines.join('\n') }
    },
    presentCall: () => ({ card: 'generic', title: '探测远端能力', kind: 'read' }),
  }))

  // ── 工具：投递自驱动任务 ──────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_submit',
    description: '把一个长跑任务投递到远端并立即返回。任务以 setsid 脱离控制端会话，SSH 断开后继续执行。重复投递安全（flock 独占 + 完成标记守卫），因此链路抖动时可直接重投。',
    parameters: {
      target: { type: 'json', required: true, description: '目标 id 或目标对象' },
      jobId: { type: 'string', required: true, description: '任务标识；同名任务只允许一个实例' },
      workDir: { type: 'string', required: true, description: '远端工作目录（绝对路径）' },
      command: { type: 'string', required: true, description: '真正的工作负载命令，支持 shell 语法' },
      kind: { type: 'string', description: '任务类别标签，如 train / build / nop-trial' },
      ensureLayout: { type: 'boolean', description: '投递前先创建远端目录布局；默认 true' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const { target, ledger } = await resolveRemoteTarget(args.target)
      const remoteRoot = target.remoteRoot ?? '.autoresearch-remote'

      if (args.ensureLayout !== false) {
        await ensureLayout(target, remoteRoot, { policy: config.policy })
      }

      const submitted = await submitJob(target, {
        jobId: args.jobId,
        workDir: args.workDir,
        command: args.command,
        remoteRoot,
      }, { policy: config.policy })

      const targetId = typeof args.target === 'string' ? args.target : '(inline)'
      let next = ledger
      if (typeof args.target === 'string') {
        next = registerJob(ledger, args.jobId, {
          targetId, kind: args.kind ?? 'generic', workDir: args.workDir,
          remoteScript: submitted.remoteScript, scriptSha256: submitted.scriptSha256,
        })
        await writeLedger(taskRoot, next)
      }

      return {
        submitted: true,
        jobId: args.jobId,
        remoteScript: submitted.remoteScript,
        scriptSha256: submitted.scriptSha256,
        report: [
          `已投递：${args.jobId}`,
          `目标：${describeTarget(target)}`,
          `脚本：${submitted.remoteScript}（${submitted.scriptBytes} 字节，SHA-256 ${submitted.scriptSha256.slice(0, 16)}）`,
          `工作目录：${args.workDir}`,
          '',
          '任务已用 setsid 脱离控制端会话，SSH 断开不影响执行。',
          `查询进度：autoresearch_remote_probe_job { jobId: "${args.jobId}", target: ${JSON.stringify(targetId)} }`,
          '链路抖动导致投递失败时可直接重投：脚本自带幂等守卫。',
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `投递远端任务 ${args.jobId}`, kind: 'execute' }),
  }))

  // ── 工具：查询任务状态 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_probe_job',
    description: '查询远端任务状态。每次都重新读远端文件，与上次连接无关。返回 complete / running / stalled / failed / pending / unknown。查询失败报 unknown 并标明是否可重试，不猜测。',
    parameters: {
      target: { type: 'json', required: true, description: '目标 id 或目标对象' },
      jobId: { type: 'string', required: true, description: '任务标识' },
      record: { type: 'boolean', description: '是否把本次探测写入本地账本；默认 true' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const { target, ledger } = await resolveRemoteTarget(args.target)
      const probe = await probeJob(target, target.remoteRoot ?? '.autoresearch-remote', args.jobId, {
        policy: config.policy,
      })

      if (args.record !== false && probe.reachable) {
        await writeLedger(taskRoot, recordProbe(ledger, args.jobId, probe))
      }

      const phaseLabel = {
        complete: '已完成（有完成标记）',
        running: '运行中（进程存活）',
        stalled: '状态说在跑但进程已不在',
        failed: '失败（有失败标记）',
        pending: '未见任何标记，可能尚未启动',
        unknown: '状态未知（连接失败）',
      }[probe.phase] ?? probe.phase

      const lines = [
        `任务：${args.jobId} @ ${describeTarget(target)}`,
        `状态：${probe.phase} —— ${phaseLabel}`,
      ]
      if (probe.reachable !== true) {
        lines.push('', `查询失败：${probe.error}`)
        lines.push(probe.retryable ? '该失败可重试：重新执行本工具即可。' : '该失败不可重试：检查目标配置与凭据。')
        lines.push('未写入账本：连接失败不等于任务失败，不猜测状态。')
      } else {
        if (Object.keys(probe.state).length > 0) {
          lines.push(`状态文件：${JSON.stringify(probe.state)}`)
        }
        if (probe.phase === 'stalled') {
          lines.push('', '进程已不在但无失败标记：可能是机器被回收或进程被杀。',
            '处理：确认是否需要在新实例上恢复快照后续接（autoresearch_remote_restore）。')
        }
        if (probe.logTail) lines.push('', '── 日志尾部 ──', probe.logTail)
      }

      return { ...probe, report: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `查询远端任务 ${args.jobId}`, kind: 'read' }),
  }))

  // ── 工具：快照 ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_snapshot',
    description: '把远端产物打包带回本地，附 SHA-256 清单。对应教程 M4 的机外快照要求：机器可能被回收，证据必须在机外。',
    parameters: {
      target: { type: 'json', required: true, description: '目标 id 或目标对象' },
      paths: {
        type: 'array',
        required: true,
        description: '远端要打包的路径（绝对路径）',
        items: { type: 'string' },
      },
      record: { type: 'boolean', description: '是否写入账本；默认 true' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const { target, ledger } = await resolveRemoteTarget(args.target)
      const localDir = resolve(taskRoot, config.snapshotDir)
      await mkdir(localDir, { recursive: true })

      const snapshot = await captureSnapshot(target, args.paths, localDir, { policy: config.policy })
      if (!snapshot.captured) {
        return {
          captured: false,
          error: snapshot.error,
          report: [
            `快照未成功：${describeTarget(target)}`,
            `原因：${snapshot.error}`,
            '未写入账本：无证据就不记录成功。',
          ].join('\n'),
        }
      }

      if (args.record !== false) {
        await writeLedger(taskRoot, recordSnapshot(ledger, snapshot))
      }

      return {
        ...snapshot,
        report: [
          `快照完成：${snapshot.localArchive}`,
          `大小：${snapshot.bytes} 字节`,
          `SHA-256：${snapshot.sha256}`,
          `清单：${snapshot.localArchive}.manifest.json`,
          `远端路径：${snapshot.remotePaths.join(', ')}`,
          '',
          '清单与归档一并留痕，可支撑 M4 的 snapshot_restore_probe。',
        ].join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `采集远端快照（${args.paths.length} 个路径）`, kind: 'other' }),
  }))

  // ── 工具：恢复 ────────────────────────────────────────────────────────────

  // ── 工具：持久化体检 ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_status',
    description: '持久化体检：列出登记的远端目标、任务状态与本轮快照数量，并指出未完成/未知/长时间未探测的任务。对应教程 M4 的机外快照与恢复证据要求。',
    parameters: {
      refresh: { type: 'boolean', description: '为 true 时对未完成任务逐个重新探测（会建立多次短连接）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      let ledger = await readLedger(taskRoot)

      if (args.refresh === true) {
        for (const [jobId, job] of Object.entries(ledger.jobs)) {
          const target = ledger.targets[job.targetId]
          if (target === undefined) continue
          const probe = await probeJob(target, target.remoteRoot ?? '.autoresearch-remote', jobId, {
            policy: config.policy,
          })
          if (probe.reachable) ledger = recordProbe(ledger, jobId, probe)
        }
        await writeLedger(taskRoot, ledger)
      }

      const summary = summarizePersistence(ledger)
      const lines = [
        '远端持久化体检',
        `目标：${summary.targetCount} 个｜任务：${summary.jobCount} 个｜快照：${summary.snapshotCount} 个`,
        '',
      ]

      if (summary.jobCount === 0) {
        lines.push('尚未投递任何任务。')
      } else {
        for (const job of summary.jobs) {
          const stale = job.stale ? '（长时间未探测）' : ''
          lines.push(`${job.jobId}  [${job.phase}]  ${job.kind}  @${job.targetId}${stale}`)
          lines.push(`  提交于 ${job.submittedAt}｜上次探测 ${job.lastProbeAt ?? '从未'}`)
        }
      }

      if (summary.unfinished.length > 0) {
        lines.push('', `未完成任务 ${summary.unfinished.length} 个：`)
        for (const job of summary.unfinished) {
          lines.push(`  ${job.jobId}（${job.phase}）`)
        }
        lines.push('用 autoresearch_remote_probe_job 逐个确认；状态以远端文件为准。')
      }
      if (summary.unknown.length > 0) {
        lines.push('', `状态未知 ${summary.unknown.length} 个（连接失败或从未探测）：`)
        for (const job of summary.unknown) lines.push(`  ${job.jobId}（${job.phase}）`)
      }

      lines.push('', 'M4 恢复证据：' + (summary.restoreProbeReady
        ? `已有 ${summary.snapshotCount} 份机外快照。`
        : '尚无快照。教程要求机外快照与恢复 probe，用 autoresearch_remote_snapshot 采集。'))

      return { summary, ledger, report: lines.join('\n') }
    },
    presentCall: () => ({ card: 'generic', title: '远端持久化体检', kind: 'read' }),
  }))

  // ── 工具：直接执行短命令 ──────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_remote_exec',
    description: '在远端执行一条短命令并返回输出，带保活与指数退避重试。只用于查询与轻量操作；长跑任务请用 autoresearch_remote_submit（本工具受超时限制，SSH 抖动时会重试但可能失败）。',
    parameters: {
      target: { type: 'json', required: true, description: '目标 id 或目标对象' },
      command: { type: 'string', required: true, description: '要执行的命令' },
      timeoutMs: { type: 'number', description: '超时（毫秒）；默认 60 秒' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const { target } = await resolveRemoteTarget(args.target)
      const result = await sshExec(target, args.command, {
        policy: config.policy,
        timeoutMs: args.timeoutMs ?? config.policy.commandTimeoutMs,
      })
      const lines = [
        `远端命令 @ ${describeTarget(target)}`,
        `退出码：${result.exitCode ?? 'null'}${result.timedOut ? '（超时被终止）' : ''}｜尝试 ${result.attempts} 次｜耗时 ${(result.durationMs / 1000).toFixed(1)}s`,
      ]
      if (result.stdout) lines.push('', '── stdout ──', String(result.stdout).trimEnd())
      if (result.stderr) lines.push('', '── stderr ──', String(result.stderr).trimEnd())
      if (!result.ok && result.retryable) lines.push('', '该失败可重试。')
      return { ...result, report: lines.join('\n') }
    },
    presentCall: () => ({ card: 'generic', title: '远端执行短命令', kind: 'execute' }),
  }))

  ctx.logger?.info?.('autoresearch-remote: tools registered')
}
