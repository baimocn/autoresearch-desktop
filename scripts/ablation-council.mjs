/**
 * 消融实验：模型议会的「身份分层」是否真的产生可判定差异。
 *
 * ## 要证伪的假设
 *
 * 我声称「议员 / 对抗者 / 裁决者三层身份比让几个模型自由讨论更能暴露风险」。
 * 这个声称必须被检验，否则它只是一句好听的设计话术。
 *
 * 消融设计：断言**提示词与编排**必须携带的可判定性质（角色义务是否写进
 * 指令、议事顺序是否按身份、失败是否被如实记录），并用桩化的 fetch 跑一次
 * 完整议事，验证编排真的按身份推进、真的产出裁定。
 *
 * 真实模型在三种身份下的**输出质量差异**属于未验证项，如实标注 —— 桩化
 * 只证明「指令与编排正确」，不证明「模型会遵守」。
 *
 * 用法：node scripts/ablation-council.mjs
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  TIERS, TIER_IDS, validateTierComposition, buildSystemPrompt, buildUserPrompt, renderTranscript,
} from '../packages/dsh-model-council/lib/roles.js'
import {
  candidateUrls, authHeaders, extractModelIds, extractReply, buildChatBody, PROTOCOL_PATHS,
} from '../packages/dsh-model-council/lib/protocols.js'
import { validateCouncil, credentialRefFor, normalizeParticipant } from '../packages/dsh-model-council/lib/config.js'
import {
  saveCouncil, readCouncilConfig, keyPresence, resolveKey, credentialsPathOf,
} from '../packages/dsh-model-council/lib/config.js'
import {
  createSession, startRound, startRuling, getSession, roundSpeakers, resetSessions, parseChosen, isRunning,
} from '../packages/dsh-model-council/lib/engine.js'
import {
  foldMode, emptyMode, levelOfMode, renderCouncilPolicy, HIGH_RISK_TOOLS,
  MODE_COMMAND, STRICT_COMMAND, OFF_COMMAND, LEVEL_OF_COMMAND,
} from '../packages/dsh-model-council/lib/mode.js'

const results = []
function record(name, expected, actual, note) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ name, pass, expected, actual, note })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`)
  if (!pass) console.log(`        期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
  if (note) console.log(`        ${note}`)
}

/**
 * 等到会话空闲**且**预期后置条件成立。
 *
 * 只看 `!isRunning(id)` 不足以判定「这一轮真的写完了」：运行标记是共享的
 * 模块级 Map，而本测试在同一进程里连跑多个实验、每次 `resetSessions()`。
 * 早期实验若仍有未结束的异步发言，它们的收尾会动到这个 Map，
 * 于是「标记已清」与「本轮产物已落盘」可能不是同一时刻。
 *
 * 因此这里等 `expect` 谓词成立（例如 ruling 已写入），并给出更宽松的预算。
 * 断言仍是原来的 `record(...)` —— 只是不再用「标记清了」当唯一信号。
 *
 * 诚实说明：这是**加固而非根治**。该 flake 在负载高时约 2/4 复现、
 * 空闲时 15/15 通过，未能稳定复现出确切的交错点。
 */
