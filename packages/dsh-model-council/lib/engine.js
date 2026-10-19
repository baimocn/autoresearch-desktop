/**
 * 议事引擎 —— 会话、逐位发言、裁决。
 *
 * ## 一次发言是无状态的
 *
 * 每一路都是独立的一次 HTTP 对话请求，**没有会话记忆**。所以每次发言都把
 * 「议题 + 至今全部议事记录」整段带上。这不是浪费 token，是正确性要求：
 * 只给增量的话，后发言者看不到先发言者的论据，对抗就退化成各说各话。
 *
 * ## 长任务不能在路由里同步跑
 *
 * 一轮议事 = 成员数 × 单次模型延迟。6 位成员、每位 20 秒就是两分钟，远超
 * HTTP 路由的合理时限。所以「开一轮」只负责**启动**，立刻返回；页面轮询
 * 会话状态读进度。运行状态存在内存里，每次改动落盘 —— 进程重启后历史
 * 还在，但**不会**假装那次运行还在继续（重启即中断，如实标为 idle）。
 *
 * ## 失败如实记录，不静默跳过
 *
 * 某一路鉴权失败或超时，会在议事记录里留一条明确的错误条目，而不是跳过。
 * 一个「少了一路但看起来完整」的议会，会让裁决者基于残缺信息定夺 ——
 * 那比直接失败更危险。
 *
 * @module dsh-model-council/lib/engine
 */

