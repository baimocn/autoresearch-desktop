/**
 * dsh-autoresearch-qa —— 双路独立质检编排插件。
 *
 * 把「配好两个 API/模型 → 一份提示词 → 自动隔离双跑 → 自动聚合」做成三个工具：
 *
 *   autoresearch_qa_lanes    查看/校验两路配置（provider、model、凭据、隔离方式）
 *   autoresearch_qa_pack     把提交目录打成确定性 ZIP（发布门要求单个 .zip）
 *   autoresearch_qa_dual     两路并行独立质检 + fail-closed 聚合，输出结论与留痕
 *
 * 隔离是结构性的，不是约定：
 *   · 每路一个独立 headless 进程（无 Host、无 HTTP、无浏览器）
 *   · 每路一个独立 DSH_HOME（会话与凭据不互污染）
 *   · 每路独立输出目录，且提示词明确禁止读取另一路
 *   · 身份（provider/model/version/session_id）由编排层生成，模型无法伪造
 *
 * @module dsh-autoresearch-qa
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, writeFile, mkdir, stat, access } from 'node:fs/promises'
import { join, dirname, resolve, isAbsolute, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import {
  QaRunnerError, REQUIRED_SKILL, validateLanes, runDualQa, auditConsensus, sha256File,
} from './lib/runner.js'
import { coverageOf, describeMissing, expectedCheckIds } from './lib/coverage.js'
import { packDirectory, listZipEntries, FORBIDDEN_NAMES, FORBIDDEN_EXTENSIONS } from './lib/zip.js'
import { readLanesFile, writeLanesFile, resolveSavedLanes } from './lib/lanes.js'
import { listProviders, profilePatchPath } from 'dsh-autoresearch-api/lib/profile-patch.js'
import { readCredentialRefs } from 'dsh-autoresearch-api/lib/providers.js'
// 上游资产解析器：全仓唯一的「哪一份资产在哪」声明（见 gates/lib/tools.js）。
// 用静态 import 而非动态 await —— apply() 不是 async，动态 import 会直接语法错误。
import { resolveUpstreamAsset } from 'dsh-autoresearch-gates/lib/tools.js'

export const name = 'autoresearch-qa'

export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))

/**
 * dsh 入口与桌面补丁层的解析。
 *
 * 不能用路径算术（`resolve(HERE,'..','..')` 再拼 `node_modules/@deepseek-ai/dsh`）：
 * 那个表达式只在「从源码仓库运行」时成立。装进 profile 后本包位于
 * `<DSH_HOME>/profiles/<name>/node_modules/dsh-autoresearch-qa`，往上两级是
 * **profile 目录**，那里既没有 `node_modules/@deepseek-ai` 也没有 `build/` ——
 * 实测双路质检因此恒返回 BLOCKED，两个工具在装好的应用里都跑不起来。
 *
 * Node 的模块解析在两种布局下都正确：仓库里命中仓库根的 `node_modules`，
 * profile 里向上走同样能命中（profile 的 node_modules 只放本项目包，
 * `@deepseek-ai/*` 由仓库根提供）。
 */
const requireFromHere = createRequire(import.meta.url)

/** dsh 入口；解析不到返回 null（调用方如实报不可用）。 */
function resolveDshEntry() {
  try {
    return requireFromHere.resolve('@deepseek-ai/dsh/lib/bin.js')
  } catch {
    return null
  }
}

/** DSH_HOME：与桌面壳、安装脚本、UI 插件同一规则。 */
function dshHome() {
  const raw = process.env.DSH_HOME
  if (typeof raw === 'string' && raw.trim() !== '') return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  return join(process.cwd(), '.dsh-home')
}

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** 任务根目录；相对路径以进程工作目录为基准。 */
  taskRoot: '.',
  /** 质检工作根目录（相对任务根）。每路一个子目录，互不可见。 */
  workDir: 'expert_evidence/dual-qa',
  /** 单路墙钟上限（毫秒）。默认 2 小时。 */
  laneTimeoutMs: 2 * 60 * 60 * 1000,
  /** headless profile 名。 */
  profile: 'headless',
  /** 质检技能名。 */
  skillName: 'autoresearch-task-qa',
  /** 需要挂载的附加 patch（除每路模型 patch 外）。 */
  extraPatches: [],
  /** 两路配置。credentialEnv 由调用方给出，避免把密钥写进 profile。 */
  lanes: [],
})