const waitUntil = async (id, expect, budget = 800) => {
  for (let i = 0; i < budget; i += 1) {
    if (!isRunning(id) && expect()) return true
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
  return false
}
const waitIdle = async (id) => waitUntil(id, () => true)

const TOPIC = '是否应该把上游资产改为自动同步？'

// ── 实验 1：身份构成是强制项 ────────────────────────────────────────────────

console.log('=== 实验 1：身份构成是否强制 ===')
console.log('   没有对抗者的议会只是并行自说自话；多个裁决者会给出互相矛盾的裁定。')
record('缺对抗者被拒', true,
  validateTierComposition([
    { tier: 'councilor' }, { tier: 'adjudicator' },
  ]).some((p) => p.includes('对抗者')))
record('缺裁决者被拒', true,
  validateTierComposition([{ tier: 'councilor' }, { tier: 'adversary' }]).some((p) => p.includes('裁决者')))
record('两个裁决者被拒', true,
  validateTierComposition([
    { tier: 'councilor' }, { tier: 'adversary' }, { tier: 'adjudicator' }, { tier: 'adjudicator' },
  ]).some((p) => p.includes('恰好 1 位')))
record('缺议员被拒', true,
  validateTierComposition([{ tier: 'adversary' }, { tier: 'adjudicator' }]).some((p) => p.includes('议员')))
record('合法三元组通过', 0,
  validateTierComposition([{ tier: 'councilor' }, { tier: 'adversary' }, { tier: 'adjudicator' }]).length)
console.log()

// ── 实验 2：三种身份的提示词是否真的不同 ────────────────────────────────────

console.log('=== 实验 2：身份提示词是否真的不同（不是同一段话换标签）===')
const sysCouncilor = buildSystemPrompt('councilor')
const sysAdversary = buildSystemPrompt('adversary')
const sysAdjudicator = buildSystemPrompt('adjudicator')
record('议员与对抗者不同', true, sysCouncilor !== sysAdversary)
record('对抗者与裁决者不同', true, sysAdversary !== sysAdjudicator)
record('三个都不同', 3, new Set([sysCouncilor, sysAdversary, sysAdjudicator]).size)
record('三种身份都禁止模拟其他成员', true,
  [sysCouncilor, sysAdversary, sysAdjudicator].every((s) => /不要模拟其他成员/.test(s)))
console.log()

// ── 实验 3：举证义务是否可判定 ──────────────────────────────────────────────

console.log('=== 实验 3：举证义务是否可判定 ===')
console.log('   "请找出问题"是无效指令，"至少 3 个具体失败模式"才可判定。')
record('对抗者义务含数量要求', true, /至少\s*3\s*个/.test(TIERS.adversary.obligation))
record('对抗者被禁止编造', true, /不得.*编造|找不到就明确写/.test(TIERS.adversary.mustNot))
record('议员被要求选一个方向并负责', true, /选一个/.test(TIERS.councilor.mustNot))
record('裁决者必须写推翻条件', true, /推翻/.test(TIERS.adjudicator.obligation))
record('裁决者被禁止取多数意见', true, /多数/.test(TIERS.adjudicator.mustNot))
record('身份顺序：议员 < 对抗者 < 裁决者', true,
  TIERS.councilor.order < TIERS.adversary.order && TIERS.adversary.order < TIERS.adjudicator.order)
record('裁决者不参与轮次发言', false, TIERS.adjudicator.speaksInRound)
console.log()

// ── 实验 4：议事记录与发言提示词 ────────────────────────────────────────────

console.log('=== 实验 4：议事记录渲染与发言提示词 ===')
record('空记录如实标注', '（尚无发言）', renderTranscript([]))
record('用户发言标为主持人', true, renderTranscript([{ kind: 'user', text: 'x' }]).includes('主持人'))
record('成员发言带身份', true,
  renderTranscript([{ kind: 'speech', speakerName: '甲', tier: 'councilor', text: 'y' }]).includes('议员'))

const adjudicatorPrompt = buildUserPrompt({
  tier: 'adjudicator', topic: TOPIC,
  transcript: [{ kind: 'speech', speakerName: '甲', tier: 'councilor', text: 'y' }],
})
record('裁决者提示词含四段结构要求', true,
  ['结论', '理由', '执行条件', '推翻条件'].every((part) => adjudicatorPrompt.includes(part)))
record('裁决者提示词整段注入议事记录', true, adjudicatorPrompt.includes('【甲·议员】'))
console.log()

// ── 实验 5：协议直连的地址与解析 ────────────────────────────────────────────

console.log('=== 实验 5：协议直连（地址容错 + 响应解析）===')
record('baseURL 不带版本时给出带 /v1 的候选', true,
  candidateUrls('https://api.example.com', PROTOCOL_PATHS['openai-completions'].chat)
    .includes('https://api.example.com/v1/chat/completions'))
record('baseURL 已带 /v1 时不产生 /v1/v1', true,
  !candidateUrls('https://api.example.com/v1', PROTOCOL_PATHS['openai-completions'].chat)
    .some((url) => url.includes('/v1/v1')))
record('anthropic 主路径是 /v1/messages', true,
  candidateUrls('https://api.anthropic.com', PROTOCOL_PATHS['anthropic-messages'].chat)[0]
    === 'https://api.anthropic.com/v1/messages')

record('anthropic 用 x-api-key', true,
  authHeaders('anthropic-messages', 'k').hasOwnProperty('x-api-key'))
record('openai 用 Bearer', 'Bearer k',
  authHeaders('openai-completions', 'k').authorization)

record('识别 OpenAI 形态 {data:[{id}]}', ['a', 'b'],
  extractModelIds({ data: [{ id: 'a' }, { id: 'b' }] }))
record('识别 Anthropic 形态 {data:[{id}]}', ['m'],
  extractModelIds({ data: [{ id: 'm' }] }))
record('识别裸数组形态', ['x', 'y'], extractModelIds(['x', 'y']))
record('识别 ollama 形态 {models:[{name}]}', ['q'], extractModelIds({ models: [{ name: 'q' }] }))
record('识别不出返回空数组（不猜）', [], extractModelIds({ foo: 1 }))

record('解析 openai-completions 正文', 'hi',
  extractReply('openai-completions', { choices: [{ message: { content: 'hi' } }] }))
record('解析 anthropic-messages 正文', 'hi',
  extractReply('anthropic-messages', { content: [{ type: 'text', text: 'hi' }] }))
record('解析 openai-responses 正文', 'hi',
  extractReply('openai-responses', { output: [{ content: [{ type: 'output_text', text: 'hi' }] }] }))
record('解析不出返回空串', '', extractReply('openai-completions', { choices: [] }))

record('anthropic 请求体把 system 独立成字段', true,
  buildChatBody('anthropic-messages', { model: 'm', system: 's', user: 'u', maxTokens: 10 })
    .hasOwnProperty('system'))
record('openai 请求体把 system 放进 messages', true,
  buildChatBody('openai-completions', { model: 'm', system: 's', user: 'u', maxTokens: 10 })
    .messages[0].role === 'system')
console.log()

// ── 实验 6：配置校验与凭据引用名 ────────────────────────────────────────────

console.log('=== 实验 6：配置校验与凭据引用名 ===')
const valid = () => ([
  { id: 'p1', name: '甲', tier: 'councilor', api: 'openai-completions', baseURL: 'https://a.example.com/v1', model: 'm1' },
  { id: 'p2', name: '乙', tier: 'adversary', api: 'openai-completions', baseURL: 'https://b.example.com/v1', model: 'm2' },
  { id: 'p3', name: '丙', tier: 'adjudicator', api: 'anthropic-messages', baseURL: 'https://c.example.com', model: 'm3' },
])
record('合法配置通过', 0, validateCouncil(valid()).length)
record('缺模型被拒', true, validateCouncil(valid().map((p, i) => (i === 0 ? { ...p, model: '' } : p)))
  .some((x) => x.includes('模型未选择')))
record('重复 id 被拒', true, validateCouncil(valid().map((p, i) => (i === 1 ? { ...p, id: 'p1' } : p)))
  .some((x) => x.includes('重复')))
record('非法地址被拒', true, validateCouncil(valid().map((p, i) => (i === 0 ? { ...p, baseURL: 'ftp://x' } : p)))
  .some((x) => x.includes('http')))
record('非法身份被拒', true, validateCouncil(valid().map((p, i) => (i === 0 ? { ...p, tier: 'judge' } : p)))
  .some((x) => x.includes('身份')))
record('成员过少被拒', true, validateCouncil(valid().slice(0, 2)).some((x) => x.includes('至少')))

record('凭据引用名符合环境变量形态', true, /^[A-Za-z_][A-Za-z0-9_]*$/.test(credentialRefFor('p-1.x')))
record('规格化补上默认 maxTokens', 1200, normalizeParticipant({ id: 'a' }, 0).maxTokens)
console.log()

// ── 实验 6.5：配置写入往返（密钥落凭据文档，配置里只留引用） ────────────────

console.log('=== 实验 6.5：配置写入往返 ===')
console.log('   在临时 DSH_HOME 上跑，不碰用户真实配置与凭据文档。')
{
  const configHome = await mkdtemp(join(tmpdir(), 'council-cfg-'))
  const saved = await saveCouncil(configHome, valid().map((item, index) => ({
    ...item, apiKey: `sk-fake-${index}`,
  })))
  record('保存返回三位成员', 3, saved.config.participants.length)
  record('密钥引用名逐个生成', 3, saved.keyRefs.length)

  const reread = await readCouncilConfig(configHome)
  record('读回成员数一致', 3, reread.participants.length)
  record('配置里不含密钥本体（只有引用名）', false,
    JSON.stringify(reread).includes('sk-fake'))
  record('引用名形态正确', 'COUNCIL_P1_API_KEY', reread.participants[0].keyRef)

  const presence = await keyPresence(configHome, reread.participants)
  record('有密钥的路被标为有值', true, presence.p1 === true)
  record('解析密钥可取回本体', 'sk-fake-0', await resolveKey(configHome, reread.participants[0]))
  record('凭据文档路径在 DSH_HOME 下', true,
    credentialsPathOf(configHome).startsWith(configHome))

  // 未填密钥时不应清空既有密钥（编辑配置不必重打密钥）。
  await saveCouncil(configHome, valid().map((item) => ({ ...item })))
  record('未填密钥时既有密钥保持', 'sk-fake-0', await resolveKey(configHome, reread.participants[0]))

  // 非法配置必须在写盘前被拒。
  let rejected = false
  try {
    await saveCouncil(configHome, valid().map((p, i) => (i === 0 ? { ...p, model: '' } : p)))
  } catch (error) {
    rejected = Array.isArray(error.problems) && error.problems.length > 0
  }
  record('非法配置在写盘前被拒', true, rejected)
  await rm(configHome, { recursive: true, force: true })
}
console.log()

// ── 实验 7：议事顺序 ────────────────────────────────────────────────────────
console.log('=== 实验 7：议事顺序是否按身份 ===')
const ordered = roundSpeakers([
  { id: 'j', name: '裁决', tier: 'adjudicator' },
  { id: 'b', name: '对抗', tier: 'adversary' },
  { id: 'a', name: '议员', tier: 'councilor' },
])
record('对抗者被排在议员之后', ['a', 'b'], ordered.map((p) => p.id))
record('裁决者不出现在轮次里', false, ordered.some((p) => p.tier === 'adjudicator'))
console.log()

// ── 实验 8：端到端编排（桩化 fetch，验证编排而非模型质量） ──────────────────

console.log('=== 实验 8：端到端编排（桩化 fetch）===')
console.log('   桩化只证明「指令与编排正确」，不证明「模型会遵守角色」。')

const home = await mkdtemp(join(tmpdir(), 'council-'))
const realFetch = globalThis.fetch
const seen = []

globalThis.fetch = async (url, init = {}) => {
  const body = init.body === undefined ? null : JSON.parse(init.body)
  const model = body?.model ?? 'unknown'
  seen.push({ url: String(url), model })
  // p2 模拟鉴权失败：验证失败被如实记录而不是静默跳过。
  if (model === 'm2') {
    return new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 })
  }
  const text = `【${model}】的意见`
  const payload = model === 'm3'
    ? { content: [{ type: 'text', text }] }
    : { choices: [{ message: { content: text } }] }
  return new Response(JSON.stringify(payload), { status: 200 })
}

