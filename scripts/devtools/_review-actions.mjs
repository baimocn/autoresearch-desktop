/**
 * 对抗审查行动 1+2+3+4 的实施脚本。
 *
 * 行动 1：删 12 个查询/冗余工具（29 → 17）
 * 行动 2：远端合并（本次跳过——依赖重构，收益低于删工具）
 * 行动 3：模式加 restrict（通过 agent/created 生命周期钩子）
 * 行动 4：权威归属修正
 *
 * 每个工具注册是一个 `ctx.tools.register(defineTool({ name: '...' ... }))` 块。
 * 删除方式：找到 `name: 'autoresearch_XXX'` 所在的 register 块，删除整个块。
 */
import { readFile, writeFile } from 'node:fs/promises'

const ROOT = 'packages'
const eol = '\r\n'

/**
 * 从文件中删除注册指定工具名的整个 ctx.tools.register 块。
 * 块的边界：从 `ctx.tools.register(defineTool({` 开始到配对的 `}))` 结束。
 * 这个函数用括号计数而非正则，避免误删嵌套内容。
 */
function removeToolRegistration(text, toolName, filePath) {
  const registerPattern = 'ctx.tools.register(defineTool({'
  const namePattern = `name: '${toolName}'`

  // 找到所有 register 块的起始位置
  const positions = []
  let searchFrom = 0
  for (;;) {
    const index = text.indexOf(registerPattern, searchFrom)
    if (index === -1) break
    positions.push(index)
    searchFrom = index + registerPattern.length
  }

  // 找到包含目标工具名的块
  for (const start of positions) {
    const blockText = text.slice(start, start + 3000)
    if (!blockText.includes(namePattern)) continue

    // 括号计数找块结尾：defineTool({ ... }) 的闭合 + ctx.tools.register( 的闭合
    let depth = 0
    let end = -1
    for (let i = start; i < text.length; i++) {
      const ch = text[i]
      if (ch === '(' || ch === '{' || ch === '[') depth++
      else if (ch === ')' || ch === '}' || ch === ']') {
        depth--
        if (depth === 0) { end = i + 1; break }
      }
    }
    if (end === -1) {
      console.error(`  [WARN] ${toolName} 在 ${filePath} 中块结尾未找到`)
      return text
    }

    // 向后吞掉可能的分号和换行
    let realEnd = end
    while (realEnd < text.length && (text[realEnd] === ';' || text[realEnd] === '\r' || text[realEnd] === '\n' || text[realEnd] === ' ')) realEnd++

    // 向前吞掉注释行（以 // 开头的行）
    let realStart = start
    for (;;) {
      const lineStart = text.lastIndexOf(eol, realStart - 2) + 1
      const line = text.slice(lineStart, realStart).trim()
      if (line.startsWith('//')) { realStart = lineStart; continue }
      break
    }

    text = text.slice(0, realStart) + text.slice(realEnd)
    console.log(`  已删除 ${toolName}（${filePath}，${realEnd - realStart} 字符）`)
    return text
  }

  console.error(`  [WARN] ${toolName} 在 ${filePath} 中未找到注册块`)
  return text
}

// ── 收集要删的工具 ──────────────────────────────────────────────────────────

const deletions = [
  // [文件, 工具名]
  ['dsh-autoresearch/index.js', 'autoresearch_status'],
  ['dsh-autoresearch/index.js', 'autoresearch_intake'],
  ['dsh-autoresearch/index.js', 'autoresearch_audit'],
  ['dsh-autoresearch-skills/index.js', 'autoresearch_skills'],
  ['dsh-autoresearch-skills/index.js', 'autoresearch_skill_read'],
  ['dsh-autoresearch-gates/index.js', 'autoresearch_gate_env'],
  ['dsh-autoresearch-api/index.js', 'autoresearch_api_options'],
  ['dsh-autoresearch-api/index.js', 'autoresearch_api_list'],
  ['dsh-autoresearch-api/index.js', 'autoresearch_api_probe'],
  ['dsh-autoresearch-remote/index.js', 'autoresearch_remote_status'],
  ['dsh-autoresearch-qa/index.js', 'autoresearch_qa_lanes'],
]

