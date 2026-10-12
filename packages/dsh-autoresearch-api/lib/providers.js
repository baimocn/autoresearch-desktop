/**
 * 自定义 API 接入 —— 任意 OpenAI 兼容 / Anthropic 兼容端点与任意模型名。
 *
 * 为什么要自己做：内置的 Models 设置页支持「手写自定义 pi-ai 路由」，但它是
 * 一个交互式表单，无法被脚本、双路质检、批量配置复用。这里把同一件事做成
 * 可编排的能力：一份声明式配置 → 写进 profile 的 provider 段 + 凭据文档。
 *
 * 三个必须对齐的契约（都从实现里读出来，不是猜的）：
 *   1. provider 段字段：`api` / `baseURL` / `apiKeyEnv` / `models[]` / `headers`
 *   2. `api` 只接受三种协议：openai-completions / openai-responses / anthropic-messages
 *   3. 凭据 ref 名必须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（即环境变量名形态）
 *
 * 密钥处理：只写进 `$DSH_HOME/.credentials.yaml` 的 refs 段，权限 0600；
 * profile 只保存 ref 名，不保存密钥本体。这是凭据服务的既有分层，不另造一套。
 *
 * @module dsh-autoresearch-api
 */

import { spawn } from 'node:child_process'
import { readFile, writeFile, mkdir, chmod, stat, rename } from 'node:fs/promises'
import { dirname, join, resolve, isAbsolute } from 'node:path'

export class ApiConfigError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ApiConfigError'
    this.detail = detail ?? null
  }
}

/** pi-ai 支持的三种协议；顺序即配置界面的推荐顺序。 */
export const SUPPORTED_PROTOCOLS = Object.freeze([
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
])

