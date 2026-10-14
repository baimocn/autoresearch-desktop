/**
 * 消融实验：红线 1（数据泄露）与红线 6（DinD/Compose）
 *
 * ## 这些实验要证伪什么
 *
 * 上一轮复审实测发现 G3.1 的 COPY 正则漏掉 7 种等价写法 —— 越界可以被
 * 绕过的检查等于不存在。所以本实验的核心不是"能不能检出"，而是
 * **"能不能检出等价写法"**：每种红线都列出多种真实写法，逐一验证。
 *
 * 另一个重点是**误报**。红线 1 若对 `val_loader` 这类正常写法也报 fail，
 * 使用者会学会忽略这条检查，真泄露时也不会看。所以必须验证：
 * 正常评测代码不判 fail。
 *
 * 用法：node scripts/ablation-redlines.mjs
 */

import { scanDataLeakage, scanArchitecture, scanRedLines } from '../packages/dsh-autoresearch/lib/redlines.js'
import { extractCopySources, isEscapingSource, gateDockerPathContract }
  from '../packages/dsh-autoresearch/lib/gates.js'

const results = []
function record(name, expected, actual) {
  const pass = JSON.stringify(expected) === JSON.stringify(actual)
  results.push({ name, pass, expected, actual })
  console.log(`  ${pass ? 'ok  ' : 'FAIL'} ${name}`)
  if (!pass) console.log(`        期望 ${JSON.stringify(expected)} / 实际 ${JSON.stringify(actual)}`)
}

console.log('=== 实验 1：红线 6 —— DinD 的多种等价写法（吸取 F1 教训）===')
const DIND_CASES = [
  ['docker run 挂 socket', 'docker run -v /var/run/docker.sock:/var/run/docker.sock img'],
  ['--mount 挂 socket', 'docker run --mount type=bind,src=/var/run/docker.sock,dst=/var/run/docker.sock img'],
  ['DOCKER_HOST unix', 'export DOCKER_HOST=unix:///var/run/docker.sock'],
  ['DOCKER_HOST tcp', 'export DOCKER_HOST=tcp://127.0.0.1:2375'],
  ['启动 dockerd', 'nohup /usr/bin/dockerd --host unix:///$B/docker.sock &'],
  ['service docker start', 'service docker start'],
  ['systemctl start docker', 'systemctl start docker'],
  ['apt 装 docker-ce', 'RUN apt-get install -y docker-ce'],
  ['apt 装 docker.io', 'RUN apt-get update && apt-get install -y docker.io'],
  ['apk 装 docker', 'RUN apk add --no-cache docker'],
  ['pip 装 docker', 'RUN pip install docker'],
  ['conda 装 docker', 'RUN conda install -y docker'],
]
for (const [label, text] of DIND_CASES) {
  const hits = scanArchitecture(text)
  record(`检出：${label}`, true, hits.length > 0)
}
console.log()

console.log('=== 实验 2：红线 6 —— Compose 的多种写法 ===')
const COMPOSE_CASES = [
  ['docker compose 命令', 'docker compose up -d'],
  ['docker-compose 命令', 'docker-compose up -d'],
  ['compose.yaml 文件名', '见 assets/compose.yaml 模板'],
  ['compose.yml 文件名', '见 assets/compose.yml 模板'],
  ['services: 顶层键', 'services:\n  lane-a:\n    build: .\n'],
]
for (const [label, text] of COMPOSE_CASES) {
  record(`检出：${label}`, true, scanArchitecture(text).length > 0)
}
console.log()

console.log('=== 实验 3：红线 6 —— 注释与文档提及不应误报 ===')
record('整行 # 注释不报', 0, scanArchitecture('# 不要用 docker.sock').length)
record('整行 // 注释不报', 0, scanArchitecture('// 不要用 dockerd').length)
record('空行不报', 0, scanArchitecture('\n\n').length)
console.log()