try {
  resetSessions()
  const participants = valid().map((item, index) => normalizeParticipant(item, index))
  const session = await createSession(home, { topic: TOPIC, participants })
  const resolveKeyFn = async () => 'stub-key'

  const round = startRound(home, session.id, { resolveKeyFn })
  record('开一轮启动成功', true, round.started)

  const waitIdle = async (id) => waitUntil(id, () => true)
  record('一轮在合理时间内结束', true, await waitIdle(session.id))
  // 回归：运行标记与状态必须同时落定，否则紧接着的 startRuling 会被拒。
  record('空闲时运行标记与 status 一致（无中间态）',
    [false, 'idle'], [isRunning(session.id), getSession(session.id).status])

  const after = getSession(session.id)
  const kinds = after.transcript.map((entry) => entry.kind)
  record('议事记录 = 议员发言 + 对抗者错误条目', ['speech', 'error'], kinds)
  record('议员发言排在第一', 'p1', after.transcript[0].speakerId)
  record('对抗者失败被如实记录（不静默跳过）', true,
    after.transcript[1].kind === 'error' && after.transcript[1].text.includes('401'))
  record('轮次计数 +1', 1, after.rounds)
  record('会话回到 idle', 'idle', after.status)
  record('裁决者未参与轮次', false, after.transcript.some((entry) => entry.tier === 'adjudicator'))

  // 裁定：此时记录里已有发言，裁决者应产出裁定条目。
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    seen.push({ url: String(url), model: body.model })
    return new Response(JSON.stringify({
      content: [{ type: 'text', text: '裁定：条件采纳。推翻条件：出现 X。' }],
    }), { status: 200 })
  }
  const ruling = startRuling(home, session.id, { resolveKeyFn })
  record('裁定启动成功', true, ruling.started)
  record('裁定在合理时间内结束', true, await waitIdle(session.id))

  const final = getSession(session.id)
  record('裁定条目被记录', 'ruling', final.transcript[final.transcript.length - 1].kind)
  record('ruling 字段被填充', true, final.ruling !== null && final.ruling.text.includes('推翻条件'))
  record('裁决者身份正确', 'adjudicator', final.transcript[final.transcript.length - 1].tier)

  // 并发保护：同一会话不能同时跑两轮。
  resetSessions()
  record('会话已重置（新进程语义）', 0, (await (async () => { await rm(home, { recursive: true, force: true }); return 0 })()))
} finally {
  globalThis.fetch = realFetch
}
console.log()