/** 常见端点的协议与默认地址建议；只是建议，不作为限制。 */
export const ENDPOINT_PRESETS = Object.freeze({
  openai: { api: 'openai-completions', baseURL: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY' },
  anthropic: { api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', keyEnv: 'ANTHROPIC_API_KEY' },
  deepseek: { api: 'openai-completions', baseURL: 'https://api.deepseek.com', keyEnv: 'DEEPSEEK_API_KEY' },
  moonshot: { api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', keyEnv: 'MOONSHOT_API_KEY' },
  dashscope: { api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', keyEnv: 'DASHSCOPE_API_KEY' },
  zhipu: { api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', keyEnv: 'ZHIPU_API_KEY' },
  siliconflow: { api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', keyEnv: 'SILICONFLOW_API_KEY' },
  ollama: { api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', keyEnv: 'OLLAMA_API_KEY' },
  vllm: { api: 'openai-completions', baseURL: 'http://127.0.0.1:8000/v1', keyEnv: 'VLLM_API_KEY' },
})

/** 凭据 ref 名合法形态（与凭据服务同一正则）。 */
const REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/

export function isValidRefName(value) {
  return typeof value === 'string' && REF_PATTERN.test(value)
}

/** provider 路由 id 形态：小写连字符标识（凭据记录寻址用）。 */
const ROUTE_PATTERN = /^[a-z][a-z0-9-]*$/

export function isValidRouteId(value) {
  return typeof value === 'string' && ROUTE_PATTERN.test(value)
}

/**
 * 校验一份自定义 API 声明。
 * 返回问题清单（空数组表示合规）。在写入任何文件之前拦住配置错误。
 */
export function validateApiDeclaration(declaration) {
  const problems = []
  if (typeof declaration !== 'object' || declaration === null) {
    return ['声明必须是对象']
  }

  const { route, api, baseURL, models, keyEnv, apiKey, headers, displayName } = declaration

  if (!isValidRouteId(route)) {
    problems.push(`route 必须是 小写字母开头的连字符标识（如 my-gateway）；当前：${JSON.stringify(route)}`)
  }
  if (api !== undefined && !SUPPORTED_PROTOCOLS.includes(api)) {
    problems.push(`api 只能是 ${SUPPORTED_PROTOCOLS.join(' / ')}；当前：${JSON.stringify(api)}`)
  }
  if (baseURL !== undefined) {
    if (typeof baseURL !== 'string' || baseURL.trim() === '') {
      problems.push('baseURL 必须是非空字符串')
    } else {
      try {
        const parsed = new URL(baseURL)
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          problems.push(`baseURL 必须是 http 或 https；当前协议：${parsed.protocol}`)
        }
      } catch {
        problems.push(`baseURL 不是合法 URL：${baseURL}`)
      }
    }
  }
  if (models !== undefined) {
    // 空数组合法：语义是「保留该路由现有的模型列表」——编辑密钥/地址时
    // 不必重打模型。整体替换会丢模型的坑就是这个语义引入前踩的。
    if (!Array.isArray(models)) {
      problems.push('models 必须是数组（空数组 = 保留现有列表）')
    } else if (models.length === 0) {
      // 保留现有：无需进一步校验
    } else {
      models.forEach((model, index) => {
        const id = typeof model === 'string' ? model : model?.id
        if (typeof id !== 'string' || id.trim() === '') {
          problems.push(`models[${index}] 缺少非空 id`)
        }
      })
    }
  }
  if (keyEnv !== undefined && !isValidRefName(keyEnv)) {
    problems.push(`keyEnv "${keyEnv}" 不是合法的凭据引用名（须匹配 ${REF_PATTERN}，即环境变量名形态）`)
  }
  if (apiKey !== undefined && (typeof apiKey !== 'string' || apiKey.trim() === '')) {
    problems.push('apiKey 必须是非空字符串（或省略此项只声明引用名）')
  }
  if (headers !== undefined) {
    if (typeof headers !== 'object' || headers === null || Array.isArray(headers)) {
      problems.push('headers 必须是对象')
    } else {
      for (const [name, value] of Object.entries(headers)) {
        if (typeof value !== 'string') problems.push(`headers.${name} 必须是字符串`)
        else if (value.includes('\n')) problems.push(`headers.${name} 不得含换行`)
      }
    }
  }
  if (displayName !== undefined && typeof displayName !== 'string') {
    problems.push('displayName 必须是字符串')
  }

  // 自定义端点必须显式给协议；否则该路由无法被服务。
  if (baseURL !== undefined && api === undefined) {
    problems.push('声明了 baseURL 时必须同时声明 api（协议）：自定义端点无法靠目录推断协议')
  }

  return problems
}

/** 把声明规格化为写盘结构。 */
export function normalizeDeclaration(declaration) {
  const preset = ENDPOINT_PRESETS[declaration.route]
  const api = declaration.api ?? preset?.api ?? 'openai-completions'
  const baseURL = declaration.baseURL ?? preset?.baseURL
  const keyEnv = declaration.keyEnv ?? preset?.keyEnv ?? `${String(declaration.route).toUpperCase().replace(/-/g, '_')}_API_KEY`

  const models = (declaration.models ?? []).map((model) => (
    typeof model === 'string'
      ? { id: model, name: model }
      : { id: model.id, ...(model.name === undefined ? {} : { name: model.name }) }
  ))

  return {
    route: declaration.route,
    displayName: declaration.displayName ?? declaration.route,
    api,
    baseURL,
    keyEnv,
    models,
    ...(declaration.headers === undefined ? {} : { headers: declaration.headers }),
    ...(declaration.reasoning === undefined ? {} : { reasoning: declaration.reasoning }),
    ...(declaration.timeoutMs === undefined ? {} : { timeoutMs: declaration.timeoutMs }),
    apiKey: declaration.apiKey ?? null,
  }
}

/** 生成 provider 段的 YAML 片段（缩进两格，嵌在 profile patch 的 config 下）。 */
export function renderProviderPatch(declarations) {
  const lines = [
    '# 自定义 API 路由 —— 由 AutoResearch API 接入生成。',
    '# 密钥本体不在此处：本段只保存引用名，值在 $DSH_HOME/.credentials.yaml 的 refs 段。',
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
  ]
  for (const entry of declarations) {
    lines.push(`      ${entry.route}:`)
    if (entry.displayName !== undefined) lines.push(`        displayName: ${JSON.stringify(entry.displayName)}`)
    lines.push(`        api: ${JSON.stringify(entry.api)}`)
    if (entry.baseURL !== undefined) lines.push(`        baseURL: ${JSON.stringify(entry.baseURL)}`)
    lines.push(`        apiKeyEnv: ${JSON.stringify(entry.keyEnv)}`)
    if (entry.headers !== undefined && Object.keys(entry.headers).length > 0) {
      lines.push('        headers:')
      for (const [name, value] of Object.entries(entry.headers)) {
        lines.push(`          ${JSON.stringify(name)}: ${JSON.stringify(value)}`)
      }
    }
    if (entry.reasoning !== undefined) lines.push(`        reasoning: ${JSON.stringify(entry.reasoning)}`)
    if (entry.timeoutMs !== undefined) lines.push(`        timeoutMs: ${entry.timeoutMs}`)
    if (entry.models.length > 0) {
      lines.push('        models:')
      for (const model of entry.models) {
        lines.push(`          - id: ${JSON.stringify(model.id)}`)
        if (model.name !== undefined && model.name !== model.id) {
          lines.push(`            name: ${JSON.stringify(model.name)}`)
        }
      }
    }
  }
  lines.push('')
  return lines.join('\n')
}

/**
 * 生成模型选择 patch —— 把默认模型指到自定义路由。
 * 单独成文件：默认模型与 provider 声明可以分别更新。
 */
export function renderDefaultModelPatch(route, model, reasoningEffort) {
  return [
    '# 默认模型路由 —— 由 AutoResearch API 接入生成。',
    '- id: agent-default-model',
    '  config:',
    `    provider: ${JSON.stringify(route)}`,
    `    model: ${JSON.stringify(model)}`,
    ...(reasoningEffort === undefined ? [] : [`    reasoningEffort: ${JSON.stringify(reasoningEffort)}`]),
    '',
  ].join('\n')
}

/**
 * 读取凭据文档并返回 refs 映射。
 * 文档只有 `refs`（环境变量名 → 值）与 `records`（结构化记录）两段。
 */
export async function readCredentialRefs(credentialsPath) {
  let text
  try {
    text = await readFile(credentialsPath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return {}
    throw error
  }
  const refs = {}
  let inRefs = false
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^refs:\s*$/.test(rawLine)) { inRefs = true; continue }
    if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*$/.test(rawLine)) { inRefs = false; continue }
    if (!inRefs) continue
    const pair = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*(.*)$/.exec(rawLine)
    if (pair === null) continue
    const value = pair[2].trim().replace(/^["']|["']$/g, '')
    if (value !== '') refs[pair[1]] = value
  }
  return refs
}

/**
 * 更新凭据文档的 refs 段。
 *
 * 刻意做最小改写：只动 refs 段里需要改的行，其余字节原样保留 ——
 * 凭据文档里可能有 records 段与注释，全量重写会丢掉作者意图。
 * 写入后收紧权限到 0600（凭据服务启动时会检查，可读范围超出所有者即拒绝启动）。
 */
export async function writeCredentialRefs(credentialsPath, updates) {
  let text
  try {
    text = await readFile(credentialsPath, 'utf8')
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
    text = 'version: 1\nrefs:\n'
  }

  const lines = text.split(/\r?\n/)
  const refsIndex = lines.findIndex((line) => /^refs:\s*$/.test(line))

  if (refsIndex === -1) {
    // 没有 refs 段：在 version 行后插入，保留其余内容。
    const versionIndex = lines.findIndex((line) => /^version:\s*/.test(line))
    const insertAt = versionIndex === -1 ? 0 : versionIndex + 1
    lines.splice(insertAt, 0, 'refs:')
    for (const [name, value] of Object.entries(updates)) {
      lines.splice(insertAt + 1, 0, `  ${name}: ${value}`)
    }
  } else {
    // 有 refs 段：就地更新命中的行，未命中的追加到段内末尾。
    const sectionEnd = (() => {
      for (let index = refsIndex + 1; index < lines.length; index += 1) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*:\s*/.test(lines[index])) return index
      }
      return lines.length
    })()

    const pending = new Map(Object.entries(updates))
    for (let index = refsIndex + 1; index < sectionEnd; index += 1) {
      const pair = /^\s+([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(lines[index])
      if (pair === null) continue
      if (pending.has(pair[1])) {
        lines[index] = `  ${pair[1]}: ${pending.get(pair[1])}`
        pending.delete(pair[1])
      }
    }
    let insertAt = sectionEnd
    for (const [name, value] of pending) {
      lines.splice(insertAt, 0, `  ${name}: ${value}`)
      insertAt += 1
    }
  }

  const next = lines.join('\n')
  await mkdir(dirname(credentialsPath), { recursive: true })
  const temporary = `${credentialsPath}.${process.pid}.tmp`
  await writeFile(temporary, next, 'utf8')
  await chmod(temporary, 0o600).catch(() => { /* Windows 无 POSIX 位；凭据服务另有检查 */ })
  await rename(temporary, credentialsPath)
  return { path: credentialsPath, refs: Object.keys(updates) }
}

/** 探测端点可达性与协议（只发一个最小的鉴权请求，不发送任务内容）。 */
export async function probeEndpoint(declaration, options = {}) {
  const normalized = normalizeDeclaration(declaration)
  const apiKey = options.apiKey ?? declaration.apiKey
  if (normalized.baseURL === undefined) {
    return { reachable: false, reason: '缺少 baseURL' }
  }

  const url = buildProbeUrl(normalized)
  const headers = { ...(normalized.headers ?? {}) }
  if (apiKey !== undefined && apiKey !== null && apiKey !== '') {
    if (normalized.api === 'anthropic-messages') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
  }

  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
    })
    return {
      reachable: true,
      status: response.status,
      ok: response.ok,
      url,
      // 鉴权失败也说明端点活着：这区分「地址错」与「密钥错」。
      interpretation: interpretProbeStatus(response.status),
    }
  } catch (error) {
    return {
      reachable: false,
      reason: String(error?.message ?? error),
      url,
      interpretation: '连接失败：检查 baseURL、网络与代理设置',
    }
  }
}

function buildProbeUrl(normalized) {
  const base = normalized.baseURL.replace(/\/+$/, '')
  return `${base}/models`
}

function interpretProbeStatus(status) {
  if (status === 401 || status === 403) return '端点可达，但鉴权失败：检查密钥或该密钥的权限'
  if (status === 404) return '端点可达，但没有 /models 路由：可能 baseURL 需要带 /v1，或该服务不提供模型列表'
  if (status >= 200 && status < 300) return '端点可达且鉴权通过'
  if (status === 429) return '端点可达，但被限流'
  return `端点可达，返回 ${status}`
}

/** 运行 dsh 命令并返回输出（用于校验 profile 组合是否可加载）。 */
export function runDsh(dshEntryPath, argv, options = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, [dshEntryPath, ...argv], {
      cwd: options.cwd,
      env: { ...process.env, DSH_HOME: options.dshHome, NO_COLOR: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch { /* */ } }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ok: false, error: error.message, stdout, stderr, exitCode: null })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ok: code === 0, exitCode: code, stdout, stderr })
    })
  })
}