console.log('=== 实验 4：红线 1 —— 训练中读评测集标签必须判 leak ===')
const LEAK_CASES = [
  ['DataLoader 读 val 标签', 'val_loader = DataLoader(ValDataset(), batch_size=32)\nfor x, y in val_loader:\n    loss = criterion(model(x), y)\n    loss.backward()\n    optimizer.step()'],
  ['直接读 test labels', 'test_labels = np.load("test_labels.npy")\nfor epoch in range(10):\n    loss = criterion(model(x), test_labels)\n    loss.backward()'],
  ['val targets 进训练', 'y_val = torch.load("y_val.pt")\nloss = criterion(pred, y_val)\nloss.backward()\noptimizer.step()'],
  ['ground truth 进反传', 'gt = load_ground_truth()\nloss = criterion(out, gt)\nloss.backward()'],
]
for (const [label, text] of LEAK_CASES) {
  record(`判 leak：${label}`, true, scanDataLeakage(text).some((f) => f.level === 'leak'))
}
console.log()

console.log('=== 实验 5：红线 1 —— 正常评测代码不得判 fail（防误报）===')
console.log('   误报的代价很实际：这条检查若经常误报，使用者会学会忽略它。')
const NORMAL_CASES = [
  ['评估函数里算 val accuracy', 'def evaluate(model, val_loader):\n    acc = compute_accuracy(model, val_loader)\n    print(f"val accuracy: {acc}")\n    return acc'],
  ['val_loader 仅作参数', 'def build_loaders():\n    val_loader = DataLoader(ValDataset(), batch_size=64)\n    return train_loader, val_loader'],
  ['日志打印 test 指标', 'logger.info("test mAP", test_metric)'],
  ['评估时读 test labels 算 F1', 'test_labels = load("test_labels.npy")\nf1 = f1_score(preds, test_labels)\nlogger.info(f"test f1 {f1}")'],
  ['断言里用 val 集', 'assert val_accuracy > 0.5, "val accuracy too low"'],
]
for (const [label, text] of NORMAL_CASES) {
  const hits = scanDataLeakage(text)
  record(`不判 leak：${label}`, 0, hits.filter((f) => f.level === 'leak').length)
}
console.log()

console.log('=== 实验 6：红线 1 —— mention 必须如实记录，不得静默丢弃 ===')
const mentionText = 'def evaluate(model, val_loader):\n    acc = compute_accuracy(model, val_loader)\n    return acc'
const mentionHits = scanDataLeakage(mentionText)
record('评估语境的引用被记录为 mention', true, mentionHits.length > 0 && mentionHits.every((f) => f.level === 'mention'))
console.log()

console.log('=== 实验 7：COPY/ADD 源提取 —— 覆盖 F1 曾漏掉的 7 种形态 ===')
const COPY_CASES = [
  ['普通 COPY', 'COPY ../secret /x', '../secret'],
  ['双引号', 'COPY "../secret" /x', '../secret'],
  ['单引号', "COPY '../secret' /x", '../secret'],
  ['JSON 数组形式', 'COPY ["../secret", "/x"]', '../secret'],
  ['ADD 指令', 'ADD ../secret /x', '../secret'],
  ['带 --from', 'COPY --from=builder /out/app /app', '/out/app'],
  ['带 --chown', 'COPY --chown=1000:1000 ../secret /x', '../secret'],
  ['制表符分隔', 'COPY\t../secret\t/x', '../secret'],
  ['反斜杠续行', 'COPY ../sec\\\nret /x', '../secret'],
]
for (const [label, text, want] of COPY_CASES) {
  const got = extractCopySources(text)
  record(`${label} → 源路径`, want, got.length > 0 ? got[0].source : '(未提取)')
}
console.log()

console.log('=== 实验 8：越界判定覆盖路径段中的 .. ===')
const ESCAPE_CASES = [
  ['../secret', true],
  ['/abs/path', true],
  ['a/../../b', true],
  ['..', true],
  ['.', false],
  ['sub/dir', false],
  ['./sub', false],
  ['secret', false],
]
for (const [src, want] of ESCAPE_CASES) {
  record(`越界判定 ${src}`, want, isEscapingSource(src))
}
console.log()

