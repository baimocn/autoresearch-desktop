/**
 * dsh-autoresearch-gates —— AutoResearch 门禁工具插件。
 *
 * 把随包分发的 Python 门禁工具（SOP 的 11 个工具 + 教程 V3 附件的 QA 脚本）
 * 暴露为模型可调用的工具，并强制三条纪律：
 *
 *   1. 缺前置如实报不可用 —— 需要 Docker / root / GPU 而当前环境没有时，
 *      返回明确原因，不回落宿主执行、不伪造通过。
 *   2. 退出码是结论 —— 0/1/2 三态语义原样透出，不折算成「成功」。
 *   3. 输出原样保留 —— stdout/stderr 全量回传，供人工与报告引用。
 *
 * @module dsh-autoresearch-gates
 */

import { spawn } from 'node:child_process'
import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  TOOL_REGISTRY, EXIT_SEMANTICS, buildArgv, checkPrerequisites,
  listTools, probeRuntime, resolveTool, readTaskMetricDirection, ASSETS_ROOT,
} from './lib/tools.js'

export const name = 'autoresearch-gates'

export const inject = ['tools']

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 单次工具调用的墙钟上限（毫秒）。默认 30 分钟。 */
  timeoutMs: 30 * 60 * 1000,
  /** 单次调用保留的 stdout/stderr 上限（字符）。 */
  maxOutputChars: 200_000,
  /** 是否允许运行需要 Docker 的工具（当前环境无 Docker 时仍会如实拒绝）。 */
  allowDockerTools: true,
  /** 是否允许运行需要 root 的工具。 */
  allowRootTools: false,
})

/** 运行一个子进程，收集全部输出，不经过 shell。 */
function runProcess(command, argv, options) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    let child
    try {
      child = spawn(command, argv, {
        cwd: options.cwd,
        env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      })
    } catch (error) {
      resolve({ ok: false, spawnError: error.message, stdout: '', stderr: '', exitCode: null, durationMs: 0 })
      return
    }

    let stdout = ''
    let stderr = ''
    let truncated = false
    const limit = options.maxOutputChars
    const append = (current, chunk) => {
      if (current.length >= limit) { truncated = true; return current }
      const next = current + chunk
      if (next.length > limit) { truncated = true; return next.slice(0, limit) }
      return next
    }

    child.stdout?.on('data', (chunk) => { stdout = append(stdout, String(chunk)) })
    child.stderr?.on('data', (chunk) => { stderr = append(stderr, String(chunk)) })

    const timer = setTimeout(() => {
      try { child.kill('SIGKILL') } catch { /* 进程可能已退出 */ }
    }, options.timeoutMs)

    child.on('error', (error) => {
      clearTimeout(timer)
      resolve({ ok: false, spawnError: error.message, stdout, stderr, exitCode: null, durationMs: Date.now() - startedAt })
    })

    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        ok: true,
        exitCode: code,
        signal,
        stdout,
        stderr,
        truncated,
        durationMs: Date.now() - startedAt,
        timedOut: code === null && signal === 'SIGKILL',
      })
    })
  })
}

/**
 * 把退出码映射为三态结论。
 *
 * 退出码 0 **不总是** PASS —— 这一条由工具自己在注册表里声明，不能由调用方假定：
 *   · `qa-implementation-review` 默认 `--fail-on never`，退出 0 只表示「跑完了」，
 *     真正结论在报告里的结论字段。它是发布门证据的生产者，把 0 当 PASS 等于
 *     在「一次都没强制门禁」的运行上盖通过章。
 *   · `qa-audit` 的 0 是「收集完成（未完成初稿）」。
 *   · `numeric-backsolve` 是纯咨询工具，根本没有判定失败路径。
 * 这三类声明 `exitZeroIsPass: false`，映射为 NEEDS_EVIDENCE（需人工读报告）。
 *
 * 退出码 2 同理：多数工具是「需人工确认」，但上面几个是**参数错误**，
 * 声明 `exitTwoIsInputError: true` —— 调用方式错了不是「证据不足」，
 * 混为一谈会让模型以为该补证据，而实际该改参数。
 *
 * 导出仅为可测：它是纯函数，行为由注册表声明决定，值得单测钉住。
 */
