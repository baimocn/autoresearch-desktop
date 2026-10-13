/**
 * 决议审议台 —— 多模型对抗审议，用于方向决策。
 *
 * ## 第一性原理：为什么不是「多模型讨论」
 *
 * 「让几个模型讨论出方案」有一个隐藏陷阱。若实现方式是各写一版再取共识，
 * 分歧会被**平均掉**而不是被**解决**。三个模型若共享同一批训练偏差，
 * 它们会一起错，而且因为"多数一致"让错误显得更可信 —— 这反而**升高**风险。
 *
 * 真正降低风险的结构是**对抗**，不是投票：
 *
 *   提案方给出方向 → 反例方**必须**找出失败模式 → 代价方给出资源与不可逆性
 *
 * 产出不是「一个更好的方案」，而是「一个方案 + 已知的反驳 + 明确的取舍」。
 * 让决策者看到风险边界，而不是被一个自信的答案安抚。
 *
 * ## 与双路质检的关系
 *
 * 双路质检是「验证已经做完的题」，审议台是「审议还没成形的方向」。
 * 两者共用隔离基建（独立 DSH_HOME、独立凭据、独立进程），
 * 但**结论语义完全不同**：
 *
 *   · 质检    → fail-closed，有 PASS/NOT_READY，接发布门
 *   · 审议台  → 不判定对错，只暴露分歧，**不接门禁**
 *
 * ## 为什么不接门禁（这条是刻意的）
 *
 * 一旦审议结论成为 `advance` 的前置条件，它就会退化成合规仪式 ——
 * 使用者会为了过门而凑一份"看起来被审议过"的记录，而不是真的用它做决策。
 * 所以本模块只产出材料，不产出判定，也不被任何门禁读取。
 *
 * @module dsh-autoresearch-qa/lib/deliberation
 */

import { mkdir, writeFile, readFile, stat } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'

/** 审议角色。每个角色有**不同的举证义务**，这是对抗性的来源。 */
export const ROLES = Object.freeze({
  propose: {
    id: 'propose',
    label: '提案方',
    obligation: '给出一个明确方向，说明依据、预期收益、以及你认为它可能失败的地方。',
    mustNot: '不要罗列多个方向让决策者自己挑。选一个，并为它负责。',
  },
  counter: {
    id: 'counter',
    label: '反例方',
    obligation: '必须找出至少 3 个具体的失败模式、反例或未验证假设。',
    mustNot: '找不到就明确写"我找不到"，**不得**为了凑数编造，也不得复述提案方的话。',
  },
  cost: {
    id: 'cost',
    label: '代价方',
    obligation: '给出该方向的资源、时间、许可代价，并判断其不可逆性。',
    mustNot: '不要评价方向好不好。只算代价，让决策者自己权衡值不值。',
  },
})

/**
 * 校验审议配置。
 *
 * 与双路质检的关键差别：这里允许 **2 路以上**，且不要求身份两两不同 ——
 * 因为"同一个模型跑两个角色"本身是有意义的对照（能看出角色提示词
 * 是否真的改变了输出，还是模型只是在复读自己）。
 * 但**必须如实标注**，不能假装成多模型。
 */
export function validateBoard(lanes) {
  const problems = []
  if (!Array.isArray(lanes) || lanes.length < 2) {
    problems.push('审议台至少需要 2 路（提案 + 反例）')
    return problems
  }
  if (lanes.length > 6) problems.push('审议台最多 6 路，再多会稀释每个角色的举证义务')

  lanes.forEach((lane, i) => {
    const at = `第 ${i + 1} 路`
    if (typeof lane?.route !== 'string' || lane.route.trim() === '') problems.push(`${at}：route 不能为空`)
    if (typeof lane?.model !== 'string' || lane.model.trim() === '') problems.push(`${at}：model 不能为空`)
    if (!Object.hasOwn(ROLES, lane?.role ?? '')) {
      problems.push(`${at}：role 必须是 ${Object.keys(ROLES).join(' / ')} 之一`)
    }
  })

  // 反例方必须存在。没有反例方的审议只是并行的自说自话。
  const roles = lanes.map((l) => l?.role)
  if (!roles.includes('counter')) {
    problems.push('必须至少有一路担任反例方（counter）—— 没有反例的审议无法暴露偏差')
  }
  return problems
}

