/**
 * 逐项覆盖断言 —— 让「漏判若干条」在结构上无法通过发布门。
 *
 * ## 为什么必须存在（实测确认的跳过洞）
 *
 * qa_consensus.py 只比较**两路都写了的条目**：两路漏掉同一批条目时不会产生
 * 任何分歧记录，聚合照样 PASS。逐项判定只存在于两份 lane report 的
 * checks / content_gates.checks / harbor.checks 里，共识输出没有覆盖信息 ——
 * 「少写几项」与「全判了」在发布门眼里无法区分。Prompt 里那句「不要跳过
 * 任何一步」是对模型的恳求；这里是机制。
 *
 * ## 权威条目清单从哪来
 *
 * 从 0.3.10 判据脚本**运行时解析**，不在 JS 里再抄一份：
 *   · QA01–QA21 ← audit_task.py 的 CHECK_TITLES
 *   · G01–G03   ← content_gates.py
 *   · H01–H06   ← harbor_review.py 的 H_IDS
 * 清单变了脚本跟着变；脚本缺失或解析出零条目 → 抛错 —— 宁可门禁坏掉，
 * 也不能把期望清单静默当空（当空等于全部豁免）。
 *
 * @module dsh-autoresearch-qa/coverage
 */

import { readFile } from 'node:fs/promises'

/** 从 Python 源码里抠出带引号的 ID 常量（去重、保持出现顺序）。 */
function quotedIds(source, prefix) {
  const pattern = new RegExp(`["'](${prefix}\\d+)["']`, 'g')
  const seen = new Set()
  const out = []
  for (const match of String(source).matchAll(pattern)) {
    if (!seen.has(match[1])) { seen.add(match[1]); out.push(match[1]) }
  }
  return out
}

/**
 * H01–H06 的权威出处是 harbor_review.py 的推导式：
 *   `H_IDS = [f"H{i:02d}" for i in range(1, 7)]`
 * 注意 **H04 不在源码里字面出现** —— 只由推导式生成（实测第一次按
 * 「字面量必须出现」校验时被它抓住）。所以先解析推导式的 range，
 * 解析不出再退回字面量扫描。
 */
function harborIds(source) {
  const gen = source.match(/H_IDS\s*=\s*\[f"H\{i:02d\}"\s+for\s+i\s+in\s+range\((\d+),\s*(\d+)\)\]/)
  if (gen !== null) {
    const from = Number(gen[1])
    const to = Number(gen[2])
    if (!Number.isInteger(from) || !Number.isInteger(to) || to <= from) {
      throw new Error(`harbor_review.py 的 H_IDS range 异常：${gen[0]}`)
    }
    const ids = []
    for (let i = from; i < to; i++) ids.push(`H${String(i).padStart(2, '0')}`)
    return ids
  }
  // 退化路径：推导式不在了，按字面量扫（此时 H04 若确实只由推导式生成会漏 ——
  // 但推导式都不在了说明脚本已重写，字面量是当时仅存的证据）。
  return quotedIds(source, 'H0')
}

/**
 * 解析权威条目清单。
 *
 * @param {(logical: string, sourceId: string) => Promise<string|null>} resolveAsset
 *   gates 包的 resolveUpstreamAsset —— 注入而不是 import，保持本模块无跨包硬依赖。
 * @returns {Promise<{qa: string[], gate: string[], harbor: string[]}>}
 */