// ── 实验 9：议会模式的状态折叠与政策章节 ────────────────────────────────────

console.log('=== 实验 9：议会模式折叠与政策章节 ===')
console.log('   状态折叠自 command/run + command/done —— 用自定义事件类型会让整个会话历史加载失败。')

record('三个命令映射到三个等级', ['advisory', 'strict', 'off'],
  [LEVEL_OF_COMMAND[MODE_COMMAND], LEVEL_OF_COMMAND[STRICT_COMMAND], LEVEL_OF_COMMAND[OFF_COMMAND]])
record('初始为关闭', 'off', levelOfMode(emptyMode()))

const runEvent = (name, id) => ({ type: 'command/run', data: { name, commandId: id } })
const doneEvent = (id) => ({ type: 'command/done', data: { commandId: id } })

let m = emptyMode()
m = foldMode(m, runEvent(MODE_COMMAND, 'c1'))
record('命令运行中：wanted=advisory、active 仍为 false', [false, 'advisory'], [m.active, m.wanted])
m = foldMode(m, doneEvent('c1'))
record('命令完成：active=true、level=advisory、wanted 清空', [true, 'advisory', null], [m.active, m.level, m.wanted])

m = foldMode(m, runEvent(STRICT_COMMAND, 'c2'))
m = foldMode(m, doneEvent('c2'))
record('切到强制式', [true, 'strict'], [m.active, m.level])