import { readdir, readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { TIERS } from './roles.js'
import { buildSystemPrompt, buildUserPrompt } from './roles.js'
import { chatOnce } from './protocols.js'
import { councilSessionsDir } from './config.js'

/** 内存中的会话表。进程生命周期内有效；落盘用于重启后读回历史。 */
const sessions = new Map()

/** 正在跑的会话 id → { kind, startedAt }。防止同一会话并发跑两轮。 */
const running = new Map()

/** 是否已从磁盘装载过（避免每次请求都扫目录）。 */
let loadedFrom = null

export function isRunning(id) {
  return running.has(id)
}

function sessionPath(home, id) {
  return join(councilSessionsDir(home), `${id}.json`)
}

async function persist(home, session) {
  const dir = councilSessionsDir(home)
  await mkdir(dir, { recursive: true })
  const path = sessionPath(home, session.id)
  const temporary = `${path}.${process.pid}.tmp`
  session.updatedAt = new Date().toISOString()
  await writeFile(temporary, `${JSON.stringify(session, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
}

/** 从磁盘装载全部会话（只装一次；进程重启后调用）。 */
export async function loadSessions(home) {
  if (loadedFrom === home) return
  loadedFrom = home
  let names = []
  try {
    names = await readdir(councilSessionsDir(home))
  } catch {
    return
  }
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    try {
      const parsed = JSON.parse(await readFile(join(councilSessionsDir(home), name), 'utf8'))
      if (parsed !== null && typeof parsed === 'object' && typeof parsed.id === 'string') {
        // 进程重启 = 上次运行已中断。不假装它还在跑。
        // 同时补齐早期版本没有的字段（options/context），否则读取路径要到处判空。
        sessions.set(parsed.id, {
          ...parsed,
          context: typeof parsed.context === 'string' ? parsed.context : '',
          options: Array.isArray(parsed.options) ? parsed.options : [],
          status: 'idle',
          current: null,
          lastError: parsed.status === 'running' ? '上一次运行在进程重启时中断' : (parsed.lastError ?? null),
        })
      }
    } catch {
      // 单个会话文件损坏不该拖垮整个列表；跳过并在列表中不出现。
    }
  }
}

/** 会话摘要列表（不含完整议事记录，供选择器用）。 */
export function listSessions() {
  return [...sessions.values()]
    .map((session) => ({
      id: session.id,
      topic: session.topic,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      rounds: session.rounds,
      entries: session.transcript.length,
      status: isRunning(session.id) ? 'running' : session.status,
      hasRuling: session.ruling !== null,
      members: session.participants.length,
    }))
    .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))
}

export function getSession(id) {
  return sessions.get(id) ?? null
}

/** 创建会话：把当时的议会名单**快照**进去 —— 之后改配置不影响已开的会。 */
export async function createSession(home, { topic, participants, options, context }) {
  const id = `c-${Date.now().toString(36)}-${randomUUID().slice(0, 8)}`
  const now = new Date().toISOString()
  const session = {
    id,
    createdAt: now,
    updatedAt: now,
    topic,
    // 本轮上下文：会话走到这个决策点时的真实处境（由调用方注入）。
    context: typeof context === 'string' ? context : '',
    // 候选选项：非空即「选项裁定」形态（议会替人工在方案间挑一个）。
    options: Array.isArray(options) ? options.map((item) => String(item)) : [],
    participants: participants.map((item) => ({ ...item })),
    transcript: [],
    rounds: 0,
    ruling: null,
    status: 'idle',
    current: null,
    lastError: null,
  }
  sessions.set(id, session)
  await persist(home, session)
  return session
}

/**
 * 从裁定正文里解析出被选中的候选选项。
 *
 * 靠**格式约定**：裁决者被要求首行输出 `选定：<选项原文>`。解析不出来就返回
 * `null` —— 绝不猜、绝不用「最像的那个」顶替。一个假的 chosen 会让无人监管
 * 的会话基于错误的选择继续往下走，比「没解析出来，请读裁定原文」危险得多。
 */
export function parseChosen(text, options) {
  if (!Array.isArray(options) || options.length === 0) return null
  const line = String(text ?? '').split(/\r?\n/).find((item) => /^\s*选定\s*[:：]/.test(item))
  if (line === undefined) return null
  const raw = line.replace(/^\s*选定\s*[:：]\s*/, '').trim()
    .replace(/^[「『"'（(]+/, '').replace(/[」』"'）)]+$/, '').trim()
  if (raw === '') return null

  const normalized = options.map((item) => ({ raw: item, text: String(item).trim() }))
  const exact = normalized.find((item) => item.text === raw)
  if (exact !== undefined) return exact.raw
  // 模型常把长选项截短或加解释；前缀匹配是安全的（不会把 A 认成 B）。
  const prefix = normalized.find((item) => item.text.startsWith(raw) || raw.startsWith(item.text))
  return prefix === undefined ? null : prefix.raw
}

export async function deleteSession(home, id) {
  if (running.has(id)) throw new Error('该会话正在运行，先等它结束再删除')
  sessions.delete(id)
  await rm(sessionPath(home, id), { force: true })
  return { deleted: id }
}

let seqCounter = 0
function nextSeq(session) {
  seqCounter = Math.max(seqCounter, session.transcript.length)
  seqCounter += 1
  return seqCounter
}

async function append(home, session, entry) {
  session.transcript.push({ seq: nextSeq(session), at: new Date().toISOString(), ...entry })
  await persist(home, session)
}

/** 主持人（用户）插入一条发言。运行中也可插入 —— 它能影响后续发言者。 */
export async function appendUserMessage(home, id, text) {
  const session = sessions.get(id)
  if (session === undefined) throw new Error(`会话不存在：${id}`)
  const trimmed = String(text ?? '').trim()
  if (trimmed === '') throw new Error('发言内容不能为空')
  await append(home, session, { kind: 'user', speakerName: '主持人', text: trimmed })
  return session
}

/** 议会中「开一轮」要发言的成员，按身份顺序（议员 → 对抗者）。 */
export function roundSpeakers(participants) {
  return participants
    .map((participant, index) => ({ participant, index }))
    .filter(({ participant }) => TIERS[participant.tier]?.speaksInRound === true)
    .sort((a, b) => {
      const order = (TIERS[a.participant.tier]?.order ?? 99) - (TIERS[b.participant.tier]?.order ?? 99)
      return order !== 0 ? order : a.index - b.index
    })
    .map(({ participant }) => participant)
}

/** 让一位成员发言，把结果（或错误）写进议事记录。 */
async function speak(home, session, participant, { kind, resolveKeyFn }) {
  session.current = { participantId: participant.id, name: participant.name, tier: participant.tier, kind }
  await persist(home, session)

  const apiKey = await resolveKeyFn(participant)
  if (apiKey === null) {
    session.current = null
    await append(home, session, {
      kind: 'error',
      speakerId: participant.id,
      speakerName: participant.name,
      tier: participant.tier,
      model: participant.model,
      text: `未配置密钥（引用 ${participant.keyRef}）：请在配置页填写该路的密钥`,
    })
    return { ok: false, error: 'missing-credential' }
  }

  const startedAt = Date.now()
  const result = await chatOnce(participant, {
    system: buildSystemPrompt(participant.tier),
    user: buildUserPrompt({
      tier: participant.tier,
      topic: session.topic,
      transcript: session.transcript,
      options: session.options,
      context: session.context,
    }),
    maxTokens: participant.maxTokens,
    timeoutMs: participant.timeoutMs,
    apiKey,
  })
  const elapsedMs = Date.now() - startedAt
  session.current = null

  if (!result.ok) {
    await append(home, session, {
      kind: 'error',
      speakerId: participant.id,
      speakerName: participant.name,
      tier: participant.tier,
      model: participant.model,
      text: `${result.error}${result.url === undefined ? '' : `（${result.url}）`}`,
      elapsedMs,
    })
    return { ok: false, error: result.error }
  }

  const entry = {
    kind: kind === 'ruling' ? 'ruling' : 'speech',
    speakerId: participant.id,
    speakerName: participant.name,
    tier: participant.tier,
    model: participant.model,
    text: result.text,
    elapsedMs,
    url: result.url,
  }
  await append(home, session, entry)
  if (entry.kind === 'ruling') {
    // chosen 只在有候选选项时有意义；解析不出来就如实为 null，不猜。
    const chosen = parseChosen(entry.text, session.options)
    session.ruling = { seq: entry.seq, text: entry.text, at: entry.at, chosen }
    entry.chosen = chosen
  }
  return { ok: true, entry }
}

/**
 * 启动一轮议事（不等待完成）。
 *
 * @returns {{ started: boolean, speakers: string[], reason?: string }}
 */
export function startRound(home, id, { resolveKeyFn }) {
  const session = sessions.get(id)
  if (session === undefined) throw new Error(`会话不存在：${id}`)
  if (running.has(id)) return { started: false, reason: '该会话正在运行' }

  const speakers = roundSpeakers(session.participants)
  if (speakers.length === 0) return { started: false, reason: '没有可发言的成员（裁决者只在裁定时发言）' }

  running.set(id, { kind: 'round', startedAt: new Date().toISOString() })
  session.status = 'running'
  session.lastError = null

  void (async () => {
    let failure = null
    try {
      for (const participant of speakers) {
        await speak(home, session, participant, { kind: 'speech', resolveKeyFn })
      }
      session.rounds += 1
    } catch (error) {
      failure = error
    } finally {
      // 顺序要紧：**先清运行标记，再落状态**。反过来的话，轮询者可能看到
      // status=idle 而 running 里还有这个 id，于是立刻 startRuling 被
      // 「该会话正在运行」拒掉 —— 一轮白跑。消融测试实测撞到过这个竞态。
      session.current = null
      running.delete(id)
      session.status = failure === null ? 'idle' : 'error'
      session.lastError = failure === null ? null : String(failure?.message ?? failure)
      await persist(home, session).catch(() => { /* 落盘失败不掩盖已完成的结果 */ })
    }
  })()

  return { started: true, speakers: speakers.map((item) => item.name) }
}

/** 让裁决者作出裁定（不等待完成）。可多次调用 —— 每轮之后的裁定会覆盖上一次。 */
export function startRuling(home, id, { resolveKeyFn }) {
  const session = sessions.get(id)
  if (session === undefined) throw new Error(`会话不存在：${id}`)
  if (running.has(id)) return { started: false, reason: '该会话正在运行' }

  const adjudicators = session.participants.filter((item) => item.tier === 'adjudicator')
  if (adjudicators.length !== 1) {
    return { started: false, reason: `裁决者必须恰好 1 位（当前 ${adjudicators.length} 位）` }
  }
  if (session.transcript.length === 0) {
    return { started: false, reason: '还没有任何发言，先开一轮再裁定' }
  }

  running.set(id, { kind: 'ruling', startedAt: new Date().toISOString() })
  session.status = 'running'
  session.lastError = null

  void (async () => {
    let failure = null
    try {
      await speak(home, session, adjudicators[0], { kind: 'ruling', resolveKeyFn })
    } catch (error) {
      failure = error
    } finally {
      // 同 startRound：先清运行标记再落状态，避免轮询者看到不一致的中间态。
      session.current = null
      running.delete(id)
      session.status = failure === null ? 'idle' : 'error'
      session.lastError = failure === null ? null : String(failure?.message ?? failure)
      await persist(home, session).catch(() => { /* 同上 */ })
    }
  })()

  return { started: true, speakers: [adjudicators[0].name] }
}

/** 测试与路由共用的重置钩子（清内存态，不删盘）。 */
export function resetSessions() {
  sessions.clear()
  running.clear()
  loadedFrom = null
  seqCounter = 0
}