/**
 * 判定「独立性」的真实等级。
 *
 * 不假装多路就是独立：同一 provider+model 的多路只是**同一模型的多次采样**，
 * 它能减少随机性，但不能减少系统性偏差。必须如实分级。
 */
export function independenceLevel(lanes) {
  const identities = lanes.map((l) => `${l.route}/${l.model}`)
  const distinct = new Set(identities)
  const providers = new Set(lanes.map((l) => l.route))

  if (distinct.size === 1) return { level: 'single', note: '同一模型多次采样：只能减少随机性，不能减少系统性偏差' }
  if (providers.size === 1) return { level: 'same-provider', note: '同一提供方的不同模型：偏差部分相关，独立性中等' }
  return { level: 'multi-provider', note: '跨提供方：独立性最高' }
}

/** 角色化的审议提示词。这是本模块唯一影响输出质量的地方，值得写清楚。 */
export function buildDeliberationPrompt(input) {
  const role = ROLES[input.role]
  const lines = [
    `你在一个「方案审议台」中担任**${role.label}**。`,
    '',
    '## 待审议的方向',
    '',
    input.question,
    '',
  ]
  if (input.context !== undefined && input.context.trim() !== '') {
    lines.push('## 背景材料', '', input.context, '')
  }
  lines.push(
    '## 你的举证义务',
    '',
    role.obligation,
    '',
    `## 禁止事项`,
    '',
    role.mustNot,
    '',
    '## 输出纪律',
    '',
    '- 只输出你的角色结论，不要模拟其他角色的发言。',
    '- 不要为了显得全面而写"另一方面"。你的角色要求的是立场，不是平衡。',
    '- 明确区分「我说的是事实」与「我说的是判断」。事实要给出来源，判断要说依据。',
    '- 如果关键信息缺失到无法判断，直接写缺什么，不要用推测填空。',
    '- 不要复述背景材料。决策者已经读过了。',
  )
  return lines.join('\n')
}

/** 单路执行环境：独立 DSH_HOME 与凭据，和双路质检同一套隔离思路。 */
export function boardLaneEnvironment(baseEnvironment, lane, laneRoot) {
  const environment = {
    ...baseEnvironment,
    DSH_HOME: join(laneRoot, 'dsh-home'),
    NO_COLOR: '1',
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    DSH_PERMISSION_MODE: 'danger-full-access',
  }
  if (typeof lane.credentialEnv === 'string' && typeof lane.apiKey === 'string' && lane.apiKey !== '') {
    environment[lane.credentialEnv] = lane.apiKey
  }
  return environment
}

/**
 * 聚合审议结果。
 *
 * **刻意不做的事**：不裁判谁对，不给总分，不投票。
 * 只做三件事：提取每个角色的结论、标出分歧点、标出反例方提出的失败模式。
 *
 * 理由：审议的价值在于让决策者看到"这里有争议"，而不是替他决定。
 * 一旦聚合器开始裁判，它就变成了另一个会犯错的单点。
 */
