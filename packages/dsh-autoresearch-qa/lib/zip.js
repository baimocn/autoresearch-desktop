/**
 * 最小 ZIP 打包器 —— 只做 store（不压缩），避免依赖平台工具。
 *
 * 用途：发布门质检要求提交物是单个 .zip（`--release-self-check` 的硬要求），
 * 而 Windows / Linux / macOS 上可用的压缩命令各不相同。这里用纯 Node 生成
 * 确定性 ZIP：同样输入得到逐字节相同的产物，便于哈希锚定。
 *
 * 刻意不做的事：不跟随符号链接、不打包缓存残留、不压缩（压缩会引入
 * 实现差异，破坏「相同源码 → 相同字节」）。
 *
 * @module dsh-autoresearch-qa/zip
 */

import { readFile, readdir, stat, mkdir, writeFile } from 'node:fs/promises'
import { join, relative, isAbsolute, resolve } from 'node:path'

/** 禁止打包的目录与文件名（SOP 打包一致性门禁的清单）。 */
export const FORBIDDEN_NAMES = new Set([
  '__pycache__', '.git', '.pytest_cache', '.DS_Store', 'Thumbs.db',
  'node_modules', '.dsh-home', '.venv', 'venv', '.idea', '.vscode',
])

/** 禁止打包的扩展名。 */
export const FORBIDDEN_EXTENSIONS = ['.pyc', '.pyo', '.log', '.tmp', '.swp']

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) !== 0 ? (0xedb88320 ^ (value >>> 1)) : (value >>> 1)
    }
    table[index] = value >>> 0
  }
  return table
})()

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** DOS 时间戳；固定值让产物可复现（不写入真实修改时间）。 */
const FIXED_DOS_TIME = 0
const FIXED_DOS_DATE = (1 << 5) | 1 // 1980-01-01

/** 收集待打包文件，返回 { entries: [{ relativePath, absolutePath, bytes }], skipped }。 */
export async function collectEntries(root, options = {}) {
  const { include = null, exclude = [], maxFileBytes = 256 * 1024 * 1024 } = options
  const entries = []
  const skipped = []

  async function walk(directory) {
    let children
    try {
      children = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      skipped.push({ path: directory, reason: `无法读取目录：${error.message}` })
      return
    }
    for (const child of children.sort((left, right) => left.name.localeCompare(right.name))) {
      const absolute = join(directory, child.name)
      const relativePath = relative(root, absolute).split('\\').join('/')

      if (FORBIDDEN_NAMES.has(child.name)) {
        skipped.push({ path: relativePath, reason: '禁止项（缓存/依赖/元数据目录）' })
        continue
      }
      if (FORBIDDEN_EXTENSIONS.some((extension) => child.name.endsWith(extension))) {
        skipped.push({ path: relativePath, reason: '禁止项（缓存/临时文件）' })
        continue
      }
      if (exclude.some((pattern) => relativePath === pattern || relativePath.startsWith(`${pattern}/`))) {
        skipped.push({ path: relativePath, reason: '按配置排除' })
        continue
      }

      if (child.isSymbolicLink()) {
        skipped.push({ path: relativePath, reason: '符号链接不跟随' })
        continue
      }
      if (child.isDirectory()) {
        await walk(absolute)
        continue
      }
      if (!child.isFile()) {
        skipped.push({ path: relativePath, reason: '非常规文件' })
        continue
      }

      const info = await stat(absolute)
      if (info.size > maxFileBytes) {
        skipped.push({ path: relativePath, reason: `超过单文件上限 ${maxFileBytes} 字节` })
        continue
      }
      if (include !== null && !include(relativePath)) {
        skipped.push({ path: relativePath, reason: '不在包含范围' })
        continue
      }

      entries.push({ relativePath, absolutePath: absolute, bytes: info.size })
    }
  }

  await walk(root)
  entries.sort((left, right) => left.relativePath.localeCompare(right.relativePath))
  return { entries, skipped }
}

/** 由已收集的条目生成 ZIP 字节。 */
export async function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.relativePath, 'utf8')
    const data = await readFile(entry.absolutePath)
    const checksum = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)      // 本地文件头签名
    local.writeUInt16LE(20, 4)               // 解压所需版本
    local.writeUInt16LE(0x0800, 6)           // 通用标志位：文件名 UTF-8
    local.writeUInt16LE(0, 8)                // 压缩方法：store
    local.writeUInt16LE(FIXED_DOS_TIME, 10)
    local.writeUInt16LE(FIXED_DOS_DATE, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(data.length, 18)     // 压缩后大小
    local.writeUInt32LE(data.length, 22)     // 原始大小
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)               // 扩展字段长度

    localParts.push(local, nameBytes, data)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)     // 中央目录签名
    central.writeUInt16LE(20, 4)             // 创建版本
    central.writeUInt16LE(20, 6)             // 解压所需版本
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt16LE(0, 10)
    central.writeUInt16LE(FIXED_DOS_TIME, 12)
    central.writeUInt16LE(FIXED_DOS_DATE, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt16LE(0, 30)             // 扩展字段
    central.writeUInt16LE(0, 32)             // 注释
    central.writeUInt16LE(0, 34)             // 起始磁盘
    central.writeUInt16LE(0, 36)             // 内部属性
    central.writeUInt32LE(0o644 << 16, 38)   // 外部属性：常规文件 0644
    central.writeUInt32LE(offset, 42)

    centralParts.push(central, nameBytes)
    offset += local.length + nameBytes.length + data.length
  }

  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localParts, ...centralParts, end])
}

/**
 * 打包目录为 ZIP 文件。返回 { zipPath, entryCount, bytes, sha256, skipped }。
 * 不覆盖既有文件。
 */
export async function packDirectory(root, zipPath, options = {}) {
  const absoluteRoot = isAbsolute(root) ? root : resolve(process.cwd(), root)
  const { entries, skipped } = await collectEntries(absoluteRoot, options)
  if (entries.length === 0) {
    throw new Error(`目录为空或全部被排除，拒绝生成空包：${absoluteRoot}`)
  }
  const buffer = await buildZip(entries)
  const absoluteZip = isAbsolute(zipPath) ? zipPath : resolve(process.cwd(), zipPath)
  await mkdir(join(absoluteZip, '..'), { recursive: true })
  await writeFile(absoluteZip, buffer)

  const { createHash } = await import('node:crypto')
  return {
    zipPath: absoluteZip,
    entryCount: entries.length,
    bytes: buffer.length,
    sha256: createHash('sha256').update(buffer).digest('hex'),
    skipped,
  }
}

/** 读取 ZIP 的中央目录条目名（用于打包后自检，不依赖外部工具）。 */
export function listZipEntries(buffer) {
  const names = []
  for (let index = 0; index + 46 <= buffer.length; index += 1) {
    if (buffer.readUInt32LE(index) !== 0x02014b50) continue
    const nameLength = buffer.readUInt16LE(index + 28)
    const extraLength = buffer.readUInt16LE(index + 30)
    const commentLength = buffer.readUInt16LE(index + 32)
    names.push(buffer.subarray(index + 46, index + 46 + nameLength).toString('utf8'))
    index += 45 + nameLength + extraLength + commentLength
  }
  return names
}
