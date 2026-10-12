/**
 * 会话 ↔ 任务根绑定。
 *
 * 多任务并行的工作模型（方案 A）：一个会话驱动一个任务根；同时推进 N 个任务
 * = N 个会话各绑一个根。绑定由 /autoresearch-task <路径> 命令写入，工具解析
 * 任务根时按「显式参数 > 会话绑定 > 配置根」取用。
 *
 * 存储是 DSH_HOME 下的一个 JSON 文件（sessionId → taskRoot）。会话 id 跨重启
 * 稳定，因此绑定在重启后仍然生效。文件是纯缓存：绑定丢失只是退回配置根，
 * 不会破坏任何任务状态。
 *
 * @module dsh-autoresearch/lib/session-tasks
 */

import { readFile, writeFile, mkdir, stat, readdir } from 'node:fs/promises'
import { join, resolve, isAbsolute } from 'node:path'

/** 任务根的判定标记：目录里存在其中之一即视为任务根。 */
/**
 * 任务根的判定标记：目录里存在其中之一即视为任务根。
 *
 * 三种来源都算数（实测教训：只认自己的状态文件会把「按教程手工搭的任务包」
 * 判成非任务根 —— 用户的 auto2604 有完整 workspace/harbor_task 结构却没有
 * autoresearch-state.json，被拒之门外）：
 *   · autoresearch-state.json            —— autoresearch_init 写的状态
 *   · workspace/harbor_task/task.toml    —— 教程 V3 的权威任务定义位置
 *   · task.toml                          —— 顶层契约（打包/校验常用）
 */
export const TASK_ROOT_MARKERS = ['autoresearch-state.json', 'workspace/harbor_task/task.toml', 'task.toml']

/** DSH_HOME 解析：与桌面壳、安装脚本、UI 插件同一规则（显式 > 环境变量 > 项目 .dsh-home）。 */
export function resolveDshHome(explicit) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return isAbsolute(explicit) ? explicit : resolve(process.cwd(), explicit)
  }
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return isAbsolute(fromEnvironment) ? fromEnvironment : resolve(process.cwd(), fromEnvironment)
  }
  return join(process.cwd(), '.dsh-home')
}

const bindingsPath = (dshHome) => join(dshHome, 'autoresearch-session-tasks.json')

async function readDoc(dshHome) {
  try {
    const parsed = JSON.parse(await readFile(bindingsPath(dshHome), 'utf8'))
    if (parsed && typeof parsed === 'object' && parsed.bindings && typeof parsed.bindings === 'object') {
      return parsed
    }
  } catch { /* 不存在或损坏都当作空绑定：缓存性质，不阻塞 */ }
  return { version: 1, bindings: {} }
}

async function writeDoc(dshHome, doc) {
  await mkdir(dshHome, { recursive: true })
  await writeFile(bindingsPath(dshHome), `${JSON.stringify(doc, null, 2)}\n`, 'utf8')
}

/** 目录是否具备任务根标记。 */
export async function isTaskRoot(path) {
  for (const marker of TASK_ROOT_MARKERS) {
    try {
      if ((await stat(join(path, marker))).isFile()) return true
    } catch { /* 继续看下一个标记 */ }
  }
  return false
}

/** 校验并归一任务根路径；不合格直接抛错，绝不静默接受。 */
export async function assertTaskRoot(path) {
  if (typeof path !== 'string' || path.trim() === '') {
    throw new Error('任务根路径不能为空')
  }
  const absolute = isAbsolute(path) ? resolve(path) : resolve(process.cwd(), path)
  if (!(await isTaskRoot(absolute))) {
    throw new Error(
      `"${absolute}" 不是任务根（缺少 ${TASK_ROOT_MARKERS.join(' 或 ')}）。`
      + '先用 autoresearch_init 初始化，或检查路径拼写。',
    )
  }
  return absolute
}

/** 读取一个会话的绑定；绑定指向的目录已不存在时视为未绑定并清理。 */
export async function readSessionTask(dshHome, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return null
  const doc = await readDoc(dshHome)
  const bound = doc.bindings[sessionId]
  if (typeof bound !== 'string' || bound === '') return null
  try {
    if ((await stat(bound)).isDirectory()) return bound
  } catch { /* 目录没了 */ }
  delete doc.bindings[sessionId]
  await writeDoc(dshHome, doc)
  return null
}