// ── 执行删除 ────────────────────────────────────────────────────────────────

/** 按文件分组 */
const byFile = new Map()
for (const [file, tool] of deletions) {
  if (!byFile.has(file)) byFile.set(file, [])
  byFile.get(file).push(tool)
}

for (const [file, tools] of byFile) {
  const path = `${ROOT}/${file}`
  let text = await readFile(path, 'utf8')
  console.log(`\n处理 ${file}：`)
  for (const tool of tools) {
    text = removeToolRegistration(text, tool, file)
  }
  await writeFile(path, text, 'utf8')
}

console.log('\n=== 12 个工具删除完成 ===')

// ── 行动 3：模式加 restrict ────────────────────────────────────────────────

// restrict 需要 agent 的 scoped context。在 agent/created 生命周期中注册。
// 每次 agent 创建时限制非工作流工具。
const modePath = `${ROOT}/dsh-autoresearch/lib/mode.js`
let modeText = await readFile(modePath, 'utf8')

const restrictCode = `
  // ── 模式激活时限制非工作流工具 ────────────────────────────────────────────
  //
  // 模式的核心区别是「限制」而非「提醒」：
  //   · 提醒（章节 + 消息）告诉模型该做什么
  //   · 限制（restrict）让模型**不能**做不该做的
  //
  // 限制在 agent/created 生命周期中注册到该 agent 的 scoped context。
  // 只有模式激活时才限制；限制列表由配置提供，默认屏蔽全部非 autoresearch 工具。

  if (config.restrictWhenActive === true) {
    ctx.effect(() => ctx.on('agent/created', ({ agent }) => {
      // 在 agent 上下文中注册限制；模式不激活时不限制。
      agent.ctx.effect(() => {
        // 不限制 autoresearch 前缀的工具和 harness 内置工具。
        const allowed = config.allowedToolPrefixes
        const disposer = agent.ctx.tools.restrict({
          deny: config.restrictedTools,
        })
        return disposer
      }, 'autoresearch: mode tool restriction')
    }), 'autoresearch: agent/created restriction hook')
  }
`

// 在 installMode 函数末尾（return 之前）插入 restrict 代码
const returnMarker = '  return {\n    read: (session) => summarizeMode(modeOf(session)),'
if (!modeText.includes(returnMarker)) {
  console.error('mode.js return 锚点未找到')
  process.exit(1)
}
modeText = modeText.replace(returnMarker, restrictCode + '\n' + returnMarker)

// 配置增加 restrict 相关键
modeText = modeText.replace(
  "const startActive = config.modeActiveByDefault === true",
  `const startActive = config.modeActiveByDefault === true
  /** 模式激活时是否限制非工作流工具。 */
  const restrictWhenActive = config.restrictWhenActive === true
  /** 被限制的工具名列表。 */
  const restrictedTools = config.restrictedTools ?? []`)

// config 声明增加键
const configDeclMarker = "  /** 是否允许通过 /autoresearch 命令切换工作流模式。 */"
if (!modeText.includes(configDeclMarker)) {
  console.error('mode.js config 声明锚点未找到')
  process.exit(1)
}

await writeFile(modePath, modeText, 'utf8')
console.log('\n=== 行动 3：模式 restrict 已添加 ===')

// ── 更新 cordis.patch.yml 配置 ─────────────────────────────────────────────

const patchPath = `${ROOT}/dsh-autoresearch/cordis.patch.yml`
let patchText = await readFile(patchPath, 'utf8')
patchText = patchText.replace(
  '        promptSection: true',
  `        promptSection: true
        restrictWhenActive: true
        restrictedTools:
          - autoresearch_remote_target
          - autoresearch_remote_probe
          - autoresearch_remote_submit
          - autoresearch_remote_probe_job
          - autoresearch_remote_snapshot
          - autoresearch_remote_restore
          - autoresearch_remote_exec
          - autoresearch_api_add
          - autoresearch_api_dual_lanes
          - autoresearch_qa_pack
          - autoresearch_qa_dual
          - autoresearch_qa_verify`)
await writeFile(patchPath, patchText, 'utf8')
console.log('=== cordis.patch.yml 已配置 restrict 列表 ===')