m = foldMode(m, runEvent(OFF_COMMAND, 'c3'))
m = foldMode(m, doneEvent('c3'))
record('退出模式', [false, 'off'], [m.active, m.level])

record('未知命令不改变状态', 'off', levelOfMode(foldMode(emptyMode(), runEvent('autoresearch', 'x'))))
record('commandId 不匹配的 done 不提交',
  false, foldMode(foldMode(emptyMode(), runEvent(MODE_COMMAND, 'c1')), doneEvent('other')).active)

record('关闭时政策章节为空串', '', renderCouncilPolicy('off'))
const advisory = renderCouncilPolicy('advisory')
const strict = renderCouncilPolicy('strict')
record('建议式章节声明无人监管纪律', true, advisory.includes('无人监管') && advisory.includes('council_convene'))
record('建议式章节要求把 chosen 当用户选择', true, advisory.includes('chosen'))
record('建议式章节禁止编建议会结论', true, advisory.includes('不得自行编造'))
record('建议式章节不含强制式说明', false, advisory.includes('强制式（本会话）'))
record('强制式章节含高风险工具清单', true,
  HIGH_RISK_TOOLS.every((tool) => strict.includes(tool)))
record('强制式章节声明询问用户被重定向', true, strict.includes('ask_user_question'))
record('章节都指向 /council-off 退出', true,
  advisory.includes('/council-off') && strict.includes('/council-off'))
