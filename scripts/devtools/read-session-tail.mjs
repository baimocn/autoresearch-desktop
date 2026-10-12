// 读会话日志（多帧 zstd）末尾若干条，用于排查 /autoresearch 报错。
import { readFileSync } from 'node:fs'
import { zstdDecompressSync } from 'node:zlib'

const file = process.argv[2]
const tailCount = Number(process.argv[3] ?? 40)
const buffer = readFileSync(file)

// 会话日志是多帧 zstd：逐帧扫描解压（zstdDecompressSync 只读第一帧）。
function scanFrames(buf) {
  const frames = []
  let offset = 0
  while (offset < buf.length) {
    const magic = buf.readUInt32LE(offset)
    if (magic !== 0xfd2fb528) { offset += 1; continue }
    // 尝试从 offset 解压，逐步扩大长度直到成功
    let end = Math.min(buf.length, offset + 1 << 20)
    let decompressed = null
    while (end <= buf.length) {
      try {
        decompressed = zstdDecompressSync(buf.subarray(offset, end))
        break
      } catch { end += Math.max(4096, (end - offset)) }
    }
    if (decompressed !== null) {
      frames.push(decompressed)
      offset += (decompressed.length > 0 ? buf.subarray(offset).length : 1) // 简化：继续向后找魔数
      // 用魔数继续找下一帧
      let next = offset
      while (next < buf.length - 4 && buf.readUInt32LE(next) !== 0xfd2fb528) next += 1
      offset = next
    } else {
      offset += 4
    }
  }
  return frames
}

const frames = scanFrames(buffer)
const text = Buffer.concat(frames).toString('utf8')
const lines = text.split('\n').filter((line) => line.trim() !== '')
console.log(`帧数 ${frames.length}，总行数 ${lines.length}`)
for (const line of lines.slice(-tailCount)) {
  try {
    const event = JSON.parse(line)
    const summary = { type: event.type, seq: event.seq }
    if (event.type === 'command/run') summary.data = event.data
    else if (event.type === 'command/done') summary.data = event.data
    else if (event.type === 'assistant/message') {
      summary.text = (event.data?.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 200)
    } else if (event.type === 'tool/result') {
      summary.tool = event.data?.name ?? event.data?.tool
      summary.failed = event.data?.failed ?? event.data?.isError
      const content = event.data?.content ?? event.data?.result?.content
      summary.content = JSON.stringify(content).slice(0, 300)
    } else if (event.type === 'user/message') {
      summary.text = (event.data?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join(' ').slice(0, 300)
    } else {
      summary.data = JSON.stringify(event.data).slice(0, 200)
    }
    console.log(JSON.stringify(summary))
  } catch {
    console.log('RAW:', line.slice(0, 300))
  }
}
