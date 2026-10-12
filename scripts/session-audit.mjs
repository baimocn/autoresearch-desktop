/**
 * 会话日志检查器 —— 复用 harness 的 zstd 多帧解码，找出含未知事件类型的日志。
 *
 * ## 为什么需要它
 *
 * 会话日志是**多帧 zstd 追加**的（每批写入一个独立帧）。`zstdDecompressSync`
 * 只解第一帧，因此用它扫描会漏报 —— 我的第一版扫描器就因此误报「无污染」，
 * 而界面上明明在报未知事件。这个脚本按帧边界逐帧解压，与 harness 的
 * `scanZstdFrames` 同口径。
 *
 * ## 用途
 *
 * 一次真实事故的复盘工具：自定义会话事件类型会让**整个日志**无法被读取
 * （读取路径拒绝解释含未知类型的日志）。这个脚本用来确认哪些会话受影响。
 *
 * 用法：node scripts/session-audit.mjs [--dsh-home <path>] [--delete]
 */
import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createZstdDecompress } from 'node:zlib'

const ZSTD_MAGIC = 0xfd2fb528

/** 按帧边界切分（与 harness 的 scanZstdFrames 同口径）。 */
function scanFrames(buffer) {
  const frames = []
  let offset = 0
  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`invalid frame magic at byte ${offset}`)
    }
    offset += 4
    if (offset === buffer.length) return { frames, tornStart: start }

    const descriptor = buffer.readUInt8(offset)
    offset += 1
    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 32) !== 0
    const checksum = (descriptor & 4) !== 0
    const dictionaryFlag = descriptor & 3
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    // 扫描块头直到最后一个块（block header 3 字节，bit 0 = last block）
    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 3
      const blockSize = blockHeader >>> 3
      offset += 3
      if (blockType === 1) { /* RLE：1 字节 */ offset += 1 }
      else offset += blockSize
      if (offset > buffer.length) return { frames, tornStart: start }
      if (lastBlock) break
    }
    if (checksum) offset += 4
    frames.push({ start, end: offset })
  }
  return { frames, tornStart: null }
}

/** 解压单个帧。 */
function decodeFrame(buffer) {
  return new Promise((resolve, reject) => {
    const chunks = []
    const stream = createZstdDecompress()
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', reject)
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.end(buffer)
  })
}

/** 读一个会话日志的全部事件。 */
async function readSession(file) {
  const buffer = await readFile(file)
  const { frames, tornStart } = scanFrames(buffer)
  let text = ''
  for (const frame of frames) {
    text += await decodeFrame(buffer.subarray(frame.start, frame.end))
  }
  const lines = text.split('\n').filter((line) => line.trim() !== '')
  const events = []
  for (const line of lines) {
    try { events.push(JSON.parse(line)) } catch { events.push({ type: '(unparseable)' }) }
  }
  return { events, frameCount: frames.length, tornStart }
}

// ── 主流程 ──────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const dshHome = (() => {
  const index = argv.indexOf('--dsh-home')
  if (index !== -1 && argv[index + 1] !== undefined) return argv[index + 1]
  return process.env.DSH_HOME ?? '.dsh-home'
})()
const shouldDelete = argv.includes('--delete')

const sessionsRoot = join(dshHome, 'sessions')
const report = []

async function walk(dir) {
  let entries
  try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) { await walk(full); continue }
    if (!entry.name.endsWith('.zstd')) continue
    try {
      const { events, frameCount, tornStart } = await readSession(full)
      const types = events.map((event) => event.type).filter((type) => type !== undefined)
      const unknown = [...new Set(types)].filter((type) => type.startsWith('autoresearch/'))
      report.push({
        file: full,
        sessionId: full.split(/[\\/]/).slice(-2)[0],
        eventCount: events.length,
        frameCount,
        tornStart,
        types: [...new Set(types)],
        unknown,
        unreadable: false,
      })
    } catch (error) {
      report.push({ file: full, sessionId: full.split(/[\\/]/).slice(-2)[0], unreadable: true, error: error.message })
    }
  }
}

await walk(sessionsRoot)

const polluted = report.filter((entry) => entry.unknown !== undefined && entry.unknown.length > 0)
const unreadable = report.filter((entry) => entry.unreadable)

console.log(`会话日志审计（${sessionsRoot}）`)
console.log(`总计 ${report.length} 个会话｜含未知事件 ${polluted.length} 个｜读取失败 ${unreadable.length} 个`)
console.log()

if (polluted.length > 0) {
  console.log('含未知事件的会话（这些日志会被读取路径拒绝解释）：')
  for (const entry of polluted) {
    console.log(`  ${entry.sessionId}`)
    console.log(`    ${entry.eventCount} 事件 / ${entry.frameCount} 帧`)
    console.log(`    未知类型：${entry.unknown.join(', ')}`)
  }
  console.log()
  if (shouldDelete) {
    for (const entry of polluted) {
      await rm(entry.file, { force: true })
      console.log(`  已删除：${entry.sessionId}`)
    }
    console.log()
    console.log('注意：删除会话日志会丢失该会话历史。这只在日志已不可读时才是净收益。')
  } else {
    console.log('加 --delete 可删除这些日志（它们已不可读，删除不会损失可读内容）。')
  }
} else {
  console.log('未发现含未知事件的会话。')
}

if (unreadable.length > 0) {
  console.log()
  console.log('读取失败的会话：')
  for (const entry of unreadable) console.log(`  ${entry.sessionId}: ${entry.error}`)
}

console.log()
console.log('本次修复：模式状态改为折叠命令事件（command/run 与 command/done），')
console.log('不再写入自定义事件类型，因此新会话不会再出现此问题。')

process.exitCode = 0
