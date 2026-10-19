/**
 * dsh-model-council —— 模型议会（独立工作台，宿主半边）。
 *
 * 与 AutoResearch 工作台**完全独立**：独立面板、独立路由前缀、独立配置文件、
 * 独立会话留痕。它不读任务目录，也不参与任何门禁 —— 它是决策辅助工具，
 * 不是流程的一环。
 *
 * 三身份分层（议员 / 对抗者 / 裁决者）与举证义务见 lib/roles.js；
 * 每路独立的 URL / 协议 / 模型由 lib/protocols.js 直连；密钥复用平台凭据文档。
 *
 * @module dsh-model-council
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { listModels } from './lib/protocols.js'
import {
  readCouncilConfig, saveCouncil, keyPresence, resolveKey, resolveHome,
  credentialsPathOf, DEFAULT_CONFIG,
} from './lib/config.js'
import { TIERS, TIER_IDS } from './lib/roles.js'
import { SUPPORTED_PROTOCOLS } from './lib/protocols.js'
import {
  loadSessions, listSessions, getSession, createSession, deleteSession,
  appendUserMessage, startRound, startRuling, isRunning,
} from './lib/engine.js'
import { installCouncilMode, LEVEL_LABEL, LEVEL_OF_COMMAND, HIGH_RISK_TOOLS } from './lib/mode.js'

export const name = 'model-council'

/**
 * `tools` / `systemPrompt` / `sessionProjections` 是议会模式与两个工具的前提；
 * `connection` 是面板路由的前提。四个都是核心服务（dsh-autoresearch 同样依赖）。
 * `commands` **刻意不在这里** —— 用 `ctx.inject(['commands'], …)` 可选注入，
 * 否则缺少 commands 服务时整个插件（含面板）会一起失活。
 */
export const inject = ['connection', 'tools', 'systemPrompt', 'sessionProjections']

const API_PREFIX = '/api/model-council'

function jsonResponse(body, status = 200) {
  return Response.json(body, { status, headers: { 'cache-control': 'no-store' } })
}

function errorResponse(message, status = 400) {
  return jsonResponse({ error: message }, status)
}

