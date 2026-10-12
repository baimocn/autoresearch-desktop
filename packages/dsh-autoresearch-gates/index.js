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
  listTools, probeRuntime, resolveTool, ASSETS_ROOT,
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

/** 把退出码映射为三态结论文案。 */
function interpretExit(meta, exitCode) {
  if (exitCode === null) return { label: '未正常退出', verdict: 'UNKNOWN' }
  const semantics = meta.exitSemantics ?? EXIT_SEMANTICS
  const label = semantics[exitCode]
  if (label === undefined) return { label: `未登记的退出码 ${exitCode}`, verdict: 'UNKNOWN' }
  if (exitCode === 0) return { label, verdict: 'PASS' }
  if (exitCode === 2) return { label, verdict: 'NEEDS_EVIDENCE' }
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

      let argv
      try {
        argv = buildArgv(resolved.id, args.args ?? {})
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
        note: resolved.note ?? null,
        report: lines.join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `运行门禁工具 ${args.tool}`, kind: 'execute' }),
  }))

  ctx.logger?.info?.('autoresearch-gates: tools registered')
}