export function interpretExit(meta, exitCode) {
  if (exitCode === null) return { label: '未正常退出', verdict: 'UNKNOWN' }
  const semantics = meta.exitSemantics ?? EXIT_SEMANTICS
  const label = semantics[exitCode]
  if (label === undefined) return { label: `未登记的退出码 ${exitCode}`, verdict: 'UNKNOWN' }

  if (exitCode === 0) {
    if (meta.exitZeroIsPass === false) {
      return { label: `${label}（退出 0 不代表 PASS，须读报告结论）`, verdict: 'NEEDS_EVIDENCE' }
    }
    return { label, verdict: 'PASS' }
  }
  if (exitCode === 2) {
    if (meta.exitTwoIsInputError === true) {
      return { label: `${label}（调用方式有误，不是证据不足）`, verdict: 'UNKNOWN' }
    }
    return { label, verdict: 'NEEDS_EVIDENCE' }
  }
  return { label, verdict: 'FAIL' }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const cwdOf = () => process.cwd()
  let runtimeCache = null
  const runtime = async () => {
    if (runtimeCache === null) runtimeCache = await probeRuntime()
    return runtimeCache
  }

  // ── 工具：环境与工具可用性 ────────────────────────────────────────────────

  /**
   * 工具清单。
   *
   * 两个地方向模型承诺过 `autoresearch_gate_env`（`autoresearch_gate_run` 的
   * `tool` 参数说明，以及「工具未登记」的报错文案），但它**从来没有实现过** ——
   * 模型被告知用这个工具查可用清单，去查却得到一个不存在的工具。
   * 本工具补上这个契约。
   *
   * 每一项都带上 `parameters`（登记表里的键名与取值），因为那是**唯一的**
   * 参数发现途径：`autoresearch_gate_run` 的 args 是 additionalProperties，
   * 没有 schema 能让模型看出某个工具接受哪些开关。登记表里写了参数而不往
   * 这里透出，等于没写。
   */
  ctx.tools.register(defineTool({
    name: 'autoresearch_gate_env',
    description: '列出随包门禁工具：id、用途、退出码语义、所需前置条件，以及每个工具接受的参数（键名、类型、可选值）。'
      + '调用 autoresearch_gate_run 前先用本工具确认可用的工具 id 与参数名。',
    parameters: {
      tool: { type: 'string', description: '只查某一个工具 id；省略时列出全部' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const probe = await runtime()
      const ids = args.tool === undefined
        ? Object.keys(TOOL_REGISTRY)
        : Object.keys(TOOL_REGISTRY).filter((id) => id === args.tool)
      if (ids.length === 0) {
        return {
          found: false,
          report: `未登记的工具：${args.tool}\n可用工具：${Object.keys(TOOL_REGISTRY).join(', ')}`,
        }
      }

      const lines = [`可用门禁工具（${ids.length} 个）`, '']
      const entries = []
      for (const id of ids) {
        const resolved = await resolveTool(id)
        if (resolved === undefined) {
          lines.push(`· ${id} —— 已登记但脚本缺失，当前不可用`, '')
          entries.push({ id, available: false })
          continue
        }
        const prerequisite = checkPrerequisites(resolved, probe)
        const dockerBlocked = (resolved.requires ?? []).includes('docker') && !config.allowDockerTools
        const rootBlocked = (resolved.requires ?? []).includes('root') && !config.allowRootTools
        const available = prerequisite.runnable !== false && !dockerBlocked && !rootBlocked

        lines.push(`· ${id}${available ? '' : '（当前不可用）'}`)
        lines.push(`  用途：${resolved.title}`)
        lines.push(`  前置：${(resolved.requires ?? []).join(', ') || '无'}`)
        if (!available) {
          lines.push(`  不可用原因：${dockerBlocked ? '配置禁用需要 Docker 的工具'
            : rootBlocked ? '配置禁用需要 root 的工具' : prerequisite.reason}`)
        }
        const params = resolved.parameters ?? {}
        const names = Object.keys(params)
        if (names.length > 0) {
          lines.push('  参数：')
          for (const name of names) {
            const spec = params[name]
            const values = Array.isArray(spec.enum) ? `，可选 ${spec.enum.join(' / ')}` : ''
            const dflt = spec.default === undefined ? '' : `，默认 ${JSON.stringify(spec.default)}`
            lines.push(`    ${name}（${spec.type}${values}${dflt}）`
              + (spec.description === undefined ? '' : ` —— ${spec.description}`))
          }
        } else {
          lines.push('  参数：无（或见脚本 --help）')
        }
        lines.push('')
        entries.push({ id, title: resolved.title, available, parameters: names })
      }

      return { found: true, tools: entries, report: lines.join('\n') }
    },
    presentCall: (args) => ({
      card: 'generic',
      title: args.tool === undefined ? '查询门禁工具清单' : `查询门禁工具 ${args.tool}`,
      kind: 'read',
    }),
  }))

  // ── 工具：执行门禁工具 ────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_gate_run',
    description: '运行一个随包门禁工具并原样返回结论与输出。退出码三态：0=RECOMMEND/PASS，1=REJECT/FAIL，2=NEEDS_EVIDENCE/MANUAL。缺前置条件时如实拒绝执行，不回落宿主、不伪造通过。',
    parameters: {
      tool: {
        type: 'string',
        required: true,
        enum: Object.keys(TOOL_REGISTRY),
        description: '工具 id，可用 autoresearch_gate_env 查询',
      },
      args: {
        type: 'object',
        description: '工具参数；键名见工具登记表（camelCase），会映射为对应命令行开关',
        additionalProperties: true,
      },
      cwd: { type: 'string', description: '工作目录；省略时用会话工作目录' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const resolved = await resolveTool(args.tool)
      if (resolved === undefined) {
        throw new Error(`工具 ${args.tool} 未登记或其脚本缺失；用 autoresearch_gate_env 查看可用清单`)
      }

      const probe = await runtime()
      const prerequisite = checkPrerequisites(resolved, probe)
      if (prerequisite.runnable === false) {
        return {
          tool: resolved.id,
          executed: false,
          runnable: false,
          reason: prerequisite.reason,
          verdict: 'NOT_RUN',
          report: [
            `工具：${resolved.id} —— ${resolved.title}`,
            '状态：未执行',
            `原因：${prerequisite.reason}`,
            '',
            '按诚实性要求，缺前置条件时如实报告未运行，不回落宿主执行、不伪造通过。',
          ].join('\n'),
        }
      }

      if ((resolved.requires ?? []).includes('docker') && !config.allowDockerTools) {
        return {
          tool: resolved.id,
          executed: false,
          runnable: false,
          reason: '配置中已禁用需要 Docker 的工具（allowDockerTools = false）',
          verdict: 'NOT_RUN',
          report: `工具：${resolved.id}\n状态：未执行\n原因：配置中已禁用需要 Docker 的工具。`,
        }
      }
      if ((resolved.requires ?? []).includes('root') && !config.allowRootTools) {
        return {
          tool: resolved.id,
          executed: false,
          runnable: 'partial',
          reason: '配置中已禁用需要 root 的工具（allowRootTools = false）',
          verdict: 'NOT_RUN',
          report: `工具：${resolved.id}\n状态：未执行\n原因：配置中已禁用需要 root 的工具。`,
        }
      }

      // ── 方向派生（缺陷 3）────────────────────────────────────────────────
      //
      // feasibility-gate 的 Python 默认 minimize、JS 门禁默认 maximize，两处
      // 默认互相矛盾；方向先前只能靠调用方手工声明，忘了就按各自默认走，
      // 同一道题在两条路径上可能得出相反结论。这里改为**从题目元数据派生**。
      //
      // 显式参数优先；其次 comparison_summary.json / task.toml；都没有就
      // **不猜**，并把「方向未声明」明确写进报告 —— 猜一个方向会让这件事
      // 消失，而那正是这个缺陷的成因。
      const effectiveArgs = { ...(args.args ?? {}) }
      let directionNote = null
      if (resolved.id === 'feasibility-gate') {
        if (effectiveArgs.direction !== undefined && effectiveArgs.direction !== null) {
          directionNote = `方向：${effectiveArgs.direction}（调用方显式声明）`
        } else {
          const derived = await readTaskMetricDirection(args.cwd ?? cwdOf())
          if (derived !== null) {
            effectiveArgs.direction = derived.direction
            directionNote = `方向：${derived.direction}（从 ${derived.source} 派生）`
          } else {
            // 告警必须点名「读了哪些地方」与「该去哪补」—— 只写「未声明」会让人
            // 不知道该改哪个文件，实测这一点会直接决定调用方是补元数据还是硬编码。
            directionNote = '⚠ 方向未声明：以下来源都读不到**原始指标**的方向 —— '
              + 'tests/hidden_assets/anchors.json、optimization_evidence/comparison_summary.json'
              + '（要求 metric 不是 "score"）、expert_evidence/expert_annotation.json 的 metric_direction。'
              + '本工具按脚本默认（minimize）执行；若该题原始指标是 maximize，结果会**符号全反**。'
              + '请在上述任一处声明，或显式传 args.direction。'
              + '注意：[task].metric_direction 在 metric="score" 时按定义恒为 maximize，不能作为原始指标的方向。'
          }
        }
      }

      let argv
      try {
        argv = buildArgv(resolved.id, effectiveArgs)
      } catch (error) {
        throw new Error(`参数组装失败：${error.message}`)
      }

      const python = probe.python.command
      const outcome = await runProcess(python, [resolved.path, ...argv], {
        cwd: args.cwd ?? cwdOf(),
        timeoutMs: config.timeoutMs,
        maxOutputChars: config.maxOutputChars,
      })

      if (outcome.spawnError !== undefined) {
        return {
          tool: resolved.id,
          executed: false,
          verdict: 'UNKNOWN',
          reason: `无法启动 ${python}：${outcome.spawnError}`,
          report: `工具：${resolved.id}\n状态：启动失败\n原因：${outcome.spawnError}`,
        }
      }

      const interpretation = outcome.timedOut
        ? { label: `超时（>${Math.round(config.timeoutMs / 60000)} 分钟）被终止`, verdict: 'UNKNOWN' }
        : interpretExit(resolved, outcome.exitCode)

      const lines = [
        `工具：${resolved.id} —— ${resolved.title}`,
        `命令：${python} ${resolved.path} ${argv.join(' ')}`,
        `退出码：${outcome.exitCode ?? 'null'}（${interpretation.label}）`,
        `耗时：${(outcome.durationMs / 1000).toFixed(1)}s`,
        `结论：${interpretation.verdict}`,
      ]
      // 方向行放在命令之后、输出之前：它决定下面的数字怎么读，必须先看到。
      if (directionNote !== null) lines.splice(2, 0, directionNote)
      if (outcome.truncated) lines.push(`注意：输出超过 ${config.maxOutputChars} 字符已截断，完整输出请重定向到文件`)
      if (outcome.stdout) lines.push('', '── stdout ──', outcome.stdout.trimEnd())
      if (outcome.stderr) lines.push('', '── stderr ──', outcome.stderr.trimEnd())
      if (resolved.note) lines.push('', `说明：${resolved.note}`)

      return {
        tool: resolved.id,
        executed: true,
        exitCode: outcome.exitCode,
        exitLabel: interpretation.label,
        verdict: interpretation.verdict,
        durationMs: outcome.durationMs,
        truncated: outcome.truncated === true,
        stdout: outcome.stdout,
        stderr: outcome.stderr,
        directionNote,
        note: resolved.note ?? null,
        report: lines.join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `运行门禁工具 ${args.tool}`, kind: 'execute' }),
  }))

  ctx.logger?.info?.('autoresearch-gates: tools registered')
}
