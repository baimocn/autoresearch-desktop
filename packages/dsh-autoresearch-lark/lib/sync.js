/**
 * 飞书三表同步：把题包状态、门禁结论、双轨进度映射成多维表格。
 *
 * ## 为什么是三张表
 *
 * 与 `autoresearch-feishu-three-table` skill 的划分一致，理由是**更新频率不同**：
 *
 * | 表 | 一行代表 | 更新时机 |
 * |---|---|---|
 * | 任务表 | 一个题包 | 阶段推进、状态变更 |
 * | 门禁表 | 一次门禁结论 | 每跑一次门禁追加一行 |
 * | 轨迹表 | 一条轨迹的轮次摘要 | 每轮迭代 |
 *
 * 混成一张表的话，门禁每跑一次就要改任务行，历史结论全被覆盖 ——
 * 而「这题上次为什么没过」恰恰是最常被问的问题。
 *
 * ## 字段类型是硬约束
 *
 * 飞书多维表格的 select / number / date 字段对**值的形状**有要求：
 * select 要 `[选项]` 数组、number 要数字、date 要毫秒时间戳。
 * 传错形状不会报错，只会静默写进空值 —— 所以这里统一在 `toCell()` 里转。
 *
 * @module dsh-autoresearch-lark/lib/sync
 */

import { createBase, createTable, createRecords, createRecord, listTables, searchRecords, updateRecord } from './cli.js'
/**
 * 三表 schema。
 *
 * 字段名用中文（面向专家）；`name` 是唯一键，用于「查了再决定新建还是更新」。
 */
export const TABLE_SCHEMAS = Object.freeze({
  tasks: {
    name: '任务',
    keyField: '任务ID',
    fields: [
      { name: '任务ID', type: 'text' },
      { name: '任务名', type: 'text' },
      { name: '阶段', type: 'select', options: [
        { name: 'intake' }, { name: 'feasibility' }, { name: 'build' },
        { name: 'verify' }, { name: 'deliver' }, { name: 'done' },
      ] },
      { name: '状态', type: 'select', options: [
        { name: '进行中' }, { name: '阻塞' }, { name: '待确认' }, { name: '已完成' },
      ] },
      { name: '阻塞门禁', type: 'text' },
      { name: '指标名', type: 'text' },
      { name: '方向', type: 'select', options: [{ name: 'maximize' }, { name: 'minimize' }] },
      { name: '算力成本(元)', type: 'number' },
      { name: '更新时间', type: 'date' },
      { name: '备注', type: 'text' },
    ],
  },
  gates: {
    name: '门禁',
    keyField: '记录键',
    fields: [
      { name: '记录键', type: 'text' },
      { name: '任务ID', type: 'text' },
      { name: '门禁', type: 'text' },
      { name: '结论', type: 'select', options: [
        { name: 'RECOMMEND' }, { name: 'NEEDS_EVIDENCE' }, { name: 'REJECT' },
      ] },
      { name: '检查项', type: 'number' },
      { name: '失败项', type: 'number' },
      { name: '待确认项', type: 'number' },
      { name: '首条问题', type: 'text' },
      { name: '时间', type: 'date' },
    ],
  },
  trajectories: {
    name: '轨迹',
    keyField: '记录键',
    fields: [
      { name: '记录键', type: 'text' },
      { name: '任务ID', type: 'text' },
      { name: '轨道', type: 'select', options: [{ name: 'codex' }, { name: 'seed' }] },
      { name: '轮数', type: 'number' },
      { name: '出分轮数', type: 'number' },
      { name: '失败轮数', type: 'number' },
      { name: '最佳分', type: 'number' },
      { name: '有效时长(h)', type: 'number' },
      { name: '状态', type: 'text' },
      { name: '时间', type: 'date' },
    ],
  },
})

/**
 * 把 JS 值转成飞书单元格值。
 *
 * 三个坑，都是字段类型决定的：
 *   · select 必须 `[字符串]` —— 直接给字符串会被忽略
 *   · date 必须毫秒数 —— 给 ISO 串会得到空值
 *   · number 必须是数字 —— 给数字字符串会得到空值（空串 / null 要转成 null）
 */
export function toCell(type, value) {
  if (value === undefined || value === null || value === '') return null
  switch (type) {
    case 'select':
      return Array.isArray(value) ? value : [String(value)]
    case 'date':
      if (typeof value === 'number') return value
      if (value instanceof Date) return value.getTime()
      if (typeof value === 'string') {
        const t = Date.parse(value)
        return Number.isFinite(t) ? t : null
      }
      return null
    case 'number': {
      const n = Number(value)
      return Number.isFinite(n) ? n : null
    }
    default:
      return String(value)
  }
}

/** 按 schema 把一行对象转成飞书记录字段。未知键直接忽略（不往表里塞不存在的列）。 */
export function toRecordFields(schema, row) {
  const out = {}
  for (const field of schema.fields) {
    if (!(field.name in row)) continue
    const cell = toCell(field.type, row[field.name])
    if (cell !== null) out[field.name] = cell
  }
  return out
}

/**
 * 建一个全新的三表 Base。返回各表 token 与 id。
 *
 * 先建 Base（带第一张表 schema），再补建另外两张 —— CLI 的 `+base-create`
 * 只接受**一张**表的 schema，这是它的能力边界，不是我们的选择。
 */
