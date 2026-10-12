/**
 * 双路质检的持久化配置与解析。
 *
 * ## 配置形态
 *
 * 两路各引用一个已声明的 provider 路由与一个模型名：
 *
 *   { "lanes": [
 *       { "route": "llapi-a", "model": "deepseek-v4.1-flash" },
 *       { "route": "anthropic", "model": "claude-x" }
 *   ] }
 *
 * 解析时把「路由引用」补全为 lane 的完整事实（api / baseURL / 凭据），
 * 从 profile patch 的 llm-pi-ai.providers 与凭据文档的 refs 段读取 ——
 * 与工作台 API 页、内置设置页共用同一份配置源，不另立声明。
 *
 * ## 为什么 lane 必须带全 provider 声明
 *
 * lane 用全新的 DSH_HOME（headless 是内置 profile，没有用户配置层），
 * 每路的 model patch 必须自带 api / baseURL / apiKeyEnv：只写 apiKeyEnv
 * 的版本对自定义端点以 NO_ADAPTER 失败 —— 实测踩过。
 *
 * ## 密钥
 *
 * 配置只存路由引用；密钥本体在凭据文档（0600）里。启动 lane 进程时
 * 以环境变量注入（credentialEnv → apiKey），profile 与配置文件中不含密钥。
 *
 * @module dsh-autoresearch-qa/lib/lanes
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { join } from 'node:path'

export const LANES_FILE = 'autoresearch-qa-lanes.json'

/** 读取两路配置；文件不存在或损坏时返回空配置（调用方给出配置指引）。 */
export async function readLanesFile(dshHome) {
  try {
    const parsed = JSON.parse(await readFile(join(dshHome, LANES_FILE), 'utf8'))
    if (Array.isArray(parsed?.lanes)) return { lanes: parsed.lanes, updatedAt: parsed.updatedAt ?? null }
  } catch { /* 不存在或损坏按未配置处理 */ }
  return { lanes: [], updatedAt: null }
}

/** 写入两路配置（原子写：先写临时文件再改名）。 */
export async function writeLanesFile(dshHome, lanes) {
  await mkdir(dshHome, { recursive: true })
  const path = join(dshHome, LANES_FILE)
  const temporary = `${path}.tmp`
  const payload = JSON.stringify({ version: 1, lanes, updatedAt: new Date().toISOString() }, null, 2)
  await writeFile(temporary, `${payload}\n`, 'utf8')
  await (await import('node:fs/promises')).rename(temporary, path)
  return { path, lanes }
}

/**
 * 校验两路配置（路由引用形态）。
 *
 * 硬规则与 validateLanes 一致：恰好两路、字段非空、身份三元组两两不同。
 * 引用形态额外核对：路由已声明、模型在路由的模型表里（不匹配只警告，
 * 因为部分网关接受未列出的模型名）、凭据文档里有对应密钥。
 *
 * @returns {string[]} 问题列表；空列表 = 可以运行。
 */
export function validateSavedLanes(lanes, providers, refs = {}) {
  const issues = []
  if (!Array.isArray(lanes) || lanes.length !== 2) {
    issues.push('需要恰好两路配置')
    return issues
  }
  const identities = []
  lanes.forEach((lane, index) => {
    const label = `第 ${index + 1} 路`
    if (typeof lane?.route !== 'string' || lane.route.trim() === '') {
      issues.push(`${label} 未选择路由`)
      return
    }
    if (typeof lane?.model !== 'string' || lane.model.trim() === '') {
      issues.push(`${label} 未填写模型`)
      return
    }
    const provider = providers[lane.route]
    if (provider === undefined) {
      issues.push(`${label} 的路由 "${lane.route}" 尚未在 API 页声明`)
      return
    }
    const modelIds = (provider.models ?? []).map((model) => model.id ?? String(model))
    if (modelIds.length > 0 && !modelIds.includes(lane.model)) {
      issues.push(`${label} 的模型 "${lane.model}" 不在路由 ${lane.route} 的模型表（${modelIds.join(', ')}）—— 若网关接受未列出的模型名可忽略此警告`)
    }
    const keyEnv = provider.apiKeyEnv
    if (typeof keyEnv === 'string' && keyEnv !== '' && refs[keyEnv] === undefined) {
      issues.push(`${label} 的密钥缺失：凭据文档里没有 ${keyEnv} 的值（在 API 页补填 apiKey，或 export ${keyEnv}=...）`)
    }
    identities.push([lane.route, lane.model, lane.version ?? '1'].join('/'))
  })
  if (identities.length === 2 && identities[0] === identities[1]) {
    issues.push(`两路的 provider/model/version 必须不同（当前均为 ${identities[0]}）—— 发布门要求两个独立身份`)
  }
  return issues
}

/**
 * 把路由引用补全为可执行的 lane 事实。
 *
 * @param input.lanes 保存的两路配置（route/model/version/reasoningEffort）
 * @param input.providers profile patch 里的 providers 表
 * @param input.refs 凭据文档的 refs 段（环境变量名 → 值）
 * @returns {{ lanes: object[], issues: string[] }} issues 为空时才应运行。
 */
export function resolveSavedLanes({ lanes, providers, refs = {} }) {
  const issues = validateSavedLanes(lanes, providers, refs)
  const resolved = []
  for (const lane of lanes ?? []) {
    const provider = providers[lane?.route]
    if (provider === undefined) continue
    const keyEnv = typeof provider.apiKeyEnv === 'string' && provider.apiKeyEnv !== '' ? provider.apiKeyEnv : undefined
    resolved.push({
      provider: lane.route,
      model: lane.model,
      version: lane.version ?? '1',
      ...(lane.reasoningEffort === undefined ? {} : { reasoningEffort: lane.reasoningEffort }),
      api: provider.api,
      ...(provider.baseURL === undefined ? {} : { baseURL: provider.baseURL }),
      models: [lane.model],
      // credentialEnv = 路由声明的环境变量名；apiKey 从凭据文档取，
      // 以环境变量注入 lane 进程，不落任何文件。
      ...(keyEnv === undefined ? {} : { credentialEnv: keyEnv }),
      ...(keyEnv !== undefined && refs[keyEnv] !== undefined ? { apiKey: refs[keyEnv] } : {}),
    })
  }
  return { lanes: resolved, issues }
}
