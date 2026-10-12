/**
 * dsh-autoresearch-api —— 自定义 API 接入。
 *
 * 让「用哪个 API、哪个模型」完全自定义，不依赖任何内置服务商列表：
 *   · 任意 OpenAI 兼容 / Anthropic 兼容端点（baseURL + 协议）
 *   · 任意模型名（不必在目录里）
 *   · 密钥只进凭据文档的 refs 段，profile 只保存引用名
 *
 * 与内置 Models 设置页的关系：内置页是交互式表单，适合人手改；
 * 本插件是声明式配置，可被脚本、双路质检、批量场合复用。两者写同一份
 * profile 与凭据文档，不另造一套存储。
 *
 * @module dsh-autoresearch-api
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { readFile, writeFile, mkdir, chmod } from 'node:fs/promises'
import { join, dirname, resolve, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  profilePatchPath, mergeProviders, setDefaultModel, listProviders, readDefaultModel,
} from './lib/profile-patch.js'
import {
  ApiConfigError, SUPPORTED_PROTOCOLS, ENDPOINT_PRESETS, validateApiDeclaration,
  normalizeDeclaration, renderProviderPatch, renderDefaultModelPatch,
  readCredentialRefs, writeCredentialRefs, probeEndpoint, runDsh,
  buildDualLaneDeclarations, resolveDshHomePath, isValidRefName, isValidRouteId,
} from './lib/providers.js'

export const name = 'autoresearch-api'

export const inject = ['tools']

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..', '..')

/** 默认配置；见 dsh-autoresearch 中关于不导出 schemastery Config 的说明。 */
const DEFAULT_CONFIG = Object.freeze({
  /** profile 名；自定义路由写进这个 profile 的 patch 层。 */
  /**
   * 目标 profile 列表。第一个视为主 profile（校验与默认模型的首选目标）。
   *
   * 必须是数组而非单值：双路质检跑在 headless profile 上（无 Host / 无 HTTP，
   * 天然隔离），交互会话跑在 autoresearch profile 上。只配一个会导致另一个
   * 用不到自定义 API —— 实测踩过：改好 autoresearch 后 headless 仍指向
   * 内置服务商并报 MISSING_CREDENTIAL。
   */
  profiles: ['autoresearch', 'headless'],
  /** 是否在校验后自动重启 harness（桌面壳监听该信号；无壳时忽略）。 */
  reloadOnChange: false,
})

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const dshHome = () => resolveDshHomePath({ projectRoot: PROJECT_ROOT })
  const dshEntry = () => join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

  /**
   * 写入目标：profile 自己的 cordis.patch.yml。
   *
   * 与内置设置页共写同一份文件 —— 这是唯一能保证「设置页配的与插件配的
   * 互不覆盖」的方式。patch 的 config 是整体替换，两个文件指向同一 id 时
   * 后者必然抹掉前者。
   */
  /** 全部目标 profile 的补丁路径。 */
  const profilePatches = () => config.profiles.map((profile) => profilePatchPath(dshHome(), profile))
  /** 主 profile 的补丁路径。 */
  const profilePatch = () => profilePatches()[0]
  const credentialsPath = () => join(dshHome(), '.credentials.yaml')

  /** 读取已声明的路由（直接读 profile 用户层，与设置页同一真源）。 */
  const readDeclaredRoutes = async () => {
    const providers = await listProviders(profilePatch())
    return Object.entries(providers).map(([route, profile]) => ({
      route,
      displayName: profile.displayName ?? route,
      api: profile.api ?? 'openai-completions',
      baseURL: profile.baseURL ?? undefined,
      keyEnv: profile.apiKeyEnv ?? `${route.toUpperCase().replace(/-/g, '_')}_API_KEY`,
      models: (profile.models ?? []).map((model) => model.id ?? model),
    }))
  }

  /**
   * 合并写入 providers 到**全部**目标 profile。
   * 缺一个 profile 就会在对应运行模式（交互 / 双路质检）里用不到自定义 API。
   */
  const writeProviderPatches = async (declarations) => {
    let providers = []
    for (const path of profilePatches()) {
      const result = await mergeProviders(path, declarations)
      providers = result.providers
    }
    return providers
  }

  // ── 工具：列出可用的协议与端点预设 ────────────────────────────────────────

  // ── 工具：声明自定义 API ──────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_api_add',
    description: '声明一个自定义 API 路由：任意兼容端点 + 任意模型名。校验通过后写入 profile 的 provider 段，密钥只写进凭据文档（权限 0600），profile 只保存引用名。',
    parameters: {
      route: { type: 'string', required: true, description: '路由 id，小写连字符标识（如 my-gateway）；也可直接用预设名（openai / anthropic / deepseek / ollama 等）' },
      baseURL: { type: 'string', description: '端点地址，如 https://api.example.com/v1' },
      api: { type: 'string', description: `协议：${SUPPORTED_PROTOCOLS.join(' / ')}；给 baseURL 时必填` },
      models: {
        type: 'array',
        description: '模型列表；字符串或 { id, name }',
        items: { type: 'json' },
      },
      keyEnv: { type: 'string', description: '密钥引用名（环境变量名形态）；省略时按 route 推导' },
      apiKey: { type: 'string', description: '密钥本体；给出时写入凭据文档。可省略，之后用环境变量提供' },
      headers: { type: 'object', description: '附加请求头', additionalProperties: true },
      displayName: { type: 'string', description: '显示名' },
      setDefault: { type: 'boolean', description: '是否同时把默认模型指到该路由的第一个模型' },
      verifyEndpoint: { type: 'boolean', description: '是否探测端点可达性（默认 true）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const problems = validateApiDeclaration(args)
      if (problems.length > 0) {
        return {
          added: false,
          problems,
          report: ['配置不合法，未写入任何文件：', ...problems.map((problem) => `  [问题] ${problem}`)].join('\n'),
        }
      }

      const normalized = normalizeDeclaration(args)
      const lines = [
        `自定义 API 路由：${normalized.route}`,
        `协议：${normalized.api}`,
        `地址：${normalized.baseURL ?? '（未指定，走该协议的默认地址）'}`,
        `模型：${normalized.models.map((model) => model.id).join(', ') || '（未指定）'}`,
        `密钥引用：${normalized.keyEnv}`,
      ]

      let probe = null
      if (args.verifyEndpoint !== false && normalized.baseURL !== undefined) {
        probe = await probeEndpoint({ ...args, ...normalized }, { apiKey: args.apiKey })
        lines.push('', `端点探测：${probe.reachable ? `可达（HTTP ${probe.status}）` : '不可达'}`)
        lines.push(`  解释：${probe.interpretation ?? probe.reason}`)
      }

      // 先写凭据，再写 profile：这样不会出现「配了路由但没有密钥」的中间态。
      let credentials = null
      if (typeof args.apiKey === 'string' && args.apiKey !== '') {
        credentials = await writeCredentialRefs(credentialsPath(), { [normalized.keyEnv]: args.apiKey })
        lines.push('', `密钥已写入凭据文档：${credentials.path}`)
        lines.push('（profile 只保存引用名，不含密钥本体；文件权限已收紧到 0600）')
      } else {
        const refs = await readCredentialRefs(credentialsPath())
        const present = refs[normalized.keyEnv] !== undefined
        lines.push('', present
          ? `凭据文档已有 ${normalized.keyEnv}。`
          : `凭据文档暂无 ${normalized.keyEnv}：用环境变量 export ${normalized.keyEnv}=... 提供，` +
            `或重新调用本工具并传 apiKey。`)
      }

      const routes = await writeProviderPatches([normalized])
      lines.push('', `已合并写入 profile：${profilePatch()}`)
      lines.push(`当前声明的路由：${routes.join(', ')}`)
      lines.push('（与内置设置页共写同一份文件，双方配置互不覆盖）')

      if (args.setDefault === true && normalized.models.length > 0) {
        for (const path of profilePatches()) {
          await setDefaultModel(path, normalized.route, normalized.models[0].id)
        }
        lines.push(`默认模型已指向：${normalized.route} / ${normalized.models[0].id}`)
      }

      lines.push('', '重启 harness 后生效（桌面壳菜单 Harness → 重新启动 Harness）。')
      lines.push('排查建议：先用 autoresearch_api_verify 确认 profile 能加载。')

      return {
        added: true,
        route: normalized.route,
        normalized,
        probe,
        credentials,
        profilePatch: profilePatch(),
        report: lines.join('\n'),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `声明自定义 API：${args.route}`, kind: 'other' }),
  }))

  // ── 工具：查看已声明的路由 ────────────────────────────────────────────────

  // ── 工具：校验 ────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_api_verify',
    description: '校验自定义 API 配置：先在内存里检查声明，再真实加载 profile 组合（dsh --dump-config）确认能力被接受。只有真加载通过才算配置可用。',
    parameters: {
      route: { type: 'string', description: '只校验某个路由；省略校验全部' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const routes = await readDeclaredRoutes()
      const selected = args.route === undefined ? routes : routes.filter((route) => route.route === args.route)
      if (selected.length === 0) {
        return {
          verified: false,
          report: args.route === undefined
            ? '尚未声明任何路由，无内容可校验。'
            : `未找到路由 ${args.route}。`,
        }
      }

      // 真实加载：能解析不等于原生接受，所以要真跑一次组合。
      // 校验 profile 自身（含设置页与本插件共同写入的用户层）。
      // 不再传 --patch：那会跳过用户层，验证不到真实生效的配置。
      const dump = await runDsh(dshEntry(), [
        '--profile', config.profiles[0],
        '--dump-config',
      ], { dshHome: dshHome(), cwd: PROJECT_ROOT, timeoutMs: 180_000 })

      const accepted = dump.ok && dump.stdout.includes('llm-pi-ai')
      const lines = [
        `校验自定义 API 配置（profile: ${config.profiles.join(', ')}）`,
        `真实加载：${dump.ok ? '成功' : '失败'}`,
      ]
      if (!dump.ok) {
        lines.push('', '── 加载输出 ──', String(dump.stderr || dump.stdout).trim().split('\n').slice(-12).join('\n'))
      } else {
        lines.push(`包含 llm-pi-ai 行：${accepted ? '是' : '否'}`)
      }
      lines.push('', '已声明的路由：')
      for (const route of selected) {
        lines.push(`  ${route.route} · ${route.api} · ${route.baseURL ?? '默认地址'} · ` +
          `${route.models.length} 个模型 · 密钥引用 ${route.keyEnv}`)
      }
      if (!dump.ok) {
        lines.push('', '结论：配置不可用。按上面的加载输出修正后重试。')
      } else {
        lines.push('', '结论：配置可被原生接受。重启 harness 后生效。')
      }

      return {
        verified: dump.ok,
        exitCode: dump.exitCode,
        routes: selected,
        stdout: dump.stdout,
        stderr: dump.stderr,
        report: lines.join('\n'),
      }
    },
    presentCall: () => ({ card: 'generic', title: '校验自定义 API 配置', kind: 'read' }),
  }))

  // ── 工具：为双路质检配两路 ────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'autoresearch_api_dual_lanes',
    description: '把两个自定义 API 路由直接配成双路质检的两路。发布门要求两路身份（provider/model/version）两两不同，本工具会在两边 route 相同时直接拒绝。',
    parameters: {
      laneA: {
        type: 'json',
        required: true,
        description: '第 1 路声明：{ route, baseURL?, api?, models, keyEnv?, apiKey? }',
      },
      laneB: {
        type: 'json',
        required: true,
        description: '第 2 路声明；route 必须与第 1 路不同',
      },
      writeToQaConfig: { type: 'boolean', description: '是否同时写进双路质检插件的 lanes 配置（默认 true）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const built = buildDualLaneDeclarations(args.laneA, args.laneB)
      if (built.problems.length > 0) {
        return {
          configured: false,
          problems: built.problems,
          report: ['两路配置不合法，未写入：', ...built.problems.map((problem) => `  [问题] ${problem}`)].join('\n'),
        }
      }

      const normalizedA = normalizeDeclaration(args.laneA)
      const normalizedB = normalizeDeclaration(args.laneB)
      const routes = await writeProviderPatches([normalizedA, normalizedB])

      // 密钥走凭据文档；两路各写各的引用名。
      const updates = {}
      if (typeof args.laneA.apiKey === 'string' && args.laneA.apiKey !== '') updates[normalizedA.keyEnv] = args.laneA.apiKey
      if (typeof args.laneB.apiKey === 'string' && args.laneB.apiKey !== '') updates[normalizedB.keyEnv] = args.laneB.apiKey
      if (Object.keys(updates).length > 0) {
        await writeCredentialRefs(credentialsPath(), updates)
      }

      let qaConfigPath = null
      if (args.writeToQaConfig !== false) {
        qaConfigPath = join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-qa', 'cordis.patch.yml')
        const existing = await readFile(qaConfigPath, 'utf8')
        const lanesYaml = [
          '        lanes:',
          `          - provider: ${normalizedA.route}`,
          `            model: ${JSON.stringify(normalizedA.models[0]?.id ?? 'TODO')}`,
          `            credentialEnv: ${normalizedA.keyEnv}`,
          `          - provider: ${normalizedB.route}`,
          `            model: ${JSON.stringify(normalizedB.models[0]?.id ?? 'TODO')}`,
          `            credentialEnv: ${normalizedB.keyEnv}`,
        ].join('\n')
        const next = existing.replace(/^ {8}lanes: \[\]$/m, lanesYaml)
        if (next === existing) {
          // 已有 lanes 内容时替换整段，避免留下两套声明（单一真源）。
          const replaced = existing.replace(/^ {8}lanes:\n(?: {10}.*\n| {12}.*\n)*/m, `${lanesYaml}\n`)
          await writeFile(qaConfigPath, replaced, 'utf8')
        } else {
          await writeFile(qaConfigPath, next, 'utf8')
        }
      }

      const lines = [
        '双路质检两路已配置',
        `第 1 路：${normalizedA.route} / ${normalizedA.models[0]?.id} （密钥引用 ${normalizedA.keyEnv}）`,
        `第 2 路：${normalizedB.route} / ${normalizedB.models[0]?.id} （密钥引用 ${normalizedB.keyEnv}）`,
        '',
        `已声明路由：${routes.join(', ')}`,
      ]
      if (qaConfigPath !== null) lines.push(`已写入质检配置：${qaConfigPath}`)
      lines.push('', '身份两两不同，满足发布门的独立质检要求。')
      lines.push('下一步：npm run profile:install 刷新 profile，重启 harness，然后跑 autoresearch_qa_dual。')

      return {
        configured: true,
        lanes: built.lanes,
        routes,
        qaConfigPath,
        report: lines.join('\n'),
      }
    },
    presentCall: () => ({ card: 'generic', title: '配置双路质检的两路 API', kind: 'other' }),
  }))

  // ── 工具：探测端点 ────────────────────────────────────────────────────────

  ctx.logger?.info?.('autoresearch-api: tools registered')
}
