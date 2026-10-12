/**
 * 极简 TOML 子集解析器。
 *
 * 目的不是通用 TOML，而是让门禁判定能在不引入依赖的前提下读到它要判定的那几个
 * 字段（task.name、network_mode、environment_mode、build_timeout_sec、artifacts、
 * schema_version）。目标 Harbor 版本的真实契约判定仍由随包的
 * harbor_task_contract.py 用原生 TaskConfig 加载完成。
 *
 * @module dsh-autoresearch/toml
 */

/** 解析 TOML 文本为嵌套对象。 */
export function parseTomlSubset(text) {
  const root = {}
  let current = root
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.replace(/\s+#.*$/, '').trim()
    if (line === '') continue
    const table = /^\[([^\]]+)\]$/.exec(line)
    if (table) {
      const path = table[1].split('.').map((part) => part.trim())
      current = root
      for (const key of path) {
        current[key] ??= {}
        current = current[key]
      }
      continue
    }
    const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(line)
    if (!pair) continue
    current[pair[1]] = parseTomlValue(pair[2].trim())
  }
  return root
}

function parseTomlValue(raw) {
  if (raw.startsWith('"') && raw.endsWith('"')) return raw.slice(1, -1)
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1)
  if (raw === 'true') return true
  if (raw === 'false') return false
  if (raw.startsWith('[') && raw.endsWith(']')) {
    const inner = raw.slice(1, -1).trim()
    if (inner === '') return []
    return splitTopLevel(inner).map((part) => parseTomlValue(part.trim()))
  }
  if (raw.startsWith('{') && raw.endsWith('}')) {
    const inner = raw.slice(1, -1).trim()
    const result = {}
    if (inner === '') return result
    for (const part of splitTopLevel(inner)) {
      const pair = /^([A-Za-z0-9_-]+)\s*=\s*(.+)$/.exec(part.trim())
      if (pair) result[pair[1]] = parseTomlValue(pair[2].trim())
    }
    return result
  }
  const number = Number(raw)
  if (Number.isFinite(number)) return number
  return raw
}

/** 按顶层逗号切分，忽略引号与括号内部。 */
function splitTopLevel(text) {
  const parts = []
  let depth = 0
  let quote = null
  let start = 0
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index]
    if (quote !== null) {
      if (character === quote && text[index - 1] !== '\\') quote = null
      continue
    }
    if (character === '"' || character === "'") { quote = character; continue }
    if (character === '[' || character === '{' || character === '(') { depth += 1; continue }
    if (character === ']' || character === '}' || character === ')') { depth -= 1; continue }
    if (character === ',' && depth === 0) {
      parts.push(text.slice(start, index))
      start = index + 1
    }
  }
  parts.push(text.slice(start))
  return parts
}