async function exists(path) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const resolveRoot = () => {
    const raw = config.taskRoot
    if (raw === '.' || raw === '' || raw === undefined) return process.cwd()
    return isAbsolute(raw) ? raw : resolve(process.cwd(), raw)
  }

  // 双路质检必须用 **上游 0.3.4** 那份脚本，不是教程附件 0.3.2。
  //
  // 理由（实测，见 scripts/ablation-upstream.mjs）：
  //   教程附件版（0.3.2）的 implementation_review.py 没有 --release-self-check /
  //   --reviewer-provider / --session-id / --clean-context，产不出共识要求的
  //   qa_run 溯源块，qa_consensus.py 校验不过 → 聚合必然 NOT_READY。
  //
  // 技能正文仍以教程附件为准（权威判据口径），两者**职责不同**：
  //   · 权威口径  → tutorial-v3（catalog.js 的 rank 100）
  //   · 发布门证据 → upstream-0.3.4（本处）
  //
  // 路径解析统一走 gates 导出的 resolveUpstreamAsset（见文件顶部 import）：
  // 本包**不再拼另一个包的内部目录布局** —— 改造前这里硬编码了
  // gates/assets/qa-0.3.4，gates 一改结构即静默失效。

  /** 定位聚合脚本：上游 0.3.4 优先，其次本包自带的 skills-upstream-0.3.4。 */
  const locateConsensus = () => resolveUpstreamAsset('qa_consensus.py', 'upstream-0.3.4')

  const locateReviewScript = () => resolveUpstreamAsset('implementation_review.py', 'upstream-0.3.4')

  // ── 工具：两路配置 ────────────────────────────────────────────────────────

  // ── 工具：打包 ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_qa_pack',
    description: '把提交目录打成确定性 ZIP（发布门质检只接受单个 .zip）。自动排除缓存、依赖与元数据目录；相同输入产生逐字节相同的产物，便于哈希锚定。',
    parameters: {
      source: { type: 'string', required: true, description: '待打包目录，相对任务根或绝对路径' },
      out: { type: 'string', description: '输出 ZIP 路径；默认 <workDir>/submission.zip' },
      force: { type: 'boolean', description: '覆盖已存在的 ZIP；默认不覆盖（结论按哈希锚定）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const source = isAbsolute(args.source) ? args.source : resolve(taskRoot, args.source)
      if (!await exists(source)) throw new Error(`目录不存在：${source}`)
      const info = await stat(source)
      if (!info.isDirectory()) throw new Error(`不是目录：${source}`)

      const out = args.out === undefined
        ? resolve(taskRoot, config.workDir, 'submission.zip')
        : (isAbsolute(args.out) ? args.out : resolve(taskRoot, args.out))

      if (await exists(out) && args.force !== true) {
        const existing = await sha256File(out)
        return {
          packed: false,
          zipPath: out,
          existingSha256: existing,
          report: [
            `ZIP 已存在，未覆盖：${out}`,
            `现有 SHA-256：${existing}`,
            '',
            '结论按被检对象的 SHA-256 锚定：交付物一改，旧结论即失效。',
            '确需重打包时显式传 force=true，并重新跑双路质检。',
          ].join('\n'),
        }
      }

      // 打包排除质检自身的运行态：dual-qa 工作根（lane-N 的 prompt/patch/会话缓存）
      // 与任何嵌套 zip。实测教训：不排除会把「上一轮质检的打包产物与证据」打进
      // 本轮送检包，两路质检都会把它当作可疑内容写进报告。
      const runDirRelative = config.workDir.split('\\').join('/').replace(/^\.\//, '')
      const result = await packDirectory(source, out, { exclude: [runDirRelative] })
      const buffer = await readFile(result.zipPath)
      const names = listZipEntries(buffer)
      const forbidden = names.filter((entry) => {
        const segments = entry.split('/')
        return segments.some((segment) => FORBIDDEN_NAMES.has(segment))
          || FORBIDDEN_EXTENSIONS.some((extension) => entry.endsWith(extension))
      })
      // 自引自检：包里再套一份 .zip 或 lane-N 运行目录不是任务交付物，
      // 必须显式告警而不是静默送出。
      const nestedArtifacts = names.filter((entry) => {
        const segments = entry.split('/')
        return /\.zip$/i.test(entry) || segments.some((segment) => /^lane-\d+$/.test(segment))
      })

      const lines = [
        `打包完成：${result.zipPath}`,
        `条目数：${result.entryCount}`,
        `大小：${result.bytes} 字节`,
        `SHA-256：${result.sha256}`,
        `回读校验：中央目录 ${names.length} 个条目，与写入一致：${names.length === result.entryCount}`,
      ]
      if (forbidden.length > 0) {
        lines.push('', '包内发现禁止项（必须清理后重打）：', ...forbidden.map((name) => `  [禁止] ${name}`))
      }
      if (nestedArtifacts.length > 0) {
        lines.push('', '包内发现质检自身运行态（不应出现，必有清理后重打）：',
          ...nestedArtifacts.map((name) => `  [清理] ${name}`))
      }
      if (result.skipped.length > 0) {
        lines.push('', `已排除 ${result.skipped.length} 项：`)
        for (const entry of result.skipped.slice(0, 12)) {
          lines.push(`  ${entry.path} —— ${entry.reason}`)
        }
        if (result.skipped.length > 12) lines.push(`  …另有 ${result.skipped.length - 12} 项`)
      }

      return {
        packed: true,
        zipPath: result.zipPath,
        entryCount: result.entryCount,
        bytes: result.bytes,
        sha256: result.sha256,
        entries: names,
        forbidden,
        skipped: result.skipped,
        report: lines.join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `打包提交物：${args.source}`, kind: 'other' }),
  }))

  // ── 工具：决议审议台 ──────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_deliberate',
    description: '决议审议台：多模型**对抗审议**一个方向，降低单模型偏差带来的决策风险。'
      + '每路担任固定角色（propose 提案 / counter 反例 / cost 代价），反例方必须给出至少 3 个具体失败模式。'
      + '产出是「方案 + 已知反驳 + 代价」，不是「一个更对的答案」。'
      + '**决策辅助，不是门禁**：审议结论不参与 advance，也不替代实测证据。',
    parameters: {
      question: { type: 'string', required: true, description: '待审议的方向或决策问题' },
      context: { type: 'string', description: '背景材料（可选）；角色不会复述它' },
      lanes: {
        type: 'array',
        required: true,
        description: '审议路配置，2-6 项，每项 { route, model, role, version? }；必须至少含一路 role="counter"',
      },
      outDir: { type: 'string', description: '留痕目录；每路独立子目录 + manifest' },
      timeoutMs: { type: 'number', description: '单路超时（毫秒），默认 30 分钟' },
      task: { type: 'string', description: '任务根路径；省略时用会话绑定的任务根' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    },
    async execute(args) {
      const { validateBoard, independenceLevel, runDeliberation } = await import('./lib/deliberation.js')

      // 与双路质检同一套补全逻辑：把「路由引用」补成可执行事实（api/baseURL/密钥）。
      const saved = await readLanesFile(dshHome())
      const providers = await listProviders(profilePatchPath(dshHome(), 'autoresearch')).catch(() => ({}))
      const refs = await readCredentialRefs(join(dshHome(), '.credentials.yaml')).catch(() => ({}))
      const resolvedSaved = saved.lanes.length > 0
        ? resolveSavedLanes({ lanes: saved.lanes, providers, refs })
        : { lanes: [], issues: [] }

      const lanes = (Array.isArray(args.lanes) ? args.lanes : []).map((lane) => {
        const match = resolvedSaved.lanes.find((s) => s.route === lane.route && s.model === lane.model)
        return {
          ...lane,
          credentialEnv: lane.credentialEnv ?? match?.credentialEnv ?? null,
          apiKey: lane.apiKey ?? match?.apiKey ?? null,
          api: lane.api ?? match?.api ?? null,
          baseURL: lane.baseURL ?? match?.baseURL ?? null,
        }
      })

      const problems = validateBoard(lanes)
      if (problems.length > 0) {
        return {
          ok: false,
          problems,
          hint: '审议台至少要 提案 + 反例 两路，反例方是强制项。'
            + '路由与模型可先在工作台「双路质检」页或 API 配置页配好。',
        }
      }

      // 缺凭据的路如实报出，不静默少跑一路。
      const missingCredential = lanes
        .filter((l) => l.credentialEnv === null || l.apiKey === null)
        .map((l) => `${l.role}/${l.route}/${l.model}`)

      const dshEntry = resolveDshEntry()
      if (dshEntry === null || !await exists(dshEntry)) {
        return { ok: false, problems: [`dsh 入口不存在：${dshEntry ?? '@deepseek-ai/dsh/lib/bin.js 解析失败'}`] }
      }

      const outRoot = args.outDir !== undefined
        ? (isAbsolute(args.outDir) ? args.outDir : resolve(process.cwd(), args.outDir))
        : join(resolveRoot(), 'expert_evidence', 'deliberation',
          new Date().toISOString().replace(/[:.]/g, '-'))

      const result = await runDeliberation({
        question: args.question,
        context: args.context,
        lanes,
        outDir: outRoot,
        dshEntry,
        timeoutMs: args.timeoutMs,
        baseEnvironment: process.env,
      })

      return {
        ok: result.aggregate.missingRoles.length === 0,
        outDir: result.outDir,
        independence: result.independence,
        missingCredential,
        missingRoles: result.aggregate.missingRoles,
        failedLanes: result.aggregate.failed,
        byRole: Object.fromEntries(Object.entries(result.aggregate.byRole).map(([role, items]) => [
          role,
          items.map((x) => ({
            laneIndex: x.laneIndex, identity: x.identity, ok: x.ok, chars: x.text.length, text: x.text,
          })),
        ])),
        disclaimer: result.aggregate.disclaimer,
        nextStep: '审议结论是决策材料。要推进仍须用实测证据过门禁（审议不能替代 B/R 实测）。',
      }
    },
  }))

  // ── 工具：两路配置 ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_qa_lanes',
    description: '查看或保存双路质检的两路配置。两路各引用一个已声明路由（autoresearch_api_add 配的）与模型名；工作台「双路质检」页是与本工具等价的可视化入口。省略 lanes 参数时为查看。',
    parameters: {
      lanes: {
        type: 'array',
        description: '要保存的两路配置：每项 { route, model, version?, reasoningEffort? }；省略则只查看当前配置',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            route: { type: 'string' },
            model: { type: 'string' },
            version: { type: 'string' },
            reasoningEffort: { type: 'string' },
          },
        },
      },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const home = dshHome()
      const providers = await listProviders(profilePatchPath(home, 'autoresearch')).catch(() => ({}))
      const refs = await readCredentialRefs(join(home, '.credentials.yaml')).catch(() => ({}))
      const routeTable = Object.entries(providers).map(([route, provider]) => ({
        route,
        api: provider.api ?? null,
        baseURL: provider.baseURL ?? null,
        keyEnv: provider.apiKeyEnv ?? null,
        keyPresent: typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== ''
          ? refs[provider.apiKeyEnv] !== undefined
          : null,
        models: (provider.models ?? []).map((model) => model.id ?? String(model)),
      }))

      if (Array.isArray(args.lanes) && args.lanes.length > 0) {
        if (args.lanes.length !== 2) {
          return { saved: false, report: `需要恰好两路配置，收到 ${args.lanes.length} 路。` }
        }
        await writeLanesFile(home, args.lanes.map((lane) => ({
          route: lane.route, model: lane.model,
          ...(lane.version === undefined ? {} : { version: lane.version }),
          ...(lane.reasoningEffort === undefined ? {} : { reasoningEffort: lane.reasoningEffort }),
        })))
        const check = resolveSavedLanes({ lanes: args.lanes, providers, refs })
        return {
          saved: true,
          lanes: args.lanes,
          issues: check.issues,
          report: [
            '两路配置已保存。',
            ...args.lanes.map((lane, index) => `  第 ${index + 1} 路：${lane.route} / ${lane.model}`),
            '',
            ...(check.issues.length === 0
              ? ['校验通过，可以直接用 autoresearch_qa_dual 跑双路。']
              : ['校验还有问题：', ...check.issues.map((issue) => `  [问题] ${issue}`)]),
          ].join('\n'),
        }
      }

      const saved = await readLanesFile(home)
      const check = saved.lanes.length > 0
        ? resolveSavedLanes({ lanes: saved.lanes, providers, refs })
        : { issues: [] }
      const lines = [
        `两路配置（${saved.lanes.length} 路）${saved.updatedAt === null ? '' : `，更新于 ${saved.updatedAt}`}`,
        ...(saved.lanes.length === 0
          ? ['  （未配置。用本工具传 lanes 参数保存，或去工作台「双路质检」页配置。）']
          : saved.lanes.map((lane, index) => `  第 ${index + 1} 路：${lane.route} / ${lane.model}`)),
        '',
        '可用路由（来自 API 页声明的 provider）：',
        ...(routeTable.length === 0
          ? ['  （还没有声明任何路由。先用 autoresearch_api_add 或工作台 API 配置页添加。）']
          : routeTable.map((entry) =>
            `  ${entry.route}：${entry.api ?? '?'} @ ${entry.baseURL ?? '默认地址'}｜密钥 ${entry.keyEnv ?? '—'}${entry.keyPresent === false ? '（缺失）' : ''}｜模型 ${entry.models.join(', ') || '—'}`)),
      ]
      if (check.issues.length > 0) {
        lines.push('', '当前配置的问题：', ...check.issues.map((issue) => `  [问题] ${issue}`))
      }
      return { lanes: saved.lanes, routes: routeTable, issues: check.issues, report: lines.join('\n') }
    },
    presentCall: () => ({ card: 'generic', title: '双路质检配置', kind: 'read' }),
  }))

  // ── 工具：双路质检 ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_qa_dual',
    description: '两路独立质检：每路一个独立 headless 进程与独立 DSH_HOME，用各自配置的 provider/model 跑同一份提示词，产出两份带来源绑定的报告，再由 qa_consensus.py 做 fail-closed 聚合。发布门要求两路身份不同、逐项判定无分歧。两路默认取工作台保存的配置（autoresearch-qa-lanes.json），也可用 lanes 参数临时覆盖。',
    parameters: {
      artifact: { type: 'string', required: true, description: '提交 ZIP 路径，相对任务根或绝对路径' },
      lanes: {
        type: 'array',
        description: '两路配置；省略则用工作台保存的配置（推荐先在工作台「双路质检」页配好）。每项 { provider, model, version?, credentialEnv?, apiKey?, api?, baseURL?, models? }',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            provider: { type: 'string' },
            model: { type: 'string' },
            version: { type: 'string' },
            credentialEnv: { type: 'string' },
            apiKey: { type: 'string' },
            reasoningEffort: { type: 'string' },
          },
        },
      },
      workDir: { type: 'string', description: '质检工作根目录；默认用插件配置' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()

      // 两路来源（优先级）：显式 lanes 参数 > 工作台保存的配置。
      // 保存的配置是「路由引用」形态，需要补全为可执行事实（api/baseURL/密钥），
      // 补全失败的项以可行动的问题清单返回，不猜测、不空跑。
      let lanes = args.lanes ?? null
      if (lanes === null) {
        const saved = await readLanesFile(dshHome())
        if (saved.lanes.length > 0) {
          const providers = await listProviders(profilePatchPath(dshHome(), 'autoresearch')).catch(() => ({}))
          const refs = await readCredentialRefs(join(dshHome(), '.credentials.yaml')).catch(() => ({}))
          const resolved = resolveSavedLanes({ lanes: saved.lanes, providers, refs })
          if (resolved.issues.length > 0) {
            return {
              verdict: 'BLOCKED',
              problems: resolved.issues,
              report: [
                '两路配置需要先修好（工作台「双路质检」页 → API 配置页可补密钥/路由）：',
                ...resolved.issues.map((issue) => `  [问题] ${issue}`),
              ].join('\n'),
            }
          }
          lanes = resolved.lanes
        } else {
          lanes = config.lanes
        }
      }
      const problems = validateLanes(lanes)
      if (problems.length > 0) {
        return {
          verdict: 'BLOCKED',
          problems,
          report: ['双路配置不合法，未启动质检：', ...problems.map((problem) => `  [问题] ${problem}`)].join('\n'),
        }
      }

      const reviewScript = await locateReviewScript()
      if (reviewScript === null) {
        return {
          verdict: 'BLOCKED',
          problems: ['未找到 implementation_review.py'],
          report: '未找到质检脚本 implementation_review.py；请先安装 dsh-autoresearch-gates 包。',
        }
      }
      const consensusScript = await locateConsensus()
      if (consensusScript === null) {
        return {
          verdict: 'BLOCKED',
          problems: ['未找到 qa_consensus.py'],
          report: '未找到聚合脚本 qa_consensus.py；发布门无法完成。',
        }
      }

      const dshEntryPath = resolveDshEntry()
      if (dshEntryPath === null || !await exists(dshEntryPath)) {
        const detail = dshEntryPath ?? '@deepseek-ai/dsh/lib/bin.js 解析失败（请先执行 npm install）'
        return {
          verdict: 'BLOCKED',
          problems: [`未找到 dsh 入口：${detail}`],
          report: `未找到 dsh 入口：${detail}；请先在项目根执行 npm install。`,
        }
      }

      const workRoot = args.workDir === undefined
        ? resolve(taskRoot, config.workDir)
        : (isAbsolute(args.workDir) ? args.workDir : resolve(taskRoot, args.workDir))
      await mkdir(workRoot, { recursive: true })

      // 记录本次运行的输入指纹，便于事后核对「结论对应哪份字节」。
      const manifestPath = join(workRoot, 'run-manifest.json')
      if (await exists(manifestPath)) {
        const stamp = new Date().toISOString().replace(/[:.]/g, '-')
        const archived = join(workRoot, `run-manifest.${stamp}.json`)
        await writeFile(archived, await readFile(manifestPath, 'utf8'), 'utf8')
      }

      // 桌面补丁层可选：它当前是一份空补丁（顶层 `[]`，全部条目注释掉），
      // 传不传对 headless 车道没有区别。而装进 profile 后仓库的 build/ 不可达，
      // 硬拼路径只会让 harness 因「--patch 文件不存在」拒绝启动。
      // 因此只在它真实存在时才传。
      const candidatePatch = resolve(HERE, '..', '..', 'build', 'autoresearch.patch.yml')
      const basePatchPath = await exists(candidatePatch) ? candidatePatch : undefined

      const logs = []
      let result
      try {
        result = await runDualQa({
          lanes,
          artifactPath: args.artifact,
          workRoot,
          dshEntryPath,
          profile: config.profile,
          basePatchPath,
          skillName: config.skillName,
          reviewScript,
          consensusScript,
          taskRoot,
          timeoutMs: config.laneTimeoutMs,
          maxOutputChars: 400_000,
          pythonCommand: config.pythonCommand,
          log: (line) => logs.push(line),
        })
      } catch (error) {
        if (error instanceof QaRunnerError) {
          return {
            verdict: 'BLOCKED',
            problems: [error.message],
            report: [`质检未启动：${error.message}`].join('\n'),
          }
        }
        throw error
      }

      await writeFile(manifestPath, JSON.stringify({
        ranAt: new Date().toISOString(),
        artifactPath: result.artifactPath,
        artifactSha256: result.artifactSha256,
        skill: result.skill,
        lanes: result.lanes.map((lane) => ({
          laneIndex: lane.laneIndex,
          identity: lane.identity,
          credentialEnv: lane.credentialEnv,
          sharedCredential: lane.sharedCredential,
          reportPath: lane.reportPath,
          reportSha256: lane.reportSha256,
          exitCode: lane.exitCode,
          timedOut: lane.timedOut,
          durationMs: lane.durationMs,
          startedAt: lane.startedAt,
          finishedAt: lane.finishedAt,
        })),
        consensus: result.consensus === null ? null : {
          outPath: result.consensus.outPath,
          status: result.consensus.status,
          unresolvedDisagreements: result.consensus.unresolvedDisagreements,
          validationErrors: result.consensus.validationErrors,
        },
        coverage: result.coverage ?? null,
        verdict: result.verdict,
        notes: result.notes,
      }, null, 2), 'utf8')

      const lines = [
        `双路独立质检：${result.verdict}`,
        `提交包：${result.artifactPath}`,
        `SHA-256：${result.artifactSha256}`,
        '',
      ]
      for (const lane of result.lanes) {
        const status = lane.report !== null ? '已出报告' : (lane.timedOut ? '超时' : '未出报告')
        lines.push(`第 ${lane.laneIndex} 路 · ${lane.identity.provider}/${lane.identity.model} · ${status}`)
        lines.push(`  身份：${JSON.stringify(lane.identity)}`)
        lines.push(`  报告：${lane.reportPath ?? '（无）'}`)
        if (lane.reportSha256 !== null) lines.push(`  报告 SHA-256：${lane.reportSha256}`)
        lines.push(`  退出码：${lane.exitCode ?? 'null'}｜耗时：${(lane.durationMs / 1000).toFixed(1)}s`)
        if (lane.report !== null) {
          const decision = lane.report.summary?.decision
          lines.push(`  技能结论：${decision ?? '（未写 decision）'}`)
        }
      }

      if (result.coverage !== null && result.coverage !== undefined) {
        lines.push('', '逐项覆盖（平台强制，模型跳不过）：')
        lines.push(result.coverage.error !== undefined
          ? `  断言无法执行：${result.coverage.error}`
          : `  ${result.coverage.ok
            ? 'QA01–QA21 / G01–G03 / H01–H06 每一路全部有判定'
            : `存在缺口 —— ${describeMissing(result.coverage.missing)}`}`)
      }

      lines.push('', '聚合：')
      if (result.consensus === null) {
        lines.push('  未执行 —— 两路未同时产出报告。')
      } else {
        lines.push(`  结论：${result.consensus.status}`)
        lines.push(`  输出：${result.consensus.outPath}`)
        for (const error of result.consensus.validationErrors) lines.push(`  [问题] ${error}`)
        for (const disagreement of result.consensus.unresolvedDisagreements) {
          lines.push(`  [分歧] ${disagreement.check}：${disagreement.report_1} vs ${disagreement.report_2}`)
        }
      }

      if (result.notes.length > 0) {
        lines.push('', '说明：', ...result.notes.map((note) => `  ${note}`))
      }
      lines.push('', `运行清单：${manifestPath}`)
      lines.push('', '发布门判定：' + (result.verdict === 'PASS'
        ? '两份报告同源、身份两两不同、逐项判定无分歧 —— 满足 M5 发布门的独立质检要求。'
        : '未满足发布门：必须修完问题后重新送检，且送检后不得再改交付字节。'))

      return {
        verdict: result.verdict,
        artifactSha256: result.artifactSha256,
        lanes: result.lanes.map((lane) => ({
          laneIndex: lane.laneIndex,
          identity: lane.identity,
          credentialEnv: lane.credentialEnv,
          sharedCredential: lane.sharedCredential,
          reportPath: lane.reportPath,
          reportSha256: lane.reportSha256,
          decision: lane.report?.summary?.decision ?? null,
          exitCode: lane.exitCode,
          timedOut: lane.timedOut,
          durationMs: lane.durationMs,
        })),
        consensus: result.consensus,
        notes: result.notes,
        manifestPath,
        report: lines.join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `双路质检：${args.artifact}`, kind: 'execute' }),
  }))

  // ── 工具：复核既有聚合结果 ────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_qa_verify',
    description: '复核既有的双路质检聚合结果是否满足发布门：结论为 PASS、无未解决分歧、无校验错误、两路身份与报告同源。用于引用平台既有记录时的只读核对。',
    parameters: {
      consensus: { type: 'string', required: true, description: 'qa-consensus.json 路径' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const taskRoot = resolveRoot()
      const path = isAbsolute(args.consensus) ? args.consensus : resolve(taskRoot, args.consensus)
      let parsed
      try {
        parsed = JSON.parse(await readFile(path, 'utf8'))
      } catch (error) {
        throw new Error(`无法读取聚合结果：${error.message}`)
      }
      const problems = auditConsensus(parsed)

      // ── 逐项覆盖断言（平台强制，模型跳不过）────────────────────────────
      // 共识 JSON 不含逐项判定，只含「未解决的分歧」；两路漏判同一批条目时
      // 没有分歧记录，聚合照样 PASS（实测确认的跳过洞）。所以复核必须回到
      // 两份 lane report 上重新清点；权威清单从 0.3.10 判据脚本运行时解析，
      // 清单解析失败也如实计入问题，不静默放行。
      let coverage = null
      try {
        const reports = []
        for (const ref of parsed.qa_reports ?? []) {
          const reportPath = isAbsolute(ref.path ?? '') ? ref.path : resolve(dirname(path), ref.path ?? '')
          reports.push(JSON.parse(await readFile(reportPath, 'utf8')))
        }
        if (reports.length === 0) {
          problems.push('聚合结果未引用任何 lane report，无法断言逐项覆盖')
        } else {
          const expected = await expectedCheckIds(resolveUpstreamAsset)
          coverage = coverageOf(reports, expected)
          if (!coverage.ok) problems.push(`逐项覆盖缺口 —— ${describeMissing(coverage.missing)}`)
        }
      } catch (error) {
        problems.push(`逐项覆盖断言无法执行：${error.message}`)
      }

      const lines = [
        `聚合结果：${path}`,
        `结论：${parsed.status ?? '（缺 status）'}`,
        `提交包 SHA-256：${parsed.artifact_sha256 ?? '（缺）'}`,
        '',
      ]
      if (problems.length === 0) {
        lines.push('发布门：满足（两份报告同源、身份两两不同、逐项判定无分歧且全覆盖）。')
      } else {
        lines.push('发布门：未满足', ...problems.map((problem) => `  [问题] ${problem}`))
      }
      return { path, consensus: parsed, coverage, problems, satisfied: problems.length === 0, report: lines.join('\n') }
    },
    presentCall: (args) => ({ card: 'generic', title: `复核聚合结果：${args.consensus}`, kind: 'read' }),
  }))

  // ── 工具：旧题豁免后处理（0.3.10-standard-waiver.5）──────────────────────
  //
  // audit_standard_with_waivers.py 的语义：先跑**未修改的** v0.3.10 全量审计，
  // 再按审阅底稿逐发现应用豁免。它是旧题返修链的最后一环 —— 在接线之前，
  // 这条流程在平台上是纸面的（实测全库搜索零调用）。
  //
  // fail-closed：脚本缺失、启动失败、退出码非 0 都如实报错；不猜「大概过了」。
  // 底稿（standard_review / review）可选 —— 缺省时脚本按「未提供 → 按已授权
  // 旧题缺口豁免」语义走；但**给了就必须真实存在**，传不存在的底稿等于伪造豁免输入。
  ctx.tools.register(defineTool({
    name: 'autoresearch_qa_waiver',
    description: '对旧格式题包运行豁免审计（audit_standard_with_waivers.py）：先执行未修改的 v0.3.10 全量审计，再逐发现应用已批准豁免。review.json 与 legacy_review.json 是内部底稿，不是新增交付物。',
    parameters: {
      source: { type: 'string', required: true, description: '题包目录或 ZIP 路径' },
      standard_review: { type: 'string', description: '原 v0.3.10 review.json 内部底稿路径（可选）' },
      review: { type: 'string', description: '完整审阅与逐原因豁免底稿路径（可选）' },
      out_dir: { type: 'string', required: true, description: '输出目录（必须不存在或为空；报告三件套写在这里）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const root = resolveRoot()
      const at = (p) => (isAbsolute(p) ? p : resolve(root, p))
      const script = await resolveUpstreamAsset('audit_standard_with_waivers.py', 'upstream-0.3.10')
      if (script === null) {
        throw new Error('找不到 audit_standard_with_waivers.py（upstream-0.3.10 来源）。'
          + '该脚本是旧题豁免链的默认入口，缺失时门禁拒绝继续。')
      }
      const python = process.platform === 'win32' ? 'python' : 'python3'
      const outDir = at(args.out_dir)
      const argv = [script, at(args.source), '--out-dir', outDir]
      for (const [flag, key] of [['--standard-review', 'standard_review'], ['--review', 'review']]) {
        if (args?.[key]) {
          const reviewPath = at(args[key])
          await readFile(reviewPath, 'utf8') // 不存在会抛错：伪造的底稿输入在这拦住
          argv.push(flag, reviewPath)
        }
      }
      const startedAt = Date.now()
      const outcome = await new Promise((resolvePromise) => {
        const child = spawn(python, argv, {
          env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' },
          windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        })
        let stdout = '', stderr = ''
        child.stdout.on('data', (c) => { stdout += c })
        child.stderr.on('data', (c) => { stderr += c })
        child.on('error', (e) => resolvePromise({ spawnError: e.message, stdout: '', stderr: '', exitCode: null }))
        child.on('close', (code) => resolvePromise({ spawnError: null, stdout, stderr, exitCode: code }))
      })
      const decisionMatch = /"decision"\s*:\s*"([A-Z_]+)"/.exec(outcome.stdout)
      const decision = decisionMatch === null ? null : decisionMatch[1]
      const report = [
        `豁免审计：${outcome.spawnError !== null ? `启动失败 — ${outcome.spawnError}` : `退出码 ${outcome.exitCode}`}（${((Date.now() - startedAt) / 1000).toFixed(1)}s）`,
        `结论：${decision ?? '（未解析到 decision）'}`,
        `输出目录：${outDir}`,
        outcome.stderr.trim() !== '' ? `stderr：${outcome.stderr.trim().slice(0, 400)}` : null,
      ].filter(Boolean).join('\n')
      if (outcome.spawnError !== null || outcome.exitCode !== 0) {
        return { ok: false, decision, outDir, report, stderr: outcome.stderr.slice(0, 2000) }
      }
      return { ok: true, decision, outDir, report }
    },
    presentCall: (args) => ({ card: 'generic', title: `豁免审计：${args.source}`, kind: 'read' }),
  }))

  ctx.logger?.info?.('autoresearch-qa: dual-lane tools registered')
}