export async function provisionBase({ name, folderToken, dryRun = false }, options) {
  const [taskSchema, ...rest] = [TABLE_SCHEMAS.tasks, TABLE_SCHEMAS.gates, TABLE_SCHEMAS.trajectories]
  const base = await createBase({
    name,
    folderToken,
    fields: taskSchema.fields,
    tableName: taskSchema.name,
    dryRun,
  }, options)
  if (!base.baseToken) {
    throw new Error('建 Base 成功但没拿到 base token，无法继续建表')
  }

  const tables = {}
  // 第一张表已随 Base 建好，需要拿到它的 table_id。
  const listed = await listTables({ baseToken: base.baseToken }, options)
  const first = listed.tables.find((t) => t.name === taskSchema.name) ?? listed.tables[0]
  tables.tasks = { id: first?.id ?? null, name: taskSchema.name }

  for (const schema of rest) {
    const made = await createTable({ baseToken: base.baseToken, name: schema.name, fields: schema.fields, dryRun }, options)
    tables[schema.name === '门禁' ? 'gates' : 'trajectories'] = { id: made.tableId, name: schema.name }
  }

  return { baseToken: base.baseToken, tables }
}

/**
 * 把一批状态同步进三表。
 *
 * 任务表按「任务ID」做 upsert（同一个任务只留一行）；门禁表与轨迹表**追加**。
 * 追加的理由：历史比现状更重要 —— 「上次为什么被拒」不能被覆盖。
 */
export async function syncTaskPackage({
  baseToken, tables, task, gates = [], trajectories = [], now = new Date(), dryRun = false,
}, options) {
  const result = { baseToken, written: { tasks: 0, gates: 0, trajectories: 0 }, errors: [] }

  // 表 id 缺失时**必须报错**。实测过这个坑：`listTables` 曾按错误字段路径解析，
  // 拿到 `{ id: null }`，于是三个分支全部跳过、`written` 全是 0、`errors` 为空 ——
  // 上层看到「无错误」就以为同步成功，实际一行都没写。静默失败比报错危险得多。
  for (const [key, need] of [['tasks', true], ['gates', gates.length > 0], ['trajectories', trajectories.length > 0]]) {
    if (need && !tables?.[key]?.id) {
      result.errors.push(`${key} 表 id 缺失：无法写入（tables=${JSON.stringify(tables)}）`)
    }
  }
  if (result.errors.length > 0) return result

  // ── 任务表：按任务ID upsert ───────────────────────────────────────────
  if (tables?.tasks?.id) {
    const row = toRecordFields(TABLE_SCHEMAS.tasks, { ...task, 更新时间: now })
    try {
      const found = await searchRecords({
        baseToken,
        tableId: tables.tasks.id,
        keyword: String(task[TABLE_SCHEMAS.tasks.keyField] ?? ''),
        searchFieldNames: [TABLE_SCHEMAS.tasks.keyField],
        fieldNames: [TABLE_SCHEMAS.tasks.keyField],
        limit: 1,
      }, options)
      const existing = found.records[0]?.recordId
      if (existing) {
        await updateRecord({ baseToken, tableId: tables.tasks.id, recordId: existing, fields: row, dryRun }, options)
      } else {
        await createRecord({ baseToken, tableId: tables.tasks.id, fields: row, dryRun }, options)
      }
      result.written.tasks = 1
    } catch (error) {
      result.errors.push(`任务表：${error.message}`)
    }
  }

  // ── 门禁表：追加 ─────────────────────────────────────────────────────
  if (tables?.gates?.id && gates.length > 0) {
    const rows = gates.map((g) => toRecordFields(TABLE_SCHEMAS.gates, {
      记录键: g.记录键 ?? `${g.任务ID ?? ''}:${g.门禁 ?? ''}:${now.getTime()}`,
      任务ID: g.任务ID,
      门禁: g.门禁,
      结论: g.结论,
      检查项: g.检查项,
      失败项: g.失败项,
      待确认项: g.待确认项,
      首条问题: g.首条问题,
      时间: g.时间 ?? now,
    }))
    try {
      await createRecords({ baseToken, tableId: tables.gates.id, records: rows, dryRun }, options)
      result.written.gates = rows.length
    } catch (error) {
      result.errors.push(`门禁表：${error.message}`)
    }
  }

  // ── 轨迹表：追加 ─────────────────────────────────────────────────────
  if (tables?.trajectories?.id && trajectories.length > 0) {
    const rows = trajectories.map((t) => toRecordFields(TABLE_SCHEMAS.trajectories, {
      记录键: t.记录键 ?? `${t.任务ID ?? ''}:${t.轨道 ?? ''}:${now.getTime()}`,
      任务ID: t.任务ID,
      轨道: t.轨道,
      轮数: t.轮数,
      出分轮数: t.出分轮数,
      失败轮数: t.失败轮数,
      最佳分: t.最佳分,
      '有效时长(h)': t.有效时长h,
      状态: t.状态,
      时间: t.时间 ?? now,
    }))
    try {
      await createRecords({ baseToken, tableId: tables.trajectories.id, records: rows, dryRun }, options)
      result.written.trajectories = rows.length
    } catch (error) {
      result.errors.push(`轨迹表：${error.message}`)
    }
  }

  return result
}
