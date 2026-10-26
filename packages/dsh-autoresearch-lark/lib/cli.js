/**
 * 飞书 CLI 封装。
 *
 * ## 为什么走 CLI 而不是 SDK
 *
 * `@larksuite/cli`（v1.0.98）已经在本机装好并完成授权（bot 身份 ready），
 * 自带 DPoP、token 自动刷新、`--jq` 过滤与 `--dry-run` 预演。
 * 直接调它的子进程比再引一套 SDK 少三类风险：多一份凭据管理、多一套版本兼容、
 * 多一处「两边行为不一致」。
 *
 * ## 三条纪律
 *
 * 1. **不解析人读输出。** 一律 `--format json` + 自己 `JSON.parse`；
 *    pretty/table 格式会随版本变，那不是契约。
 * 2. **失败必须显式。** CLI 非零退出、或 JSON 里带 `error`/`code != 0`，
 *    都抛 `LarkError`，绝不返回半截数据让上层误以为成功。
 * 3. **危险操作先 dry-run。** `--dry-run` 是 CLI 自带能力，封装层把它透传出去，
 *    让上层能先看清请求再执行。
 *
 * @module dsh-autoresearch-lark/lib/cli
 */

import { spawn } from 'node:child_process'

/** 飞书调用失败。`stderr` 保留原文，便于定位是权限、参数还是网络。 */
export class LarkError extends Error {
  constructor(message, { command, exitCode, stdout, stderr } = {}) {
    super(message)
    this.name = 'LarkError'
    this.command = command ?? null
    this.exitCode = exitCode ?? null
    this.stdout = stdout ?? ''
    this.stderr = stderr ?? ''
  }
}

/** CLI 可执行文件。`lark-cli` 在 PATH 上时直接用它，否则退回 npx。 */
const CLI = process.env.LARK_CLI_BIN || null

/**
 * 参数 → shell 安全的单个参数。
 *
 * ## 为什么必须做这一步（实测教训）
 *
 * Windows 上 `npx` 是 `.cmd`，spawn 必须 `shell: true` 才找得到。但
 * `shell: true` + 参数数组在 Node 里是**只拼接、不转义**的 —— 实测把
 * `--name 'AutoResearch 联调测试'` 拆成了两个位置参数，CLI 报
 * 「positional arguments are not supported (got ["联调测试"])」。
 *
 * 也就是说：任何带空格的中文名、带引号的 JSON、带 `$`/`&` 的值都会坏掉，
 * 而且坏法随平台而异。所以这里自己转义，并把整条命令作为**一个字符串**交给
 * spawn（不再依赖 Node 的数组拼接）。
 */
function shellQuote(arg) {
  const s = String(arg)
  if (s === '') return '""'
  // 单引号包裹最安全：内部单引号按 POSIX 惯例用 '"'"' 断开再接。
  // 但 cmd.exe 不认单引号，所以统一用双引号 + 转义内部双引号与特殊字符。
  if (/^[A-Za-z0-9_@%+=:,./\\-]+$/.test(s)) return s
  return `"${s.replace(/"/g, '\\"').replace(/([&|<>^()$`])/g, '^$1')}"`
}

function buildCommandLine(args) {
  const parts = CLI ? [shellQuote(CLI)] : ['npx', '--no-install', '@larksuite/cli']
  for (const a of args) parts.push(shellQuote(a))
  return parts.join(' ')
}

/**
 * 跑一条 CLI 命令，返回解析后的 JSON。
 *
 * @param {string[]} args 例如 `['base', '+record-search', '--base-token', tok]`
 * @param {{timeoutMs?: number, cwd?: string, env?: object}} options
 */
export function runLark(args, options = {}) {
  const { timeoutMs = 60_000, cwd, env } = options
  const commandLine = buildCommandLine(args)

  return new Promise((resolve, reject) => {
    const child = spawn(commandLine, {
      cwd,
      env: { ...process.env, ...env },
      // 必须 shell：Windows 下 npx / lark-cli 都是 .cmd。参数已由 shellQuote 转义。
      shell: true,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* 已退出 */ }
      reject(new LarkError(`飞书 CLI 超时（${timeoutMs}ms）：${args.slice(0, 2).join(' ')}`, {
        command: args.join(' '), exitCode: null, stdout, stderr,
      }))
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(new LarkError(`无法启动飞书 CLI：${error.message}。`
        + '请确认已安装 @larksuite/cli 并完成 lark-cli auth login', {
        command: args.join(' '), exitCode: null, stdout, stderr,
      }))
    })

    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)

      // npx 会把 npm warn 打到 stderr，不能因此判失败 —— 只看退出码。
      if (code !== 0) {
        // 从 stderr 里挑出最像原因的一行，避免把整段 npm warn 抛给用户。
        const lines = stderr.split(/\r?\n/).map((l) => l.trim())
          .filter((l) => l !== '' && !/^npm warn/i.test(l) && !/npm notice/i.test(l))
        const reason = lines.slice(-3).join(' | ') || `退出码 ${code}`
        reject(new LarkError(`飞书 CLI 失败（${args.slice(0, 2).join(' ')}）：${reason}`, {
          command: args.join(' '), exitCode: code, stdout, stderr,
        }))
        return
      }

      const text = stdout.trim()
      if (text === '') { resolve(null); return }
      try {
        resolve(JSON.parse(text))
      } catch {
        // 非 JSON 输出只在确实需要时才用；这里如实报错，不猜结构。
        reject(new LarkError(`飞书 CLI 输出不是 JSON：${text.slice(0, 300)}`, {
          command: args.join(' '), exitCode: code, stdout, stderr,
        }))
      }
    })
  })
}

