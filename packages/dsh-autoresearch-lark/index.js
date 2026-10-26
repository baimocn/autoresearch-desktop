/**
 * dsh-autoresearch-lark —— 飞书集成（多维表格同步 / 审批状态 / 消息通知）。
 *
 * ## 为什么走 CLI
 *
 * `@larksuite/cli` 已装好并授权，自带 DPoP 与 token 刷新。引 SDK 等于再管一份
 * 凭据、再对一遍版本兼容。封装细节见 lib/cli.js。
 *
 * ## 三个真实坑（都在实测里撞过）
 *
 * 1. 子命令名不能按直觉猜：没有 `+record-create`（是 `+record-batch-create`）、
 *    没有 `im +msg-send`（是 `im +messages-send`）。端点表集中在 lib/cli.js。
 * 2. CLI 走 shell 时参数必须自己转义：中文名带空格会被拆成位置参数。
 * 3. 响应字段名与文档常常不一致（`base_token` vs `app_token`、`tables[].id` vs
 *    `table_id`、矩阵形状的记录）。**所有取值路径都以实测为准**，取不到就报错，
 *    绝不返回 null 让上层静默空写。
 *
 * @module dsh-autoresearch-lark
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import {
  authStatus, runLark, describeCommand, LarkError,
  createBase, createTable, listTables,
  searchRecords, listRecords, createRecord, createRecords, updateRecord,
  sendMessage,
} from './lib/cli.js'
import { provisionBase, syncTaskPackage, TABLE_SCHEMAS, toCell, toRecordFields } from './lib/sync.js'
import { normalizeLarkConfig } from './lib/config.js'

export const name = 'autoresearch-lark'

export const inject = ['tools']

const DEFAULT_CONFIG = Object.freeze({
  /** 三表 Base token；缺省时第一次 sync 会提示先 provision。 */
  baseToken: null,
  /** 预建好的表 id；缺省时按表名在 baseToken 里查。 */
  tables: null,
  /** 通知群 chat_id（oc_ 开头）。 */
  chatId: null,
  /** 同步失败是否抛错。默认 false：飞书不可达不该阻塞出题主流程。 */
  strict: false,
  timeoutMs: 60_000,
})

/** 把任务根的 state.json / run_summary / 双轨轨迹汇总成三表行。 */
async function buildRowsFromTask(taskRoot) {
  const rows = { task: null, gates: [], trajectories: [] }
  const readJson = async (p) => {
    try { return JSON.parse(await readFile(p, 'utf8')) } catch { return undefined }
  }
  const state = await readJson(join(taskRoot, 'autoresearch-state.json'))
  if (state) {
    const blocking = (state.checks ?? []).filter((c) => c.status === 'FAIL').map((c) => c.id)
    rows.task = {
      任务ID: state.taskId ?? taskRoot.split(/[\\/]/).pop(),
      任务名: state.taskName ?? null,
      阶段: state.phase ?? null,
      状态: blocking.length > 0 ? '阻塞' : (state.phase === 'done' ? '已完成' : '进行中'),
      阻塞门禁: blocking.join(',') || null,
      指标名: state.metric?.name ?? null,
      方向: state.metric?.direction ?? null,
      '算力成本(元)': state.autodl?.costYuan ?? null,
      备注: state.note ?? null,
    }
    for (const check of state.checks ?? []) {
      rows.gates.push({
        任务ID: rows.task.任务ID,
        门禁: check.id,
        结论: check.status === 'FAIL' ? 'REJECT' : (check.status === 'UNKNOWN' ? 'NEEDS_EVIDENCE' : 'RECOMMEND'),
        首条问题: check.detail ?? null,
      })
    }
  }
  const runSummary = await readJson(join(taskRoot, 'expert_evidence', 'run_summary.json'))
  if (runSummary) {
    for (const track of runSummary.agent_execution ?? []) {
      rows.trajectories.push({
        任务ID: rows.task?.任务ID ?? taskRoot.split(/[\\/]/).pop(),
        轨道: track.track === 'trajectory_seed' ? 'seed' : 'codex',
        轮数: track.trajectory_rounds ?? track.effective_rounds ?? null,
        出分轮数: track.scored_rounds ?? null,
        失败轮数: track.failed_rounds ?? null,
        '有效时长h': track.duration_hours ?? null,
        状态: track.threshold_pass === true ? '达标' : '未达标',
      })
    }
  }
  return rows
}


/** 统一的 JSON 输出形态：dsh-tools 强制要求 output.render，缺它会直接抛错。 */
const jsonOutput = {
  schema: { type: 'json' },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
}

