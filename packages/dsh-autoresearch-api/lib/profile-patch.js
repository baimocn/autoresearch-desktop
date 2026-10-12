/**
 * Profile 补丁层编辑 —— 与内置设置页共写同一份文件。
 *
 * ## 为什么必须共写一份
 *
 * `applyEntryPatches` 对非 insert 补丁执行 `target[key] = value`：
 * **config 是整体替换，不是深合并**。因此若我的插件另写一个指向
 * `id: llm-pi-ai` 的 patch 文件，它会按叠加顺序把设置页写好的 providers
 * 整个抹掉 —— 这正是「设置里的自定义 API 用不了」的真实原因。
 *
 * 结论：provider 与默认模型只有一个真源 —— profile 自己的 `cordis.patch.yml`。
 * 设置页写它，本插件也写它，双方都做「读入 → 合并 → 写回」。
 *
 * ## 安全约束
 *
 *   · 解析失败即拒绝写入（fail loud），不冒着损坏用户配置的风险去猜
 *   · 只改动目标条目的目标字段，其余条目与注释顺序原样保留
 *   · 原子写入（临时文件 + rename），避免半截文件
 *   · `!!js` 标签原样透传，不解释也不重写
 *
 * @module dsh-autoresearch-api/profile-patch
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseDocument, isMap, isSeq, YAMLMap, YAMLSeq } from 'yaml'

export class ProfilePatchError extends Error {
  constructor(message, detail) {
    super(message)
    this.name = 'ProfilePatchError'
    this.detail = detail ?? null
  }
}

/** profile 补丁文件路径。 */
export function profilePatchPath(dshHome, profile) {
  return join(dshHome, 'profiles', profile, 'cordis.patch.yml')
}

/**
 * 读取 profile 补丁文档。
 *
 * 用 `parseDocument` 而不是 `parse`：需要保留注释与顺序，写回时才不会重排。
 * `!!js` 标签以未解析节点形式保留，写回时原样输出。
 */
export async function readProfilePatch(path) {
  let text
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') {
      return { document: null, text: null, exists: false }
    }
    throw new ProfilePatchError(`无法读取 profile 补丁：${error.message}`)
  }

  const document = parseDocument(text, { keepSourceTokens: false })
  if (document.errors.length > 0) {
    throw new ProfilePatchError(
      `profile 补丁不是合法 YAML，拒绝写入以免损坏用户配置：${path}`,
      document.errors.map((error) => error.message))
  }
  if (document.contents !== null && !isSeq(document.contents)) {
    throw new ProfilePatchError(
      `profile 补丁顶层必须是数组（loader patch 列表），实际是 ${document.contents?.constructor?.name ?? 'null'}：${path}`)
  }
  return { document, text, exists: true }
}

/** 在文档里按 id 找条目；返回 { entry, index }。 */
function findEntry(document, id) {
  const contents = document.contents
  if (contents === null || !isSeq(contents)) return { entry: null, index: -1 }
  for (let index = 0; index < contents.items.length; index += 1) {
    const item = contents.items[index]
    if (!isMap(item)) continue
    const idNode = item.get('id', true)
    if (idNode !== undefined && String(idNode) === id) {
      return { entry: item, index }
    }
  }
  return { entry: null, index: -1 }
}

/** 把普通对象转成可插入文档的 YAML 节点。 */
function toNode(document, value) {
  return document.createNode(value)
}

/**
 * 合并 providers 到 `llm-pi-ai` 条目。
 *
 * 与设置页协作的关键：读出现有的 providers，把新路由并进去，
 * 已有的同名路由被新声明覆盖（这是调用方的显式意图），其余全部保留。
 *
 * @returns {Promise<{ changed: boolean, providers: string[], path: string }>}
 */
