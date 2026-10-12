/**
 * 运行目录解析 —— 桌面壳、启动脚本与安装脚本共用同一套规则。
 *
 * 之前两边各写一套（桌面壳用 Electron userData，脚本用项目 .dsh-home），
 * 导致「装好的 profile 桌面端看不见」。这里收敛为单一真源。
 *
 * 解析优先级：
 *   1. 显式传入的 dshHome
 *   2. 环境变量 DSH_HOME
 *   3. 项目内 .dsh-home（开发与本地验证用，保证 npm run 三件套互相看见）
 *
 * 不采用 Electron userData：它随应用名与打包方式变化，会让「同一个项目」
 * 在不同启动路径下看到不同 profile，正是上面那个问题的成因。
 *
 * @module desktop/runtime-paths
 */

import { join, resolve, isAbsolute, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { existsSync } from 'node:fs'

const HERE = dirname(fileURLToPath(import.meta.url))

/** 项目根：src/main/runtime-paths.js → ../../ */
export const PROJECT_ROOT = resolve(HERE, '..', '..')

/** profile 名。桌面壳与安装脚本共用。 */
export const PROFILE_NAME = 'autoresearch'

/** 双路质检使用的一次性 profile（无 Host / 无 HTTP）。 */
export const HEADLESS_PROFILE_NAME = 'headless'

/**
 * 解析 DSH_HOME。
 * 解析优先级：显式传入 > 环境变量 DSH_HOME > 项目内 .dsh-home。
 * 三者都收敛到项目根的 .dsh-home，保证「npm run harness / npm run desktop /
 * profile:install」看到同一份 profile —— 曾经的 ~/.dsh 分叉就是这么来的。
 * @param options.projectRoot 项目根覆盖
 * @param options.explicit 显式指定，最高优先级
 */
export function resolveDshHome(options = {}) {
  if (typeof options.explicit === 'string' && options.explicit.trim() !== '') {
    return isAbsolute(options.explicit) ? options.explicit : resolve(process.cwd(), options.explicit)
  }
  const fromEnvironment = process.env.DSH_HOME
  if (typeof fromEnvironment === 'string' && fromEnvironment.trim() !== '') {
    return isAbsolute(fromEnvironment) ? fromEnvironment : resolve(process.cwd(), fromEnvironment)
  }
  return join(options.projectRoot ?? PROJECT_ROOT, '.dsh-home')
}

/** 任务根（launch-root）：harness 的工作目录。 */
export function resolveLaunchRoot(dshHome = resolveDshHome()) {
  return join(dshHome, 'launch-root')
}

/** dsh CLI 入口。 */
export function resolveDshEntry(projectRoot = PROJECT_ROOT) {
  return join(projectRoot, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
}

/** profile 根目录。 */
export function resolveProfileRoot(dshHome, profile = PROFILE_NAME) {
  return join(dshHome, 'profiles', profile)
}

/**
 * 检查运行前置：dsh 入口存在、profile 已安装。
 * 返回结构化结果，供启动器在起进程之前给出可执行的修复指引。
 */
export function inspectRuntime(options = {}) {
  const projectRoot = options.projectRoot ?? PROJECT_ROOT
  const dshHome = resolveDshHome(options)
  const dshEntryPath = resolveDshEntry(projectRoot)
  const profileRoot = resolveProfileRoot(dshHome, options.profile ?? PROFILE_NAME)

  const dshEntryPresent = existsSync(dshEntryPath)
  const profileManifest = join(profileRoot, 'package.json')
  const profilePresent = existsSync(profileManifest)

  const problems = []
  if (!dshEntryPresent) {
    problems.push({
      code: 'DSH_ENTRY_MISSING',
      detail: `找不到 dsh 入口：${dshEntryPath}`,
      fix: '在项目根执行 npm install',
    })
  }
  if (!profilePresent) {
    problems.push({
      code: 'PROFILE_MISSING',
      detail: `profile "${options.profile ?? PROFILE_NAME}" 未安装：${profileManifest}`,
      fix: '执行 npm run profile:install',
    })
  }

  return {
    projectRoot,
    dshHome,
    dshEntryPath,
    profileRoot,
    dshEntryPresent,
    profilePresent,
    ready: problems.length === 0,
    problems,
  }
}

/** 打包后资源路径解析（patch 文件与插件包）。 */
export function resolveResourcePath(name, options = {}) {
  const packaged = options.isPackaged === true && typeof options.resourcesPath === 'string'
  return packaged
    ? join(options.resourcesPath, name)
    : join(options.projectRoot ?? PROJECT_ROOT, 'build', name)
}