async function readBody(request) {
  try {
    return await request.json()
  } catch {
    return null
  }
}

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULT_CONFIG, ...(rawConfig ?? {}) }
  const home = () => resolveHome(config.dshHome)

  const resolveKeyFn = (participant) => resolveKey(home(), participant)

  /**
   * 议会模式的句柄。**在路由之前声明**：路由的处理函数在请求时才执行，
   * 那时它已经有值；而配置路由回显 `mode.ready` 就成了「apply() 跑到底」的
   * 真实证据 —— 只注册了路由、模式装配中途抛错的话，这里仍是 null。
   */
  let modeApi = null

  // ── 路由：议会配置（参与者名单） ──────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/config`,
    methods: ['GET', 'POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const base = home()
      if (request.method === 'POST') {
        const body = await readBody(request)
        if (body === null) return errorResponse('请求体不是合法 JSON', 400)
        try {
          const { config: saved, keyRefs } = await saveCouncil(base, body?.participants ?? [])
          return jsonResponse({
            saved: true,
            participants: saved.participants,
            keyRefs,
            keyPresence: await keyPresence(base, saved.participants),
          })
        } catch (error) {
          return jsonResponse({ error: error.message, problems: error.problems ?? [] }, 400)
        }
      }

      let stored
      try {
        stored = await readCouncilConfig(base)
      } catch (error) {
        return errorResponse(error.message, 500)
      }
      return jsonResponse({
        participants: stored.participants,
        updatedAt: stored.updatedAt,
        keyPresence: await keyPresence(base, stored.participants),
        credentialsPath: credentialsPathOf(base),
        protocols: SUPPORTED_PROTOCOLS,
        tiers: TIER_IDS.map((id) => ({ id, label: TIERS[id].label, order: TIERS[id].order })),
        // 议会模式是否就绪（含三个命令）。它只有 installCouncilMode 跑完才有值，
        // 所以这里同时是给用户看的说明与「插件装配完整」的自证。
        mode: {
          ready: modeApi !== null,
          levels: Object.entries(LEVEL_LABEL).map(([id, label]) => ({ id, label })),
          commands: Object.entries(LEVEL_OF_COMMAND).map(([name, level]) => ({ name, level })),
          highRiskTools: HIGH_RISK_TOOLS,
        },
        note: '每路可独立设置地址、协议与模型；密钥写进凭据文档（本页只显示有值/无值，不回显本体）。',
      })
    },
  }), 'model-council: config route')

  // ── 路由：探测模型列表 ────────────────────────────────────────────────────
  //
  // 模型 id 不靠手打：先探测端点拿到列表再选。密钥可取「本次填的」或
  // 「已存凭据的」—— 编辑已有参与者时页面上不回显密钥，所以必须支持按引用读。

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/probe`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      if (body === null) return errorResponse('请求体不是合法 JSON', 400)

      const base = home()
      let apiKey = typeof body.apiKey === 'string' && body.apiKey.trim() !== '' ? body.apiKey.trim() : null
      if (apiKey === null && typeof body.keyRef === 'string' && body.keyRef.trim() !== '') {
        apiKey = await resolveKey(base, { keyRef: body.keyRef.trim() })
      }

      const result = await listModels({
        api: body.api,
        baseURL: body.baseURL,
        apiKey,
        headers: body.headers,
      }, { timeoutMs: body.timeoutMs })

      return jsonResponse({
        ok: result.ok === true,
        models: result.models ?? [],
        url: result.url ?? null,
        status: result.status ?? null,
        error: result.error ?? null,
        raw: result.raw ?? null,
        usedStoredKey: apiKey !== null && (body.apiKey === undefined || body.apiKey === ''),
      })
    },
  }), 'model-council: probe route')

  // ── 路由：会话列表 ───────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/sessions`,
    methods: ['GET'],
    requestBody: 'buffered',
    async fetch() {
      await loadSessions(home())
      return jsonResponse({ sessions: listSessions() })
    },
  }), 'model-council: sessions route')

  // ── 路由：单个会话（读 / 建 / 删） ────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/session`,
    methods: ['GET', 'POST', 'DELETE'],
    requestBody: 'buffered',
    async fetch(request) {
      const base = home()
      await loadSessions(base)
      const url = new URL(request.url)

      if (request.method === 'POST') {
        const body = await readBody(request)
        if (body === null) return errorResponse('请求体不是合法 JSON', 400)
        const topic = typeof body.topic === 'string' ? body.topic.trim() : ''
        if (topic === '') return errorResponse('议题不能为空', 400)

        let stored
        try {
          stored = await readCouncilConfig(base)
        } catch (error) {
          return errorResponse(error.message, 500)
        }
        if (stored.participants.length < 3) {
          return errorResponse('议会成员不足（至少 议员 + 对抗者 + 裁决者），先到配置页配好', 400)
        }
        const session = await createSession(base, { topic, participants: stored.participants })
        return jsonResponse({ created: session.id, session })
      }

      const id = url.searchParams.get('id')
      if (id === null || id === '') return errorResponse('缺少 id 参数', 400)

      if (request.method === 'DELETE') {
        try {
          return jsonResponse(await deleteSession(base, id))
        } catch (error) {
          return errorResponse(error.message, 409)
        }
      }

      const session = getSession(id)
      if (session === null) return errorResponse(`会话不存在：${id}`, 404)
      return jsonResponse({
        session: { ...session, running: isRunning(id), current: session.current ?? null },
      })
    },
  }), 'model-council: session route')

  // ── 路由：主持人发言 ─────────────────────────────────────────────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/session/say`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      if (body === null) return errorResponse('请求体不是合法 JSON', 400)
      try {
        const session = await appendUserMessage(home(), body.id, body.text)
        return jsonResponse({ ok: true, entries: session.transcript.length })
      } catch (error) {
        return errorResponse(error.message, 400)
      }
    },
  }), 'model-council: say route')

  // ── 路由：开一轮 / 请裁决者裁定（启动即返回，页面轮询进度） ───────────────

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/session/round`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      if (body === null) return errorResponse('请求体不是合法 JSON', 400)
      try {
        await loadSessions(home())
        const result = startRound(home(), body.id, { resolveKeyFn })
        return jsonResponse(result, result.started ? 200 : 409)
      } catch (error) {
        return errorResponse(error.message, 400)
      }
    },
  }), 'model-council: round route')

  ctx.effect(() => ctx.connection.fetch.register({
    path: `${API_PREFIX}/session/ruling`,
    methods: ['POST'],
    requestBody: 'buffered',
    async fetch(request) {
      const body = await readBody(request)
      if (body === null) return errorResponse('请求体不是合法 JSON', 400)
      try {
        await loadSessions(home())
        const result = startRuling(home(), body.id, { resolveKeyFn })
        return jsonResponse(result, result.started ? 200 : 409)
      } catch (error) {
        return errorResponse(error.message, 400)
      }
    },
  }), 'model-council: ruling route')

  // ── 议会模式：把议会接入正在跑的普通会话 ───────────────────────────────────
  //
  // 模式本身（投影 / 政策章节 / 三个命令 / 强制式的 restrict+guard）都在
  // lib/mode.js。这里只负责装配，以及注册两个工具。

  const mode = installCouncilMode(ctx, { config, logger: ctx.logger })
  modeApi = mode

  const DEFAULT_WAIT_MS = 300_000
  const MAX_WAIT_MS = 900_000

  function clampInt(value, min, max, fallback) {
    if (!Number.isFinite(value)) return fallback
    return Math.min(max, Math.max(min, Math.floor(value)))
  }

  /** 等到会话空闲或超期。返回是否已空闲。 */
  async function waitUntilIdle(id, deadline) {
    while (Date.now() < deadline) {
      if (!isRunning(id)) return true
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    return false
  }

  function clip(text, limit = 6000) {
    const value = String(text ?? '')
    return value.length > limit ? `${value.slice(0, limit)}\n…（已截断，完整记录见议会面板）` : value
  }

  function renderConveneReport(session, running) {
    const lines = [`议会会话 ${session.id}｜议题：${session.topic}`]
    if (session.options.length > 0) lines.push(`候选选项：${session.options.join(' / ')}`)
    lines.push(`状态：${running ? '仍在进行' : session.status}｜已完成 ${session.rounds} 轮｜${session.transcript.length} 条发言`)

    const errors = session.transcript.filter((entry) => entry.kind === 'error')
    if (errors.length > 0) {
      lines.push(`失败的路（如实列出，未静默跳过）：${errors.map((entry) => `${entry.speakerName}: ${entry.text}`).join('；')}`)
    }

    if (running) {
      lines.push('', '议会仍在进行 —— 用 council_read 带同一个 sessionId 继续等待。')
    } else if (session.ruling != null) {
      if (session.options.length > 0) {
        lines.push('', session.ruling.chosen == null
          ? '**议会未能解析出选定项**（裁定未按「选定：<选项>」格式给出）—— 请读下方裁定原文自行判断，不要猜。'
          : `**议会选定：${session.ruling.chosen}**`)
      }
      lines.push('', '## 裁定原文', '', clip(session.ruling.text))
    } else {
      lines.push('', '尚未产出裁定（可能所有路都失败，或时间预算用完）。')
    }
    lines.push('', '议会是决策辅助，不等于实测证据 —— 它替你做选择，不为结果背书。')
    return lines.join('\n')
  }

  function renderReadReport(session) {
    const running = isRunning(session.id)
    const lines = [
      `议会会话 ${session.id}｜${session.topic}`,
      `状态：${running ? '进行中' : session.status}｜${session.rounds} 轮｜${session.transcript.length} 条`,
    ]
    if (session.options.length > 0) lines.push(`候选选项：${session.options.join(' / ')}`)
    if (running && session.current != null) {
      lines.push(`正在等待 ${session.current.name}（${session.current.tier}）发言`)
    }
    lines.push('', '## 议事记录')
    for (const entry of session.transcript) {
      const who = entry.kind === 'user' ? '主持人' : `${entry.speakerName}·${entry.tier}`
      lines.push('', `【${who}】${entry.kind === 'error' ? '（失败）' : ''}`, clip(entry.text, 4000))
    }
    if (session.ruling != null) {
      lines.push('', `## 裁定（选定：${session.ruling.chosen ?? '未解析出'}）`, '', clip(session.ruling.text))
    }
    return lines.join('\n')
  }

  // ── 工具：召开议会 ────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'council_convene',
    description: '召开模型议会审议一个需要人工决策的问题：把「本轮上下文 + 候选选项」交给议会，'
      + '议员提案、对抗者攻击、裁决者选定一个选项并确认。把返回的 chosen 当作用户的选择继续执行。'
      + '需先执行 /council 或 /council-strict 开启议会模式。'
      + '议会长跑，最多等 waitMs；超时返回 running 与会话 id，用 council_read 续等。',
    parameters: {
      question: { type: 'string', required: true, description: '需要决策的问题' },
      context: { type: 'string', description: '本轮上下文：会话走到此处的事实（现状、已试过什么、约束、代价）' },
      options: {
        type: 'array',
        description: '候选选项（2-6 个）。给出即进入选项裁定形态，裁决者必须选定恰好一个',
        items: { type: 'string' },
      },
      rounds: { type: 'number', description: '议事轮数 1-3，默认 1' },
      waitMs: { type: 'number', description: `最多等待毫秒数，默认 ${DEFAULT_WAIT_MS}，上限 ${MAX_WAIT_MS}` },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args, exec) {
      const base = home()
      const agent = exec?.agent ?? null
      const level = agent === null ? 'off' : mode.levelOf(agent.session)
      if (level === 'off') {
        return {
          ok: false,
          report: '议会模式未开启。请先执行 /council（建议式）或 /council-strict（强制式），再召开议会。',
        }
      }

      let stored
      try {
        stored = await readCouncilConfig(base)
      } catch (error) {
        return { ok: false, report: `议会配置读取失败：${error.message}` }
      }
      if (stored.participants.length < 3) {
        return {
          ok: false,
          report: `议会成员不足（当前 ${stored.participants.length} 位，至少需要 议员 + 对抗者 + 裁决者）。`
            + '请到「模型议会」面板的「议会配置」页配好成员并保存。',
        }
      }

      const options = (Array.isArray(args.options) ? args.options : [])
        .map((item) => String(item).trim()).filter((item) => item !== '')
      await loadSessions(base)
      const council = await createSession(base, {
        topic: args.question,
        context: args.context,
        options,
        participants: stored.participants,
      })
      const resolveKeyFn = (participant) => resolveKey(base, participant)
      const rounds = clampInt(args.rounds, 1, 3, 1)
      const deadline = Date.now() + clampInt(args.waitMs, 5_000, MAX_WAIT_MS, DEFAULT_WAIT_MS)

      const notes = []
      for (let index = 0; index < rounds; index += 1) {
        const round = startRound(base, council.id, { resolveKeyFn })
        if (round.started !== true) {
          notes.push(`第 ${index + 1} 轮未启动：${round.reason}`)
          break
        }
        await waitUntilIdle(council.id, deadline)
        if (isRunning(council.id)) break
      }

      if (!isRunning(council.id) && getSession(council.id)?.ruling == null) {
        const ruling = startRuling(base, council.id, { resolveKeyFn })
        if (ruling.started !== true) notes.push(`裁定未启动：${ruling.reason}`)
        else await waitUntilIdle(council.id, deadline)
      }

      const current = getSession(council.id)
      const running = isRunning(council.id)
      // 强制式：拿到裁定即放行高风险工具（但「不许问用户」的重定向保留）。
      if (!running && current?.ruling != null && level === 'strict' && agent !== null) {
        await mode.releaseHighRisk(agent)
        notes.push('已取得裁定，高风险工具已放行。')
      }

      return {
        ok: current?.ruling != null,
        sessionId: current?.id ?? council.id,
        status: running ? 'running' : (current?.status ?? 'unknown'),
        chosen: current?.ruling?.chosen ?? null,
        ruling: current?.ruling?.text ?? null,
        notes,
        report: renderConveneReport(current ?? council, running),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `召开议会：${args.question}`, kind: 'other' }),
  }))

  // ── 工具：读取议事记录（轮询 + 留痕） ─────────────────────────────────────

  ctx.tools.register(defineTool({
    name: 'council_read',
    description: '读取一场议会会话的状态与完整议事记录：既是等待进行中的议会的轮询手段，也是回看某次裁定的留痕。',
    parameters: {
      sessionId: { type: 'string', required: true, description: 'council_convene 返回的会话 id' },
      waitMs: { type: 'number', description: '若仍在进行，最多再等多少毫秒；默认 0（立即返回）' },
    },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: value.report }],
    },
    async execute(args) {
      const base = home()
      await loadSessions(base)
      const session = getSession(args.sessionId)
      if (session === null) return { ok: false, report: `会话不存在：${args.sessionId}` }

      const wait = clampInt(args.waitMs, 0, MAX_WAIT_MS, 0)
      if (wait > 0 && isRunning(session.id)) await waitUntilIdle(session.id, Date.now() + wait)

      return {
        ok: true,
        sessionId: session.id,
        status: isRunning(session.id) ? 'running' : session.status,
        chosen: session.ruling?.chosen ?? null,
        report: renderReadReport(session),
      }
    },
    presentCall: (args) => ({ card: 'generic', title: `读取议会 ${args.sessionId}`, kind: 'read' }),
  }))

  ctx.logger?.info?.('model-council: routes registered')
}
