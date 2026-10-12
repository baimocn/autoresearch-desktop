/**
 * 技能目录清单 —— 把随包分发的 AutoResearch 技能登记为可枚举的元数据。
 *
 * 技能正文从包内 assets/ 读取（不依赖运行时网络）。两份来源分别保留：
 *   skills-0.3.2/         教程 V3 附件里的质检技能（autoresearch-task-qa、autoresearch-baseline-quality）
 *   skills-upstream-0.3.4/ autoresearch-skills 上游 0.3.4 的完整 8 技能
 *
 * 同一 name 出现在两份来源时，教程附件版本优先（教程正文以它为准），
 * 但候选来源全部保留，便于比对版本差异。
 *
 * @module dsh-autoresearch-skills/catalog
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { join, dirname, basename } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ASSETS_ROOT = join(HERE, '..', 'assets')

/** 来源目录与优先级（数字越小越优先）。 */
export const SOURCES = Object.freeze([
  { id: 'tutorial-v3', root: 'skills-0.3.2', rank: 100, label: '教程 V3 附件（autoresearch-qa-skills-0.3.2）' },
  { id: 'upstream-0.3.4', root: 'skills-upstream-0.3.4', rank: 200, label: 'autoresearch-skills 上游 0.3.4' },
])

/** SOP 经验理论来源。 */
export const SOP_ROOT = 'sop'

/** 每个技能的触发条件与产出说明 —— 用于模型路由，不替代 SKILL.md 正文。 */
export const SKILL_ROUTING = Object.freeze({
  'autoresearch-paper-discovery': {
    whenToUse: '从零找论文、维护候选池、专家自主选题或池内快选时',
    produces: '去重候选账本、许可与权威查重证据、RECOMMEND/NEEDS_EVIDENCE/REJECT 结论',
    stops: '任一硬门槛失败即拒题；未知项不能写成通过',
  },
  'autoresearch-optimization-surface': {
    whenToUse: '判断论文或代码是否存在方法级优化空间时',
    produces: '可修改面、冻结面、反例和最小验证合同',
    stops: '只有超参数变化、无法隔离或不可复算时停止',
  },
  'autoresearch-baseline-quality': {
    whenToUse: '审查正式 Baseline 是否合理、公平、可复现时',
    produces: 'Baseline 质量结论、偏差来源与修复清单',
    stops: '预算、seed、实现或评测口径不公平时不得进入正式比较',
  },
  'autoresearch-task-authoring': {
    whenToUse: '将论文与代码仓转化为可交付研究题时',
    produces: 'Starter、Baseline、Reference、评分器、冻结合同和五阶段 QA 证据',
    stops: 'selection/pilot/container/long-run/release 任一累计门失败即暂停下游工作',
  },
  'autoresearch-run-isolation': {
    whenToUse: '设计双轨运行、Docker、GPU/API 成本、恢复与血缘时',
    produces: '运行合同、容量计划、隔离拓扑、快照与 lineage',
    stops: 'pilot 未过、容量风险不可接受或恢复证据缺失时停止消费',
  },
  'autoresearch-task-qa': {
    whenToUse: '对任务目录或 ZIP 做独立只读审查时',
    produces: 'TXT、Markdown、JSON 报告及可执行整改项',
    stops: '研究质量、实现、Harbor、隐私或证据门失败即 NOT READY',
  },
  'autoresearch-feishu-three-table': {
    whenToUse: '在授权的飞书多维表格中流转领题、完成提交/验收和组长初检时',
    produces: '当期题号核验、最小字段变更、权限交接草稿与写后回读',
    stops: 'schema/权限不可验证、跨表身份冲突或回读不一致时停止',
  },
  'autoresearch-conversation-handoff': {
    whenToUse: '长会话收尾、切换 Agent、恢复中断工作时',
    produces: '已验证事实、失败、阻塞、文件入口和下一步命令',
    stops: '对话陈述与现场证据不一致时，以现场为准并保留差异',
  },
})

