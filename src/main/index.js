/**
 * AutoResearch Desktop —— Electron 主进程。
 *
 * 职责边界（对齐 dsh-desktop 的安全模型）：
 *   · 启动 harness 子进程并等待就绪，窗口加载 harness 自己的 Web UI
 *   · 窗口启用 contextIsolation + sandbox，renderer 无 Node 权限
 *   · 外部链接交给系统浏览器；阻止站内不可信跳转
 *   · 退出时停止 harness 子进程
 *
 * 桌面专属 UI 走宿主插件的 slot 与 /api 路由，不用 preload 注入 DOM。
 * 唯一的例外是启动闪屏的品牌字样：它在构建产物里是字面量，没有槽位可用，
 * 只能由本进程注入 CSS 覆盖（见 applyBootBranding）。
 *
 * @module desktop/main
 */

import { app, BrowserWindow, Menu, shell } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdir } from 'node:fs/promises'
import { HarnessLauncher, DEFAULT_HARNESS_PORT } from './harness-launcher.js'
import {
  PROFILE_NAME, inspectRuntime, resolveLaunchRoot, resolveResourcePath,
} from './runtime-paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const APP_ROOT = join(HERE, '..', '..')

const DEVELOPMENT = !app.isPackaged
const PROFILE = PROFILE_NAME

let mainWindow = null
let launcher = null
let quitting = false

/** 桌面壳自带 profile 补丁。 */
function desktopPatchPath() {
  return resolveResourcePath('autoresearch.patch.yml', {
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    projectRoot: APP_ROOT,
  })
}

/**
 * 启动闪屏的品牌字样替换。
 *
 * 侧边栏品牌是槽位，已由 dsh-ars-brand 接管；但启动闪屏那句 `HARNESS` 不是 ——
 * 它是 dsh-web-frontend 构建产物里的**字面量**，由启动脚本直接写进 DOM：
 *   yn(styles.wordmark, "HARNESS")  →  <div class="_wordmark_u7vgf_31">HARNESS</div>
 * 既没有槽位可注册，也没有 config 可改，所以只能在渲染层覆盖。
 *
 * 选择器用**类名前缀**而不是全名：类名带内容哈希（`_wordmark_u7vgf_31` 的
 * `u7vgf` 会随构建变化），前缀匹配可以跨版本存活。作用域限定在 `[data-dshBoot]`
 * 之内 —— 那只在启动闪屏的根节点上出现，因此这段 CSS 不可能影响主界面。
 *
 * 闪屏只显示一两秒；覆盖失败也只是继续显示原文，不会影响功能。
 */
const BOOT_SPLASH_CSS = `
[data-dshBoot] div[class^="_wordmark_"]{visibility:hidden;position:relative}
[data-dshBoot] div[class^="_wordmark_"]::after{
  content:'AutoResearch Sentinel';
  visibility:visible;position:absolute;inset:0;
  display:flex;align-items:center;justify-content:center;
  letter-spacing:.02em;white-space:nowrap;
}`

/** 在页面 DOM 就绪时注入闪屏覆盖样式（样式表对之后创建的元素同样生效）。 */
function applyBootBranding(window) {
  window.webContents.on('dom-ready', () => {
    window.webContents.insertCSS(BOOT_SPLASH_CSS, { cssOrigin: 'user' }).catch(() => {
      // 覆盖失败不影响任何功能：闪屏会显示上游原文。
    })
  })
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 600,
    show: false,
    backgroundColor: '#0f172a',
    title: 'AutoResearch 出题工作台',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
    },
  })

  window.once('ready-to-show', () => window.show())
  applyBootBranding(window)

  // 外部链接交给系统浏览器；站内跳转一律拒绝。
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const target = new URL(url)
    const isLoopback = target.hostname === '127.0.0.1' || target.hostname === 'localhost'
    if (!isLoopback) {
      event.preventDefault()
      void shell.openExternal(url)
    }
  })

  return window
}