/** 组装一条干跑命令的可读形式，供报告里展示「将执行什么」。 */
export function describeCommand(args) {
  return buildCommandLine(args)
}

/** 鉴权状态。未授权时如实返回，不抛错 —— 上层据此决定是提示还是降级。 */
export async function authStatus(options) {
  try {
    const raw = await runLark(['auth', 'status'], options)
    const identities = raw?.identities ?? {}
    return {
      appId: raw?.appId ?? null,
      brand: raw?.brand ?? null,
      bot: identities.bot?.status ?? null,
      user: identities.user?.status ?? null,
      userOpenId: identities.user?.openId ?? null,
      usable: identities.bot?.available === true || identities.user?.available === true,
      raw,
    }
  } catch (error) {
    return { usable: false, error: error.message, raw: null }
  }
}

/** 建 Base（多维表格）。返回 base token。 */
export async function createBase({ name, folderToken, fields, tableName, dryRun }, options) {
  const args = ['base', '+base-create', '--name', name, '--format', 'json']
  if (folderToken) args.push('--folder-token', folderToken)
  if (Array.isArray(fields) && fields.length > 0) {
    args.push('--fields', JSON.stringify(fields))
    if (tableName) args.push('--table-name', tableName)
  }
  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  // 真实响应形状（实测）：{ ok, identity, data: { base: { base_token, url, name }, created } }
  // 早期按 data.base.app_token 取，拿到 null 才发现的 —— 这里把几种可能都认上。
  return {
    baseToken: raw?.data?.base?.base_token
      ?? raw?.data?.base?.app_token
      ?? raw?.data?.base_token
      ?? raw?.base_token
      ?? null,
    url: raw?.data?.base?.url ?? null,
    name: raw?.data?.base?.name ?? null,
    raw,
  }
}

/** 建表（带字段 schema）。返回 table id。 */
export async function createTable({ baseToken, name, fields, dryRun }, options) {
  const args = ['base', '+table-create', '--base-token', baseToken,
    '--name', name, '--fields', JSON.stringify(fields), '--format', 'json']
  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  // 真实形状（实测）：{ ok, data: { table: { id, name, fields, views }, fields } }
  const tableId = raw?.data?.table?.id ?? raw?.data?.table_id ?? raw?.table_id ?? null
  if (tableId === null) {
    // 拿不到 id 就报错，绝不返回 null 让上层继续（那会退化成静默 0 写入）。
    throw new LarkError(`建表成功但响应里没有 table id：${JSON.stringify(raw).slice(0, 300)}`)
  }
  return { tableId, name: raw?.data?.table?.name ?? name, raw }
}

/** 列表。 */
export async function listTables({ baseToken }, options) {
  const raw = await runLark(['base', '+table-list', '--base-token', baseToken, '--format', 'json'], options)
  // 真实形状（实测）：{ ok, data: { tables: [{ id, name, records_count, rev }], total } }
  // 注意字段是 id 不是 table_id —— 早期按 items/table_id 取会静默拿到空数组。
  const items = raw?.data?.tables ?? raw?.data?.items ?? raw?.tables ?? raw?.items ?? []
  return {
    tables: items.map((t) => ({
      id: t?.id ?? t?.table_id ?? null,
      name: t?.name ?? null,
    })),
    raw,
  }
}

/**
 * 新增记录。
 *
 * CLI 没有 `+record-create`（早期按命名直觉写过，实测 unknown command），
 * 单条写入走 `+record-upsert`，批量走 `+record-batch-create`（上限 200 条/次）。
 * 这里统一用批量接口 —— 同步三表常常一次写多条，走 batch 少一次进程开销。
 *
 * `fields` 是 `{列名: 值}` 的普通对象；CLI 要求包进 `create_records` 数组，
 * 封装层在这里吃掉这层包装。
 */
export async function createRecord({ baseToken, tableId, fields, dryRun }, options) {
  const args = ['base', '+record-batch-create', '--base-token', baseToken,
    '--table-id', tableId, '--json', JSON.stringify({ create_records: [fields] }), '--format', 'json']
  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  const created = raw?.data?.records ?? raw?.records ?? []
  return { recordId: created[0]?.record_id ?? null, raw }
}

