/**
 * 工程化质检范式（v3，最高规格）—— 六道闸门的结构化强制层。
 *
 * ## 这个模块是什么、不是什么
 *
 * `D:\Desktop\论文质检\提示词_通用_工程化质检.md`（v3）是一份**给人/模型看的
 * 提示词**：六道闸门、逐项 evidence、判读队列落锤、十一张交付表、核验卡。
 * 提示词的问题在于它只是文字 —— 「不许跳过闸门」「不许按类别批量归因」
 * 是对执行者的恳求，没有任何机制阻止跳过。
 *
 * 本模块把提示词中**可机检的骨架**变成数据与校验函数：
 *   · 闸门顺序 → manifest 落盘，闸门 N 拒绝运行除非 N−1 已确认
 *   · 十一张交付表 → 缺一即该闸门失败
 *   · 判读队列 → 处置词封闭四种，「其他/明显无关」这类逃生舱写法直接拒收
 *   · evidence → 无行号/字段路径时该项最高 manual，不许 pass
 *   · 决策字段 → 两个分层各自允许的取值集，PASS_WITH_WAIVERS 不得说成通过
 *
 * **语义深度仍在审阅者**。本模块不判断「证据是否支持结论」——
 * 它保证的是：结构上不存在「少交一张表、少判一批项、跳过一道闸门
 * 还声称完成」的空间。
 *
 * @module dsh-autoresearch-qa/paradigm
 */

