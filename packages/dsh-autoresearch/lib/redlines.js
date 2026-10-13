/**
 * 红线静态扫描器 —— PRD 七条红线中尚未实现的两条。
 *
 * ## 为什么单独一个模块
 *
 * `gates.js` 已有 800+ 行，覆盖 G-CONTRACT / G-FEASIBILITY / G-DOCKERFILE /
 * G-TRAJECTORY / G-REPLAY-CONTRACT / G-SINGLE-SOURCE / G-PACK-VERIFY。
 * 把两条新的纯静态扫描塞进去会让它继续膨胀，而这两条的输入输出都自成一类
 * （扫源码文本，产问题清单），与门禁的"读 task.toml 判契约"不是一回事。
 *
 * 所以拆出来：`gates.js` 只调用 `scanRedLines()` 并把结果折成检查项。
 * 扫描逻辑改写、关键词扩充、误报调优都在本文件内完成，不牵动门禁。
 *
 * ## 已实现的红线（不在这里重复）
 *
 * · 红线 2 预算公平  → G-FEASIBILITY（seed 集/预算对齐）
 * · 红线 3 原生 NOP  → nop_preflight.py（随包 SOP 工具）
 * · 红线 4 哈希对齐  → G-CONTRACT（task_content_sha256 覆盖四路径）
 * · 红线 5 数学标定  → G-FEASIBILITY（R_LO/R_HI、3σ、5σ）
 * · 红线 7 隔离      → G-DOCKERFILE（G3.2 私有内容不得进 Agent 镜像）
 *
 * ## 本文件负责
 *
 * · 红线 1：Reference 不得读取验证集/测试集标签进训练
 * · 红线 6：严禁 DinD；内场不接受 Compose 交付
 *
 * @module dsh-autoresearch/lib/redlines
 */

/**
 * 红线 1 —— 数据泄露。
 *
 * ## 判据为什么要分档，不能一律命中即拦
 *
 * 朴素的"出现 val/test 就报错"会产生大量误报：`val_loader`、`val_accuracy`
 * 在正常评测代码里到处都是，写进训练的循环外也会出现。误报的代价很实际 ——
 * 一旦这条检查经常误报，使用者就学会忽略它，真正泄露时也不会看。
 *
 * 所以分三档：
 *   · `leak`    训练路径上出现测试/验证集**标签**读取 → 硬失败
 *   · `suspect` 训练路径上出现验证集**数据**读取 → 需人工确认
 *   · `mention` 仅出现在评估/日志语境 → 只记录，不拦
 *
 * 判定"是否在训练路径上"用启发式：看该行附近有没有训练循环/反传/优化器
 * 调用，或者所在函数名是否含 train。启发式会有漏，因此所有 `mention`
 * 也会如实列出，不做静默丢弃。
 */

/** 数据集标识：命中即说明在碰验证/测试集。 */
const EVAL_SET = String.raw`(?:val|valid|validation|test|eval|holdout|dev_set|held_?out)`

/** 标签类读取：`labels`、`y_val`、`targets`、`gt` 等。 */
const LABEL_READ = String.raw`(?:labels?|targets?|y_?(?:val|test|eval)|ground[_\s]?truth|\bgt\b|annotations?)`

/** 训练语境：训练循环、反传、优化器。 */
const TRAIN_CONTEXT = String.raw`(?:\.backward\s*\(|optimizer\.step|loss\.backward|for\s+.*\s+in\s+.*train|\.fit\s*\(|train_loop|training_step|\.train\s*\(\s*\))`

/**
 * 扫描一个源文件是否为"在训练中读取评测集标签"。
 *
 * ## 为什么必须用滑动窗口而不是逐行匹配
 *
 * 实测过的漏报：把评测集喂进训练时，**集合名与标签绑定常常不在同一行**。
 *
 *   val_loader = DataLoader(ValDataset(), batch_size=32)
 *   for x, y in val_loader:        ← 这里才绑定 y 与评测集
 *       loss = criterion(model(x), y)
 *       loss.backward()             ← 这里才是训练
 *
 * 逐行看任何一行都不含"集合名 + 标签"的组合，于是漏报。所以按
 * **窗口**判定：把邻近若干行合起来看，只要窗口内同时出现
 * 「评测集标识」与「标签绑定」且处于训练语境，即判 leak。
 *
 * 代价是窗口越大误报越多，所以窗口只取前后各 4 行，并要求训练语境
 * （backward / optimizer.step / train 循环）同时成立。
 *
 * @param {string} text 源码文本
 * @param {string} [filename] 文件名（用于语境判断，可省略）
 * @returns {{level: string, line: number, code: string, text: string}[]}
 */