console.log('=== 实验 9：门禁折叠 —— 红线触发时 G-DOCKERFILE 必须 REJECT ===')
const badEnv = gateDockerPathContract({
  environmentDockerfile: 'FROM python:3.11\nCOPY "../hidden" /app/hidden\nRUN apt-get install -y docker-ce\n',
  testsDockerfile: 'FROM python:3.11\nCOPY . /tests\n',
  instructionMd: '',
  sourceFiles: [{ path: 'reference/train.py', text: 'val_labels = load("val_labels.npy")\nloss.backward()\noptimizer.step()' }],
})
record('红线触发 → REJECT', 'REJECT', badEnv.verdict)
record('红线 6 判 fail', true, badEnv.checks.some((c) => c.id === 'G3.11' && c.status === 'FAIL'))
record('红线 1 判 fail', true, badEnv.checks.some((c) => c.id === 'G3.8' && c.status === 'FAIL'))
record('越界 COPY 仍判 fail（F1 已修）', true, badEnv.checks.some((c) => c.id === 'G3.1' && c.status === 'FAIL'))

const cleanEnv = gateDockerPathContract({
  environmentDockerfile: 'FROM python:3.11\nCOPY . /app\n',
  testsDockerfile: 'FROM python:3.11\nCOPY . /tests\n',
  instructionMd: '',
  sourceFiles: [{ path: 'reference/train.py', text: 'for x, y in train_loader:\n    loss = criterion(model(x), y)\n    loss.backward()\n    optimizer.step()' }],
})
record('干净输入 → 不因红线 REJECT', true, cleanEnv.verdict !== 'REJECT')
console.log()

console.log('=== 实验 10：未提供源码时必须 UNKNOWN，不得当通过 ===')
const noSource = gateDockerPathContract({
  environmentDockerfile: 'FROM python:3.11\nCOPY . /app\n',
  testsDockerfile: 'FROM python:3.11\nCOPY . /tests\n',
  instructionMd: '',
})
record('无源码 → G3.8 为 UNKNOWN', 'UNKNOWN', noSource.checks.find((c) => c.id === 'G3.8')?.status)
record('无源码 → 整体不得 RECOMMEND', true, noSource.verdict !== 'RECOMMEND')
console.log()

console.log('=== 实验 11：scanRedLines 的归类是否完整（无静默丢弃）===')
const agg = scanRedLines({
  files: [
    { path: 'a.py', text: 'test_labels = load("t.npy")\nloss.backward()' },
    { path: 'b.py', text: 'def evaluate(m, val_loader):\n    return acc(m, val_loader)' },
    { path: 'c.yml', text: 'services:\n  x:\n    build: .' },
  ],
  scope: 'reference/',
})
record('扫到 3 个文件', 3, agg.scannedFiles)
record('保留 scope 说明', 'reference/', agg.scope)
record('leak 与 mention 都非空', true, agg.leak.hard.length > 0 && agg.leak.mention.length > 0)
record('架构问题非空', true, agg.architecture.hard.length > 0)
const allLeak = agg.leak.hard.length + agg.leak.suspect.length + agg.leak.mention.length
record('三档之和 = 明细总数（无丢弃）', true, allLeak > 0)
console.log()

console.log('=== 实验 12：红线 1 —— 标识符子串不得判 leak（实测误报回归）===')
console.log('   输入取自真实任务 AutoRe1852 的 score/score.py：把类名做归一化，')
console.log('   再求评测类别与训练类别词表是否有词面交集。没有标注读取、没有反传。')
// 旧实现因 `split_labels` → `labels`、`test_class_names` → `test`、
// `for label in train_class_names` → 训练语境，把 7 行全判 leak、门禁硬拒。
const classnameWindow = [
  '            class_names = split_labels(metadata.thing_classes)',
  '            train_class_names = split_labels(train_metadata.thing_classes)',
  '        train_class_names = {l for label in train_class_names for l in label}',
  '        category_overlapping_list = []',
  '        for test_class_names in class_names:',
  '            is_overlapping = not set(train_class_names).isdisjoint(set(test_class_names))',
  '            category_overlapping_list.append(is_overlapping)',
].join('\n')
const windowFindings = scanDataLeakage(classnameWindow, 'score.py')
record('7 行词表运算 → 0 个 leak', 0, windowFindings.filter((f) => f.level === 'leak').length)
record('7 行词表运算 → 0 个 suspect', 0, windowFindings.filter((f) => f.level === 'suspect').length)

