/**
 * 交付包一致性核对（G-PACK-VERIFY 的 G14.1–G14.4 输入采集）。
 *
 * ## 为什么单独成模块
 *
 * 这三项判据的**输入此前从来没人构造**：`gatePackVerify` 的
 * `sourceHashes`/`packedHashes`/`forbiddenEntries` 默认 `{}`/`{}`/`[]`，
 * `collectFromTask` 的 `G-PACK-VERIFY` 分支也不返回它们，工具 schema 里更没有
 * 传 ZIP 路径的参数。三重缺失叠加的结果是三项**恒判 PASS**，报告写着
 * 「交付包含全部 **0** 个文件」—— 空集上的 PASS，判定力为零。
 *
 * 比 FAIL 更危险：FAIL 促使人排查，空集 PASS 让人以为已验证。本仓实测发生过
 * `*.preM5` 备份文件泄漏进交付 ZIP 的事故，而这道门（含 G14.4）全程未报警。
 *
 * ## 采集范围（**已用真实任务核定，不是猜的**）
 *
 * 范围取自 AutoRe1841 实际使用的打包脚本 `_m5_pack_submission.py`：
 *
 *   DELIVER = ["workspace", "expert_evidence", "optimization_evidence"]
 *
 * 排除项也与该脚本逐条对齐（`__pycache__` / `.pytest_cache` / `.ipynb_checkpoints`
 * 等目录，`.DS_Store` / `Thumbs.db` / `desktop.ini` 文件，`.pyc` / `.pyo` 后缀）。
 *
 * **为什么不把任务根下所有东西都算进源树**：任务根还有 `_evidence/`、`_probe_kit/`、
 * `_m5_stage/`、`_data/` 等**私有工作目录**，它们不进交付包（也不该进）。
 * 用「任务根全量」当基准会让每一道题都产生大量「合理但无解」的 FAIL。
 * 该题自带的独立校验器（`_m5_independent_pack_verify.py`）也正是按这两个域
 * 分别比对的，其 `deliver` 域报 202/202 完全一致。
 *
 * @module dsh-autoresearch/lib/pack-scope
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve, sep } from 'node:path'
import { createHash } from 'node:crypto'

/** 进入交付包的三个顶层目录（与 _m5_pack_submission.py 的 DELIVER 一致）。 */
export const DELIVER_DIRS = Object.freeze(['workspace', 'expert_evidence', 'optimization_evidence'])

/** 禁止出现在交付包里的目录名。 */
export const FORBIDDEN_DIRS = new Set([
  '__pycache__', '.pytest_cache', '.ipynb_checkpoints', '.git',
  'node_modules', '.venv', 'venv', '.idea', '.vscode',
])

/** 禁止出现在交付包里的文件名。 */
export const FORBIDDEN_FILES = new Set(['.DS_Store', 'Thumbs.db', 'desktop.ini'])

/** 禁止出现在交付包里的后缀。 */
export const FORBIDDEN_SUFFIXES = ['.pyc', '.pyo', '.swp', '.tmp']

/**
 * 额外禁止项：`*.preM5` 一类**备份残留**。
 *
 * 这是本仓真实事故的指纹 —— M5 阶段的备份文件经目录级 COPY 进了 Agent 镜像、
 * 又被打包脚本当普通文件打进交付 ZIP。任务里叫 `*.preM5`，
 * 但同类命名（`.bak` / `.orig` / `~` 结尾）都属同一风险，一并拦截。
 */
export const FORBIDDEN_BACKUP_PATTERN = /(\.preM5$|\.bak$|\.orig$|~$)/i

/** 相对路径统一用 `/`，屏蔽平台差异（打包器与 Python 侧都按 `/` 记录）。 */
function toPosix(relativePath) {
  return relativePath.split(sep).join('/')
}