export function scanDataLeakage(text, filename = '') {
  const findings = []
  const lines = text.split(/\r?\n/)
  const WINDOW = 4

  const evalSetRe = new RegExp(EVAL_SET, 'i')
  const labelRe = new RegExp(LABEL_READ, 'i')
  // 评测集标识 + 标签读取在同一小段文本内（允许跨行，用 [\s\S] 而非 [^\n]）。
  const bothRe = new RegExp(
    `${EVAL_SET}[\\s\\S]{0,120}?${LABEL_READ}|${LABEL_READ}[\\s\\S]{0,120}?${EVAL_SET}`,
    'i',
  )
  // 仅凭标签读取（无集合名）也构成强信号 —— 例如 `gt = load_ground_truth()`
  // 后直接 `loss.backward()`。这类写法不需要出现 val/test 字样就已经在
  // 拿评测真值训练了，若要求必须同时出现集合名就会漏掉它（实测漏报）。
  //
  // 边界用 `(?<![A-Za-z0-9])` / `(?![A-Za-z0-9])` 而不是 `\b`：
  // 下划线在正则里属于单词字符，所以 `\bground_truth\b` 匹配不了
  // `load_ground_truth()`（前面是 `_`）。实测这个差别造成漏报。
  const strongLabelRe = /(?<![A-Za-z0-9])(?:ground[_\s]?truth|gt_labels?|test_labels?|val_labels?|y_test|y_val)(?![A-Za-z0-9])/i
  // 解包绑定：`for x, y in val_loader:` 把评测集的标签绑到 y。
  // 这是最常见的泄露形态，而它在字面上既没有 "label" 也没有 "target"，
  // 只靠词表必然漏报（实测漏报）。所以单独识别「遍历评测集并解包多个变量」。
  const unpackOverEvalRe = new RegExp(
    `for\\s+[^:\\n]*,[^:\\n]*\\s+in\\s+[^:\\n]*${EVAL_SET}`, 'i',
  )
  const evalReadRe = new RegExp(`(?:load|read|open|getitem|dataloader|dataset|split)[^\\n]{0,40}${EVAL_SET}`, 'i')
  const trainCtxRe = new RegExp(TRAIN_CONTEXT, 'i')
  // 评估语境：指标、日志、断言 —— 这些位置读标签是正常的。
  const evalCtxRe = /(?:accuracy|precision|recall|f1|metric|evaluate|eval_|report|print|log|assert|score|auc|mAP|iou|confusion)/i

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const from = Math.max(0, i - WINDOW)
    const to = Math.min(lines.length, i + WINDOW + 1)
    const window = lines.slice(from, to).join('\n')

    // 本行是否涉及评测集或标签，或窗口内有组合信号。
    const lineHasEval = evalSetRe.test(line)
    const lineHasLabel = labelRe.test(line) || strongLabelRe.test(line) || unpackOverEvalRe.test(line)
    const windowHasBoth = bothRe.test(window) || strongLabelRe.test(window) || unpackOverEvalRe.test(window)
    const windowHasEvalRead = evalReadRe.test(window)

    // 完全无关的行直接跳过，避免把整个文件都当候选。
    if (!lineHasEval && !lineHasLabel && !windowHasBoth && !windowHasEvalRead) continue

    const inTrain = trainCtxRe.test(window)
    const inEval = evalCtxRe.test(line)

    let level
    if (windowHasBoth && inTrain && !inEval) level = 'leak'
    else if (windowHasBoth && inEval) level = 'mention'
    else if (windowHasEvalRead && inTrain) level = 'suspect'
    else if (lineHasEval || lineHasLabel) level = 'mention'
    else level = 'suspect'

    findings.push({
      level,
      line: i + 1,
      code: windowHasBoth ? 'EVAL_LABEL_READ' : 'EVAL_DATA_READ',
      text: trimmed.slice(0, 160),
    })
  }

  // 同一处泄露会在窗口内被多行重复命中，按 (level, code) 归并到首个行号，
  // 避免一份文件报出几十条同源发现而淹没真信号。
  const merged = []
  const seen = new Set()
  for (const f of findings) {
    const key = `${f.level}:${f.code}:${f.text}`
    if (seen.has(key)) continue
    seen.add(key)
    merged.push(f)
  }
  return merged
}

