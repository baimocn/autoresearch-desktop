/**
 * 自定义 API 接入自检 —— 覆盖声明校验、patch 生成、凭据文档最小改写、
 * 端点探测解释、双路配对约束。
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PACKAGES = join(HERE, '..', 'packages')
const providers = await import(new URL(
  `file://${join(PACKAGES, 'dsh-autoresearch-api/lib/providers.js').replace(/\\/g, '/')}`).href)
const profilePatch = await import(new URL(
  `file://${join(PACKAGES, 'dsh-autoresearch-api/lib/profile-patch.js').replace(/\\/g, '/')}`).href)

let passed = 0
let failed = 0
const cases = []
const test = (name, fn) => cases.push({ name, fn })

// ── 协议与凭据引用名 ────────────────────────────────────────────────────────

test('支持的协议就是 pi-ai 承认的三种', () => {
  assert.deepEqual(providers.SUPPORTED_PROTOCOLS,
    ['openai-completions', 'openai-responses', 'anthropic-messages'])
})

test('凭据引用名按环境变量名形态校验', () => {
  assert.equal(providers.isValidRefName('ANTHROPIC_API_KEY'), true)
  assert.equal(providers.isValidRefName('_PRIVATE'), true)
  assert.equal(providers.isValidRefName('a1_b2'), true)
  assert.equal(providers.isValidRefName('1LEADING_DIGIT'), false)
  assert.equal(providers.isValidRefName('has-dash'), false)
  assert.equal(providers.isValidRefName('has.dot'), false)
  assert.equal(providers.isValidRefName(''), false)
  assert.equal(providers.isValidRefName(undefined), false)
})

test('路由 id 必须是小写连字符标识', () => {
  assert.equal(providers.isValidRouteId('my-gateway'), true)
  assert.equal(providers.isValidRouteId('openai'), true)
  assert.equal(providers.isValidRouteId('My-Gateway'), false)
  assert.equal(providers.isValidRouteId('-bad'), false)
  assert.equal(providers.isValidRouteId('has_underscore'), false)
})

// ── 声明校验 ────────────────────────────────────────────────────────────────

test('合法声明通过校验', () => {
  assert.deepEqual(providers.validateApiDeclaration({
    route: 'my-gateway', api: 'openai-completions',
    baseURL: 'https://api.example.com/v1', models: ['model-a', { id: 'model-b' }],
    keyEnv: 'MY_GATEWAY_API_KEY',
  }), [])
})

test('非法协议被拒并列出合法值', () => {
  const problems = providers.validateApiDeclaration({
    route: 'x', api: 'openai', baseURL: 'https://a.example.com', models: ['m'],
  })
  assert.equal(problems.length, 1)
  assert.match(problems[0], /openai-completions/)
})

test('非法 baseURL 被拒', () => {
  assert.match(providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', baseURL: 'ftp://a.example.com', models: ['m'],
  }).join(' '), /http 或 https/)
  assert.match(providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', baseURL: 'not-a-url', models: ['m'],
  }).join(' '), /不是合法 URL/)
})

test('给 baseURL 却不给协议时被拒（自定义端点无法靠目录推断协议）', () => {
  const problems = providers.validateApiDeclaration({
    route: 'x', baseURL: 'https://a.example.com', models: ['m'],
  })
  assert.match(problems.join(' '), /必须同时声明 api/)
})

test('空 models 合法（保留现有语义），含空 id 的项被拒', () => {
  // 空数组不再是错误：语义是「保留该路由现有模型列表」——编辑密钥/地址时
  // 不必重打模型。非数组仍被拒。
  assert.equal(providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', models: [],
  }).length, 0)
  assert.match(providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', models: 'not-an-array',
  }).join(' '), /必须是数组/)
  assert.match(providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', models: [{ id: '' }],
  }).join(' '), /缺少非空 id/)
})

test('非法 keyEnv 被拒并说明正则', () => {
  const problems = providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', models: ['m'], keyEnv: 'bad-name',
  })
  assert.match(problems.join(' '), /合法的凭据引用名/)
  assert.match(problems.join(' '), /A-Za-z_/, '错误信息应给出合法形态')
})

test('header 含换行被拒（防注入）', () => {
  const problems = providers.validateApiDeclaration({
    route: 'x', api: 'openai-completions', models: ['m'],
    headers: { 'x-bad': 'a\nb' },
  })
  assert.match(problems.join(' '), /不得含换行/)
})

// ── 规格化 ──────────────────────────────────────────────────────────────────

test('预设路由自动补齐协议、地址与密钥引用名', () => {
  const normalized = providers.normalizeDeclaration({ route: 'deepseek', models: ['deepseek-chat'] })
  assert.equal(normalized.api, 'openai-completions')
  assert.equal(normalized.baseURL, 'https://api.deepseek.com')
  assert.equal(normalized.keyEnv, 'DEEPSEEK_API_KEY')
  assert.equal(normalized.models[0].id, 'deepseek-chat')
})

test('非预设路由按 route 推导密钥引用名', () => {
  const normalized = providers.normalizeDeclaration({ route: 'my-gateway', models: ['m'] })
  assert.equal(normalized.keyEnv, 'MY_GATEWAY_API_KEY')
})

test('本地推理预设不要求真实密钥', () => {
  const ollama = providers.normalizeDeclaration({ route: 'ollama', models: ['llama3'] })
  assert.equal(ollama.baseURL, 'http://127.0.0.1:11434/v1')
  const vllm = providers.normalizeDeclaration({ route: 'vllm', models: ['local-model'] })
  assert.equal(vllm.baseURL, 'http://127.0.0.1:8000/v1')
})

// ── patch 生成 ──────────────────────────────────────────────────────────────

test('provider patch 含协议、地址、密钥引用与模型列表', () => {
  const patch = providers.renderProviderPatch([providers.normalizeDeclaration({
    route: 'my-gateway', api: 'anthropic-messages',
    baseURL: 'https://gw.example.com', models: ['model-a', 'model-b'],
    keyEnv: 'GW_KEY',
  })])
  assert.ok(patch.includes('- id: llm-pi-ai'))
  assert.ok(patch.includes('      my-gateway:'))
  assert.ok(patch.includes('        api: "anthropic-messages"'))
  assert.ok(patch.includes('        baseURL: "https://gw.example.com"'))
  assert.ok(patch.includes('        apiKeyEnv: "GW_KEY"'))
  assert.ok(patch.includes('          - id: "model-a"'))
  assert.ok(patch.includes('          - id: "model-b"'))
  assert.equal(patch.includes('sk-'), false, 'patch 里不得出现密钥本体')
})

test('provider patch 可承载自定义请求头', () => {
  const patch = providers.renderProviderPatch([providers.normalizeDeclaration({
    route: 'gw', api: 'openai-completions', models: ['m'],
    headers: { 'x-custom': 'v', authorization: 'Bearer static' },
  })])
  assert.ok(patch.includes('        headers:'))
  assert.ok(patch.includes('"x-custom": "v"'))
})

test('默认模型 patch 单独成文件', () => {
  const patch = providers.renderDefaultModelPatch('my-gateway', 'model-a', 'high')
  assert.ok(patch.includes('- id: agent-default-model'))
  assert.ok(patch.includes('    provider: "my-gateway"'))
  assert.ok(patch.includes('    model: "model-a"'))
  assert.ok(patch.includes('    reasoningEffort: "high"'))
})

// ── 凭据文档最小改写 ────────────────────────────────────────────────────────

test('凭据文档：不存在时创建并写入 refs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autoresearch-cred-'))
  try {
    const path = join(dir, '.credentials.yaml')
    await providers.writeCredentialRefs(path, { MY_KEY: 'sk-test-1' })
    const text = await readFile(path, 'utf8')
    assert.ok(text.includes('version: 1'))
    assert.ok(text.includes('refs:'))
    assert.ok(text.includes('  MY_KEY: sk-test-1'))
    const refs = await providers.readCredentialRefs(path)
    assert.equal(refs.MY_KEY, 'sk-test-1')
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('凭据文档：更新已有 key 时保留 records 段与注释', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autoresearch-cred-'))
  try {
    const path = join(dir, '.credentials.yaml')
    await writeFile(path, [
      'version: 1',
      '# 这是注释，必须保留',
      'refs:',
      '  OLD_KEY: sk-old',
      '  KEEP_KEY: sk-keep',
      'records:',
      '  client-connection/browser-session:',
      '    kind: grant',
      '    payload:',
      '      version: 1',
      '      secret: abc',
      '',
    ].join('\n'), 'utf8')

    await providers.writeCredentialRefs(path, { OLD_KEY: 'sk-new', ADDED_KEY: 'sk-added' })
    const text = await readFile(path, 'utf8')

    assert.ok(text.includes('  OLD_KEY: sk-new'), '已有 key 被更新')
    assert.ok(text.includes('  KEEP_KEY: sk-keep'), '未涉及的 key 原样保留')
    assert.ok(text.includes('  ADDED_KEY: sk-added'), '新 key 被追加进 refs 段')
    assert.ok(text.includes('records:'), 'records 段必须保留')
    assert.ok(text.includes('client-connection/browser-session:'), 'records 内容必须保留')
    assert.ok(text.includes('secret: abc'), 'records 深层字段必须保留')
    assert.ok(text.includes('# 这是注释，必须保留'), '注释必须保留')

    const refsIndex = text.indexOf('refs:')
    const recordsIndex = text.indexOf('records:')
    const addedIndex = text.indexOf('ADDED_KEY')
    assert.ok(addedIndex > refsIndex && addedIndex < recordsIndex,
      `ADDED_KEY 位置 ${addedIndex} 应落在 refs(${refsIndex}) 与 records(${recordsIndex}) 之间`)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

test('凭据文档：读取时忽略 records 段', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'autoresearch-cred-'))
  try {
    const path = join(dir, '.credentials.yaml')
    await writeFile(path, [
      'version: 1',
      'refs:',
      '  REAL_KEY: sk-real',
      'records:',
      '  scope/id:',
      '    kind: grant',
      '',
    ].join('\n'), 'utf8')
    const refs = await providers.readCredentialRefs(path)
    assert.deepEqual(Object.keys(refs), ['REAL_KEY'])
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})

// ── 端点探测解释 ────────────────────────────────────────────────────────────

test('端点探测：401 解释为端点活着但密钥有问题', async () => {
  const server = await startStubServer((request, response) => {
    response.writeHead(401, { 'content-type': 'application/json' })
    response.end('{"error":"invalid key"}')
  })
  try {
    const probe = await providers.probeEndpoint({
      route: 'stub', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.port}/v1`, models: ['m'], keyEnv: 'STUB_KEY',
    }, { apiKey: 'bad' })
    assert.equal(probe.reachable, true)
    assert.equal(probe.status, 401)
    assert.match(probe.interpretation, /鉴权失败/)
  } finally {
    await server.close()
  }
})

test('端点探测：2xx 解释为可达且鉴权通过', async () => {
  const server = await startStubServer((request, response) => {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end('{"data":[]}')
  })
  try {
    const probe = await providers.probeEndpoint({
      route: 'stub', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.port}/v1`, models: ['m'],
    })
    assert.equal(probe.reachable, true)
    assert.match(probe.interpretation, /鉴权通过/)
  } finally {
    await server.close()
  }
})

test('端点探测：404 解释为可能缺路径前缀，不误判为失败', async () => {
  const server = await startStubServer((request, response) => {
    response.writeHead(404)
    response.end()
  })
  try {
    const probe = await providers.probeEndpoint({
      route: 'stub', api: 'openai-completions',
      baseURL: `http://127.0.0.1:${server.port}`, models: ['m'],
    })
    assert.equal(probe.reachable, true)
    assert.match(probe.interpretation, /没有 \/models 路由/)
  } finally {
    await server.close()
  }
})

test('端点探测：连不上时不宣称可达', async () => {
  const probe = await providers.probeEndpoint({
    route: 'dead', api: 'openai-completions',
    baseURL: 'http://127.0.0.1:1/v1', models: ['m'],
  }, { timeoutMs: 3000 })
  assert.equal(probe.reachable, false)
  assert.ok(typeof probe.reason === 'string' && probe.reason.length > 0)
})

test('anthropic 协议用 x-api-key 而不是 Authorization', async () => {
  let seen = null
  const server = await startStubServer((request, response) => {
    seen = request.headers
    response.writeHead(200)
    response.end('{}')
  })
  try {
    await providers.probeEndpoint({
      route: 'stub', api: 'anthropic-messages',
      baseURL: `http://127.0.0.1:${server.port}`, models: ['m'],
    }, { apiKey: 'sk-ant' })
    assert.equal(seen['x-api-key'], 'sk-ant')
    assert.equal(seen.authorization, undefined)
    assert.ok(typeof seen['anthropic-version'] === 'string')
  } finally {
    await server.close()
  }
})

// ── 双路配对 ────────────────────────────────────────────────────────────────

test('双路配对：route 不同时给出可用的两路', () => {
  const built = providers.buildDualLaneDeclarations(
    { route: 'lane-a', api: 'openai-completions', baseURL: 'https://a.example.com/v1', models: ['m-a'], keyEnv: 'A_KEY' },
    { route: 'lane-b', api: 'anthropic-messages', baseURL: 'https://b.example.com', models: ['m-b'], keyEnv: 'B_KEY' },
  )
  assert.deepEqual(built.problems, [])
  assert.equal(built.lanes[0].provider, 'lane-a')
  assert.equal(built.lanes[0].model, 'm-a')
  assert.equal(built.lanes[0].credentialEnv, 'A_KEY')
  assert.equal(built.lanes[1].provider, 'lane-b')
  assert.equal(built.lanes[1].credentialEnv, 'B_KEY')
})

test('双路配对：route 相同直接拒绝（共识要求身份两两不同）', () => {
  const built = providers.buildDualLaneDeclarations(
    { route: 'same', api: 'openai-completions', models: ['m1'] },
    { route: 'same', api: 'openai-completions', models: ['m2'] },
  )
  assert.match(built.problems.join(' '), /route 必须不同/)
  assert.equal(built.lanes, undefined)
})

test('双路配对：单边非法时汇总报出', () => {
  const built = providers.buildDualLaneDeclarations(
    { route: 'ok', api: 'openai-completions', models: ['m'] },
    { route: 'bad cape', api: 'nope', models: [] },
  )
  assert.ok(built.problems.some((problem) => problem.startsWith('第 2 路：')))
})

// ── 辅助 ────────────────────────────────────────────────────────────────────

/** 起一个本地 stub 服务，用于验证探测行为；用完即关。 */
function startStubServer(handler) {
  return new Promise((resolvePromise) => {
    const server = createServer(handler)
    // 句柄不参与事件循环保活：断言失败提前退出时不会拖住进程关闭，
    // Windows 上也就不会触发 libuv 的 UV_HANDLE_CLOSING 断言。
    server.unref()
    server.listen(0, '127.0.0.1', () => {
      resolvePromise({
        port: server.address().port,
        // undici 默认用 keep-alive 连接池；只调 close() 会等待这些连接自然结束，
        // 于是测试跑完后仍有句柄挂着。先断开存活连接再关闭。
        close: () => new Promise((done) => {
          server.closeAllConnections?.()
          server.close(() => done())
        }),
      })
    })
  })
}