export function apply(ctx, config = {}) {
  let cfg = normalizeLarkConfig(config)

  const loadTables = async () => {
    cfg = await normalizeLarkConfig(cfg)
    if (!cfg.baseToken) throw new LarkError('未配置飞书 baseToken。先运行 autoresearch_lark_provision，或写 .dsh-home/.lark.json')
    if (cfg.tables?.tasks?.id) return cfg.tables
    // 没有显式表 id：按表名查（第一次 provision 后即可省略 tables 配置）。
    const listed = await listTables({ baseToken: cfg.baseToken }, { timeoutMs: cfg.timeoutMs })
    const find = (name) => listed.tables.find((t) => t.name === name)?.id ?? null
    return {
      tasks: { id: find('任务') },
      gates: { id: find('门禁') },
      trajectories: { id: find('轨迹') },
    }
  }

  // ── 状态与探查 ─────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_status',
    description: '查飞书授权状态与已配置的三表。只读。',
    parameters: {},
    async execute() {
      cfg = await normalizeLarkConfig(cfg)
      const auth = await authStatus({ timeoutMs: cfg.timeoutMs })
      let tables = null
      if (cfg.baseToken) {
        try {
          const listed = await listTables({ baseToken: cfg.baseToken }, { timeoutMs: cfg.timeoutMs })
          tables = listed.tables
        } catch (error) {
          tables = [{ error: error.message }]
        }
      }
      return {
        auth,
        baseToken: cfg.baseToken ?? null,
        tables,
        chatId: cfg.chatId ?? null,
        hint: auth.usable ? undefined : '需要先 lark-cli auth login（或检查凭据）',
      }
    },
  }))

  // ── 建三表 ─────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_provision',
    description: '在飞书创建「任务/门禁/轨迹」三表 Base，返回需要写进 .dsh-home/.lark.json 的配置。',
    parameters: {
      name: { type: 'string', description: 'Base 名称' },
      folder_token: { type: 'string', description: '目标文件夹 token（可省略，建在默认位置）' },
      dry_run: { type: 'boolean', description: '只预演请求' },
    },
    async execute(args) {
      return provisionBase({
        name: args?.name ?? 'AutoResearch 平台',
        folderToken: args?.folder_token,
        dryRun: args?.dry_run === true,
      }, { timeoutMs: cfg.timeoutMs })
    },
  }))

  // ── 同步 ──────────────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_sync',
    description: '把一个题包的状态/门禁结论/双轨轨迹同步进飞书三表。任务表按任务ID upsert，其余追加。',
    parameters: {
      task_root: { type: 'string', description: '题包根目录（含 autoresearch-state.json）', required: true },
      dry_run: { type: 'boolean', description: '只预演' },
    },
    async execute(args) {
      const root = args?.task_root
      if (typeof root !== 'string' || root === '') throw new LarkError('必须提供 task_root')
      const [tables, rows] = await Promise.all([loadTables(), buildRowsFromTask(root)])
      if (!rows.task && rows.gates.length === 0 && rows.trajectories.length === 0) {
        return { synced: false, reason: `在 ${root} 没读到 autoresearch-state.json 或 run_summary.json，无可同步内容` }
      }
      return syncTaskPackage({
        baseToken: cfg.baseToken,
        tables,
        task: rows.task ?? { 任务ID: root.split(/[\\/]/).pop() },
        gates: rows.gates,
        trajectories: rows.trajectories,
        dryRun: args?.dry_run === true,
      }, { timeoutMs: cfg.timeoutMs })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_records',
    description: '读回飞书三表的记录（用于核对同步是否真的写进去了）。只读。',
    parameters: {
      table: { type: 'string', enum: ['tasks', 'gates', 'trajectories'], description: '读哪张表', required: true },
      keyword: { type: 'string', description: '按关键词查（配合 search_field）' },
      search_field: { type: 'string', description: '搜索限定列名，默认 任务ID' },
      limit: { type: 'number', description: '条数上限，默认 20' },
    },
    async execute(args) {
      const tables = await loadTables()
      const tableId = tables?.[args?.table]?.id
      if (!tableId) throw new LarkError(`表 ${args?.table} 的 id 缺失，请先 provision`)
      if (args?.keyword) {
        return searchRecords({
          baseToken: cfg.baseToken, tableId,
          keyword: String(args.keyword),
          searchFieldNames: [args?.search_field ?? '任务ID'],
          limit: args?.limit ?? 20,
        }, { timeoutMs: cfg.timeoutMs })
      }
      return listRecords({ baseToken: cfg.baseToken, tableId, limit: args?.limit ?? 20 },
        { timeoutMs: cfg.timeoutMs })
    },
  }))

  // ── 通知与审批辅助 ─────────────────────────────────────────────────────

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_notify',
    description: '往配置的群发一条通知（门禁阻塞、阶段完成、算力成本等）。会真实发消息。',
    parameters: {
      text: { type: 'string', description: '纯文本内容' },
      markdown: { type: 'string', description: 'markdown 内容（与 text 二选一）' },
      chat_id: { type: 'string', description: '目标群；缺省用配置里的 chatId' },
      dry_run: { type: 'boolean', description: '只预演' },
    },
    async execute(args) {
      cfg = await normalizeLarkConfig(cfg)
      const chatId = args?.chat_id ?? cfg.chatId
      if (!chatId) {
        return { sent: false, reason: '未配置飞书群 chat_id。把群 chat_id 写进 .dsh-home/.lark.json 的 chatId 字段。' }
      }
      return sendMessage({
        chatId,
        text: args?.text,
        markdown: args?.markdown,
        dryRun: args?.dry_run === true,
      }, { timeoutMs: cfg.timeoutMs })
    },
  }))

  ctx.tools.register(defineTool({
    output: jsonOutput,
    name: 'autoresearch_lark_raw',
    description: '直接跑一条 lark-cli 命令（逃生舱口）。用于封装没覆盖到的表单/审批/视图操作。',
    parameters: {
      args: { type: 'string', description: '以空格分隔的参数（不含 lark-cli 本身），例：base +field-list --base-token X --table-id Y',
        required: true },
      dry_run: { type: 'boolean' },
    },
    async execute(args) {
      cfg = await normalizeLarkConfig(cfg)
      const argv = String(args?.args ?? '').trim().split(/\s+/).filter(Boolean)
      if (argv.length === 0) throw new LarkError('必须提供 args')
      if (argv[0] === 'lark-cli' || argv[0] === 'lark-cli.cmd') argv.shift()
      if (argv[0] === 'npx') argv.splice(0, 3)
      if (args?.dry_run === true) argv.push('--dry-run')
      return { command: describeCommand(argv), result: await runLark(argv, { timeoutMs: cfg.timeoutMs }) }
    },
  }))
}

export { TABLE_SCHEMAS, LarkError }
