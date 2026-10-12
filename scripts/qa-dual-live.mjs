// 双路质检端到端实证：读工作台保存的两路配置 → 打包 → 两个隔离 headless 真跑 → fail-closed 聚合。
// 用法：node scripts/qa-dual-live.mjs [taskRoot]
//   两路配置来自 DSH_HOME/autoresearch-qa-lanes.json（工作台「双路质检」页维护）。
//   若该路由的密钥不在凭据文档里，可通过环境变量补：<KEY_ENV>=... node scripts/qa-dual-live.mjs
import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PROJECT_ROOT = resolve(HERE, '..')
const taskRoot = resolve(process.argv[2] ?? join(PROJECT_ROOT, '.dsh-home', 'launch-root', 'task-alpha'))

const { runDualQa } = await import(pathToFileURL(join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-qa', 'lib', 'runner.js')).href)
const { packDirectory } = await import(pathToFileURL(join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-qa', 'lib', 'zip.js')).href)
const { readLanesFile, resolveSavedLanes } = await import(pathToFileURL(join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-qa', 'lib', 'lanes.js')).href)
const { listProviders, profilePatchPath } = await import(pathToFileURL(join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-api', 'lib', 'profile-patch.js')).href)
const { readCredentialRefs } = await import(pathToFileURL(join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-api', 'lib', 'providers.js')).href)

// ── 两路来源于用户配置（DSH_HOME/autoresearch-qa-lanes.json），不写死 ──────
// 这份配置由工作台「双路质检」页或 autoresearch_qa_lanes 工具写入 —— 与
// autoresearch_qa_dual 走完全相同的解析路径，保证测试的就是产品行为。
const dshHome = process.env.DSH_HOME ?? join(PROJECT_ROOT, '.dsh-home')
const saved = await readLanesFile(dshHome)
if (saved.lanes.length !== 2) {
  console.error(`两路未配置（${dshHome}/autoresearch-qa-lanes.json）。先在工作台配好，或用 LLAPI_KEY 走下面的临时配置。`)
  process.exit(1)
}
const providers = await listProviders(profilePatchPath(dshHome, 'autoresearch'))
const refs = await readCredentialRefs(join(dshHome, '.credentials.yaml')).catch(() => ({}))
// 测试脚本用环境变量补一份密钥：配置里只有引用名，密钥在凭据文档或环境。
for (const lane of saved.lanes) {
  const keyEnv = providers[lane.route]?.apiKeyEnv
  if (typeof keyEnv === 'string' && refs[keyEnv] === undefined && process.env[keyEnv] !== undefined) {
    refs[keyEnv] = process.env[keyEnv]
  }
}
const resolved = resolveSavedLanes({ lanes: saved.lanes, providers, refs })
if (resolved.issues.length > 0) {
  console.error('两路配置有问题：', resolved.issues)
  process.exit(1)
}
console.log('两路来源：工作台配置')
for (const [index, lane] of resolved.lanes.entries()) {
  console.log(`  第 ${index + 1} 路：${lane.provider} / ${lane.model} @ ${lane.baseURL ?? '默认'}（密钥 ${lane.credentialEnv ?? '—'}）`)
}

const qaScripts = join(PROJECT_ROOT, 'packages', 'dsh-autoresearch-gates', 'assets', 'qa-0.3.4')
const reviewScript = join(qaScripts, 'implementation_review.py')
const consensusScript = join(qaScripts, 'qa_consensus.py')
const dshEntryPath = join(PROJECT_ROOT, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')

// 打包：先打到任务盘的临时文件，再挪进任务（跨盘 rename 会 EXDEV；且避免把 zip 自己打进 zip）。
// 排除 dual-qa 工作根：不排除会把自己上一轮的 lane 运行态与旧 zip 打进送检包。
// 跑前清空工作根：聚合产物按「不覆盖」保护（结论锚定既有字节），验证脚本要的是全新一轮。
const workRoot = join(taskRoot, 'expert_evidence', 'dual-qa')
await rm(workRoot, { recursive: true, force: true })
const tmpZip = join(taskRoot, `qa-pack-${Date.now()}.zip`)
await packDirectory(taskRoot, tmpZip, { exclude: ['expert_evidence/dual-qa'] })
await mkdir(workRoot, { recursive: true })
const artifactPath = join(workRoot, 'submission.zip')
await rename(tmpZip, artifactPath)
console.log('打包完成：', artifactPath)

const log = (line) => console.log('  ', line)
const result = await runDualQa({
  lanes: resolved.lanes,
  artifactPath,
  workRoot,
  dshEntryPath,
  profile: 'headless',
  basePatchPath: join(PROJECT_ROOT, 'build', 'autoresearch.patch.yml'),
  skillName: 'autoresearch-task-qa',
  reviewScript,
  consensusScript,
  taskRoot,
  timeoutMs: 420_000,
  maxOutputChars: 400_000,
  log,
})

const manifest = {
  ranAt: new Date().toISOString(),
  artifactPath: result.artifactPath,
  artifactSha256: result.artifactSha256,
  skill: result.skill,
  lanes: result.lanes.map((lane) => ({
    laneIndex: lane.laneIndex,
    identity: lane.identity,
    credentialEnv: lane.credentialEnv,
    sharedCredential: lane.sharedCredential,
    reportPath: lane.reportPath,
    reportSha256: lane.reportSha256,
    exitCode: lane.exitCode,
    timedOut: lane.timedOut,
    durationMs: lane.durationMs,
    startedAt: lane.startedAt,
    finishedAt: lane.finishedAt,
  })),
  consensus: result.consensus === null ? null : {
    outPath: result.consensus.outPath,
    status: result.consensus.status,
    unresolvedDisagreements: result.consensus.unresolvedDisagreements,
    validationErrors: result.consensus.validationErrors,
  },
  verdict: result.verdict,
  notes: result.notes,
}
await writeFile(join(workRoot, 'run-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

console.log('\n══ 结果 ══')
console.log('verdict:', result.verdict)
for (const lane of result.lanes) {
  console.log(`\n── lane ${lane.laneIndex}: ${lane.identity.provider}/${lane.identity.model} exit=${lane.exitCode} ${Math.round(lane.durationMs / 1000)}s`)
  console.log('  报告：', lane.reportPath ?? '（未产出）')
  console.log('  stdout 尾：')
  console.log('   ', (lane.stdoutTail ?? '').split('\n').slice(-6).join('\n    '))
  if (lane.stderrTail) {
    console.log('  stderr 尾：')
    console.log('   ', lane.stderrTail.split('\n').slice(-4).join('\n    '))
  }
}
console.log('\n共识：', result.consensus === null ? '（未聚合）' : result.consensus.status)
console.log('notes:', result.notes)