/**
 * 红线 6 —— 架构交付。
 *
 * ## 为什么必须是硬失败而不是警告
 *
 * 内场不交付依赖 Docker 的方案，这是**架构约束**而非偏好。DinD 在评测
 * 环境下会因缺 privileged 权限或嵌套存储驱动直接跑不起来，属于"静态全绿、
 * 真机必挂"。这类问题在提交后才暴露的代价极高，所以命中即 fail。
 *
 * ## 覆盖哪些写法（吸取 F1 教训）
 *
 * 上一轮复审发现 G3.1 的 COPY 正则 `/^\s*COPY\s+(\S+)/gim` 漏掉 7 种
 * 等价写法（引号、--from、多阶段、反斜杠续行等）。DinD 检测不能重复这个
 * 错误 —— 这里把每条规则的多种写法都列出来，并写消融实验覆盖。
 */
export function scanArchitecture(text, filename = '') {
  const findings = []
  const lines = text.split(/\r?\n/)

  /** 每条规则列出该模式的多种等价写法。 */
  const RULES = [
    {
      id: 'DIND_SOCKET',
      level: 'fail',
      // 挂载宿主 docker socket —— DinD 最典型的形态。
      // 覆盖：-v /var/run/docker.sock、--mount ... docker.sock、DOCKER_HOST 指向
      patterns: [
        /docker\.sock/i,
        /\/var\/run\/docker/i,
        /\/run\/docker\.sock/i,
      ],
      why: '挂载宿主 Docker socket 等价于把宿主控制权交给容器，内场严禁',
    },
    {
      id: 'DIND_DAEMON',
      level: 'fail',
      // 在容器里起一个 docker daemon。
      patterns: [
        /\bdockerd\b/i,
        /service\s+docker\s+start/i,
        /systemctl\s+start\s+docker/i,
        /DOCKER_HOST\s*=\s*unix:/i,
        /DOCKER_HOST\s*=\s*tcp:/i,
      ],
      why: '在容器内启动 docker daemon 属于 DinD，评测环境无 privileged 权限必然失败',
    },
    {
      id: 'DIND_INSTALL',
      level: 'fail',
      // 在镜像里装 docker。
      //
      // 包管理器动词不统一，必须逐个覆盖（实测 `apk add` 曾漏报）：
      //   apt-get/apt/yum/dnf 用 install，apk 用 add，pip/conda/mamba 用 install。
      patterns: [
        /(?:apt-get|apt|yum|dnf)\s+(?:install|add)[^\n]*\bdocker(?:-ce|-cli|\.io)?\b/i,
        /apk\s+(?:add|install)[^\n]*\bdocker(?:-ce|-cli|\.io)?\b/i,
        /pip\s+install[^\n]*\bdocker\b/i,
        /(?:conda|mamba)\s+install[^\n]*\bdocker\b/i,
      ],
      why: '在镜像中安装 docker 客户端/引擎，指向 DinD 用法',
    },
    {
      id: 'COMPOSE',
      level: 'fail',
      // 内场不交付依赖 Compose 的方案。
      patterns: [
        /docker[\s-]compose/i,
        /^\s*services\s*:/m,
        /compose\.ya?ml/i,
      ],
      why: '内场不交付依赖 Docker Compose 的方案，优先单容器',
    },
  ]

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    // 注释行不算 —— 但仅限整行注释，避免漏掉行尾注释里藏的真实指令。
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue

    for (const rule of RULES) {
      for (const pattern of rule.patterns) {
        if (pattern.test(line)) {
          findings.push({
            level: rule.level,
            id: rule.id,
            line: i + 1,
            text: trimmed.slice(0, 160),
            why: rule.why,
          })
          break
        }
      }
    }
  }
  return findings
}

/**
 * 运行两条红线扫描，产出可读报告。
 *
 * @param {{files: {path: string, text: string}[], scope: string}} input
 *   scope 用于说明扫的是 reference/ 还是 starter/，写进报告便于追责。
 */
export function scanRedLines(input) {
  const files = Array.isArray(input?.files) ? input.files : []
  const leakFindings = []
  const archFindings = []

  for (const file of files) {
    if (typeof file?.text !== 'string') continue
    for (const f of scanDataLeakage(file.text, file.path)) {
      leakFindings.push({ ...f, path: file.path })
    }
    for (const f of scanArchitecture(file.text, file.path)) {
      archFindings.push({ ...f, path: file.path })
    }
  }

  return {
    scope: input?.scope ?? 'unknown',
    scannedFiles: files.length,
    leak: {
      hard: leakFindings.filter((f) => f.level === 'leak'),
      suspect: leakFindings.filter((f) => f.level === 'suspect'),
      mention: leakFindings.filter((f) => f.level === 'mention'),
    },
    architecture: {
      hard: archFindings.filter((f) => f.level === 'fail'),
    },
  }
}