export async function mergeProviders(path, declarations) {
  const { document, exists } = await readProfilePatch(path)
  const doc = exists ? document : parseDocument('[]\n')

  const { entry } = findEntry(doc, 'llm-pi-ai')

  // 读出现有 providers（设置页写的 + 本插件先前写的）
  const existing = {}
  if (entry !== null) {
    const config = entry.get('config', true)
    if (isMap(config)) {
      const providers = config.get('providers', true)
      if (isMap(providers)) {
        for (const item of providers.items) {
          const key = item.key?.value ?? item.key
          existing[String(key)] = item.value?.toJSON?.() ?? item.value
        }
      }
    }
  }

  // 合并：**未提供的字段保留现有值**（编辑友好），显式提供才覆盖。
  //
  // 为什么不能整体替换：给一个已有路由补密钥或补模型时，多数调用方只会带
  // 自己关心的那两三个字段。整体替换会把没带的字段（典型是 models 列表）
  // 清空 —— 实测踩过：给路由追加模型 B，原有模型 A 丢了。
  // 语义约定：
  //   · undefined / 空数组  → 保留现有
  //   · baseURL 显式空串     → 删除该键（切回协议默认地址）
  //   · models 显式非空数组  → 覆盖（调用方给出完整列表）
  const merged = { ...existing }
  for (const declaration of declarations) {
    const prior = existing[declaration.route] ?? {}
    const keep = (key) => (prior[key] === undefined ? {} : { [key]: prior[key] })
    merged[declaration.route] = {
      displayName: declaration.displayName ?? prior.displayName ?? declaration.route,
      ...(declaration.api === undefined ? keep('api') : { api: declaration.api }),
      ...(declaration.baseURL === undefined
        ? keep('baseURL')
        : (declaration.baseURL === '' || declaration.baseURL === null
          ? {}
          : { baseURL: declaration.baseURL })),
      ...(declaration.keyEnv === undefined || declaration.keyEnv === ''
        ? keep('apiKeyEnv')
        : { apiKeyEnv: declaration.keyEnv }),
      ...(declaration.headers === undefined ? keep('headers') : { headers: declaration.headers }),
      ...(declaration.reasoning === undefined ? keep('reasoning') : { reasoning: declaration.reasoning }),
      ...(declaration.timeoutMs === undefined ? keep('timeoutMs') : { timeoutMs: declaration.timeoutMs }),
      ...(declaration.models.length === 0
        ? (Array.isArray(prior.models) && prior.models.length > 0 ? { models: prior.models } : {})
        : {
          models: declaration.models.map((model) => ({
            id: model.id,
            ...(model.name === undefined || model.name === model.id ? {} : { name: model.name }),
          })),
        }),
    }
  }

  if (entry !== null) {
    // 就地更新：只动 config.providers，保留该条目的其它字段与顺序
    let config = entry.get('config', true)
    if (!isMap(config)) {
      entry.set('config', doc.createNode({ providers: merged }))
    } else {
      config.set('providers', toNode(doc, merged))
    }
  } else {
    doc.add(toNode(doc, { id: 'llm-pi-ai', config: { providers: merged } }))
  }

  await writeAtomic(path, String(doc))
  return { changed: true, providers: Object.keys(merged), path }
}

/**
 * 设置默认模型。
 *
 * 写入位置必须与内置 config-editor 一致：`config` 之内
 * （它的实现是 `document.setIn([index, "config"], node)`）。
 * 写到条目顶层是无效的 —— loader 的 EntryOptions 只认 id/name/config/
 * group/disabled/inject，顶层 provider/model 会被静默忽略。
 *
 * `reasoningEffort` 必须**显式清理**：它是上一个模型的属性，不是新模型的。
 * 不清理会让不支持的档位残留下来，在调用时报
 * `UNSUPPORTED_REASONING_EFFORT` —— 实测踩过（deepseek-official 的 high
 * 被带到不支持推理档位的 llapi 模型上）。因此未指定时删除该字段，
 * 而不是「保留原值」。
 */