test('mergeProviders：未提供的字段保留现有（不覆盖 model 列表/密钥引用）', async () => {
  const { mergeProviders, listProviders } = profilePatch
  const { mkdtemp, writeFile, readFile } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'merge-test-'))
  const path = join(dir, 'cordis.patch.yml')
  await writeFile(path, [
    '- id: llm-pi-ai',
    '  config:',
    '    providers:',
    '      gw:',
    '        displayName: gw',
    '        api: openai-completions',
    '        baseURL: https://gw.example/v1',
    '        apiKeyEnv: GW_KEY',
    '        models:',
    '          - id: model-a',
    '',
  ].join('\n'), 'utf8')

  // 只给 keyEnv（不带 models）→ 模型保留
  await mergeProviders(path, [{ route: 'gw', keyEnv: 'GW_KEY', models: [] }])
  let providers = await listProviders(path)
  assert.deepEqual(providers.gw.models.map((m) => m.id), ['model-a'])
  assert.equal(providers.gw.baseURL, 'https://gw.example/v1')

  // 显式给全列表 → 覆盖
  await mergeProviders(path, [{ route: 'gw', api: 'openai-completions', keyEnv: 'GW_KEY', models: [{ id: 'model-a' }, { id: 'model-b' }] }])
  providers = await listProviders(path)
  assert.deepEqual(providers.gw.models.map((m) => m.id), ['model-a', 'model-b'])

  // 显式空 baseURL → 删除该键（切回协议默认）
  await mergeProviders(path, [{ route: 'gw', api: 'openai-completions', baseURL: '', keyEnv: 'GW_KEY', models: [] }])
  providers = await listProviders(path)
  assert.equal(providers.gw.baseURL, undefined)
  assert.deepEqual(providers.gw.models.map((m) => m.id), ['model-a', 'model-b'])
})

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

console.log(`\n自定义 API 接入自检：${passed} 通过，${failed} 失败，共 ${cases.length} 项`)

// undici 连接池在最后一个 stub 关闭后仍需一拍才真正释放 socket；立即退出会让
// Windows 上的 libuv 在句柄关闭中途被打断而断言。等一拍再退出，输出与退出码都可信。
await new Promise((resolve) => setTimeout(resolve, 300))
process.exitCode = failed === 0 ? 0 : 1
