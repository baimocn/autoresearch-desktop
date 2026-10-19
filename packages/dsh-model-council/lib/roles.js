/**
 * 模型议会 —— 身份分层与举证义务。
 *
 * ## 为什么是「议会」而不是「群聊」
 *
 * 让几个模型围绕一个议题自由发言，最常见的失败是**趋同**：后发言者顺着
 * 先发言者的语气补充，最后得到一个「大家都同意」的结论 —— 而分歧不是被
 * 解决了，是被**抹平**了。三个模型若共享同一批训练偏差，它们会一起错，
 * 而且「多数一致」会让这个错误显得更可信。
 *
 * 所以这里给每个身份**固定且互不重复的举证义务**，让分歧必须被写下来：
 *
 *   议员   —— 必须给出一个明确主张，并为它负责（不许罗列方案让人挑）
 *   对抗者 —— 必须找出 ≥3 个具体失败模式（找不到就明说，不许编造凑数）
 *   裁决者 —— 必须通读全部发言后给出裁定，且必须写清「什么证据会推翻它」
 *
 * 三者不是「权重不同的投票者」，而是**不同职能**：提案、攻击、定夺。
 * 裁决者不是「最后投票的那个」，它的产出必须交代理由与可推翻条件 ——
 * 一个不能被推翻的裁定，等于没有裁定。
 *
 * @module dsh-model-council/lib/roles
 */

/** 三种身份。`order` 决定议事顺序：议员先陈述，对抗者后攻击，裁决者最后定夺。 */
export const TIERS = Object.freeze({
  councilor: {
    id: 'councilor',
    label: '议员',
    order: 1,
    obligation: '给出一个明确主张：你的判断、判断的依据、预期收益，以及你认为它最可能失败的地方。',
    mustNot: '不要罗列多个方案让裁决者自己挑。选一个，并为它负责。',
    /** 是否参与「开一轮」；裁决者只在被要求裁定时发言。 */
    speaksInRound: true,
  },
  adversary: {
    id: 'adversary',
    label: '对抗者',
    order: 2,
    obligation: '必须找出至少 3 个具体的失败模式、反例或未验证假设，逐条编号。',
    mustNot: '找不到就明确写「我找不到」——不得为凑数编造，也不得复述其他成员的话。',
    speaksInRound: true,
  },
  adjudicator: {
    id: 'adjudicator',
    label: '裁决者',
    order: 3,
    obligation: '通读全部议事记录后作出裁定：①结论（采纳 / 不采纳 / 条件采纳）②理由（依据了哪位成员的哪条论证）'
      + '③执行条件与不可逆性 ④什么证据会推翻本裁定。',
    mustNot: '不得简单取多数意见，也不得和稀泥。裁定必须能被推翻 —— 写不出推翻条件就等于没裁定。',
    speaksInRound: false,
  },
})

export const TIER_IDS = Object.freeze(Object.keys(TIERS))

export function isTierId(value) {
  return typeof value === 'string' && Object.hasOwn(TIERS, value)
}

export function tierLabel(value) {
  return TIERS[value]?.label ?? '未分层'
}

/**
 * 每路共同的议事纪律。
 *
 * 这几条不是礼貌用语，各自堵一个具体的坏输出：
 *   · 「不要模拟其他成员」—— 否则模型会写出「议员乙可能会说……」这种假发言，
 *     把真实分歧伪装成已经讨论过了。
 *   · 「区分事实与判断」—— 让裁决者知道哪句可以追责。
 *   · 「缺信息就说缺什么」—— 挡住用推测填空，那是幻觉的主要入口。
 *   · 「不复述议事记录」—— 复述会让上下文膨胀并掩盖「本轮没有新信息」。
 */
const COMMON_DISCIPLINE = [
  '你在「多模型议会」中担任一个固定身份，与其他成员共同审议同一个议题。',
  '你的发言会进入共享议事记录，其他成员与裁决者都会读到。',
  '',
  '## 议事纪律',
  '',
  '- 只输出你这个身份的结论，**不要模拟其他成员发言**。',
  '- 明确区分「事实」与「判断」：事实要给依据，判断要说理由。',
  '- 关键信息缺失到无法判断时，直接写缺什么，不要用推测填空。',
  '- 不要复述议事记录里已有的内容，决策者已经读过了。',
]

/** 把议事记录渲染成纯文本。用户发言标为「主持人」。 */
export function renderTranscript(transcript) {
  if (!Array.isArray(transcript) || transcript.length === 0) return '（尚无发言）'
  return transcript.map((entry) => {
    const who = entry.kind === 'user'
      ? '主持人'
      : `${entry.speakerName ?? '成员'}·${tierLabel(entry.tier)}`
    return `【${who}】\n${entry.text ?? ''}`
  }).join('\n\n')
}