export async function setDefaultModel(path, provider, model, reasoningEffort) {
  const { document, exists } = await readProfilePatch(path)
  const doc = exists ? document : parseDocument('[]\n')

  const { entry } = findEntry(doc, 'agent-default-model')

  if (entry === null) {
    doc.add(toNode(doc, {
      id: 'agent-default-model',
      config: {
        provider,
        model,
        ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
      },
    }))
  } else {
    let config = entry.get('config', true)
    if (!isMap(config)) {
      entry.set('config', doc.createNode({ provider, model }))
      config = entry.get('config', true)
    }
    config.set('provider', provider)
    config.set('model', model)
    if (reasoningEffort === undefined) {
      config.delete('reasoningEffort')
    } else {
      config.set('reasoningEffort', reasoningEffort)
    }
  }

  await writeAtomic(path, String(doc))
  return { changed: true, provider, model, reasoningEffort: reasoningEffort ?? null, path }
}


/**
 * 从 `llm-pi-ai` 条目移除一个 provider 路由。
 *
 * 工作台「删除路由」走这里：只动 providers 里这一个键，其余声明与文件
 * 其余字节（经 YAML 重序列化）原样保留。路由不存在时返回 changed: false。
 *
 * @returns {Promise<{ changed: boolean, path: string }>}
 */
export async function removeProvider(path, routeId) {
  const { document, exists } = await readProfilePatch(path)
  if (!exists) return { changed: false, path }
  const { entry } = findEntry(document, 'llm-pi-ai')
  if (entry === null) return { changed: false, path }
  const config = entry.get('config', true)
  if (!isMap(config)) return { changed: false, path }
  const providers = config.get('providers', true)
  if (!isMap(providers) || !providers.has(routeId)) return { changed: false, path }
  providers.delete(routeId)
  await writeAtomic(path, String(document))
  return { changed: true, path }
}

/**
 * 清掉 `agent-default-model` 条目顶层的无效 provider/model 字段。
 *
 * 早期版本的写实现把它们加在了条目顶层（loader 不读），留下无效果的残留。
 * 保留会让文件看起来有两套声明，违反「同一事实单一真源」。
 */
export async function dropStrayModelKeys(path) {
  const { document, exists } = await readProfilePatch(path)
  if (!exists) return { cleaned: [] }
  const { entry } = findEntry(document, 'agent-default-model')
  if (entry === null) return { cleaned: [] }

  const cleaned = []
  for (const key of ['provider', 'model', 'reasoningEffort']) {
    // config 之外的同名字段是无效残留，删掉。
    if (entry.has(key) && !isMap(entry.get(key, true))) {
      entry.delete(key)
      cleaned.push(key)
    }
  }
  if (cleaned.length > 0) await writeAtomic(path, String(document))
  return { cleaned }
}

/** 列出 profile 补丁里已声明的 providers。 */
export async function listProviders(path) {
  const { document, exists } = await readProfilePatch(path)
  if (!exists) return {}
  const { entry } = findEntry(document, 'llm-pi-ai')
  if (entry === null) return {}

  const config = entry.get('config', true)
  if (!isMap(config)) return {}
  const providers = config.get('providers', true)
  if (!isMap(providers)) return {}

  const result = {}
  for (const item of providers.items) {
    const key = String(item.key?.value ?? item.key)
    result[key] = item.value?.toJSON?.() ?? item.value
  }
  return result
}

/** 读出当前默认模型。 */
export async function readDefaultModel(path) {
  const { document, exists } = await readProfilePatch(path)
  if (!exists) return null
  const { entry } = findEntry(document, 'agent-default-model')
  if (entry === null) return null
  const config = entry.get('config', true)
  if (!isMap(config)) return null
  const provider = config.get('provider', true)
  const model = config.get('model', true)
  if (provider === undefined || model === undefined) return null
  return { provider: String(provider), model: String(model) }
}

/** 原子写入。 */
async function writeAtomic(path, text) {
  await mkdir(dirname(path), { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, text, 'utf8')
  await rename(temporary, path)
}
