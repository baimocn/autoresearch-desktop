/**
 * 议会配置的读写、校验与密钥分层。
 *
 * ## 配置存哪
 *
 *   $DSH_HOME/model-council.json          参与者名单（含各自 URL / 协议 / 模型）
 *   $DSH_HOME/.credentials.yaml 的 refs 段  各路的密钥本体
 *
 * 密钥**不写进议会配置文件**：那份 JSON 会被页面完整回显给用户核对配置，
 * 一旦密钥在里面，它就随每次读取进入浏览器内存与 devtools。凭据文档是
 * 平台既有的密钥分层，复用它是唯一正确的落点 —— 配置里只留引用名。
 *
 * （用户明确允许密钥在其本机明文保存；凭据文档本身就是明文 YAML，
 *   所以这里没有增加暴露面，只是把密钥放回它该在的地方。）
 *
 * @module dsh-model-council/lib/config
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { readJsonDoc } from 'dsh-autoresearch/lib/session-tasks.js'
import {
  SUPPORTED_PROTOCOLS, readCredentialRefs, writeCredentialRefs,
} from 'dsh-autoresearch-api/lib/providers.js'
import { TIER_IDS, isTierId, validateTierComposition } from './roles.js'

export const DEFAULT_PARTICIPANT = Object.freeze({
  maxTokens: 1200,
  timeoutMs: 300_000,
})

export const DEFAULT_CONFIG = Object.freeze({
  version: 1,
  participants: [],
  defaults: { maxRounds: 3 },
})

/** 议会配置文件的绝对路径。 */
export function councilConfigPath(home) {
  return join(home, 'model-council.json')
}

/** 议事会话留痕目录。 */
export function councilSessionsDir(home) {
  return join(home, 'model-council-sessions')
}

/** 凭据文档路径（与 API 配置页同一份）。 */
export function credentialsPathOf(home) {
  return join(home, '.credentials.yaml')
}

/**
 * 由参与者 id 推导凭据引用名。
 *
 * 引用名必须是环境变量名形态（`^[A-Za-z_][A-Za-z0-9_]*$`）—— 凭据服务
 * 用它寻址，形态不对整份凭据文档会加载失败。
 */
