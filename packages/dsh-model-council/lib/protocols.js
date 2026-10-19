/**
 * 三种协议的**直连**客户端：拉模型列表 + 一轮对话。
 *
 * ## 为什么不复用 pi-ai 路由
 *
 * 议会的每一路都要**自己独立的 URL / 协议 / 模型 / 密钥**（用户明确要求），
 * 而不是引用全局 provider 表里的一个路由。走 pi-ai 就得为每一路往 profile
 * 里写 provider 段、为每一路准备独立 DSH_HOME —— 一个议会有 6 路，就是 6 份
 * 配置。直连 HTTP 更简单，也让「这一路到底打到哪个地址」在页面上可见。
 *
 * ## 三种协议各自的形状（不是猜的，按各家公开契约写）
 *
 *   openai-completions  POST {base}/chat/completions   → choices[0].message.content
 *   openai-responses    POST {base}/responses          → output_text / output[].content[].text
 *   anthropic-messages  POST {base}/v1/messages        → content[].text（system 是独立字段）
 *
 * ## 地址容错
 *
 * 同一个服务商对 baseURL 要不要带 `/v1` 并不统一（DeepSeek 两种都能用，
 * OpenAI 必须带）。所以每个协议给出候选路径，**按顺序试到第一个非 404**，
 * 而不是猜一个。这比让用户在页面上纠结 `/v1` 更可靠。
 *
 * @module dsh-model-council/lib/protocols
 */

import { SUPPORTED_PROTOCOLS } from 'dsh-autoresearch-api/lib/providers.js'

export { SUPPORTED_PROTOCOLS }

/** 每个协议的候选相对路径，按尝试顺序。 */
export const PROTOCOL_PATHS = Object.freeze({
  'openai-completions': {
    chat: ['chat/completions', 'v1/chat/completions'],
    models: ['models', 'v1/models'],
  },
  'openai-responses': {
    chat: ['responses', 'v1/responses'],
    models: ['models', 'v1/models'],
  },
  'anthropic-messages': {
    chat: ['v1/messages', 'messages'],
    models: ['v1/models', 'models'],
  },
})

/**
 * 把 baseURL 与候选路径拼成待试 URL 列表。
 *
 * baseURL 已经以 `/v1`（或其它版本段）结尾时，跳过带版本前缀的候选 ——
 * 否则会拼出 `.../v1/v1/messages`，那种地址必然 404，白跑一次请求。
 */
export function candidateUrls(baseURL, paths) {
  const base = String(baseURL ?? '').replace(/\/+$/, '')
  if (base === '') return []
  const hasVersion = /\/v\d+$/.test(base)
  const out = []
  for (const path of paths ?? []) {
    const cleaned = String(path).replace(/^\/+/, '')
    if (hasVersion && /^v\d+\//.test(cleaned)) continue
    const url = `${base}/${cleaned}`
    if (!out.includes(url)) out.push(url)
  }
  return out
}

/** 鉴权头：三种协议两种形态（anthropic 用 x-api-key，其余用 Bearer）。 */
export function authHeaders(api, apiKey, extra) {
  const headers = { ...(extra ?? {}) }
  if (typeof apiKey === 'string' && apiKey !== '') {
    if (api === 'anthropic-messages') {
      headers['x-api-key'] = apiKey
      headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01'
    } else {
      headers.authorization = `Bearer ${apiKey}`
    }
  }
  return headers
}

/** 从各种形态的模型列表响应里抠出 id。识别不了就返回空数组，不猜。 */
export function extractModelIds(json) {
  const collect = (list) => {
    const ids = []
    for (const item of list) {
      const id = typeof item === 'string' ? item : (item?.id ?? item?.name ?? item?.model)
      if (typeof id === 'string' && id.trim() !== '') ids.push(id.trim())
    }
    return [...new Set(ids)]
  }
  if (Array.isArray(json)) return collect(json)
  if (Array.isArray(json?.data)) return collect(json.data)
  if (Array.isArray(json?.models)) return collect(json.models)
  return []
}

function clip(text, limit = 400) {
  const value = String(text ?? '')
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

/**
 * 拉取一个端点的模型列表。
 *
 * 返回 `{ ok, models, url, status, error, raw }`。**失败必须如实返回原因**：
 * 页面上「探测」按钮转完圈什么都没发生，是最难排查的失败形态。
 */
export async function listModels(participant, options = {}) {
  const { api, baseURL, apiKey, headers } = participant ?? {}
  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    return { ok: false, models: [], error: `不支持的协议：${JSON.stringify(api)}` }
  }
  const urls = candidateUrls(baseURL, PROTOCOL_PATHS[api]?.models)
  if (urls.length === 0) return { ok: false, models: [], error: '缺少 baseURL' }

  let lastError = null
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: authHeaders(api, apiKey, headers),
        signal: AbortSignal.timeout(options.timeoutMs ?? 15_000),
      })
      const text = await response.text()
      // 404 只说明这个候选路径不对，换下一个；其余状态码是终点。
      if (response.status === 404) {
        lastError = { url, status: 404, error: '该地址没有 /models 路由（可能 baseURL 需要带 /v1）' }
        continue
      }
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON：下面按「识别不出」处理 */ }
      if (!response.ok) {
        return {
          ok: false, models: [], url, status: response.status,
          error: `HTTP ${response.status}`, raw: clip(text),
        }
      }
      const models = extractModelIds(json)
      if (models.length === 0) {
        return {
          ok: false, models: [], url, status: response.status,
          error: '端点可达但没有识别出模型列表（该服务可能不提供 /models）', raw: clip(text),
        }
      }
      return { ok: true, models, url, status: response.status }
    } catch (error) {
      lastError = { url, status: null, error: String(error?.message ?? error) }
    }
  }
  return {
    ok: false, models: [],
    url: lastError?.url ?? urls[0],
    status: lastError?.status ?? null,
    error: lastError?.error ?? '连接失败：检查 baseURL、网络与代理设置',
  }
}