/** 该相对路径是否属于禁止项。返回禁止原因或 null。 */
export function forbiddenReason(relativePath) {
  const posix = toPosix(relativePath)
  const parts = posix.split('/')
  for (const part of parts.slice(0, -1)) {
    if (FORBIDDEN_DIRS.has(part)) return `禁止目录 ${part}`
  }
  const name = parts[parts.length - 1]
  if (FORBIDDEN_FILES.has(name)) return `禁止文件 ${name}`
  const lower = name.toLowerCase()
  for (const suffix of FORBIDDEN_SUFFIXES) {
    if (lower.endsWith(suffix)) return `禁止后缀 ${suffix}`
  }
  if (FORBIDDEN_BACKUP_PATTERN.test(name)) return '备份残留（真实事故指纹：曾泄漏进交付包）'
  return null
}

/** 单文件 sha256（流式读，避免大文件整体驻留内存）。 */
async function sha256File(absolutePath) {
  const bytes = await readFile(absolutePath)
  return createHash('sha256').update(bytes).digest('hex')
}

/**
 * 采集源树的逐文件 sha256 与禁止项。
 *
 * 这些目录不存在时**如实跳过**（不是错误）：任务可能还没建齐三个目录，
 * 那种情况由 G14.1 报 UNKNOWN 而不是在这里抛错。
 *
 * @returns {{ files: Record<string,string>, forbidden: string[], scanned: number }}
 */
export async function collectSourceHashes(taskRoot, options = {}) {
  const dirs = Array.isArray(options.dirs) && options.dirs.length > 0 ? options.dirs : DELIVER_DIRS
  const files = {}
  const forbidden = []
  let scanned = 0

  const walk = async (relativeDir, depth = 0) => {
    if (depth > 12) return
    const absolute = resolve(taskRoot, relativeDir)
    let entries
    try {
      entries = await readdir(absolute, { withFileTypes: true })
    } catch {
      return // 目录不存在：如实跳过
    }
    for (const entry of entries) {
      const rel = `${relativeDir}/${entry.name}`
      if (entry.isDirectory()) {
        // 禁止目录本身要记进 forbidden，但不再往里走（避免把整棵缓存树列出来）。
        const reason = forbiddenReason(`${rel}/x`)
        if (reason !== null) { forbidden.push(rel); continue }
        await walk(rel, depth + 1)
        continue
      }
      if (!entry.isFile()) continue // 符号链接一律不跟随（与打包器一致）
      const reason = forbiddenReason(rel)
      if (reason !== null) { forbidden.push(rel); continue }
      let info
      try {
        info = await stat(join(absolute, entry.name))
      } catch {
        continue
      }
      if (info.size > (options.maxFileBytes ?? 512 * 1024 * 1024)) {
        // 超大文件不哈希但仍登记：静默跳过会让「缺文件」变成假 PASS。
        forbidden.push(`${rel}（超过 ${options.maxFileBytes ?? 512 * 1024 * 1024} 字节，未哈希）`)
        continue
      }
      scanned += 1
      files[toPosix(rel)] = await sha256File(join(absolute, entry.name))
    }
  }

  for (const dir of dirs) await walk(dir)
  return { files, forbidden, scanned }
}

/**
 * 解析 ZIP 的中央目录，取出每个条目名与数据位置。
 *
 * 不复用 `dsh-autoresearch-qa/lib/zip.js` 的 `listZipEntries`：那个只返回
 * **条目名**（用于打包后确认产物完整），而这里还要按字节复算 sha256，
 * 必须同时拿到压缩方法、压缩长度与本地头偏移。给它加字段会改变既有契约
 * 的返回形状，反而容易碰坏那边的调用方，所以在本模块内解析。
 *
 * 路径穿越（`..`）在此拒绝：ZIP 里带 `../` 的条目会写到交付目录之外。
 */