export async function expectedCheckIds(resolveAsset) {
  const specs = [
    { section: 'qa', file: 'audit_task.py', sourceId: 'upstream-0.3.10' },
    { section: 'gate', file: 'content_gates.py', sourceId: 'upstream-0.3.10' },
    { section: 'harbor', file: 'harbor_review.py', sourceId: 'upstream-0.3.10' },
  ]
  const out = {}
  for (const spec of specs) {
    const path = await resolveAsset(spec.file, spec.sourceId)
    if (path === null) {
      throw new Error(`权威条目清单不可用：找不到 ${spec.sourceId}/${spec.file}。`
        + '清单缺失时不能断言覆盖（静默当空等于全部豁免），门禁拒绝继续。')
    }
    const source = await readFile(path, 'utf8')
    let ids
    if (spec.section === 'qa') {
      // audit_task.py 的 CHECK_TITLES 是权威注册表（缺项时它自己也会 RuntimeError）。
      const block = source.match(/CHECK_TITLES\s*=\s*\{([\s\S]*?)\n\}/)
      ids = block === null ? [] : quotedIds(block[1], 'QA')
    } else if (spec.section === 'gate') {
      ids = quotedIds(source, 'G0')
    } else {
      ids = harborIds(source)
    }
    if (ids.length === 0) {
      throw new Error(`从 ${spec.file} 解析出 0 个条目：判据脚本结构可能已变更，拒绝按空清单断言覆盖`)
    }
    out[spec.section] = ids
  }
  // 一致性哨兵：教程口径是 21 项 QA + 3 门 + 6 Harbor。数量变了说明判据
  // 升级了 —— 此时应该人工复核本模块，而不是继续用旧数量放行。
  if (out.qa.length !== 21 || out.gate.length !== 3 || out.harbor.length !== 6) {
    throw new Error(`权威条目数量异常（qa=${out.qa.length} gate=${out.gate.length} `
      + `harbor=${out.harbor.length}，预期 21/3/6）。判据可能已升级，先人工核对再放行。`)
  }
  return out
}

/**
 * 计算两份（或多份）lane report 的逐项覆盖。
 *
 * @param {object[]} reports 已解析的 report.json 数组
 * @param {{qa: string[], gate: string[], harbor: string[]}} expected
 * @returns {{ok: boolean, missing: {qa: string[], gate: string[], harbor: string[]},
 *            presentCounts: {qa: number, gate: number, harbor: number}, perLane: object[]}}
 *   覆盖要求：**每一路**都对每个条目给出判定 —— 只有一路写了、另一路没写，
 *   共识层会报分歧；两路都没写才是本模块要抓的洞。
 */
export function coverageOf(reports, expected) {
  const list = Array.isArray(reports) ? reports : []
  const perLane = []
  const missing = { qa: [], gate: [], harbor: [] }

  const presentOf = (report) => {
    const present = new Set()
    for (const row of report?.checks ?? []) {
      if (row && typeof row.id === 'string') present.add(`qa:${row.id}`)
    }
    for (const row of report?.content_gates?.checks ?? []) {
      if (row && typeof row.id === 'string') present.add(`gate:${row.id}`)
    }
    for (const row of report?.harbor?.checks ?? []) {
      if (row && typeof row.id === 'string') present.add(`harbor:${row.id}`)
    }
    return present
  }

  for (const section of ['qa', 'gate', 'harbor']) {
    const need = expected[section] ?? []
    const missingHere = new Set()
    for (const report of list) {
      const present = presentOf(report)
      for (const id of need) {
        if (!present.has(`${section}:${id}`)) missingHere.add(id)
      }
    }
    // 缺失 = 任一路没判的条目（两路都判了才算覆盖）。
    missing[section] = [...missingHere].sort()
  }

  for (const report of list) {
    const present = presentOf(report)
    perLane.push({
      qa: (expected.qa ?? []).filter((id) => present.has(`qa:${id}`)).length,
      gate: (expected.gate ?? []).filter((id) => present.has(`gate:${id}`)).length,
      harbor: (expected.harbor ?? []).filter((id) => present.has(`harbor:${id}`)).length,
    })
  }

  const ok = missing.qa.length === 0 && missing.gate.length === 0 && missing.harbor.length === 0
  return {
    ok,
    missing,
    presentCounts: perLane.length > 0 ? perLane[0] : { qa: 0, gate: 0, harbor: 0 },
    perLane,
    laneCount: list.length,
  }
}

/** 可读的缺口描述，直接进报告/门禁 detail。 */
export function describeMissing(missing) {
  const parts = []
  if (missing.qa.length > 0) parts.push(`QA 项缺失：${missing.qa.join(', ')}`)
  if (missing.gate.length > 0) parts.push(`内容门缺失：${missing.gate.join(', ')}`)
  if (missing.harbor.length > 0) parts.push(`Harbor 项缺失：${missing.harbor.join(', ')}`)
  return parts.join('；') || '（无缺失）'
}
