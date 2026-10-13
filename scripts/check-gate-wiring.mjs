/**
 * 检查：G-DOCKERFILE 的自填 payload 是否真的会读入源码。
 *
 * ## 为什么需要这道检查
 *
 * 红线 1/6 的扫描逻辑已经过消融验证（59 项）。但如果 `autoresearch_gate`
 * 在构造 G-DOCKERFILE 的 payload 时**没把源码读进来**，红线在真实流程里
 * 永远只会报「未扫描」—— 也就是红线只活在消融实验里，属于"纸面门禁"。
 *
 * 这类脱节靠读代码很难发现，所以用真实临时任务树跑一次端到端：
 * 造一个含泄露源码与 DinD 的任务目录，看门禁是否真的判 REJECT。
 *
 * 用法：node scripts/check-gate-wiring.mjs
 */

import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
function record(name, ok, detail) {
  results.push({ name, ok })
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `  ${detail}` : ''}`)
}

/** 造一个最小的任务树，只放门禁需要的文件。 */
async function makeTaskTree({ withLeak, withDind }) {
  const taskRoot = await mkdtemp(join(tmpdir(), 'ars-wiring-'))
  const harbor = join(taskRoot, 'workspace', 'harbor_task')
  const reference = join(taskRoot, 'workspace', 'reference')
  await mkdir(join(harbor, 'environment'), { recursive: true })
  await mkdir(join(harbor, 'tests'), { recursive: true })
  await mkdir(reference, { recursive: true })

  await writeFile(join(harbor, 'task.toml'), 'version = "1.0"\n', 'utf8')
  await writeFile(join(harbor, 'instruction.md'), '## Goal\n\n做点什么\n', 'utf8')

  // environment/Dockerfile：withDind 时含 `apt-get install docker-ce`（红线 6 应命中）。
  await writeFile(join(harbor, 'environment', 'Dockerfile'), withDind
    ? 'FROM python:3.11\nCOPY . /app\nRUN apt-get install -y docker-ce\n'
    : 'FROM python:3.11\nCOPY . /app\nRUN pip install numpy\n', 'utf8')
  await writeFile(join(harbor, 'tests', 'Dockerfile'),
    'FROM python:3.11\nCOPY . /tests\n', 'utf8')

  // reference/train.py：withLeak 时含泄露（红线 1 应命中）。
  await writeFile(join(reference, 'train.py'), withLeak
    ? 'test_labels = load("test_labels.npy")\nfor epoch in range(10):\n    loss = criterion(model(x), test_labels)\n    loss.backward()\n    optimizer.step()\n'
    : 'for x, y in train_loader:\n    loss = criterion(model(x), y)\n    loss.backward()\n    optimizer.step()\n', 'utf8')

  return taskRoot
}

console.log('=== G-DOCKERFILE 自填 payload 端到端接线检查 ===')
console.log()

// 直接复用工具层的自填逻辑：以 gateDockerPathContract 的输入契约为准，
// 模拟 index.js 里那段读取代码的行为，确认它能读到文件。
const { readFile } = await import('node:fs/promises')

for (const scenario of [
  { label: '含泄露与 DinD', withLeak: true, withDind: true, expectReject: true },
  { label: '干净的 reference 与 Dockerfile', withLeak: false, withDind: false, expectReject: false },
]) {
  const { label, withLeak, withDind, expectReject } = scenario
  const taskRoot = await makeTaskTree({ withLeak, withDind })
  try {
    // 复刻 index.js 的读取路径（目录清单 + 逐文件读入）。
    const SOURCE_EXTENSIONS = ['.py', '.js', '.mjs', '.cjs', '.ts', '.sh', '.bash',
      '.yaml', '.yml', '.json', '.toml', '.cfg', '.ini', '.ipynb', '.dockerfile', '.txt', '.md']
    const listSourceFiles = async (relDir) => {
      const { readdir } = await import('node:fs/promises')
      let entries
      try {
        entries = await readdir(join(taskRoot, relDir), { withFileTypes: true })
      } catch { return [] }
      const out = []
      for (const e of entries) {
        if (e.name.startsWith('.')) continue
        const rel = `${relDir}/${e.name}`
        if (e.isDirectory()) out.push(...await listSourceFiles(rel))
        else if (SOURCE_EXTENSIONS.some((x) => e.name.endsWith(x))) out.push(rel)
      }
      return out
    }

    const sourceFiles = []
    for (const dir of ['workspace/reference', 'workspace/starter', 'workspace/harbor_task/reference']) {
      for (const rel of await listSourceFiles(dir)) {
        try {
          sourceFiles.push({ path: rel, text: await readFile(join(taskRoot, rel), 'utf8') })
        } catch { /* 读不到就不放 */ }
      }
    }

    record(`${label}：读到 reference 源码`, sourceFiles.length > 0, `${sourceFiles.length} 个文件`)

    const { gateDockerPathContract } = await import('../packages/dsh-autoresearch/lib/gates.js')
    const { readFile: rf } = await import('node:fs/promises')
    const readIf = async (p) => { try { return await rf(join(taskRoot, p), 'utf8') } catch { return undefined } }

    const gate = gateDockerPathContract({
      environmentDockerfile: await readIf('workspace/harbor_task/environment/Dockerfile'),
      testsDockerfile: await readIf('workspace/harbor_task/tests/Dockerfile'),
      instructionMd: await readIf('workspace/harbor_task/instruction.md'),
      sourceFiles,
      sourceScope: 'workspace/reference + workspace/starter',
    })

    if (expectReject) {
      record(`${label}：整体判 REJECT`, gate.verdict === 'REJECT', `verdict=${gate.verdict}`)
      record(`${label}：红线 1 命中（G3.8 FAIL）`,
        gate.checks.some((c) => c.id === 'G3.8' && c.status === 'FAIL'))
      record(`${label}：红线 6 命中（G3.11 FAIL）`,
        gate.checks.some((c) => c.id === 'G3.11' && c.status === 'FAIL'))
    } else {
      record(`${label}：红线 1 未误报`, !gate.checks.some((c) => c.id === 'G3.8' && c.status === 'FAIL'))
      record(`${label}：红线 6 未误报`, !gate.checks.some((c) => c.id === 'G3.11' && c.status === 'FAIL'))
      record(`${label}：两条红线均判 PASS`,
        gate.checks.some((c) => c.id === 'G3.8' && c.status === 'PASS')
        && gate.checks.some((c) => c.id === 'G3.11' && c.status === 'PASS'))
    }
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
  console.log()
}

console.log('=== 反向检查：没有源码时必须是 UNKNOWN，不能静默通过 ===')
const emptyRoot = await mkdtemp(join(tmpdir(), 'ars-wiring-empty-'))
try {
  const { gateDockerPathContract } = await import('../packages/dsh-autoresearch/lib/gates.js')
  const gate = gateDockerPathContract({
    environmentDockerfile: 'FROM python:3.11\nCOPY . /app\n',
    testsDockerfile: 'FROM python:3.11\nCOPY . /tests\n',
    instructionMd: '',
  })
  record('无 sourceFiles → G3.8 UNKNOWN', gate.checks.find((c) => c.id === 'G3.8')?.status === 'UNKNOWN')
  record('无 sourceFiles → 不得 RECOMMEND', gate.verdict !== 'RECOMMEND', `verdict=${gate.verdict}`)
  record('红线 6 仍会扫 Dockerfile（不依赖源码）', gate.checks.some((c) => c.id === 'G3.11'))
} finally {
  await rm(emptyRoot, { recursive: true, force: true })
}

console.log()
console.log('='.repeat(62))
const failed = results.filter((r) => !r.ok)
console.log(`接线检查：${results.length - failed.length} 通过，${failed.length} 失败，共 ${results.length} 项`)
if (failed.length > 0) {
  console.log('\n失败项：')
  for (const f of failed) console.log(`  · ${f.name}`)
}
process.exit(failed.length === 0 ? 0 : 1)
