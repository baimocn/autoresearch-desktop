/**
 * Windows 工具体验守卫。
 *
 * 两条实测教训，都以「拦截 + 现场教学」的形态生效（守卫只能拒绝不能改写：
 * PreToolDecision 明确排除输入改写，因为参数已入日志 —— 所以deny 消息里
 * 直接给出修复后的模板，模型下一轮立即纠正）：
 *
 * 1. 编码：这台机器只有 Windows PowerShell 5.1，管道输出默认 GBK
 *    （[Console]::OutputEncoding = gb2312），而 harness 按 UTF-8 解码 ——
 *    模型写的任何含中文的 pwsh 命令，结果都是乱码。实测修复有效：
 *    命令前缀 `[Console]::OutputEncoding=[Text.Encoding]::UTF8;
 *    $OutputEncoding=[Text.Encoding]::UTF8; `。守卫在「命令含非 ASCII 且
 *    未含编码设置」时拦截并给出该模板。
 *
 * 2. sleep 轮询：模型爱用 Start-Sleep/timeout/ping 空等结果再查一遍 ——
 *    最低效的等待方式。守卫拦秒级以上的等待，教正确做法：本地进程用
 *    -Wait / Wait-Process；远端任务用 autoresearch_remote_probe_job
 *    逐次探测（每次探测都是重新评估的机会）；短暂等待（≤3 秒）放行。
 *
 * @module dsh-autoresearch/lib/windows-guard
 */

/** 编码修复前缀（实测把管道输出从 gb2312 变 utf-8）。 */
export const PWSH_ENCODING_PREFIX =
  '[Console]::OutputEncoding=[System.Text.Encoding]::UTF8; $OutputEncoding=[System.Text.Encoding]::UTF8; '

/** 秒级等待放行阈值：≤ 3 秒的短暂等待合法（服务启动间隙等）。 */
const SLEEP_THRESHOLD_SECONDS = 3

/** 匹配各类秒级等待及其时长。Milliseconds 不匹配（毫秒级天然放行）。 */
const SLEEP_PATTERNS = [
  /Start-Sleep\s+(?:-Seconds\s+)?(\d+)/gi,
  /\bsleep\s+(\d+)\b/gi,
  /timeout\s+\/t\s+(\d+)/gi,
  /ping(?:\.exe)?\s+-n\s+(\d+)/gi,
]

const containsNonAscii = (text) => /[^\x00-\x7F]/.test(text)

/** 提取命令里最大的等待秒数；无等待返回 0。 */
export function sleepSecondsOf(command) {
  let max = 0
  for (const pattern of SLEEP_PATTERNS) {
    for (const match of String(command).matchAll(pattern)) {
      const seconds = Number(match[1] ?? 0)
      if (Number.isFinite(seconds) && seconds > max) max = seconds
    }
  }
  return max
}

/**
 * 单条 pwsh 命令的守卫判定。
 * @returns {string|undefined} 返回拒绝理由（含修复指引）；undefined = 放行。
 */
export function inspectPwshCommand(command) {
  const text = String(command ?? '')

  // sleep 轮询先于编码判定：ping -n 10 这类空等命令本身可能是纯 ASCII 的，
  // 但等待浪费与编码无关，各自独立拦截。
  const seconds = sleepSecondsOf(text)
  if (seconds > SLEEP_THRESHOLD_SECONDS) {
    return [
      `命令里有 ${seconds} 秒的 sleep 空等 —— 这是最低效的等待方式（阻塞一个工具调用槽位，且期间无法评估进展）。改用：`,
      '',
      '· 等本地进程结束：用 -Wait（Start-Process）或 Wait-Process，让等待发生在命令内部；',
      '· 等远端 GPU 任务：直接调 autoresearch_remote_probe_job，每次探测都是重新评估的机会——',
      '  未完成就先去做别的事（补交付物、写文档），下轮再探；',
      '· 服务启动间隙：≤3 秒的短暂等待是允许的。',
    ].join('\n')
  }

  if (containsNonAscii(text) && !text.includes('OutputEncoding')) {
    return [
      '命令包含非 ASCII 字符（中文）但未设置输出编码 —— Windows PowerShell 5.1 的管道输出默认 GBK，',
      'harness 按 UTF-8 解码，结果会变成乱码。请把编码前缀加在命令最前面后重新提交：',
      '',
      `${PWSH_ENCODING_PREFIX}${text.trim()}`,
      '',
      '（若是把脚本写成 .ps1 文件再执行：文件必须保存为「UTF-8 with BOM」，否则 PS 5.1 会按 ANSI 误读中文。）',
    ].join('\n')
  }

  return undefined
}
