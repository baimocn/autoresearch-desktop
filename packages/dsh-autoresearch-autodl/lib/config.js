/**
 * AutoDL / 飞书配置解析 —— 工具入口与 UI 路由共用同一份。
 *
 * ## 为什么单独抽出来
 *
 * 早期 token 解析写在工具入口的闭包里，UI 路由要用就得复制一份 ——
 * 两份代码迟早漂移（比如一边改了 `.autodl.json` 的字段名，另一边不知道）。
 * 现在两边都从这里读，token / 账本路径 / 预算护栏只有一个定义处。
 *
 * @module dsh-autoresearch-autodl/lib/config
 */

import { readFile } from 'node:fs/promises'
import { join, isAbsolute, resolve } from 'node:path'
import { homedir } from 'node:os'

export const DEFAULT_AUTODL_CONFIG = Object.freeze({
  /** 租约账本；相对路径以 cwd 为基准。 */
  leaseFile: '.autodl-leases.json',
  defaultGpuSpec: 'v-48g',
  defaultCudaVersion: 113,
  /** 预算护栏：单次创建预估上限（元）。 */
  maxTotalYuan: 20,
  /** 单价（元/小时）。官方文档未给 payg_price 的计费单位，不猜默认值。 */
  pricePerHourYuan: null,
  reapMode: 'stop',
  timeoutMs: 30_000,
})

/** 解析 token：环境变量 > 配置 > `.dsh-home/.autodl.json`。 */
export async function resolveAutodlToken(config) {
  const fromEnv = process.env.AUTODL_TOKEN
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  if (typeof config?.token === 'string' && config.token.trim() !== '') return config.token.trim()
  for (const candidate of autodlCredentialPaths()) {
    try {
      const parsed = JSON.parse(await readFile(candidate, 'utf8'))
      if (typeof parsed?.token === 'string' && parsed.token.trim() !== '') return parsed.token.trim()
    } catch { /* 不存在或不可解析：找下一个 */ }
  }
  return null
}

/** 凭据候选路径（按顺序找第一个可读的）。 */
export function autodlCredentialPaths() {
  const home = process.env.DSH_HOME || join(homedir(), '.dsh')
  return [
    join(home, '.autodl.json'),
    join(process.cwd(), '.dsh-home', '.autodl.json'),
  ]
}

/** 账本绝对路径。 */
export function leaseFilePath(config) {
  const p = config?.leaseFile ?? DEFAULT_AUTODL_CONFIG.leaseFile
  return isAbsolute(p) ? p : resolve(process.cwd(), p)
}

/** 归一化配置（工具入口与 UI 都用它，保证同一套默认值）。 */
export function normalizeAutodlConfig(rawConfig) {
  return { ...DEFAULT_AUTODL_CONFIG, ...(rawConfig ?? {}) }
}