export function aggregateDeliberation(lanes) {
  const byRole = {}
  for (const lane of lanes) {
    const role = lane.role ?? 'unknown'
    if (!byRole[role]) byRole[role] = []
    byRole[role].push({
      laneIndex: lane.laneIndex,
      identity: `${lane.route}/${lane.model}`,
      text: lane.text ?? '',
      ok: lane.exitCode === 0 && (lane.text ?? '').trim() !== '',
      exitCode: lane.exitCode,
      timedOut: lane.timedOut ?? false,
    })
  }

  const failed = lanes
    .filter((l) => l.exitCode !== 0 || (l.text ?? '').trim() === '')
    .map((l) => ({ laneIndex: l.laneIndex, role: l.role, exitCode: l.exitCode, timedOut: l.timedOut ?? false }))

  // 分歧不是错误，是产物。但角色缺失是真问题 —— 没有反例方的审议是无效的。
  const missingRoles = ['propose', 'counter'].filter((r) => !byRole[r] || byRole[r].every((x) => !x.ok))

  return {
    byRole,
    failed,
    missingRoles,
    // 明确写出这个结论**不能**用来做什么，避免被误用。
    disclaimer: '本审议结果是决策辅助材料，不是门禁判定，也不能替代实测证据。'
      + '审议说"可行"不等于 G-FEASIBILITY 通过，那必须实测 B/R 与 σ_B。',
  }
}

/** 跑一路：起一个 headless dsh 进程，返回它的输出文本。 */
export function runBoardLane(input) {
  return new Promise((resolvePromise) => {
    const prompt = buildDeliberationPrompt({
      role: input.role,
      question: input.question,
      context: input.context,
    })

    let child
    try {
      child = spawn(input.dshCommand ?? 'node', [input.dshEntry, '--profile', 'headless', prompt], {
        cwd: input.cwd,
        env: input.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      resolvePromise({ ...input, text: '', exitCode: null, spawnError: String(error.message) })
      return
    }

    let stdout = ''
    let stderr = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, input.timeoutMs ?? 30 * 60 * 1000)

    child.stdout.on('data', (c) => { stdout += c })
    child.stderr.on('data', (c) => { stderr += c })
    child.on('error', (error) => {
      clearTimeout(timer)
      resolvePromise({ ...input, text: stdout, stderr, exitCode: null, spawnError: String(error.message), timedOut })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolvePromise({ ...input, text: stdout, stderr, exitCode: code, spawnError: null, timedOut })
    })
  })
}

/** 主流程：跑多路审议并落盘留痕。 */
export async function runDeliberation(input) {
  const problems = validateBoard(input.lanes)
  if (problems.length > 0) {
    const error = new Error(`审议配置不合法：${problems.join('；')}`)
    error.problems = problems
    throw error
  }

  const outDir = isAbsolute(input.outDir) ? input.outDir : resolve(process.cwd(), input.outDir)
  await mkdir(outDir, { recursive: true })

  const independence = independenceLevel(input.lanes)
  const startedAt = new Date().toISOString()

  const lanes = await Promise.all(input.lanes.map(async (lane, index) => {
    const laneIndex = index + 1
    const laneRoot = join(outDir, `lane-${laneIndex}`)
    await mkdir(laneRoot, { recursive: true })
    const env = boardLaneEnvironment(input.baseEnvironment ?? process.env, lane, laneRoot)
    const result = await runBoardLane({
      ...lane,
      laneIndex,
      question: input.question,
      context: input.context,
      cwd: laneRoot,
      env,
      dshEntry: input.dshEntry,
      timeoutMs: input.timeoutMs,
    })
    // 原始输出落盘，便于复核 —— 与双路质检同样留痕。
    await writeFile(join(laneRoot, 'deliberation.txt'), result.text ?? '', 'utf8')
    if (result.stderr) await writeFile(join(laneRoot, 'stderr.log'), result.stderr, 'utf8')
    return result
  }))

  const aggregate = aggregateDeliberation(lanes)
  const manifest = {
    kind: 'deliberation',
    startedAt,
    finishedAt: new Date().toISOString(),
    question: input.question,
    independence,
    lanes: lanes.map((l) => ({
      laneIndex: l.laneIndex,
      role: l.role,
      route: l.route,
      model: l.model,
      version: l.version ?? null,
      exitCode: l.exitCode,
      timedOut: l.timedOut ?? false,
      chars: (l.text ?? '').length,
    })),
    aggregate,
  }
  await writeFile(join(outDir, 'deliberation-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')

  return { outDir, lanes, aggregate, independence, manifest }
}