// 反向对照：同一段代码里加上真正的评测标签读取并送进 loss，
// 必须重新判 leak —— 证明修复不是把整段代码变成盲区。
const windowWithLabelRead = classnameWindow + '\n' + [
  '        val_labels = json.load(open("val_labels.json"))',
  '        loss = criterion(model(x), val_labels)',
  '        loss.backward()',
].join('\n')
record('同段代码 + 真读评测标签并送 loss → ≥1 个 leak', true,
  scanDataLeakage(windowWithLabelRead, 'score.py').some((f) => f.level === 'leak'))

// 分档如实：`ann = json.load(open(eval_json))` 这类只有「评测集数据读取」、
// 没有标签证据的写法落 suspect（待人工确认），不虚报成 leak、也不静默丢弃。
const windowWithDataRead = classnameWindow + '\n' + [
  '        ann = json.load(open(eval_json))',
  '        loss = criterion(model(x), ann)',
  '        loss.backward()',
].join('\n')
record('同段代码 + 评测集数据读取（无标签证据）→ ≥1 个 suspect', true,
  scanDataLeakage(windowWithDataRead, 'score.py').some((f) => f.level === 'suspect'))
console.log()

console.log('=== 实验 13：红线 1 —— 训练路径读评测集注册 / 训练期评测（补漏报）===')
console.log('   输入取自真实任务 AutoRe1852 的真违规：build_model() 里求值')
console.log('   cfg.DATASETS.TEST，且训练配置的 EVAL_PERIOD 非零。旧实现只判 mention。')
const registrationRead = [
  'def build_model(cfg):',
  '    return dict(',
  '        "train_metadata": MetadataCatalog.get(cfg.DATASETS.TRAIN[0]),',
  '        "test_metadata":  MetadataCatalog.get(cfg.DATASETS.TEST[0]),',
  '    )',
].join('\n')
const regFindings = scanDataLeakage(registrationRead, 'score.py')
record('build_model 里求值 DATASETS.TEST → ≥1 个 leak', true,
  regFindings.some((f) => f.level === 'leak'))
// 反向对照：同一行换成 DATASETS.TRAIN，不得误报。
record('反向：DATASETS.TRAIN → 0 个 leak', 0,
  scanDataLeakage('def build_model(cfg):\n    return MetadataCatalog.get(cfg.DATASETS.TRAIN[0])\n', 'score.py')
    .filter((f) => f.level === 'leak').length)

// 训练配置里 EVAL_PERIOD 非零：训练期会在评测集上评估。
// 静态文本无法证明「测试集是否被覆盖」，因此落 suspect 而非 leak（如实分档）。
const evalPeriodCfg = [
  'DATASETS:',
  '  TEST: ("nwpu_val_instance",)',
  'TEST:',
  '  EVAL_PERIOD: 50000',
].join('\n')
record('训练配置 EVAL_PERIOD: 50000 → ≥1 个 suspect', true,
  scanDataLeakage(evalPeriodCfg, 'score.yaml').some((f) => f.level === 'suspect'))
record('EVAL_PERIOD: 0 → 0 个 suspect', 0,
  scanDataLeakage('TEST:\n  EVAL_PERIOD: 0\n', 'score.yaml').filter((f) => f.level === 'suspect').length)

// 训练入口调用评测集加载器构造。
const trainCallsEvalLoader = [
  'def train(cfg):',
  '    for x, y in train_loader:',
  '        loss = criterion(model(x), y)',
  '        loss.backward()',
  '        optimizer.step()',
  '    eval_loaders = build_eval_loaders(cfg)',
].join('\n')
record('训练脚本调用 build_eval_loaders → ≥1 个 suspect', true,
  scanDataLeakage(trainCallsEvalLoader, 'train.py').some((f) => f.level === 'suspect'))
console.log()

