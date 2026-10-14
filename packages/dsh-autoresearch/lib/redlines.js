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
 * · 红线 4 哈希对齐  → **未实现**（G-CONTRACT 无哈希逻辑；详见 docs/red-lines.md）
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
 *   · `leak`    训练路径上读取测试/验证集**标签**，或求值评测集**注册** → 硬失败
 *   · `suspect` 训练路径上读取验证集**数据**，或训练期在评测集上评估 → 需人工确认
 *   · `mention` 评测/日志语境，或未构成训练路径证据的评测集引用 → 只记录，不拦
 *
 * 判定"是否在训练路径上"用启发式：看该行附近有没有训练循环/反传/优化器
 * 调用，或者所在函数名是否含 train。启发式会有漏，因此所有 `mention`
 * 也会如实列出，不做静默丢弃。
 */

// ── 标识符级判定 ───────────────────────────────────────────────────────────
//
// 用正则做**子串**匹配是误报的根源：`split_labels` 含 `labels`、
// `test_labels_format` 含 `labels`、`val_class_names` 含 `val`。每修一处就
// 冒出下一处 —— 因为判定依据（子串包含）本身是错的。
//
// 现在改成两级判据：
//   1. **标识符分量**：把标识符按 snake_case / camelCase 切成整分量再比较，
//      而不是判断子串是否包含；
//   2. **位置**：标签名只有落在数据位置（赋值、下标、属性、loss 实参、解包
//      遍历）才算「读标签」；作为调用名 / 循环变量 / def 名出现的标签词不算。
//
// 合起来：`split_labels(...)`（调用名）、`test_labels_format`（尾分量不是
// 标签词）、`for i, name in enumerate(val_class_names)`（词表不是数据容器）
// 都不再判泄露；`for x, y in val_loader`、`gt = load_ground_truth()` 仍然判。

/** 评测集词：必须作为标识符的某个**整分量**出现才算。 */
const EVAL_WORDS = new Set(['val', 'valid', 'validation', 'test', 'eval', 'holdout'])

/** 标签词：同上，按整分量比较。 */
const LABEL_WORDS = new Set(['label', 'labels', 'target', 'targets', 'annotation', 'annotations', 'gt'])

/**
 * 容器词。两个用途，都是「分量级」比较：
 *   · 解包遍历的评测集必须是**数据容器**（`val_loader`），不能是词表/配置
 *     （`val_class_names`、`test_config`）—— 这是 `for a, b in ...` 判定；
 *   · 标签词之后只允许跟容器/集合后缀（`val_labels_list` 是标签集合，
 *     `test_labels_format` / `val_labels_count` 不是标签本身）。
 */
const CONTAINER_WORDS = new Set([
  'loader', 'dataloader', 'dl', 'ds', 'dataset', 'datasets', 'data', 'set', 'sets',
  'df', 'frame', 'tensor', 'batch', 'batches', 'iter', 'iterator', 'generator',
  'pipe', 'pipeline', 'reader', 'stream', 'queue', 'split', 'fold', 'shard',
  'sample', 'samples', 'image', 'images', 'input', 'inputs', 'list', 'array',
  'arr', 'vec', 'vector', 'dict', 'map', 'table', 'json', 'npy', 'npz', 'pt',
  'pkl', 'csv', 'txt', 'file', 'path', 'h5',
])

/** 把一个标识符切成整分量：snake_case / kebab / 空格 / camelCase / 数字边界。 */
function identComponents(name) {
  const out = []
  for (const chunk of String(name).split(/[^A-Za-z0-9]+/)) {
    if (chunk === '') continue
    for (const part of chunk.split(/(?=[A-Z])/)) {
      if (part !== '') out.push(part.toLowerCase())
    }
  }
  return out
}

/** 文本里的全部标识符。 */
function identsOf(text) {
  return String(text).match(/[A-Za-z_]\w*/g) ?? []
}

const hasTrainWord = (c) => c.includes('train') || c.includes('training')
const hasContainerWord = (c) => c.some((x) => CONTAINER_WORDS.has(x))

/** 是否是「评测集」标识符：含评测集分量，或 ground_truth。 */
function isEvalName(name) {
  const c = identComponents(name)
  if (c.some((x) => EVAL_WORDS.has(x))) return true
  return c.includes('ground') && c.includes('truth')
}

