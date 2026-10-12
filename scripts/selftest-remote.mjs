/**
 * 远端持久化自检 —— 覆盖 SSH 容错、自驱动脚本、账本与能力推导。
 *
 * 单独成文件：这部分逻辑独立于出题流程，且需要真实建立一次失败的 SSH 连接。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '..', 'packages')
const load = (relative) => import(new URL(`file://${join(PACKAGES, relative).replace(/\\/g, '/')}`).href)

const remote = await load('dsh-autoresearch-remote/lib/session.js')
const ledger = await load('dsh-autoresearch-remote/lib/ledger.js')

let passed = 0
let failed = 0
const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ── SSH 容错 ────────────────────────────────────────────────────────────────

test('SSH 公共参数包含保活与连接超时', () => {
  const args = remote.sshCommonArguments({
    host: 'gpu.example.com', user: 'root', port: 2222, identityFile: '/k/id',
  })
  assert.ok(args.includes('BatchMode=yes'))
  assert.ok(args.includes('ServerAliveInterval=15'))
  assert.ok(args.includes('ServerAliveCountMax=3'))
  assert.ok(args.includes('ConnectTimeout=20'))
  assert.ok(args.includes('-p') && args.includes('2222'))
  assert.ok(args.includes('-i') && args.includes('/k/id'))
})

test('链路类失败判为可重试，认证类判为不可重试', () => {
  assert.equal(remote.isRetryableFailure({ exitCode: 255, stderr: '' }), true)
  assert.equal(remote.isRetryableFailure({ timedOut: true, exitCode: null, stderr: '' }), true)
  assert.equal(remote.isRetryableFailure({ exitCode: 1, stderr: 'Connection reset by peer' }), true)
  assert.equal(remote.isRetryableFailure({ exitCode: 1, stderr: 'Broken pipe' }), true)
  assert.equal(remote.isRetryableFailure({ exitCode: 1, stderr: 'Connection timed out' }), true)
  assert.equal(remote.isRetryableFailure({ exitCode: 1, stderr: 'Permission denied (publickey)' }), false)
  assert.equal(remote.isRetryableFailure({ exitCode: 1, stderr: 'command not found' }), false)
})

test('默认策略的保活间隔足够短，能在抖动时及时重连', () => {
  const policy = remote.DEFAULT_POLICY
  assert.ok(policy.serverAliveInterval <= 30, '保活间隔不宜过长')
  assert.ok(policy.serverAliveCountMax <= 5)
  assert.ok(policy.retries >= 2)
  assert.ok(policy.retryBackoffMs >= 1000)
})

// ── 自驱动脚本 ──────────────────────────────────────────────────────────────

test('自驱动脚本含幂等守卫与完成/失败标记', () => {
  const script = remote.buildSelfDrivingScript({
    jobId: 'train-baseline-s41',
    remoteRoot: '/root/.autoresearch-remote',
    workDir: '/root/work',
    command: 'python train.py',
  })
  assert.ok(script.startsWith('#!/usr/bin/env bash'))
  assert.ok(script.includes('flock -n 9'), '必须有 flock 独占')
  assert.ok(script.includes('SKIP: already done'), '完成标记守卫')
  assert.ok(script.includes('SKIP: another instance holds the lock'))
  assert.ok(script.includes('.done'), '完成标记')
  assert.ok(script.includes('.fail'), '失败标记')
  assert.ok(script.includes('python train.py'))
  assert.ok(script.includes('set -u'), '未定义变量应当报错而非静默')
  assert.equal(script.includes('\r'), false, '不得写入 CRLF')
})

test('自驱动脚本把状态写进文件，不依赖控制端', () => {
  const script = remote.buildSelfDrivingScript({
    jobId: 'j', remoteRoot: '/r', workDir: '/w', command: 'true',
  })
  // 脚本内 JSON 里的引号是转义后的 \"，所以断言串也要带反斜杠。
  assert.ok(script.includes('\\"phase\\":\\"running\\"'), '启动时写 running 状态')
  assert.ok(script.includes('\\"phase\\":\\"complete\\"'), '完成时写 complete 状态')
  assert.ok(script.includes('\\"phase\\":\\"failed\\"'), '失败时写 failed 状态')
  assert.ok(script.includes('$$'), '状态文件记录 pid 供存活复核')
  assert.ok(script.includes('"$STATE"'), '状态写入固定文件路径，与连接无关')
})

test('shell 引号转义可安全承载单引号与换行', () => {
  const quoted = remote.shellQuote("it's a 'test'\nline")
  assert.ok(quoted.startsWith("'") && quoted.endsWith("'"))
  assert.ok(quoted.includes("'\\''"), '内部单引号必须转义')
  assert.ok(quoted.includes('\n'), '换行原样保留在引号内')
})

test('远端布局目录齐备', () => {
  const layout = remote.REMOTE_LAYOUT
  for (const key of ['root', 'scripts', 'state', 'logs', 'markers', 'snapshots', 'reports']) {
    assert.ok(typeof layout[key] === 'string' && layout[key].length > 0, `缺 ${key}`)
  }
})

// ── 能力推导 ────────────────────────────────────────────────────────────────

test('缺 buildx 则不能构建镜像，也就不具备 NOP 全链路能力', () => {
  const capabilities = remote.capabilitiesFromProbe({
    reachable: true, platform: 'Linux x86_64', docker: 'Docker version 27',
    compose: 'Docker Compose version v2', buildx: null,
    gpus: ['0, NVIDIA H20, 98304 MiB'], runtimes: 'map[nvidia:{}]', disk: '/dev/vda1 500G',
  })
  assert.equal(capabilities.canBuildImages, false)
  assert.equal(capabilities.canRunNopTrial, false)
  assert.match(capabilities.reasons.join(' '), /buildx/)
})

test('Docker 齐备且 GPU 与 nvidia runtime 都有时具备 NOP 全链路能力', () => {
  const capabilities = remote.capabilitiesFromProbe({
    reachable: true, platform: 'Linux x86_64', docker: 'Docker version 27',
    compose: 'Docker Compose version v2', buildx: 'github.com/docker/buildx v0.17',
    gpus: ['0, NVIDIA H20, 98304 MiB'], runtimes: 'map[nvidia:{}]', disk: '/dev/vda1 500G',
  })
  assert.equal(capabilities.canBuildImages, true)
  assert.equal(capabilities.canRunNopTrial, true)
  assert.equal(capabilities.gpuCount, 1)
  assert.equal(capabilities.hasNvidiaRuntime, true)
})

test('有 GPU 但 nvidia runtime 未注册时，如实指出缺哪一项', () => {
  const capabilities = remote.capabilitiesFromProbe({
    reachable: true, platform: 'Linux', docker: 'Docker', compose: 'Compose', buildx: 'buildx',
    gpus: ['0, NVIDIA L20, 49152 MiB'], runtimes: 'map[runc:{}]', disk: '500G',
  })
  assert.equal(capabilities.canTrainGpu, true)
  assert.equal(capabilities.hasNvidiaRuntime, false)
  assert.equal(capabilities.canRunNopTrial, false)
  assert.match(capabilities.reasons.join(' '), /nvidia runtime/)
})

test('无 GPU 时只报告 CPU 能力，不夸大', () => {
  const capabilities = remote.capabilitiesFromProbe({
    reachable: true, platform: 'Linux', docker: 'Docker', compose: 'Compose', buildx: 'buildx',
    gpus: null, runtimes: 'map[runc:{}]', disk: '100G',
  })
  assert.equal(capabilities.canTrainGpu, false)
  assert.equal(capabilities.canRunNopTrial, false)
  assert.match(capabilities.reasons.join(' '), /未检测到 GPU/)
})

test('远端不可达时能力推导如实返回否', () => {
  const capabilities = remote.capabilitiesFromProbe({ reachable: false, error: 'timeout' })
  assert.equal(capabilities.reachable, false)
  assert.equal(capabilities.canBuildImages, false)
  assert.equal(capabilities.canRunNopTrial, false)
  assert.match(capabilities.reasons.join(' '), /不可达/)
})

// ── 账本 ────────────────────────────────────────────────────────────────────

test('账本：登记目标与任务，拒绝未登记目标与空 host', () => {
  let book = ledger.emptyLedger()
  book = ledger.registerTarget(book, 'gpu-a', { host: '10.0.0.5', user: 'root', remoteRoot: '/root/.ar' })
  assert.equal(book.targets['gpu-a'].host, '10.0.0.5')
  book = ledger.registerJob(book, 'train-1', { targetId: 'gpu-a', workDir: '/root/w', kind: 'train' })
  assert.equal(book.jobs['train-1'].targetId, 'gpu-a')
  assert.throws(() => ledger.registerJob(book, 'train-2', { targetId: 'nope', workDir: '/w' }), /未登记的目标/)
  assert.throws(() => ledger.registerTarget(book, 'bad', { host: '' }), /必须有 host/)
  assert.throws(() => ledger.registerJob(book, '', { targetId: 'gpu-a' }), /jobId/)
})

test('账本是缓存不是真相：探测只追加 lastProbe，不覆盖登记信息', () => {
  let book = ledger.emptyLedger()
  book = ledger.registerTarget(book, 'gpu-a', { host: 'h' })
  book = ledger.registerJob(book, 'j1', { targetId: 'gpu-a', workDir: '/w' })
  assert.equal(book.jobs.j1.lastProbe, null)
  book = ledger.recordProbe(book, 'j1', { phase: 'running', reachable: true, logTail: 'epoch 3' })
  assert.equal(book.jobs.j1.lastProbe.phase, 'running')
  assert.equal(book.jobs.j1.workDir, '/w', '登记信息不被探测结果覆盖')
  assert.equal(book.jobs.j1.kind, 'generic')
})

test('持久化体检：区分未完成、未知与快照证据', () => {
  let book = ledger.emptyLedger()
  book = ledger.registerTarget(book, 'gpu-a', { host: 'h' })
  book = ledger.registerJob(book, 'running-job', { targetId: 'gpu-a', workDir: '/w' })
  book = ledger.registerJob(book, 'done-job', { targetId: 'gpu-a', workDir: '/w' })
  book = ledger.registerJob(book, 'never-probed', { targetId: 'gpu-a', workDir: '/w' })
  book = ledger.recordProbe(book, 'running-job', { phase: 'running', reachable: true })
  book = ledger.recordProbe(book, 'done-job', { phase: 'complete', reachable: true })

  const summary = ledger.summarizePersistence(book)
  assert.equal(summary.jobCount, 3)
  assert.deepEqual(summary.unfinished.map((job) => job.jobId).sort(), ['running-job'])
  assert.deepEqual(summary.unknown.map((job) => job.jobId), ['never-probed'])
  assert.equal(summary.restoreProbeReady, false, '无快照时不宣称有恢复证据')

  const withSnapshot = ledger.recordSnapshot(book, {
    capturedAt: '2026-10-10T00:00:00Z', localArchive: '/s/a.tar.gz',
    sha256: 'a'.repeat(64), bytes: 100, remotePaths: ['/w'],
  })
  assert.equal(ledger.summarizePersistence(withSnapshot).restoreProbeReady, true)
})

test('长时间未探测被标记为 stale', () => {
  let book = ledger.emptyLedger()
  book = ledger.registerTarget(book, 'gpu-a', { host: 'h' })
  book = ledger.registerJob(book, 'j1', { targetId: 'gpu-a', workDir: '/w' })
  book = ledger.recordProbe(book, 'j1', { phase: 'running', reachable: true })
  const fresh = ledger.summarizePersistence(book)
  assert.equal(fresh.jobs[0].stale, false)
  const stale = ledger.summarizePersistence(book, {
    now: Date.now() + 3 * 60 * 60 * 1000, staleMs: 60 * 60 * 1000,
  })
  assert.equal(stale.jobs[0].stale, true)
})

test('账本读写：原子写入、版本校验、缺失时返回空账本', async () => {
  const taskRoot = await mkdtemp(join(tmpdir(), 'autoresearch-ledger-'))
  try {
    const initial = await ledger.readLedger(taskRoot)
    assert.equal(initial.version, 1)
    assert.deepEqual(initial.targets, {})

    const book = ledger.registerTarget(initial, 'gpu-b', { host: 'example.com' })
    await ledger.writeLedger(taskRoot, book)
    const reloaded = await ledger.readLedger(taskRoot)
    assert.equal(reloaded.targets['gpu-b'].host, 'example.com')

    await writeFile(join(taskRoot, '.autoresearch-remote', 'ledger.json'),
      JSON.stringify({ version: 99 }), 'utf8')
    await assert.rejects(() => ledger.readLedger(taskRoot), /版本/)
  } finally {
    await rm(taskRoot, { recursive: true, force: true })
  }
})

// ── 真实失败路径 ────────────────────────────────────────────────────────────

test('查询失败返回 unknown 并标可重试，不猜测状态', async () => {
  // 连必然连不上的端口：验证如实返回 unknown，而不是编造 running/complete。
  const probe = await remote.probeJob(
    { host: '127.0.0.1', user: 'nobody', port: 1, remoteRoot: '/tmp/.ar' },
    '/tmp/.ar', 'j1',
    { policy: { ...remote.DEFAULT_POLICY, retries: 0, connectTimeoutSeconds: 2 }, commandTimeoutMs: 10_000 },
  )
  assert.equal(probe.reachable, false)
  assert.equal(probe.phase, 'unknown')
  assert.ok(typeof probe.error === 'string' && probe.error.length > 0, '必须带失败原因')
  assert.equal(probe.retryable, true, '本机拒绝连接属可重试类')
})

test('快照失败时不返回成功，也不写清单', async () => {
  const localDir = await mkdtemp(join(tmpdir(), 'autoresearch-snap-'))
  try {
    const snapshot = await remote.captureSnapshot(
      { host: '127.0.0.1', user: 'nobody', port: 1, remoteRoot: '/tmp/.ar' },
      ['/nonexistent/path'], localDir,
      { policy: { ...remote.DEFAULT_POLICY, retries: 0, connectTimeoutSeconds: 2 }, snapshotTimeoutMs: 10_000 },
    )
    assert.equal(snapshot.captured, false)
    assert.equal(snapshot.localArchive, null)
    assert.ok(typeof snapshot.error === 'string' && snapshot.error.length > 0)
  } finally {
    await rm(localDir, { recursive: true, force: true })
  }
})

// ── 执行 ────────────────────────────────────────────────────────────────────

for (const { name, fn } of cases) {
  try {
    await fn()
    passed += 1
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}`)
    console.log(`       ${error.message}`)
  }
}

console.log(`\n远端持久化自检：${passed} 通过，${failed} 失败，共 ${cases.length} 项`)
process.exit(failed === 0 ? 0 : 1)