/** 绑定会话到任务根。返回归一后的绝对路径。 */
export async function bindSessionTask(dshHome, sessionId, taskRoot) {
  if (typeof sessionId !== 'string' || sessionId === '') {
    throw new Error('缺少会话标识，无法绑定任务根')
  }
  const absolute = await assertTaskRoot(taskRoot)
  const doc = await readDoc(dshHome)
  doc.bindings[sessionId] = absolute
  await writeDoc(dshHome, doc)
  return absolute
}

/** 解除会话绑定。返回是否确实解除过。 */
export async function clearSessionTask(dshHome, sessionId) {
  const doc = await readDoc(dshHome)
  if (doc.bindings[sessionId] === undefined) return false
  delete doc.bindings[sessionId]
  await writeDoc(dshHome, doc)
  return true
}

/**
 * 工具侧的任务根解析：显式参数 > 会话绑定 > 配置根。
 * 三级都落空才用配置根；绑定目录失效会静默降级（缓存性质）。
 */
export async function resolveTaskRoot(dshHome, { explicit, sessionId, fallback }) {
  if (typeof explicit === 'string' && explicit.trim() !== '') {
    return assertTaskRoot(explicit)
  }
  if (typeof sessionId === 'string' && sessionId !== '') {
    const bound = await readSessionTask(dshHome, sessionId)
    if (bound !== null) return bound
  }
  return fallback
}

/**
 * 从会话 cwd 自动识别任务根。
 *
 * 判定顺序（不做猜测性绑定）：
 *   · exact     —— cwd 本身就是任务根
 *   · child     —— cwd 的一级子目录里恰好一个任务根
 *   · ambiguous —— 多个候选，列出让人选
 *   · none      —— 都没有
 *
 * @returns {{kind:'exact'|'child',path:string}|{kind:'ambiguous',candidates:string[]}|{kind:'none'}}
 */
export async function detectTaskRoot(cwd) {
  const base = isAbsolute(cwd) ? resolve(cwd) : resolve(process.cwd(), cwd)
  if (await isTaskRoot(base)) return { kind: 'exact', path: base }
  let children = []
  try {
    children = await readdir(base, { withFileTypes: true })
  } catch {
    return { kind: 'none' }
  }
  const candidates = []
  for (const child of children) {
    if (!child.isDirectory()) continue
    if (child.name.startsWith('.') || child.name === 'node_modules') continue
    const path = join(base, child.name)
    if (await isTaskRoot(path)) candidates.push(path)
  }
  if (candidates.length === 1) return { kind: 'child', path: candidates[0] }
  if (candidates.length > 1) return { kind: 'ambiguous', candidates: candidates.sort() }
  return { kind: 'none' }
}

/** 工作台任务清单文件（与 UI 插件的登记表同一份）。 */
const workbenchPath = (dshHome) => join(dshHome, 'autoresearch-workbench.json')

/**
 * 把一个任务根登记进工作台清单（幂等）。
 *
 * 「绑定会话」与「登记工作台」是同一件事的两面：模型/用户绑定了一个任务，
 * 工作台就该看见它 —— 之前要求两边各做一次手工操作，是设计缺陷。
 */
export async function registerTaskInWorkbench(dshHome, taskRoot) {
  let document = { version: 1, taskRoots: [] }
  try {
    const parsed = JSON.parse(await readFile(workbenchPath(dshHome), 'utf8'))
    if (Array.isArray(parsed?.taskRoots)) document = { version: 1, taskRoots: parsed.taskRoots }
  } catch { /* 不存在或损坏从空清单开始 */ }
  if (!document.taskRoots.includes(taskRoot)) {
    document.taskRoots.push(taskRoot)
    await mkdir(dshHome, { recursive: true })
    await writeFile(workbenchPath(dshHome), `${JSON.stringify(document, null, 2)}\n`, 'utf8')
    return { added: true, taskRoots: document.taskRoots }
  }
  return { added: false, taskRoots: document.taskRoots }
}