/**
 * 是否是「标签」标识符：标签词是末分量，或其后只跟容器/集合后缀。
 *
 * `test_labels` / `val_targets` / `gt` / `y_val` / `val_labels_list` → 是；
 * `test_labels_format` / `val_labels_count` / `val_labels_helper` → 否。
 * 训练标签（`train_labels`）不算评测标签。
 */
function isLabelName(name) {
  const c = identComponents(name)
  if (c.length === 0) return false
  if (hasTrainWord(c)) return false
  if (c.includes('ground') && c.includes('truth')) return true
  if (c.length === 2 && c[0] === 'y' && EVAL_WORDS.has(c[1])) return true
  const idx = c.findIndex((x) => LABEL_WORDS.has(x))
  if (idx < 0) return false
  return c.slice(idx + 1).every((x) => CONTAINER_WORDS.has(x))
}

/** 表达式里是否含「评测集数据容器」标识符（`val_loader` / `test_dataset`）。 */
function exprHasEvalContainer(expr) {
  return identsOf(expr).some((n) => {
    const c = identComponents(n)
    return c.some((x) => EVAL_WORDS.has(x)) && hasContainerWord(c)
  })
}

/** 表达式里是否含「训练数据容器」标识符（`train_loader`）。 */
function exprHasTrainContainer(expr) {
  return identsOf(expr).some((n) => {
    const c = identComponents(n)
    return hasTrainWord(c) && hasContainerWord(c)
  })
}

/**
 * 剥离三引号块（docstring）内容，保留行号与行长。
 *
 * 实测误报：一句 docstring —— `"""注意：不要用 cfg.DATASETS.TEST 做训练。"""`
 * —— 被判成 leak，门禁硬拒一份**劝阻违规**的说明文字。注释与文档不是代码。
 */
function blankDocstrings(lines) {
  const out = []
  let delim = null
  for (const line of lines) {
    if (delim === null) {
      const dq = line.indexOf('"""')
      const sq = line.indexOf("'''")
      let idx = -1
      let quote = ''
      if (dq >= 0 && (sq < 0 || dq < sq)) { idx = dq; quote = '"""' }
      else if (sq >= 0) { idx = sq; quote = "'''" }
      if (idx < 0) { out.push(line); continue }
      const close = line.indexOf(quote, idx + 3)
      if (close >= 0) {
        out.push(line.slice(0, idx) + ' '.repeat(close + 3 - idx) + line.slice(close + 3))
      } else {
        delim = quote
        out.push(line.slice(0, idx) + ' '.repeat(line.length - idx))
      }
    } else {
      const close = line.indexOf(delim)
      if (close < 0) { out.push(' '.repeat(line.length)); continue }
      delim = null
      out.push(' '.repeat(close + 3) + line.slice(close + 3))
    }
  }
  return out
}

