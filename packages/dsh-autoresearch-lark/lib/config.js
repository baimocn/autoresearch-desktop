/**
 * 飞书配置解析 —— 工具入口与 UI 路由共用。
 *
 * 配置落点：`.dsh-home/.lark.json`（已 gitignore），结构：
 * `{ baseToken, tables: {tasks:{id},gates:{id},trajectories:{id}}, chatId }`
 *
 * @module dsh-autoresearch-lark/lib/config
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_LARK_CONFIG = Object.freeze({
  baseToken: null,
  tables: null,
  chatId: null,
  /** 飞书不可达是否阻塞主流程。false = 同步失败只记录。 */
  strict: false,
  timeoutMs: 60_000,
})

/** 凭据候选路径。 */
export function larkConfigPaths() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return [
    join(home, '.lark.json'),
    join(process.cwd(), '.dsh-home', '.lark.json'),
  ]
}

/** 归一化配置：内置默认 ← patch 配置 ← .dsh-home/.lark.json。 */
export async function normalizeLarkConfig(rawConfig) {
  let merged = { ...DEFAULT_LARK_CONFIG, ...(rawConfig ?? {}) }
  for (const path of larkConfigPaths()) {
    try {
      const parsed = JSON.parse(await readFile(path, 'utf8'))
      merged = { ...merged, ...parsed }
      break
    } catch { /* 不存在或不可解析：用当前值 */ }
  }
  return merged
}