import { readFile, writeFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'

/** 十八份参考规范（闸门 1 要求逐一列名并存在）。 */
export const REFERENCES = Object.freeze([
  'standard-coverage', 'format-repair-policy', 'trajectory-comparability',
  'source-alignment', 'research-quality', 'implementation-policy',
  'submission-format', 'docker-path-contract', 'harbor-harness',
  'implementation-report', 'runtime-integrity', 'innerfield-deployment',
  'qa-spec', 'report-schema', 'precheck-policy', 'phase2-format-migration',
  'legacy-standard-comparison', 'exposure-manifest',
])

/** 21 项 QA（速查 id；正式报告须照抄 implementation-policy.md 的检查名）。 */
export const QA_ITEMS = Object.freeze(
  Array.from({ length: 21 }, (_v, i) => `QA${String(i + 1).padStart(2, '0')}`),
)

/** Harbor 六项与内容三门。 */
export const HARBOR_ITEMS = Object.freeze(['H01', 'H02', 'H03', 'H04', 'H05', 'H06'])
export const GATE_ITEMS = Object.freeze(['G01', 'G02', 'G03'])

/** status 只允许这五种（空 = 尚未填）。 */
export const ALLOWED_STATUS = Object.freeze(['pass', 'fail', 'manual', 'pass_with_waivers', ''])

/**
 * 判读队列的处置词**封闭集**（闸门 4.10(b)）。
 * 「其他 / 明显无关 / 无意义」等第五种写法是批量归因的逃生舱，一律拒收。
 */
export const DISPOSITIONS = Object.freeze(['确认正确', '确认无关', '确认错误', '无法判定'])

/** 两个分层的 decision 允许集（闸门 5.3：两层取值不同，别报错文件）。 */
export const DECISION_LAYERS = Object.freeze({
  standard_review: ['PASS', 'FAIL', 'INCOMPLETE'],
  waiver_review: ['PASS_WITH_WAIVERS', 'FAIL', 'ERROR'],
})

/** 十一张专项表（闸门 6.1；缺一即视为未完成）。 */
export const SPECIAL_TABLES = Object.freeze([
  { file: 'constraint_bypass.json', gate: '4.3', label: '绕过面表' },
  { file: 'formal_value_recompute.json', gate: '4.2', label: '正式值复算表' },
  { file: 'per_run_compliance.json', gate: '4.4/6.3', label: '逐 run 合规落表' },
  { file: 'resource_compliance.json', gate: '4.4/4.5', label: '资源与同预算效果' },
  { file: 'derived_recompute.json', gate: '4.6', label: '派生数差异清单' },
  { file: 'deprecation_verification.json', gate: '4.7', label: '废止声明三方原文' },
  { file: 'weakest_link.json', gate: '6.2', label: '自我指弱' },
  { file: 'attribution_review.json', gate: '4.8', label: '说明层归属核对表' },
  { file: 'caliber_review.json', gate: '4.9', label: '口径一致性矩阵' },
  { file: 'judgement_queue.json', gate: '4.10', label: '判读队列逐条落锤' },
  { file: 'table_object_caliber_matrix.json', gate: '4.11', label: '同表对象×口径对照矩阵' },
])

/** 判定依据里的禁语（闸门 3：不许出现「看起来没问题」类表述）。 */
export const FORBIDDEN_PHRASES = Object.freeze([
  '看起来没问题', '应该是正确的', '应该没问题', '没有薄弱环节',
])

/** evidence 合法形态：`路径:行号` 或 JSON Pointer / 字段全路径（`#/`）。 */
export function evidenceProblems(evidence) {
  const text = String(evidence ?? '').trim()
  if (text === '') return ['evidence 为空 → status 最高只能 manual，不许 pass']
  const hasLine = /:\d+/.test(text)
  const hasPointer = text.includes('#/')
  if (!hasLine && !hasPointer) {
    return ['evidence 只写文件名不写行号/字段路径 → 不算合格（须形如 path:123 或 result.json#/metrics/score）']
  }
  return []
}

/** 校验「已填表」：全部条目在场、status 合法、evidence 形态合格、无禁语。 */
export function validateFilledTable(items, { expectedIds, section }) {
  const problems = []
  const byId = new Map()
  for (const item of Array.isArray(items) ? items : []) {
    if (item && typeof item.id === 'string') byId.set(item.id, item)
  }
  for (const id of expectedIds) {
    const item = byId.get(id)
    if (item === undefined) { problems.push(`${id}：整行缺失（21+6+3 一行都不能少）`); continue }
    const status = String(item.status ?? '').trim().toLowerCase()
    if (!ALLOWED_STATUS.includes(status)) {
      problems.push(`${id}：status "${item.status}" 不在允许集（pass/fail/manual/pass_with_waivers）`)
      continue
    }
    if (status === '') continue // 闸门 2 阶段允许留空
    const evidence = item.evidence ?? item.evidence_text ?? ''
    const evProblems = evidenceProblems(evidence)
    const basis = String(item.依据 ?? item.basis ?? item.rationale ?? '')
    for (const phrase of FORBIDDEN_PHRASES) {
      if (basis.includes(phrase) || String(item.remark ?? '').includes(phrase)) {
        problems.push(`${id}：判定依据出现禁语「${phrase}」`)
      }
    }
    if ((status === 'pass' || status === 'pass_with_waivers') && evProblems.length > 0) {
      problems.push(`${id}：${evProblems.join('；')}（当前填了 ${status}）→ 最高 manual`)
    }
    // QA15 必查；QA04/QA19 可判不适用但须写明确定性依据。
    if (id === 'QA15' && /not_applicable|不适用/i.test(status + basis)) {
      problems.push('QA15：资源估算不允许 not_applicable')
    }
    if ((id === 'QA04' || id === 'QA19') && /not_applicable|不适用/i.test(basis) && basis.trim().length < 12) {
      problems.push(`${id}：判不适用必须写明确定性依据（当前依据过短）`)
    }
    // evidence 为空 → 只许 manual（规则原文），manual + 空 evidence 是合法组合。
    if (section === undefined && evidence === '' && status !== '' && status !== 'manual') {
      problems.push(`${id}：有 status 但无 evidence（evidence 为空时只能填 manual）`)
    }
  }
  return problems
}

/**
 * 校验判读队列（闸门 4.10）。
 *
 * 完成判据：队列条目数 = 已处置条目数；处置词在封闭集内；
 * `确认无关` 必须给逐字可验特征；`确认正确` 必须给复算值与依据；
 * `确认错误` 必须给应得值。
 */
export function validateJudgementQueue(queue) {
  const problems = []
  const entries = Array.isArray(queue) ? queue : (queue?.entries ?? [])
  if (entries.length === 0) return ['判读队列为空：机器扫出的待判读项必须落盘为文件并逐条处置']
  let dispositioned = 0
  for (const [index, entry] of entries.entries()) {
    const label = entry?.队列号 ?? entry?.id ?? `#${index + 1}`
    const d = String(entry?.disposition ?? '').trim()
    if (d === '') { problems.push(`${label}：无 disposition（每条必须落锤）`); continue }
    if (!DISPOSITIONS.includes(d)) {
      problems.push(`${label}：disposition "${d}" 不在封闭集（只允许 ${DISPOSITIONS.join('/')}）；`
        + '「其他/明显无关」这类写法是批量归因的逃生舱，不收')
      continue
    }
    dispositioned++
    if (d === '确认无关') {
      const feature = String(entry?.逐字特征 ?? entry?.verbatim_feature ?? '').trim()
      if (feature === '') problems.push(`${label}：确认无关必须给逐字可验特征（哈希前缀/字节数/行号/时间戳…）`)
    }
    if (d === '确认正确' && String(entry?.复算值 ?? entry?.recomputed ?? '').trim() === '') {
      problems.push(`${label}：确认正确必须给复算值与比对依据`)
    }
    if (d === '确认错误' && String(entry?.应得值 ?? entry?.expected ?? '').trim() === '') {
      problems.push(`${label}：确认错误必须给应得值与差异说明`)
    }
    if (d === '无法判定' && String(entry?.缺什么证据 ?? entry?.missing_evidence ?? '').trim() === '') {
      problems.push(`${label}：无法判定必须写明缺什么证据`)
    }
  }
  if (dispositioned !== entries.length) {
    problems.push(`完成判据未达：队列 ${entries.length} 条，落锤 ${dispositioned} 条（有一条没落锤即未完成）`)
  }
  return problems
}

/** 校验说明层归属核对表（闸门 4.8）：归属判定只允许三种；出现「误植」即 QA21 fail。 */
export function validateAttributionReview(entries) {
  const problems = []
  const list = Array.isArray(entries) ? entries : (entries?.entries ?? [])
  if (list.length === 0) return ['attribution_review 为空：说明层声明必须逐条编号核对（负面声明优先）']
  let misplanted = 0
  for (const [index, entry] of list.entries()) {
    const label = entry?.编号 ?? `#${index + 1}`
    const verdict = String(entry?.归属判定 ?? '').trim()
    if (!['一致', '误植', '无法确认'].includes(verdict)) {
      problems.push(`${label}：归属判定 "${verdict || '(空)'}" 不在 一致/误植/无法确认 三种之内`)
      continue
    }
    if (verdict === '误植') misplanted++
    if (verdict !== '一致' && String(entry?.实现证据 ?? entry?.implementation_evidence ?? '').trim() === '') {
      problems.push(`${label}：判定为 ${verdict} 但未给实现证据定位`)
    }
  }
  if (misplanted > 0) {
    problems.push(`存在 ${misplanted} 条「误植」（文字描述 A、实现证据指向 B）→ QA21 直接 fail，不得以历史迁移豁免`)
  }
  return problems
}

/** 校验口径一致性矩阵（闸门 4.9）：单元格未标口径且与当前口径不符 → fail。 */
export function validateCaliberReview(entries) {
  const problems = []
  const list = Array.isArray(entries) ? entries : (entries?.entries ?? [])
  if (list.length === 0) return ['caliber_review 为空：呈现数值的单元格必须逐格核对口径']
  for (const [index, cell] of list.entries()) {
    const label = cell?.单元格 ?? cell?.cell ?? `#${index + 1}`
    const consistent = cell?.['一致?'] ?? cell?.consistent
    const marked = String(cell?.口径标注 ?? cell?.caliber_marked ?? '').trim()
    if (consistent === false || consistent === '否') {
      problems.push(`${label}：当前口径位填入了非当前口径值${marked !== '' ? '' : '（且单元格自身未标注口径；注文不能替代单元格标注）'}`)
    }
  }
  return problems
}

/** 最薄弱环节（闸门 6.2 / 核验卡 9）：缺该节、答「没有」、只挑已复算项 → 未完成。 */
export function weakestLinkProblems(reportText) {
  const problems = []
  const text = String(reportText ?? '')
  const at = text.indexOf('最薄弱环节')
  if (at < 0) return ['缺少「最薄弱环节」一节：由质检方自己指认台账中最不确定的一条']
  const section = text.slice(at, at + 1200)
  if (/没有薄弱环节|无薄弱环节/.test(section)) {
    problems.push('「没有薄弱环节」视为未完成：答不出即打回')
  }
  if (!/未核对|人工|逐条/.test(section)) {
    problems.push('最薄弱环节未覆盖「未核对类别」：只挑已复算通过项里的细微不确定性视为未完成')
  }
  return problems
}

/**
 * 核对范围显式声明（闸门 6.4 / 核验卡 14）。
 *
 * 结构性部分：该节必须存在且含「未核对」。语义部分（否定结论带分母）
 * 是启发式：发现「未发现/全部通过/一致」却同句无数字 → 记 advisory（不阻塞，
 * 但必须出现在报告里供人工追问 —— 分母是否真实只有质检方自己知道）。
 */
export function scopeDeclarationProblems(reportText) {
  const problems = []
  const advisories = []
  const text = String(reportText ?? '')
  if (!/核对范围/.test(text) || !/未核对/.test(text)) {
    problems.push('缺少「核对范围与未核对项」一节：未核对类别不得隐去，隐去即视为该节缺失')
  }
  for (const match of String(text).matchAll(/[^。\n]*(?:未发现|全部通过|完全一致|没有发现)[^。\n]*。?/g)) {
    const sentence = match[0]
    if (/\d/.test(sentence)) continue
    if (/逐条|逐位|逐 run|逐格/.test(sentence)) continue
    advisories.push(sentence.trim().slice(0, 80))
  }
  if (advisories.length > 0) {
    advisories.push; // 保留供调用方展示
  }
  return { problems, advisories: advisories.slice(0, 10) }
}

/**
 * 闸门 manifest：顺序强制的机制核心。
 *
 * 闸门 N 的工具调用会先读 manifest；N−1 未确认则拒绝运行并列出被跳过的闸门。
 * 「每通过一道停下等确认，再进下一道」由此从恳求变成机制。
 */
export function manifestPath(outDir) { return join(outDir, '.paradigm-manifest.json') }

export async function readGateManifest(outDir) {
  try {
    const parsed = JSON.parse(await readFile(manifestPath(outDir), 'utf8'))
    return { confirmed: parsed?.confirmed ?? {}, gates: parsed?.gates ?? {} }
  } catch (error) {
    if (error?.code === 'ENOENT') return { confirmed: {}, gates: {} }
    throw new Error(`范式 manifest 损坏，拒绝继续（跳过记录不可丢失）：${error.message}`)
  }
}

export async function confirmGate(outDir, gate, checks) {
  const manifest = await readGateManifest(outDir)
  manifest.confirmed[gate] = new Date().toISOString()
  manifest.gates = manifest.gates ?? {}
  manifest.gates[gate] = checks
  await writeFile(manifestPath(outDir), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

/** 闸门 N 运行前置检查：1..N−1 必须全部已确认，缺哪个点哪个。 */
export async function requirePreviousGates(outDir, gate) {
  const manifest = await readGateManifest(outDir)
  const missing = []
  for (let n = 1; n < gate; n++) {
    if (!manifest.confirmed[n]) missing.push(n)
  }
  if (missing.length > 0) {
    throw new Error(`闸门 ${gate} 拒绝运行：闸门 ${missing.join('、')} 尚未确认通过。`
      + '六道闸门必须依次通过，不许合并、不许跳、不许「先看完全部再一起说」。')
  }
  return manifest
}

/** 交付物在场检查（闸门 6.1 的清单机制）。 */
export async function deliverableProblems(outDir) {
  const problems = []
  for (const table of SPECIAL_TABLES) {
    try {
      const stat = await readdir(outDir)
      if (!stat.includes(table.file)) problems.push(`缺专项表 ${table.file}（${table.label}，闸门 ${table.gate}）`)
    } catch {
      problems.push(`输出目录不可读：${outDir}`)
      return problems
    }
  }
  for (const final of ['report.txt', 'report.md', 'report.json', 'return_to_expert.txt', 'review.json']) {
    try {
      await readFile(join(outDir, final), 'utf8')
    } catch {
      problems.push(`缺终稿 ${final}`)
    }
  }
  for (const layer of ['standard_review', 'waiver_review']) {
    try {
      await readFile(join(outDir, layer, 'report.json'), 'utf8')
    } catch {
      problems.push(`缺分层目录 ${layer}/report.json`)
    }
  }
  return problems
}

/** 读一个 JSON 文件；损坏时报错而不是当空。 */
export async function readJsonStrict(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`JSON 不可解析：${path}（${error.message}）。损坏的交付物不能当不存在处理。`)
  }
}