/**
 * 一次发言的系统提示词 —— 身份决定它。
 * 这是本模块唯一影响输出质量的地方，值得写清楚。
 */
export function buildSystemPrompt(tier) {
  const role = TIERS[tier]
  if (role === undefined) throw new Error(`未知身份：${JSON.stringify(tier)}`)
  return [
    ...COMMON_DISCIPLINE,
    '',
    `## 你的身份：${role.label}`,
    '',
    '### 你的举证义务',
    '',
    role.obligation,
    '',
    '### 禁止事项',
    '',
    role.mustNot,
  ].join('\n')
}

/**
 * 一次发言的用户提示词：议题 +（可选）候选选项 + 至今全部议事记录 + 现在轮到你。
 *
 * 议事记录整段注入（而不是只给增量）：无状态直连没有会话记忆，只给增量
 * 会让后发言者看不到先发言者的论据，对抗就退化成各说各话。
 *
 * `options` 非空时进入**选项裁定**形态 —— 这是「议会替代人工」的关键：
 * 人类在对话里做的选择，通常就是在几个方案里挑一个。此时三种身份的
 * 举证义务都要改口径，否则议员会中立地罗列全部选项（等于没选），
 * 裁决者会给一个「都行，看情况」的裁定（等于没裁）。
 */
export function buildUserPrompt({ tier, topic, transcript, options, context }) {
  const role = TIERS[tier]
  const hasOptions = Array.isArray(options) && options.length > 0

  const lines = ['## 议题', '', topic, '']
  // 本轮上下文：把会话进行到这里的真实处境带进来，否则议会只能对着一个
  // 孤零零的问题做抽象判断 —— 那正是「替代人工」失败的原因。
  if (typeof context === 'string' && context.trim() !== '') {
    lines.push('## 本轮上下文（会话进行到此处的事实，按此判断）', '', context.trim(), '')
  }
  if (hasOptions) {
    lines.push('## 候选选项（必须从中选择，不要新增选项）', '')
    options.forEach((option, index) => lines.push(`${index + 1}. ${option}`))
    lines.push('')
  }
  lines.push('## 议事记录', '', renderTranscript(transcript), '', '## 现在轮到你', '')

  if (role?.id === 'adjudicator') {
    if (hasOptions) {
      lines.push(
        '请以「裁决者」身份作出裁定。**必须选定恰好一个候选选项**，不要给区间、不要和稀泥。',
        '',
        '输出格式 —— 第一行必须是选定行，选项文字**照抄**（便于机器解析）：',
        '',
        '选定：<选项原文>',
        '',
        '然后依次写：',
        '1. 理由：你采纳或否定了哪位成员的哪条论证，逐条对应',
        '2. 执行条件与不可逆性：什么前提下执行，代价是什么，可否回退',
        '3. 推翻条件：出现什么证据你会改变本裁定',
      )
    } else {
      lines.push(
        '请以「裁决者」身份作出裁定。你的裁定必须包含四部分：',
        '1. 结论：采纳 / 不采纳 / 条件采纳（三选一，不要给区间）',
        '2. 理由：你采纳或否定了哪位成员的哪条论证，逐条对应',
        '3. 执行条件与不可逆性：什么前提下执行，代价是什么，可否回退',
        '4. 推翻条件：出现什么证据你会改变本裁定',
      )
    }
    return lines.join('\n')
  }

  if (hasOptions) {
    lines.push(role?.id === 'councilor'
      ? '请以「议员」身份发言：**在候选选项中支持一个**，说明你的理由、预期收益，以及它最可能失败的地方。不要中立地罗列所有选项 —— 那是没做选择。'
      : '请以「对抗者」身份发言：指出**若选了某个候选选项会怎样失败**，至少 3 条具体失败模式，逐条编号，且必须覆盖不止一个选项。不得为凑数编造。')
    return lines.join('\n')
  }

  lines.push(`请以「${role?.label ?? '成员'}」身份发言，严格履行你的举证义务。`)
  return lines.join('\n')
}

/** 议会配置的身份结构校验（与 participants 的字段校验分开，各管一层）。 */
export function validateTierComposition(participants) {
  const problems = []
  const tiers = (participants ?? []).map((item) => item?.tier)
  const count = (tier) => tiers.filter((value) => value === tier).length

  if (count('adjudicator') !== 1) {
    problems.push(`裁决者必须恰好 1 位（当前 ${count('adjudicator')} 位）—— 多个裁决者会给出互相矛盾的裁定`)
  }
  if (count('councilor') < 1) {
    problems.push('至少需要 1 位议员 —— 没有主张就无从审议')
  }
  if (count('adversary') < 1) {
    problems.push('至少需要 1 位对抗者 —— 没有对抗的议会只是并行自说自话，暴露不了偏差')
  }
  return problems
}