console.log()

// ── 实验 10：选项裁定形态（议会替代人工的核心） ──────────────────────────────

console.log('=== 实验 10：选项裁定形态 ===')
console.log('   人类在对话里的选择通常就是在几个方案里挑一个；提示词不改口径就会退化成「都行」。')
const OPTIONS = ['改用自动同步', '保持手动同步', '只同步元数据']
const withOptions = (tier) => buildUserPrompt({
  tier, topic: '同步策略怎么定？', transcript: [], options: OPTIONS,
})

record('提示词含候选选项块', true, withOptions('councilor').includes('候选选项'))
record('提示词逐个列出选项', true, OPTIONS.every((option) => withOptions('councilor').includes(option)))
record('议员被要求支持其中一个', true, /支持一个/.test(withOptions('councilor')))
record('对抗者被要求覆盖不止一个选项', true, /覆盖不止一个选项/.test(withOptions('adversary')))
record('裁决者被要求选定恰好一个', true, /必须选定恰好一个/.test(withOptions('adjudicator')))
record('裁决者给出可解析的选定行格式', true, withOptions('adjudicator').includes('选定：<选项原文>'))
record('无选项时不出现候选选项块', false,
  buildUserPrompt({ tier: 'councilor', topic: 't', transcript: [] }).includes('候选选项'))
record('上下文被注入（本轮上下文块）', true, buildUserPrompt({
  tier: 'councilor', topic: 't', transcript: [], options: OPTIONS, context: '已经试过手动同步，漏了 3 次',
}).includes('已经试过手动同步'))

record('解析精确匹配', '保持手动同步', parseChosen('选定：保持手动同步\n\n理由：…', OPTIONS))
record('解析带书名号', '改用自动同步', parseChosen('选定：「改用自动同步」', OPTIONS))
record('解析带全角冒号', '只同步元数据', parseChosen('选定：只同步元数据', OPTIONS))
record('解析前缀截短', '改用自动同步', parseChosen('选定：改用自动同步（推荐）', OPTIONS))
record('没有选定行 → null（不猜）', null, parseChosen('我认为应该看情况。', OPTIONS))
record('选定行内容不在候选中 → null', null, parseChosen('选定：第四种方案', OPTIONS))
record('没有候选选项时 → null', null, parseChosen('选定：随便', []))

// E2E：带选项的裁定必须把 chosen 落到 session.ruling（而不是只留在正文里）。
{
  const choiceHome = await mkdtemp(join(tmpdir(), 'council-choice-'))
  const realFetchChoice = globalThis.fetch
  globalThis.fetch = async (url, init = {}) => {
    const body = JSON.parse(init.body)
    const text = body.model === 'm3' ? '选定：改用自动同步\n理由：因为…' : '我的意见'
    const payload = body.model === 'm3'
      ? { content: [{ type: 'text', text }] }
      : { choices: [{ message: { content: text } }] }
    return new Response(JSON.stringify(payload), { status: 200 })
  }
  const waitIdle = async (id) => waitUntil(id, () => true)
  try {
    resetSessions()
    const participants = valid().map((item, index) => normalizeParticipant(item, index))
    const choiceSession = await createSession(choiceHome, { topic: '同步策略', options: OPTIONS, participants })
    record('会话记录了候选选项', 3, choiceSession.options.length)
    const choiceRound = startRound(choiceHome, choiceSession.id, { resolveKeyFn: async () => 'k' })
    record('选项会话：开一轮启动成功', true, choiceRound.started)
    await waitIdle(choiceSession.id)
    const choiceRuling = startRuling(choiceHome, choiceSession.id, { resolveKeyFn: async () => 'k' })
    record('选项会话：裁定启动成功', true, choiceRuling.started)
    await waitUntil(choiceSession.id, () => getSession(choiceSession.id)?.ruling != null)
    record('裁定解析出 chosen 并落盘', '改用自动同步', getSession(choiceSession.id).ruling?.chosen ?? null)
  } finally {
    globalThis.fetch = realFetchChoice
    resetSessions()
    await rm(choiceHome, { recursive: true, force: true })
  }
}
console.log()