/** 右侧像「读取」而不是字面量：调用 / 下标 / 属性。 */
const READ_LIKE_RHS = /^\s*(?:[\w.]+\s*\(|[\w.]+\s*\[|[A-Za-z_]\w*\.[A-Za-z_]\w*)/

/** 该标识符在文本里是否处于**值位置**（后面不是调用括号）。 */
const isCalledName = (line, name, at) => /^\s*\(/.test(line.slice(at + name.length))

/**
 * 行内的标签绑定（数据位置上的标签名）。
 *
 * 数据位置：赋值左侧 + 右侧是读取、下标键、属性、loss 实参、赋值右侧的
 * 评测限定标签名。作为**调用名**出现（`split_labels(`、`load_labels(`）一律
 * 不算 —— 那正是原始误报的形态，也是需求明确要求排除的。
 *
 * @returns {{name: string, evalQualified: boolean}[]}
 */
function labelBindingsIn(line) {
  const out = []
  const seen = new Set()
  const add = (name, evalQualified) => {
    if (!isLabelName(name) || seen.has(name)) return
    seen.add(name)
    out.push({ name, evalQualified: evalQualified || isEvalName(name) })
  }

  // (a) 赋值：左侧标签名（`gt = load_ground_truth()`）+ 右侧读取里的
  //     评测限定标签名（`y = np.array(val_labels_list)`）。
  for (const m of line.matchAll(/(?:^|[^A-Za-z0-9_.])([A-Za-z_]\w*)\s*=\s*(?!=)([^\n]*)/g)) {
    const [, lhs, rhs] = m
    if (READ_LIKE_RHS.test(rhs)) {
      add(lhs, false)
      const off = line.indexOf(rhs)
      for (const name of identsOf(rhs)) {
        if (isCalledName(line, name, off + rhs.indexOf(name))) continue
        if (isEvalName(name)) add(name, true)
      }
    }
  }
  // (b) 按标签键取下标：`val_data["labels"]`
  for (const m of line.matchAll(/\[\s*['"]([^'"]+)['"]\s*\]/g)) add(m[1], false)
  // (c) 属性访问：`dataset.labels`（排除方法调用 `.labels(`）
  for (const m of line.matchAll(/\.\s*([A-Za-z_]\w*)(?!\s*\()/g)) add(m[1], false)
  // (d) loss/criterion 实参：`criterion(pred, val_labels)`；
  //     以调用形式出现的实参（`load_labels(x)`）不算。
  for (const m of line.matchAll(/\b(\w*(?:loss|criterion)\w*|cross_entropy|nll|bce|mse|mae|dice|focal|smooth_l1)\s*\(([^\n]*)/gi)) {
    const args = m[2]
    const off = line.indexOf(args)
    for (const name of identsOf(args)) {
      if (isCalledName(line, name, off + args.indexOf(name))) continue
      add(name, false)
    }
  }
  return out
}

/** 行内是否「解包遍历评测集数据容器」：`for x, y in val_loader:`。 */
function unpackOverEval(line) {
  for (const m of line.matchAll(/for\s+([^:\n]+?)\s+in\s+([^:\n]+)/g)) {
    if (/,/.test(m[1]) && exprHasEvalContainer(m[2])) return true
  }
  return false
}

/**
 * 行内是否「遍历训练数据容器」：`for batch in train_loader:`。
 *
 * 用「数据容器」而不是「名字里有 train」来判 —— 后者会把
 * `for label in train_class_names`（遍历训练词表）误当训练语境。
 * 单变量训练循环（`for batch in train_loader:`）也必须算，因为训练步常封在
 * `train_step()` 里、窗口内看不到字面 `.backward`。
 */
function forOverTrainContainer(line) {
  for (const m of line.matchAll(/for\s+([^:\n]+?)\s+in\s+([^:\n]+)/g)) {
    if (exprHasTrainContainer(m[2])) return true
  }
  return false
}

/** 行内是否「读取评测集数据」：读取动词后 40 字符内出现评测集标识符。 */
function evalDataRead(line) {
  for (const m of line.matchAll(/(?:load|read|open|getitem|dataloader|dataset|split)/gi)) {
    const seg = line.slice(m.index, m.index + 40)
    if (identsOf(seg).some(isEvalName)) return true
  }
  return false
}

/** 训练语境：反传、优化器、训练步（for 循环由 forOverTrainContainer 单独判）。 */
const TRAIN_CONTEXT = String.raw`(?:\.backward\s*\(|optimizer\.step|loss\.backward|\.fit\s*\(|train_loop|training_step|\.train\s*\(\s*\))`

/**
 * 训练路径上求值**评测集注册**。
 *
 * 覆盖 `cfg.DATASETS.TEST`、`cfg["DATASETS"]["TEST"]`、`getattr(..., "TEST")`。
 * 训练进程求值评测集注册，会迫使评测集的注册与标注路径进入 Agent 可见的
 * 镜像 —— 这是红线的正中心（实测 AutoRe1852 的真违规）。
 */
const EVAL_REGISTRATION = [
  String.raw`(?<![A-Za-z0-9_])DATASETS\s*\.\s*TEST(?![A-Za-z0-9_])`,
  String.raw`\[\s*['"]DATASETS['"]\s*\]\s*\[\s*['"]TEST['"]\s*\]`,
  String.raw`getattr\s*\([^)\n]*DATASETS[^)\n]*,\s*['"]TEST['"]\s*\)`,
].join('|')

/** 训练期评估：`EVAL_PERIOD: 50000`、`val_check_interval=0.5`、`--eval-period 50000`。 */
const EVAL_PERIOD = [
  String.raw`(?<![A-Za-z0-9_])(?:EVAL_PERIOD|eval[-_]period|eval[-_]interval|eval[-_]steps|eval[-_]every[-_]n[-_]steps|val[-_]interval|val[-_]check[-_]interval|val[-_]every[-_]n[-_]steps|validation[-_]interval)\s*[:=]\s*(\d+(?:\.\d+)?)`,
  String.raw`--(?:eval[-_]period|eval[-_]interval|eval[-_]steps)[=\s]+(\d+)`,
].join('|')

/** 评测集加载器/数据集构造调用：`build_eval_loaders()` / `get_eval_dataset()`。 */
const EVAL_LOADER_CALL = String.raw`(?<![A-Za-z0-9_])(?:(?:get|build|make|create|load|prepare|setup|init)_\w*(?:eval|val|test)\w*|\w*(?:eval|val|test)_(?:loader|dataloader|dataset|data|set|iter|fold))\w*\s*\(`

/** 构建训练模型/训练配置的函数定义名（用于判断「训练路径上」）。 */
const TRAIN_FN = String.raw`\bdef\s+\w*(?:train|build_model|build_train|train_model|setup_train|configure|build_config|make_model)\w*\s*\(`

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
  // 先剥离 docstring —— 说明文字不是代码（实测一句劝阻违规的 docstring 被判 leak）。
  const lines = blankDocstrings(text.split(/\r?\n/))
  const WINDOW = 4

  const trainCtxRe = new RegExp(TRAIN_CONTEXT, 'i')
  // 评估语境：指标、日志、断言 —— 这些位置读标签是正常的。
  //
  // `no_grad` / `inference_mode` / `.eval()` 必须在内：`with torch.no_grad():`
  // 之后遍历 test_loader 是**教科书式的评测代码**，不是泄露。早期漏了它们，
  // 于是 AutoRe0566 的 workspace/reference 被判 6 处「训练路径读评测标签」——
  // 实际那 6 处是 `test_l2 = 0` 这样的指标累加器初始化，真正触发的是窗口里
  // 那句 `for x, y in test_loader:`。结果是合法的参考实现被 G-DOCKERFILE 硬拒。
  const evalCtxRe = /(?:accuracy|precision|recall|f1|metric|evaluate|eval_|report|print|log|assert|score|auc|mAP|iou|confusion|no_grad|inference_mode|\.eval\(\))/i

  // 红线 1 的正向规则（补漏报）。
  const evalRegRe = new RegExp(EVAL_REGISTRATION, 'i')
  const evalPeriodRe = new RegExp(EVAL_PERIOD, 'i')
  const evalLoaderCallRe = new RegExp(EVAL_LOADER_CALL, 'i')
  const trainFnRe = new RegExp(TRAIN_FN, 'i')
  // 整个文件是否是训练脚本（供评测集加载器调用判定用）。
  const fileHasTrainCtx = trainCtxRe.test(text)

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const trimmed = line.trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue

    const from = Math.max(0, i - WINDOW)
    const to = Math.min(lines.length, i + WINDOW + 1)
    const win = lines.slice(from, to)
    const window = win.join('\n')
    // 往上看一段，用于识别「所在函数是不是构建训练模型/训练配置」。
    const above = lines.slice(Math.max(0, i - 12), i + 1).join('\n')

    // ── 正向形态 A：训练路径上求值评测集注册（DATASETS.TEST） ──────────────
    //
    // 判定「训练路径」的证据，任一即可：
    //   · 窗口内有训练语境（反传/优化器/训练循环）
    //   · 窗口内同时出现 `DATASETS.TRAIN`（构建训练侧元数据时顺手取了评测侧）
    //   · 所在函数名是 train/build_model/setup 之类
    // 证据不足时落 suspect（G3.9 UNKNOWN，待人工确认），**不落 mention**。
    if (evalRegRe.test(line)) {
      const inEval = evalCtxRe.test(line) || evalCtxRe.test(window)
      const trainPath = trainCtxRe.test(window)
        || win.some(forOverTrainContainer)
        || /(?<![A-Za-z0-9_])DATASETS\s*\.\s*TRAIN(?![A-Za-z0-9_])/i.test(window)
        || trainFnRe.test(above)
      findings.push({
        level: (trainPath || !inEval) ? (trainPath ? 'leak' : 'suspect') : 'mention',
        line: i + 1,
        code: 'EVAL_REG_READ',
        text: trimmed.slice(0, 160),
      })
      continue
    }

    // ── 正向形态 B：训练期在评测集上评估（评测间隔非零） ───────────────────
    //
    // 只落 suspect：静态文本里无法证明「训练命令是否覆盖了 DATASETS.TEST」，
    // 证据不足以定 leak，如实留在待确认档。
    const periodMatch = evalPeriodRe.exec(line)
    if (periodMatch) {
      const period = Number(periodMatch[1] ?? periodMatch[2] ?? 0)
      if (period > 0) {
        findings.push({ level: 'suspect', line: i + 1, code: 'EVAL_PERIOD', text: trimmed.slice(0, 160) })
      }
      continue
    }

    // ── 正向形态 C：训练入口调用评测集加载器/数据集构造 ────────────────────
    // 只认**调用**，不认定义 —— 否则训练脚本里定义一个 `def get_val_loader()`
    // 就会被判待确认（实测误报）。
    if (evalLoaderCallRe.test(line) && !/^\s*(?:async\s+)?def\s/.test(line) && fileHasTrainCtx) {
      findings.push({ level: 'suspect', line: i + 1, code: 'EVAL_LOADER_CALL', text: trimmed.slice(0, 160) })
      continue
    }

    // 本行 / 本窗口的信号 —— 全部走标识符分量 + 位置判定，不用子串。
    const lineHasEval = identsOf(line).some(isEvalName)
    const lineBindings = labelBindingsIn(line)
    const lineHasLabel = lineBindings.length > 0 || identsOf(line).some(isLabelName)
    const winBindings = win.flatMap(labelBindingsIn)
    const winHasEvalIdent = win.some((l) => identsOf(l).some(isEvalName))
    // 窗口级「评测集 + 标签绑定」：
    //   · 解包遍历评测集**数据容器**（`for x, y in val_loader:`），或
    //   · 评测限定的标签名（`test_labels = ...`，自带评测证据），或
    //   · 裸标签名（`gt = ...`）+ 窗口内有评测集标识符。
    const windowHasBoth = win.some(unpackOverEval)
      || winBindings.some((b) => b.evalQualified)
      || (winHasEvalIdent && winBindings.length > 0)
    const windowHasEvalRead = win.some(evalDataRead)

    // 完全无关的行直接跳过，避免把整个文件都当候选。
    if (!lineHasEval && !lineHasLabel && !windowHasBoth && !windowHasEvalRead) continue

    const inTrain = win.some(forOverTrainContainer) || trainCtxRe.test(window)
    // 评测语境看**窗口**而不只是本行：`with torch.no_grad():` 与它下面的
    // 累加器初始化不在同一行，只看本行会把整个评测块误判成训练路径。
    const inEval = evalCtxRe.test(line) || evalCtxRe.test(window)

    // 分级。**注意最后一个分支不能是兜底 'suspect'**：
    //
    // 早期写成 `... else level = 'suspect'`，于是任何"窗口里有信号、但本行
    // 完全无关"的行都会被标成待确认 —— 形状断言、计时、print 全中招。
    // 实测 AutoRe0566 的 21 个源文件上产生 20 条噪音，而 G3.9 的 UNKNOWN
    // 与 FAIL 一样拦阶段推进，噪音于是变成硬阻塞（gate 里那句注释说
    // "降为 unknown 待人工确认"更软，实际并不软）。
    //
    // 现在：leak 仍按窗口判（真泄露常跨行：`gt = load_gt()` 与 `backward()`
    // 相邻）；suspect 必须由**本行**自己给出评测集名或评测数据读取；
    // 无本行信号的行不产出 finding。
    let level = null
    let code = 'EVAL_DATA_READ'
    if (windowHasBoth && inTrain && !inEval) { level = 'leak'; code = 'EVAL_LABEL_READ' }
    else if (windowHasBoth && inEval) { level = 'mention'; code = 'EVAL_LABEL_READ' }
    else if (windowHasEvalRead && inTrain && (lineHasEval || evalDataRead(line))) level = 'suspect'
    else if (lineHasEval || lineHasLabel) { level = 'mention'; code = 'EVAL_LABEL_READ' }
    if (level === null) continue

    findings.push({ level, line: i + 1, code, text: trimmed.slice(0, 160) })
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