/** 解析 SKILL.md 的 YAML frontmatter。只取 name / description / metadata 三个键。 */
export function parseFrontmatter(text) {
  if (!text.startsWith('---')) return { data: {}, body: text }
  const end = text.indexOf('\n---', 3)
  if (end === -1) return { data: {}, body: text }
  const block = text.slice(3, end)
  const body = text.slice(text.indexOf('\n', end + 1) + 1)
  const data = {}
  let currentKey = null
  for (const rawLine of block.split(/\r?\n/)) {
    if (rawLine.trim() === '') continue
    const nested = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine)
    if (nested && currentKey !== null && typeof data[currentKey] === 'object') {
      data[currentKey][nested[1]] = stripQuotes(nested[2].trim())
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(rawLine)
    if (!pair) continue
    const [, key, rawValue] = pair
    const value = rawValue.trim()
    if (value === '') {
      data[key] = {}
      currentKey = key
      continue
    }
    data[key] = stripQuotes(value)
    currentKey = key
  }
  return { data, body }
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1)
  }
  return value
}

/** 扫描一个来源目录下的全部技能。 */
async function scanSource(source) {
  const root = join(ASSETS_ROOT, source.root)
  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return []
  }
  const found = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const skillFile = join(root, entry.name, 'SKILL.md')
    let text
    try {
      text = await readFile(skillFile, 'utf8')
    } catch {
      continue
    }
    const { data, body } = parseFrontmatter(text)
    const name = typeof data.name === 'string' && data.name !== '' ? data.name : entry.name
    const routing = SKILL_ROUTING[name] ?? {}
    found.push({
      name,
      directory: entry.name,
      description: typeof data.description === 'string' ? data.description : '',
      whenToUse: routing.whenToUse ?? null,
      produces: routing.produces ?? null,
      stops: routing.stops ?? null,
      source: source.id,
      sourceLabel: source.label,
      rank: source.rank,
      skillDir: join(root, entry.name),
      bodyBytes: Buffer.byteLength(body, 'utf8'),
    })
  }
  return found
}

/** 读取某个技能目录下的辅助文件清单（references/、scripts/、assets/ 等）。 */
export async function listSkillResources(skillDir) {
  const resources = []
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__' || entry.name === '.git') continue
        await walk(join(directory, entry.name), relative)
        continue
      }
      if (entry.name === 'SKILL.md' && prefix === '') continue
      try {
        const info = await stat(join(directory, entry.name))
        resources.push({ path: relative, bytes: info.size })
      } catch { /* 读取失败时跳过，不伪造条目 */ }
    }
  }
  await walk(skillDir, '')
  return resources
}

/** 枚举全部技能，按 name 去重（低 rank 优先）。 */
export async function listSkills() {
  const all = []
  for (const source of SOURCES) {
    all.push(...await scanSource(source))
  }
  const byName = new Map()
  for (const skill of all) {
    const existing = byName.get(skill.name)
    if (existing === undefined || skill.rank < existing.rank) byName.set(skill.name, skill)
  }
  return {
    skills: [...byName.values()].sort((left, right) => left.name.localeCompare(right.name)),
    shadowed: all.filter((skill) => byName.get(skill.name) !== skill)
      .map((skill) => ({ name: skill.name, source: skill.source, rank: skill.rank })),
    sources: SOURCES.map((source) => ({ id: source.id, label: source.label, rank: source.rank })),
  }
}

/** 读取技能正文（含资源清单）。 */
export async function readSkill(name) {
  const { skills } = await listSkills()
  const skill = skills.find((entry) => entry.name === name)
  if (skill === undefined) return undefined
  const text = await readFile(join(skill.skillDir, 'SKILL.md'), 'utf8')
  const { body } = parseFrontmatter(text)
  return { ...skill, content: body, resources: await listSkillResources(skill.skillDir) }
}

/** SOP 经验理论文件的目录结构（供技能正文引用）。 */
export async function listSopResources() {
  const root = join(ASSETS_ROOT, SOP_ROOT)
  const resources = []
  async function walk(directory, prefix) {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === '__pycache__') continue
        await walk(join(directory, entry.name), relative)
        continue
      }
      try {
        const info = await stat(join(directory, entry.name))
        resources.push({ path: relative, bytes: info.size })
      } catch { /* 跳过读取失败的条目 */ }
    }
  }
  await walk(root, '')
  return resources
}

/** 读取 SOP 顶层 SKILL.md。 */
export async function readSopSkill() {
  const file = join(ASSETS_ROOT, SOP_ROOT, 'SKILL.md')
  try {
    const text = await readFile(file, 'utf8')
    const { data, body } = parseFrontmatter(text)
    return { frontmatter: data, content: body }
  } catch {
    return undefined
  }
}
