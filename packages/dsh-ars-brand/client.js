/**
 * dsh-ars-brand 的浏览器半边 —— 身份层。
 *
 * 做两件事，全部通过槽位贡献，不碰任何上游产物：
 *
 *   1. 接管侧边栏品牌位：`sidebar.brand.mark` + `sidebar.brand.name`。
 *      这两个槽位由 dsh-client-ui-sidebar 声明，`ui-brand-official` 只是默认
 *      占用者（已在 cordis.patch.yml 里禁用）。契约原文允许部署方替换：
 *      "deployments may replace the shell's fish fallback without replacing
 *       the surrounding controls"。这里注册自己的占用者即可。
 *
 *   2. 提供「关于」设置页：`settings.section` 是 list 槽，每个条目是一整页；
 *      契约原文："a feature owns its own settings pages — adding a setting
 *      never means editing the shell"。归属说明放这里。
 *
 * 合规要点（对照官方 cordis-plugin-development/references/practices.md）：
 *   · 不 require 任何 @deepseek-ai/dsh-client-ui-* 包（只用 react）；
 *   · 样式只走 --dsw-alias-* 主题 token（token 改名只会掉样式，不会渲染崩）；
 *   · 工厂无副作用；样式与注册都在 apply 的 ctx.effect 内，随插件卸载回收；
 *   · 图标自绘 SVG，不使用官方 primitives。
 */