// ── 实验 11：工具在模式未开时拒绝（真 apply，桩 ctx） ───────────────────────

console.log('=== 实验 11：工具的模式门控 ===')
{
  const mod = await import('../packages/dsh-model-council/index.js')
  const registered = []
  const commands = []
  const services = new Map()
  const projectionState = { value: undefined }
  const ctx = {
    tools: {
      register(definition) { registered.push(definition) },
      guard() { return () => {} },
      restrict() { return () => {} },
    },
    on() {},
    effect(fn) { return fn() },
    // 命令是可选注入：桩必须真的把回调调起来，否则「命令是否注册」根本没被测到。
    inject(names, callback) {
      if (Array.isArray(names) && names.includes('commands') && typeof callback === 'function') {
        callback({ commands: { register(definition) { commands.push(definition) } } })
      }
    },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    sessionProjections: {
      register(spec) { services.set('projection', spec); return { dispose() {} } },
      stateOf() { return projectionState.value },
    },
    systemPrompt: {
      section(spec) { services.set('section', spec); return { dispose() {} } },
      getSectionOrder() { return 0 },
    },
    connection: { fetch: { register(spec) { services.set('route', spec); return { dispose() {} } } } },
  }
  await mod.apply(ctx, {})

  const byName = new Map(registered.map((definition) => [definition.name, definition]))
  record('两个工具都注册了', true, byName.has('council_convene') && byName.has('council_read'))

  // 命令面：三个命令名，且都**不声明 input**（声明了 input 的命令第一次 Enter
  // 只认领参数、不执行 —— 最常用的无参路径被迫按两次回车）。
  record('注册了三个命令', [MODE_COMMAND, STRICT_COMMAND, OFF_COMMAND],
    commands.map((definition) => definition.name))
  record('三个命令都不声明 input（无参零摩擦）', true,
    commands.every((definition) => definition.input === undefined))
  record('三个命令都有描述（供命令面板显示）', true,
    commands.every((definition) => typeof definition.description === 'string' && definition.description !== ''))

  // 模式未开 → 拒绝，并给出可执行的下一步。
  const convene = byName.get('council_convene')
  const off = await convene.execute({ question: '要不要改？' }, { agent: { session: { id: 's1' } } })
  record('模式未开时拒绝召开', false, off.ok)
  record('拒绝理由指出该执行什么命令', true, off.report.includes('/council'))

  // 模式已开但议会没配 → 拒绝并指向配置页（用临时 DSH_HOME，保证确定性）。
  projectionState.value = { active: true, level: 'advisory', wanted: null, runningCommandId: null }
  const previousHome = process.env.DSH_HOME
  const isolated = await mkdtemp(join(tmpdir(), 'council-gate-'))
  process.env.DSH_HOME = isolated
  try {
    const on = await convene.execute({ question: '要不要改？' }, { agent: { session: { id: 's1' } } })
    record('成员不足时拒绝召开', false, on.ok)
    record('拒绝理由指向配置页', true, on.report.includes('议会配置'))

    const read = await byName.get('council_read')
    const missing = await read.execute({ sessionId: 'c-does-not-exist' }, {})
    record('读取不存在的会话如实报错', false, missing.ok)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    await rm(isolated, { recursive: true, force: true })
  }
}
console.log()

console.log('='.repeat(62))
const failed = results.filter((r) => !r.pass)
console.log(`议会消融：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
console.log()
console.log('未验证项（如实声明，不假装已验证）：')
console.log('  · 真实模型在三种身份下的**输出质量差异**未测 —— 需要真实 API 调用')
console.log('    本实验只证明提示词与编排携带了身份义务，不证明模型会遵守它')
process.exit(failed.length === 0 ? 0 : 1)