/** 生成一份「双路质检用」的声明对：两路身份必须不同。 */
export function buildDualLaneDeclarations(laneA, laneB) {
  const problems = [
    ...validateApiDeclaration(laneA).map((problem) => `第 1 路：${problem}`),
    ...validateApiDeclaration(laneB).map((problem) => `第 2 路：${problem}`),
  ]
  if (problems.length > 0) return { problems }

  const first = normalizeDeclaration(laneA)
  const second = normalizeDeclaration(laneB)
  if (first.route === second.route) {
    problems.push(`两路的 route 必须不同（当前都是 ${first.route}）：共识要求两路身份两两不同`)
  }
  // 身份撞车是硬拒绝：返回 lanes 会让调用方有机会忽视 problems 而配出同身份两路，
  // 那种配置要跑完两路才在聚合阶段失败，浪费一整轮。
  if (problems.length > 0) return { problems }

  return {
    problems,
    lanes: [
      { provider: first.route, model: first.models[0]?.id, credentialEnv: first.keyEnv, apiKey: first.apiKey },
      { provider: second.route, model: second.models[0]?.id, credentialEnv: second.keyEnv, apiKey: second.apiKey },
    ],
  }
}

/** 解析 $DSH_HOME 路径（与运行目录解析同一规则，供插件内复用）。 */
export function resolveDshHomePath(options = {}) {
  const fromEnvironment = process.env.DSH_HOME
  if (typeof options.explicit === 'string' && options.explicit.trim() !== '') {
    return isAbsolute(options.explicit) ? options.explicit : resolve(process.cwd(), options.explicit)
  }
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return isAbsolute(fromEnvironment) ? fromEnvironment : resolve(process.cwd(), fromEnvironment)
  }
  return join(options.projectRoot ?? process.cwd(), '.dsh-home')
}

/** 检查路径是否为文件（用于确认 profile 已安装）。 */
export async function isFile(path) {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}