/** 就绪后把带 token 的 URL 交给窗口。 */
async function openHarness(url, token) {
  if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow()
  const target = new URL(url)
  if (token !== undefined && token !== null) target.searchParams.set('token', token)
  await mainWindow.loadURL(target.toString())
}

async function bootstrap() {
  // DSH_HOME 与 run-harness.mjs、安装脚本共用同一解析（单一真源）。
  const runtime = inspectRuntime({ profile: PROFILE })
  const launchRoot = resolveLaunchRoot(runtime.dshHome)
  await mkdir(runtime.dshHome, { recursive: true })
  await mkdir(launchRoot, { recursive: true })

  if (!runtime.ready) {
    const lines = runtime.problems.map((problem) => `  ${problem.detail} / 修复：${problem.fix}`)
    process.stderr.write(`desktop: 运行前置未就绪\n${lines.join('\n')}\n`)
    await showStartupFailure('运行前置未就绪', [
      ...runtime.problems.map((problem) => `${problem.detail}\n修复：${problem.fix}`),
      '',
      `DSH_HOME：${runtime.dshHome}`,
    ].join('\n'))
    return
  }

  mainWindow = createWindow()
  mainWindow.on('closed', () => { mainWindow = null })

  launcher = new HarnessLauncher({
    dshEntryPath: runtime.dshEntryPath,
    patchPath: desktopPatchPath(),
    buildDir: join(APP_ROOT, 'build'),
    dshHome: runtime.dshHome,
    cwd: launchRoot,
    profile: PROFILE,
    preferredPort: DEFAULT_HARNESS_PORT + (DEVELOPMENT ? 1 : 0),
    onLog: (line) => {
      if (DEVELOPMENT) process.stdout.write(`${line}\n`)
    },
  })

  launcher.onChange((event) => {
    if (event.kind === 'ready') {
      void openHarness(event.url, event.token).catch((error) => {
        process.stderr.write(`desktop: 加载 harness 界面失败：${error?.message ?? error}\n`)
      })
    }
  })

  try {
    await launcher.start()
  } catch (error) {
    process.stderr.write(`desktop: harness 启动失败\n${error?.message ?? error}\n`)
    await showStartupFailure('Harness 启动失败', [
      'AutoResearch profile 未能就绪。',
      `DSH_HOME：${runtime.dshHome}`,
      `dsh 入口：${runtime.dshEntryPath}`,
      '',
      '若是首次运行，执行：npm run profile:install',
      '',
      String(error?.message ?? error),
    ].join('\n'))
  }
}

/** 渲染启动失败页；错误文本按 HTML 转义，不引入注入面。 */
async function showStartupFailure(title, detail) {
  if (mainWindow === null || mainWindow.isDestroyed()) mainWindow = createWindow()
  const escape = (text) => String(text).replace(/[<>&]/g, (character) => (
    { '<': '&lt;', '>': '&gt;', '&': '&amp;' }[character]))
  const html = `<html><body style="font-family:system-ui;padding:32px;background:#0f172a;color:#e2e8f0">
    <h2>${escape(title)}</h2>
    <pre style="background:#1e293b;padding:12px;border-radius:8px;overflow:auto;white-space:pre-wrap">${escape(detail)}</pre>
    </body></html>`
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
  mainWindow.show()
}

function buildMenu() {
  const template = [
    {
      label: 'Harness',
      submenu: [
        {
          label: '重新启动 Harness',
          click: async () => {
            await launcher?.stop()
            launcher = null
            await bootstrap()
          },
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新加载' },
        { role: 'forceReload', label: '强制重新加载' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '重置缩放' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.whenReady().then(async () => {
  buildMenu()
  await bootstrap()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) void bootstrap()
  })
}).catch((error) => {
  process.stderr.write(`desktop: 启动失败 ${error?.message ?? error}\n`)
  app.quit()
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', (event) => {
  if (quitting || launcher === null) return
  event.preventDefault()
  quitting = true
  void launcher.stop().finally(() => app.quit())
})