export function credentialRefFor(id) {
  const safe = String(id ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return `COUNCIL_${safe}_API_KEY`
}

function isValidHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

/** 校验参与者名单。返回问题清单（空数组 = 合规）。写盘前调用，先拦住错误配置。 */
export function validateCouncil(participants) {
  const problems = []
  if (!Array.isArray(participants)) return ['participants 必须是数组']
  if (participants.length < 3) problems.push('议会至少需要 3 位成员（议员 + 对抗者 + 裁决者）')
  if (participants.length > 8) problems.push('议会最多 8 位成员，再多会让每位成员的举证义务被稀释')

  const seen = new Set()
  participants.forEach((item, index) => {
    const at = `第 ${index + 1} 位`
    const id = typeof item?.id === 'string' ? item.id.trim() : ''
    if (id === '') problems.push(`${at}：id 不能为空`)
    else if (seen.has(id)) problems.push(`${at}：id "${id}" 与前面重复`)
    else seen.add(id)

    if (typeof item?.name !== 'string' || item.name.trim() === '') problems.push(`${at}：名称不能为空`)
    if (!isTierId(item?.tier)) problems.push(`${at}：身份必须是 ${TIER_IDS.join(' / ')} 之一`)
    if (!SUPPORTED_PROTOCOLS.includes(item?.api)) {
      problems.push(`${at}：协议必须是 ${SUPPORTED_PROTOCOLS.join(' / ')} 之一`)
    }
    if (!isValidHttpUrl(item?.baseURL)) problems.push(`${at}：地址必须是合法的 http/https URL`)
    if (typeof item?.model !== 'string' || item.model.trim() === '') {
      problems.push(`${at}：模型未选择（先点「探测模型」拉列表再选）`)
    }
  })

  problems.push(...validateTierComposition(participants))
  return problems
}

/** 规格化一位参与者：补齐默认值、去掉空字段。 */
export function normalizeParticipant(raw, index) {
  const id = typeof raw?.id === 'string' && raw.id.trim() !== '' ? raw.id.trim() : `p${index + 1}`
  const headers = raw?.headers !== undefined && raw.headers !== null && typeof raw.headers === 'object'
    && !Array.isArray(raw.headers) && Object.keys(raw.headers).length > 0
    ? raw.headers
    : undefined
  return {
    id,
    name: typeof raw?.name === 'string' ? raw.name.trim() : '',
    tier: raw?.tier,
    api: raw?.api,
    baseURL: typeof raw?.baseURL === 'string' ? raw.baseURL.trim() : '',
    model: typeof raw?.model === 'string' ? raw.model.trim() : '',
    keyRef: credentialRefFor(id),
    ...(headers === undefined ? {} : { headers }),
    maxTokens: Number.isFinite(raw?.maxTokens) && raw.maxTokens > 0
      ? Math.floor(raw.maxTokens) : DEFAULT_PARTICIPANT.maxTokens,
    timeoutMs: Number.isFinite(raw?.timeoutMs) && raw.timeoutMs > 0
      ? Math.floor(raw.timeoutMs) : DEFAULT_PARTICIPANT.timeoutMs,
  }
}

/**
 * 读议会配置。
 *
 * 文件损坏时**隔离并抛错**，不静默回退成空配置 —— 调用方会把读到的内容
 * 整体写回，静默回退等于把用户配好的整个议会抹掉。与工作台登记表同一套
 * `readJsonDoc` 语义。
 */
export async function readCouncilConfig(home) {
  const parsed = await readJsonDoc(councilConfigPath(home), {
    isValid: (value) => value !== null && typeof value === 'object' && Array.isArray(value.participants),
  })
  if (parsed === null) return { ...DEFAULT_CONFIG, participants: [] }
  return {
    version: parsed.version ?? 1,
    updatedAt: parsed.updatedAt ?? null,
    participants: parsed.participants.map((item, index) => normalizeParticipant(item, index)),
    defaults: { ...DEFAULT_CONFIG.defaults, ...(parsed.defaults ?? {}) },
  }
}

/** 原子写配置文件。 */
export async function writeCouncilConfig(home, config) {
  const path = councilConfigPath(home)
  await mkdir(home, { recursive: true })
  const temporary = `${path}.${process.pid}.tmp`
  await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return path
}

/**
 * 保存参与者名单：先写密钥，再写配置。
 *
 * 写序是刻意的 —— 先凭据后配置，不会留下「配置里有一路、但没有密钥」的
 * 中间态；反过来则可能配置已生效而密钥还没落地，那一轮议事会以鉴权失败收场。
 *
 * @returns {{ config, keyRefs: string[] }}
 */
export async function saveCouncil(home, rawParticipants) {
  const participants = (rawParticipants ?? []).map((item, index) => normalizeParticipant(item, index))
  const problems = validateCouncil(participants)
  if (problems.length > 0) {
    const error = new Error(`议会配置不合法：${problems.join('；')}`)
    error.problems = problems
    throw error
  }

  // 密钥：只写有值的那几路；没填的保持文档原样（编辑配置时不必重打密钥）。
  const updates = {}
  const keyRefs = []
  ;(rawParticipants ?? []).forEach((raw, index) => {
    const apiKey = raw?.apiKey
    if (typeof apiKey === 'string' && apiKey.trim() !== '') {
      const ref = credentialRefFor(participants[index].id)
      updates[ref] = apiKey.trim()
      keyRefs.push(ref)
    }
  })
  if (Object.keys(updates).length > 0) {
    await writeCredentialRefs(credentialsPathOf(home), updates)
  }

  const config = {
    version: 1,
    updatedAt: new Date().toISOString(),
    participants,
    defaults: DEFAULT_CONFIG.defaults,
  }
  await writeCouncilConfig(home, config)
  return { config, keyRefs }
}

/** 读出「哪几路已有密钥」，供页面显示有值/无值 —— 不回显密钥本体。 */
export async function keyPresence(home, participants) {
  const refs = await readCredentialRefs(credentialsPathOf(home)).catch(() => ({}))
  const presence = {}
  for (const participant of participants ?? []) {
    presence[participant.id] = typeof refs[participant.keyRef] === 'string' && refs[participant.keyRef] !== ''
  }
  return presence
}

/** 解析一路的密钥本体（运行议事时用）。找不到返回 null，由调用方如实报错。 */
export async function resolveKey(home, participant) {
  const refs = await readCredentialRefs(credentialsPathOf(home)).catch(() => ({}))
  const value = refs[participant?.keyRef]
  return typeof value === 'string' && value !== '' ? value : null
}

/** 把 DSH_HOME 解析成绝对路径（与工作台、安装器同一规则）。 */
export function resolveHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
  }
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return isAbsolute(fromEnvironment) ? fromEnvironment : resolve(process.cwd(), fromEnvironment)
  }
  return join(process.cwd(), '.dsh-home')
}