window.__ModuleLoader__.load({
  id: 'dsh-ars-brand',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const PRODUCT = 'AutoResearch Sentinel'
    const SHORT = 'ARS'
    const BASE = 'DeepSeek Harness'

    /* ── 品牌标 ──────────────────────────────────────────────────────────────
     * 哨塔（sentinel）：地平线 + 锥形塔身 + 灯室 + 光束 + 门洞。
     * 尺寸由槽位 owner props 的 size 决定（侧栏展开与 56px 轨道都传各自边长），
     * currentColor 让它自动跟随主题前景色。 */

    function ArsBrandMark({ size }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.6,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true', focusable: 'false',
      },
        h('path', { d: 'M3.4 20.6h17.2' }),
        h('path', { d: 'M7.3 20.6 9 10.3h6l1.7 10.3' }),
        h('path', { d: 'M8.5 10.3V7.5h7v2.8' }),
        h('path', { d: 'M12 7.5V4.8' }),
        h('circle', { cx: 12, cy: 3.3, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M4.5 5.4 6.7 7.1M19.5 5.4 17.3 7.1' }),
        h('path', { d: 'M10.7 20.6v-4.3h2.6v4.3' }))
    }

    /**
     * 品牌名。
     *
     * 侧栏品牌行的可用宽度只够放一个短词（官方那版是 "deepseek" + "HARNESS" 徽章）。
     * 实测："AutoResearch Sentinel" 已经是这行能容纳的上限 —— 再加 ARS 徽章会被
     * 右侧的折叠按钮截断成 "AR"。因此这里只放全名，不加徽章；ARS 简写放在
     * 「关于」页里。窄栏下用省略号兜底，而不是溢出裁切。
     */
    function ArsBrandName() {
      return h('span', { className: 'ars-wordmark', title: `${PRODUCT}（${SHORT}）` },
        h('span', { className: 'ars-wordmark-main' }, PRODUCT))
    }

    /**
     * 空会话 Hero 前的品牌标。
     *
     * `conversation.hero.brand.mark` 是 single 槽，官方在 ui-conversation 里只给了
     * 一个**回退**（renderSlot(..., { fallback: <HeroFish/> })）—— 也就是那只鲸鱼。
     * 注册自己的占用者即替换回退，这是槽位机制的正常用法。
     * owner props 的 `className` 承载宿主对标记周围的几何约束，必须透传。
     */
    function ArsHeroMark({ size, className }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        className,
        stroke: 'currentColor', strokeWidth: 1.4,
        strokeLinecap: 'round', strokeLinejoin: 'round',
        role: 'img', 'aria-label': PRODUCT,
      },
        h('path', { d: 'M3.4 20.6h17.2' }),
        h('path', { d: 'M7.3 20.6 9 10.3h6l1.7 10.3' }),
        h('path', { d: 'M8.5 10.3V7.5h7v2.8' }),
        h('path', { d: 'M12 7.5V4.8' }),
        h('circle', { cx: 12, cy: 3.3, r: 1.5, fill: 'currentColor', stroke: 'none' }),
        h('path', { d: 'M4.5 5.4 6.7 7.1M19.5 5.4 17.3 7.1' }),
        h('path', { d: 'M10.7 20.6v-4.3h2.6v4.3' }))
    }

    /* ── 「关于」设置页 ────────────────────────────────────────────────────── */

    function Fact({ label, children }) {
      return h('div', { className: 'ars-fact' },
        h('dt', null, label),
        h('dd', null, children))
    }

    function ArsAboutSection() {
      return h('div', { className: 'ars-about' },
        h('h3', { className: 'ars-about-title' }, `关于 ${PRODUCT}`),
        h('p', { className: 'ars-about-lead' },
          `${PRODUCT}（${SHORT}）是一个本地研究工作台，`,
          h('b', null, `基于 ${BASE} 搭建`),
          '。'),

        h('p', { className: 'ars-about-body' },
          `界面、会话、工具运行时与插件框架来自 ${BASE}（DeepSeek 提供，本项目未修改其源码）；`,
          '工作台面板、任务画像、双路质检、远端实验编排与自定义 API 接入为本项目自有部分。'),

        h('dl', { className: 'ars-facts' },
          h(Fact, { label: '底座' }, `${BASE} · @deepseek-ai/dsh*（0.2.0-rc.2）`),
          h(Fact, { label: '本项目' }, `${PRODUCT}（${SHORT}）v0.1.0`),
          h(Fact, { label: 'profile' }, 'autoresearch'),
          h(Fact, { label: '品牌位' },
            '接管 sidebar.brand.mark / sidebar.brand.name（上游允许部署方替换官方占位）')),

        h('p', { className: 'ars-about-foot' },
          '底座版本号与各插件的 peerDependencies 保持一致；升级底座时同步更新这两处。'))

    }

    /* ── 样式 ────────────────────────────────────────────────────────────── */

    const STYLESHEET = `
.ars-wordmark{display:inline-flex;align-items:center;min-width:0;max-width:100%}
.ars-wordmark-main{font-size:14px;font-weight:640;letter-spacing:.01em;white-space:nowrap;
  min-width:0;overflow:hidden;text-overflow:ellipsis;
  color:var(--dsw-alias-label-primary,currentColor)}

.ars-about{max-width:660px;display:flex;flex-direction:column;gap:14px;
  color:var(--dsw-alias-label-primary,currentColor)}
.ars-about-title{margin:0;font-size:17px;font-weight:640}
.ars-about-lead{margin:0;font-size:14px;line-height:1.7}
.ars-about-lead b{font-weight:640}
.ars-about-body{margin:0;font-size:13px;line-height:1.75;
  color:var(--dsw-alias-label-secondary,#94a3b8)}
.ars-facts{margin:2px 0 0;display:grid;grid-template-columns:auto 1fr;gap:8px 16px;
  padding:14px 16px;border-radius:10px;
  background:var(--dsw-alias-bg-elevated,rgba(148,163,184,.06));
  border:1px solid var(--dsw-alias-border-secondary,rgba(148,163,184,.2))}
.ars-fact{display:contents}
.ars-facts dt{font-size:12px;font-weight:600;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#94a3b8)}
.ars-facts dd{margin:0;font-size:12px;line-height:1.6;overflow-wrap:anywhere}
.ars-about-foot{margin:0;font-size:12px;line-height:1.6;
  color:var(--dsw-alias-label-tertiary,#64748b)}
`

    /* ── 应用 ────────────────────────────────────────────────────────────── */

    function apply(ctx) {
      ctx.effect(() => {
        const id = 'dsh-ars-brand-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.dataset.pluginCss = 'dsh-ars-brand'
        style.textContent = STYLESHEET
        document.head.appendChild(style)
        return () => style.remove()
      }, 'ars-brand: styles')

      // 品牌位：与官方同一套注入结构 —— 两个槽位都在时才注册，槽位塌陷时自动回收。
      ctx.slots.inject('sidebar.brand.mark', () => ctx.slots.inject('sidebar.brand.name', function* () {
        yield ctx.slots.register({ name: 'sidebar.brand.mark' }, ArsBrandMark)
        yield ctx.slots.register({ name: 'sidebar.brand.name' }, ArsBrandName)
      }))

      // 空会话 Hero 的品牌标：替换 ui-conversation 的鲸鱼回退。
      ctx.slots.inject('conversation.hero.brand.mark', () => ctx.slots.register({
        name: 'conversation.hero.brand.mark',
      }, ArsHeroMark))

      // 「关于」设置页。order 取大值，排在官方各节之后。
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'ars-about',
        order: 90,
        label: '关于',
      }, ArsAboutSection))
    }

    return { apply, inject: ['slots'] }
  },
})