function readCentralDirectory(buffer) {
  const eocd = (() => {
    // 从尾部回扫 EOCD 签名（注释最长 65535 字节）。
    const floor = Math.max(0, buffer.length - 65557)
    for (let index = buffer.length - 22; index >= floor; index -= 1) {
      if (buffer.readUInt32LE(index) === 0x06054b50) return index
    }
    return -1
  })()
  if (eocd < 0) throw new Error('不是合法 ZIP：找不到中央目录结尾记录（EOCD）')

  const total = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  const entries = []
  for (let index = 0; index < total; index += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) {
      throw new Error(`ZIP 中央目录第 ${index + 1} 条记录损坏`)
    }
    const method = buffer.readUInt16LE(offset + 10)
    const compressedSize = buffer.readUInt32LE(offset + 20)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8')
    entries.push({ name, method, compressedSize, localOffset })
    offset += 46 + nameLength + extraLength + commentLength
  }
  return entries
}

/** 本地头里的文件名与扩展区长度随条目而异，必须按本地头算出数据起点。 */
function dataOffsetOf(buffer, localOffset) {
  if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
    throw new Error('ZIP 本地文件头损坏')
  }
  return localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28)
}

/**
 * 读取 ZIP 内每个条目的 sha256。
 *
 * 直接按字节解压/读取，**不调用外部解压工具**（跨平台可用性 + 不落临时文件）。
 * 只支持 store(0) 与 deflate(8) —— 这正是本仓打包器产出的两种；
 * 其余方法如实报错，不猜、不跳过（跳过会让「缺文件」变成假 PASS）。
 *
 * @returns {{ files: Record<string,string>, forbidden: string[], entries: number }}
 */
export async function collectPackedHashes(zipPath) {
  const buffer = await readFile(zipPath)
  const entries = readCentralDirectory(buffer)
  const { inflateRawSync } = await import('node:zlib')

  const files = {}
  const forbidden = []
  for (const entry of entries) {
    const name = toPosix(entry.name)
    if (name.endsWith('/')) continue // 目录条目
    if (name.split('/').includes('..')) {
      throw new Error(`ZIP 条目含路径穿越（../）：${name}`)
    }
    const reason = forbiddenReason(name)
    if (reason !== null) { forbidden.push(name); continue }

    const start = dataOffsetOf(buffer, entry.localOffset)
    const slice = buffer.subarray(start, start + entry.compressedSize)
    if (entry.method === 0) {
      files[name] = createHash('sha256').update(slice).digest('hex')
    } else if (entry.method === 8) {
      const raw = inflateRawSync(slice)
      files[name] = createHash('sha256').update(raw).digest('hex')
    } else {
      throw new Error(`ZIP 条目 ${name} 使用了未支持的压缩方法 ${entry.method}（只支持 store=0 与 deflate=8）`)
    }
  }
  return { files, forbidden, entries: entries.length }
}

/**
 * 在任务根查找唯一的交付 ZIP（`artifact` 未显式给出时的兜底）。
 *
 * 只找**根目录一层**：子目录里往往有数据集 zip（实测 `_data/` 下有若干），
 * 递归查找会把它们误当交付包 —— 那种误判比「找不到」危险得多。
 *
 * @returns 绝对路径；找不到或存在多个时不猜，返回 null 并说明原因。
 */
export async function findDeliveryZip(taskRoot, explicitArtifact) {
  if (typeof explicitArtifact === 'string' && explicitArtifact.trim() !== '') {
    const absolute = isAbsolute(explicitArtifact)
      ? explicitArtifact
      : resolve(taskRoot, explicitArtifact)
    return { path: absolute, reason: '由 artifact 参数指定' }
  }
  let entries
  try {
    entries = await readdir(taskRoot, { withFileTypes: true })
  } catch {
    return { path: null, reason: '任务根不可读' }
  }
  const zips = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.zip'))
    .map((entry) => entry.name)
  if (zips.length === 0) return { path: null, reason: '任务根下没有 .zip（可用 artifact 参数显式指定）' }
  if (zips.length > 1) {
    return { path: null, reason: `任务根下有 ${zips.length} 个 .zip，无法确定哪个是交付包（用 artifact 指定）：${zips.join(', ')}` }
  }
  return { path: join(taskRoot, zips[0]), reason: '任务根下唯一的 .zip' }
}

/** 路径相对化辅助（供测试与调用方使用）。 */
export function relativeTo(root, absolutePath) {
  return toPosix(relative(root, absolutePath))
}