/** 按协议构造对话请求体。 */
export function buildChatBody(api, { model, system, user, maxTokens }) {
  if (api === 'anthropic-messages') {
    return {
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }
  }
  if (api === 'openai-responses') {
    // responses 协议的指令与输入是分开的字段。
    return { model, instructions: system, input: user, max_output_tokens: maxTokens }
  }
  return {
    model,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    max_tokens: maxTokens,
  }
}

/** 从各协议的响应体里抠出正文。识别不了返回空串，不猜。 */
export function extractReply(api, json) {
  if (api === 'anthropic-messages') {
    const blocks = Array.isArray(json?.content) ? json.content : []
    return blocks.filter((b) => b?.type === 'text' || typeof b?.text === 'string')
      .map((b) => b.text ?? '').join('').trim()
  }
  if (api === 'openai-responses') {
    if (typeof json?.output_text === 'string' && json.output_text.trim() !== '') return json.output_text.trim()
    const blocks = Array.isArray(json?.output) ? json.output : []
    const parts = []
    for (const item of blocks) {
      for (const content of Array.isArray(item?.content) ? item.content : []) {
        if (typeof content?.text === 'string') parts.push(content.text)
      }
    }
    return parts.join('').trim()
  }
  const message = json?.choices?.[0]?.message
  const content = message?.content
  if (typeof content === 'string') return content.trim()
  if (Array.isArray(content)) return content.map((part) => part?.text ?? '').join('').trim()
  if (typeof json?.choices?.[0]?.text === 'string') return json.choices[0].text.trim()
  return ''
}

/**
 * 跑一轮对话（无状态：整段议事记录由 user 参数带入）。
 *
 * 返回 `{ ok, text, url, status, error, raw, usage }`。空回复算失败 ——
 * 一个成员「什么都没说」若被当成正常发言，议事记录里就会出现空条目，
 * 裁决者据此裁定的就是空气。
 */
export async function chatOnce(participant, { system, user, maxTokens, timeoutMs, apiKey } = {}) {
  const { api, baseURL, headers } = participant ?? {}
  if (!SUPPORTED_PROTOCOLS.includes(api)) {
    return { ok: false, text: '', error: `不支持的协议：${JSON.stringify(api)}` }
  }
  if (typeof participant?.model !== 'string' || participant.model.trim() === '') {
    return { ok: false, text: '', error: '未选择模型' }
  }
  const urls = candidateUrls(baseURL, PROTOCOL_PATHS[api]?.chat)
  if (urls.length === 0) return { ok: false, text: '', error: '缺少 baseURL' }

  const body = buildChatBody(api, { model: participant.model, system, user, maxTokens })
  let lastError = null
  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...authHeaders(api, apiKey, headers) },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs ?? 300_000),
      })
      const text = await response.text()
      if (response.status === 404) {
        lastError = { url, status: 404, error: '该地址没有对话路由（可能 baseURL 需要带 /v1）' }
        continue
      }
      let json = null
      try { json = JSON.parse(text) } catch { /* 非 JSON：下面按无正文处理 */ }
      if (!response.ok) {
        return {
          ok: false, text: '', url, status: response.status,
          error: `HTTP ${response.status}`, raw: clip(text),
        }
      }
      const reply = extractReply(api, json)
      if (reply === '') {
        return { ok: false, text: '', url, status: response.status, error: '端点返回 200 但没有正文', raw: clip(text) }
      }
      return { ok: true, text: reply, url, status: response.status, usage: json?.usage ?? null }
    } catch (error) {
      lastError = { url, status: null, error: String(error?.message ?? error) }
    }
  }
  return {
    ok: false, text: '',
    url: lastError?.url ?? urls[0],
    status: lastError?.status ?? null,
    error: lastError?.error ?? '连接失败：检查 baseURL、网络与代理设置',
  }
}