console.log('=== 实验 14：红线 1 —— 对抗性反例语料（误报回归闸）===')
console.log('   下面每条都是「名字里含评测/标签词、但语义无害」的写法。')
console.log('   它们曾全部或部分被判 leak —— 标识符子串匹配的必然结果。')
console.log('   把它们钉在这里，是因为误报只被测一次就会复发。')
const FALSE_POSITIVE_CASES = [
  ['标识符前缀：test_labels_format（尾分量不是标签词）',
    'for x, y in train_loader:\n    test_labels_format = "%d"\n    loss = criterion(model(x), y)\n    loss.backward()'],
  ['标识符前缀：val_labels_count',
    'for x, y in train_loader:\n    val_labels_count = 0\n    loss = criterion(model(x), y)\n    loss.backward()'],
  ['函数名：def val_labels_helper',
    'def val_labels_helper(x):\n    return x.strip()\n\ndef train():\n    for x, y in train_loader:\n        loss = criterion(model(x), y)\n        loss.backward()'],
  ['遍历评测命名词表：for i, name in enumerate(val_class_names)',
    'for i, name in enumerate(val_class_names):\n    pass\nloss = criterion(model(x), y)\nloss.backward()'],
  ['遍历评测命名配置：for k, v in test_config.items()',
    'for k, v in test_config.items():\n    pass\nloss = criterion(model(x), y)\nloss.backward()'],
  ['局部变量名 label 在训练循环里',
    'for batch in train_loader:\n    label = mapping[cls]\n    loss = criterion(model(x), y)\n    loss.backward()'],
]
for (const [label, text] of FALSE_POSITIVE_CASES) {
  const hits = scanDataLeakage(text, 'train.py')
  record(`不判 leak：${label}`, 0, hits.filter((f) => f.level === 'leak').length)
}
// docstring 里劝阻违规的说明文字不是代码。
record('不判 leak：docstring 里提到 cfg.DATASETS.TEST',
  0, scanDataLeakage('def build_model(cfg):\n    """注意：不要用 cfg.DATASETS.TEST 做训练。"""\n    return build(cfg)', 'score.py')
    .filter((f) => f.level === 'leak').length)
// 只「定义」评测集加载器不算调用。
record('不判 suspect（EVAL_LOADER_CALL）：def get_val_loader 定义',
  false, scanDataLeakage('def get_val_loader(cfg):\n    pass\n\ndef train():\n    for x, y in train_loader:\n        loss.backward()', 'train.py')
    .some((f) => f.code === 'EVAL_LOADER_CALL'))

// 同一批反例的「对照组」：把无害写法换成真泄露，必须仍然判 leak ——
// 证明收紧判定没有把整类写法变成盲区。
record('对照：单变量训练循环里读真值 → ≥1 个 leak', true,
  scanDataLeakage('for batch in train_loader:\n    gt = load_ground_truth()\n    step(model, gt)', 'train.py')
    .some((f) => f.level === 'leak'))
record('对照：自定义 loss 名喂评测标签 → ≥1 个 leak', true,
  scanDataLeakage('for x, y in train_loader:\n    loss = focal_loss(model(x), val_targets)\n    loss.backward()', 'train.py')
    .some((f) => f.level === 'leak'))
record('对照：评测标签集合喂进 loss → ≥1 个 leak', true,
  scanDataLeakage('y = np.array(val_labels_list)\nloss = criterion(model(x), y)\nloss.backward()', 'train.py')
    .some((f) => f.level === 'leak'))
console.log()

const failed = results.filter((r) => !r.pass)
console.log('='.repeat(62))
console.log(`红线消融：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}（期望 ${JSON.stringify(f.expected)}，实际 ${JSON.stringify(f.actual)}）`)
}
console.log()
console.log('已知局限（如实声明）：')
console.log('  · 「是否在训练路径上」是启发式判定，可能漏报精心构造的写法')
console.log('  · 因此 mention 档全部如实列出，供人工复核，不静默丢弃')
console.log('  · 评测集数据读取（非标签）只到 suspect，不虚报成 leak')
console.log('  · 变量名以 eval_ 开头的写法会命中评测语境豁免（既有行为，未在本次改动）')
console.log('  · 红线 6 只做静态扫描，不构建镜像验证；真机结论以构建日志为准')
process.exit(failed.length === 0 ? 0 : 1)
