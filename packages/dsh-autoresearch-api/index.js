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
import { createRequire } from 'node:module'
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

/**
 * 项目根与 dsh 入口的解析。
 *
 * 不能用路径算术（`resolve(HERE,'..','..')`）当作「仓库根」：那个表达式只在
 * 从源码仓库运行时成立。装进 profile 后本包位于
 * `<DSH_HOME>/profiles/<name>/node_modules/dsh-autoresearch-api`，往上两级是
 * **profile 目录** —— 那里既没有 `node_modules/@deepseek-ai` 也没有
 * `packages/`，于是 api_verify 恒报「配置不可用」（假阴性，会把人引去查一个
 * 不存在的配置错误），api_dual_lanes 在 readFile 处抛 ENOENT。
 *
 * Node 的模块解析在两种布局下都正确，因此 dsh 入口与兄弟包一律走解析器。
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

/** 兄弟包的安装目录；解析不到返回 null。 */
function packageDirOf(name) {
  try {
    return dirname(requireFromHere.resolve(`${name}/package.json`))
  } catch {
    return null
  }
}

/**
 * 双路质检的两路配置文件 —— 与 `dsh-autoresearch-qa/lib/lanes.js` 的
 * `LANES_FILE` 必须是同一个名字：那份文件是运行期读取的唯一真源。
 *
 * 这里不复用 qa 包的 `writeLanesFile`：`dsh-autoresearch-qa` 已经依赖本包
 * （它 import 本包的 profile-patch/providers），反向再依赖会形成包级环。
 * 代价是文件形态在两地各写一遍 —— `scripts/selftest.mjs` 有一项断言两者一致。
 */
const QA_LANES_FILE = 'autoresearch-qa-lanes.json'

/** 原子写两路配置（先写临时文件再改名），形态与 lanes.js 一致。 */
async function writeQaLanes(home, lanes) {
  await mkdir(home, { recursive: true })
  const path = join(home, QA_LANES_FILE)
  const temporary = `${path}.tmp`
  const payload = JSON.stringify({ version: 1, lanes, updatedAt: new Date().toISOString() }, null, 2)
  await writeFile(temporary, `${payload}\n`, 'utf8')
  await (await import('node:fs/promises')).rename(temporary, path)
  return path
}

/**
 * dsh 子进程的工作目录，以及 DSH_HOME 的环境变量缺失时的兜底根。
 *
 * 只用它当 cwd 与兜底 —— 不拿它拼任何仓库内路径。装进 profile 后它退化成
 * profile 目录，那对这两项用途都无害（`dsh --dump-config` 不读 cwd 里的项目
 * 文件；而 DSH_HOME 在桌面壳与 run-harness 启动路径上一定被设置）。
 */
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
  const dshEntry = () => resolveDshEntry()

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
        lines.push('（profile 只保存引用名，不含密钥本体）')
        // 权限文案必须按平台如实说：Windows 拿不到 0600，宣称"已收紧"是假话，
        // 会让用户以为有保护而实际没有。
        lines.push(process.platform === 'win32'
          ? '（Windows 无 POSIX 权限位，该文件的实际可读范围由账户 ACL 决定 —— 本工具无法收紧，请注意同一台机器的其他账户可读）'
          : '（文件权限已收紧到 0600）')
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
      const entry = dshEntry()
      if (entry === null) {
        // 以前这里会拼出一个不存在的路径、拿到「加载失败」，然后报「配置不可用」——
        // 那是假阴性：配置本身没问题，是入口没解析到。必须区分开。
        return {
          verified: false,
          exitCode: null,
          routes: selected,
          stdout: '',
          stderr: '',
          report: [
            `校验自定义 API 配置（profile: ${config.profiles.join(', ')}）`,
            '无法解析 dsh 入口（@deepseek-ai/dsh/lib/bin.js）。',
            '',
            '这不是配置问题，是运行环境问题：请先在项目根执行 npm install。',
          ].join('\n'),
        }
      }
      const dump = await runDsh(entry, [
        '--profile', config.profiles[0],
        '--dump-config',
      ], { dshHome: dshHome(), cwd: PROJECT_ROOT, timeoutMs: 180_000 })

      // accepted：组合里真的出现了 llm-pi-ai 行。以前算了却只打印，
      // 于是「加载成功但 llm-pi-ai 行被静默丢弃」也会报「可被原生接受」。
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
      } else if (!accepted) {
        lines.push('', '结论：profile 能加载，但组合里没有 llm-pi-ai 行 —— ' +
          '自定义路由没有真正生效。检查 profile 的 bundles 是否包含 llm-pi-ai。')
      } else {
        lines.push('', '结论：配置可被原生接受。重启 harness 后生效。')
      }

      return {
        verified: dump.ok && accepted,
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

      // 两路配置写到**运行期真正读取的那份文件**（`<DSH_HOME>/autoresearch-qa-lanes.json`）。
      //
      // 以前这里改的是仓库里的 `packages/dsh-autoresearch-qa/cordis.patch.yml`，两个问题：
      //   · 装进 profile 后该路径不存在（PROJECT_ROOT 此时是 profile 目录）→ readFile
      //     抛 ENOENT，整个工具失败；
      //   · 即使从源码跑成功，写进源码树的 patch 也要 `npm run profile:install` + 重启
      //     才生效，而 lanes 文件是立即读取的（UI 的 API 页走的就是它）。
      // 文件形态由 dsh-autoresearch-qa/lib/lanes.js 拥有（唯一真源），这里只写它声明的
      // 最小字段 { route, model } —— 不重复声明 api/baseURL/凭据，那些由 resolveSavedLanes
      // 从 provider 表补全。
      let qaConfigPath = null
      if (args.writeToQaConfig !== false) {
        const withoutModel = [normalizedA, normalizedB].find((entry) => entry.models[0]?.id === undefined)
        if (withoutModel !== undefined) {
          // 不写 'TODO' 占位：那会让 lane 带着一个假模型名启动，失败点离这里很远。
          return {
            configured: false,
            lanes: built.lanes,
            routes,
            qaConfigPath: null,
            report: [
              '双路质检两路未配置。',
              `路由 ${withoutModel.route} 没有声明任何模型，无法确定这一路用哪个模型。`,
              '',
              '请在 API 页给该路由补上 models，再重跑本工具。',
            ].join('\n'),
          }
        }
        const saved = await writeQaLanes(dshHome(), [
          { route: normalizedA.route, model: normalizedA.models[0].id },
          { route: normalizedB.route, model: normalizedB.models[0].id },
        ])
        qaConfigPath = saved
      }

      const lines = [
        '双路质检两路已配置',
        `第 1 路：${normalizedA.route} / ${normalizedA.models[0]?.id} （密钥引用 ${normalizedA.keyEnv}）`,
        `第 2 路：${normalizedB.route} / ${normalizedB.models[0]?.id} （密钥引用 ${normalizedB.keyEnv}）`,
        '',
        `已声明路由：${routes.join(', ')}`,
      ]
      if (qaConfigPath !== null) lines.push(`已写入质检两路配置：${qaConfigPath}`)
      lines.push('', '身份两两不同，满足发布门的独立质检要求。')
      // lanes 文件是运行期实时读取的，不需要重装 profile —— 但自定义 API 路由本身
      // 写在 profile patch 层，新增/修改路由仍需重启 harness 才生效。
      lines.push('下一步：重启 harness（新增路由需要重载配置），然后跑 autoresearch_qa_dual。')

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