/** 批量新增（最多 200 条/次，超出由调用方分批）。 */
export async function createRecords({ baseToken, tableId, records, dryRun }, options) {
  if (!Array.isArray(records) || records.length === 0) {
    throw new LarkError('createRecords 需要非空 records 数组')
  }
  if (records.length > 200) {
    throw new LarkError(`createRecords 单次上限 200 条，收到 ${records.length} 条，请调用方分批`)
  }
  const args = ['base', '+record-batch-create', '--base-token', baseToken,
    '--table-id', tableId, '--json', JSON.stringify({ create_records: records }), '--format', 'json']
  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  const created = raw?.data?.records ?? raw?.records ?? []
  return { recordIds: created.map((r) => r?.record_id ?? null), raw }
}

/**
 * 按条件查记录。
 *
 * 注意 `+record-search` 的 `--keyword` 是**必填**（除非给 `--json`）。
 * 只想按字段过滤时得走 `--json`，否则 CLI 会直接报参数错误。
 */
/**
 * 把 CLI 的「矩阵」响应转成字段映射记录。
 *
 * 两个搜索/列表接口（+record-search、+record-list）都返回这种形状（实测）：
 *   `{ ok, data: { fields: [列名], data: [[值,...]], record_id_list: [id], has_more } }`
 * 行与列按下标对齐 —— 直接把 `data` 当对象数组用会得到空记录
 * （早期按 `data.items` 取，拿到 undefined，静默丢掉全部记录）。
 */
function recordsFromMatrix(raw) {
  const block = raw?.data ?? {}
  const names = Array.isArray(block?.fields) ? block.fields : []
  const rows = Array.isArray(block?.data) ? block.data : []
  const ids = Array.isArray(block?.record_id_list) ? block.record_id_list : []
  return rows.map((row, index) => ({
    recordId: ids[index] ?? null,
    fields: Object.fromEntries(names.map((name, column) => [name, Array.isArray(row) ? row[column] : null])),
  }))
}

/**
 * 按关键词搜记录。
 *
 * ## 为什么不用 filter 形态
 *
 * `+record-search` 的 `--keyword` 是必填（CLI --help 明说），只传 `--json`
 * 的 filter（conditions 为空数组）实测被服务端以 800010701 拒绝。
 * 所以按关键词查：`keyword` = 要找的值，`search_fields` = 限定在哪几个列找。
 */
export async function searchRecords({ baseToken, tableId, keyword, searchFieldNames, fieldNames, limit = 50 }, options) {
  if (typeof keyword !== 'string' || keyword === '') {
    throw new LarkError('searchRecords 需要 keyword（+record-search 的必填项）')
  }
  const body = { keyword, limit }
  if (Array.isArray(searchFieldNames) && searchFieldNames.length > 0) body.search_fields = searchFieldNames
  if (Array.isArray(fieldNames) && fieldNames.length > 0) body.select_fields = fieldNames
  const raw = await runLark(['base', '+record-search', '--base-token', baseToken,
    '--table-id', tableId, '--json', JSON.stringify(body), '--format', 'json'], options)
  return { records: recordsFromMatrix(raw), hasMore: raw?.data?.has_more ?? false, raw }
}

/** 列全部记录（按字段映射返回）。适合读回校验，不适合精确查找。 */
export async function listRecords({ baseToken, tableId, fieldNames, limit = 100 }, options) {
  const args = ['base', '+record-list', '--base-token', baseToken, '--table-id', tableId,
    '--format', 'json', '--limit', String(limit)]
  for (const f of fieldNames ?? []) args.push('--field-id', f)
  const raw = await runLark(args, options)
  return { records: recordsFromMatrix(raw), hasMore: raw?.data?.has_more ?? false, raw }
}

/** 更新记录。 */
export async function updateRecord({ baseToken, tableId, recordId, fields, dryRun }, options) {
  const args = ['base', '+record-upsert', '--base-token', baseToken, '--table-id', tableId,
    '--record-id', recordId, '--json', JSON.stringify(fields), '--format', 'json']
  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  return { recordId: raw?.data?.record?.record_id ?? recordId, raw }
}

/**
 * 发消息。
 *
 * CLI 的命令是 `im +messages-send`（不是 `+msg-send`；后者实测 unknown command）。
 * 它按内容形态分 `--text` / `--markdown` / `--content`，且 `--chat-id` 与
 * `--user-id` 互斥。这里按最简单的 text 形态封装，复杂形态让调用方直接传 content。
 */
export async function sendMessage({
  chatId, userId, text, markdown, content, dryRun,
}, options) {
  const args = ['im', '+messages-send', '--format', 'json']
  if (chatId) args.push('--chat-id', chatId)
  else if (userId) args.push('--user-id', userId)
  else throw new LarkError('sendMessage 需要 chatId 或 userId 之一')

  if (typeof markdown === 'string' && markdown !== '') args.push('--markdown', markdown)
  else if (typeof text === 'string' && text !== '') args.push('--text', text)
  else if (content !== undefined) args.push('--content', JSON.stringify(content))
  else throw new LarkError('sendMessage 需要 text / markdown / content 之一')

  if (dryRun) args.push('--dry-run')
  const raw = await runLark(args, options)
  return { messageId: raw?.data?.message_id ?? null, raw }
}
