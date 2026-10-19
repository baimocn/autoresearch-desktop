/**
 * dsh-autoresearch-ui 的浏览器半边。
 *
 * AutoResearch 工作台：任务组合总览（默认页）+ 单任务详情（模式 / 四阶段 /
 * 门禁 / 轨迹 / 双路质检 / 远端实验 / 证据浏览 / API 配置）。
 * 数据全部来自宿主半边的 /api/autoresearch/* 只读路由；探测按钮走
 * /remote/probe（幂等只读远端状态）。改世界的操作留在对话里。
 *
 * 使用 window.__ModuleLoader__.load 自注册；工厂必须无副作用，样式与订阅都在
 * apply 的 ctx.effect 内完成。可见性协议：main（keyed 内容）+ sidebar.panellist
 * （导航行）双注册，缺一不可 —— 见 docs/client-ui.md。
 */
window.__ModuleLoader__.load({
  id: 'dsh-autoresearch-ui',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement

    const API = '/api/autoresearch'
    const PANEL = 'autoresearch'

    /* ── 样式表 ─────────────────────────────────────────────────────────────
     * 视觉语言：深浅主题都走 shell 的 --dsw-alias-* 变量，回退值按深色主题调。
     * 一套 .aw-* 类覆盖卡片、徽章、步进器、迷你柱图、按钮、输入框与空态。 */

    const STYLESHEET = `
/* main 槽承载层：layout 的 centerCol 是 height:100% + overflow:hidden，
   它按契约要求子面板自己滚动（插件管理页同模式）。没有这条，超出视口的
   内容会被直接裁掉 —— 实测「工作台任何栏目都滚不动」的根因。 */
.autoresearch-panel{height:100%;overflow-y:auto;overscroll-behavior:contain}
.aw-panel{
  /* 字号系统：收敛 10 种散落字号到 5 档 —— 之前 11/11.5/12/12.5/13/14/15.5/16/17/20/21
     混用，同一层级的文字在不同卡片里不一样大，是「怪」的主要来源之一。 */
  --aw-fs-xs:11px;--aw-fs-sm:12px;--aw-fs-md:13px;--aw-fs-lg:15px;--aw-fs-xl:19px;
  /* 间距系统：4 的倍数，只有这五档 */
  --aw-sp-1:4px;--aw-sp-2:8px;--aw-sp-3:12px;--aw-sp-4:16px;--aw-sp-5:24px;
  /* 状态色：优先取 DSH 语义 token，回退值只作兜底。
     注意回退值是**浅色主题下也成立**的颜色 —— 早期版本把回退写成深色
     （如 rgba(15,23,42,.35)），一旦 token 名写错就会静默变成深色块。 */
  /* 强调色 = 用于**边框 / 焦点环 / 强调文字**。必须是可读的彩色，不能是前景白。
     这里踩过一个只有肉眼看截图才能发现的坑：--dsw-alias-brand-primary 在 DSH
     深色主题里是 **#f9fafb（近白）** —— 它是"品牌前景色"，不是填充色。把它当
     背景用（按钮、选中标签）就得到白底 + 白字 = 完全看不见。
     DOM 断言全绿（它量的是 --aw-ink 对 --aw-bg 的对比度），实际控件是空白的。
     现在改用真正的强调色（#7aaaff），填充场景另用下面的 --aw-fill-* 一对。
     （注意：这段在模板字符串里，注释中不能出现反引号。） */
  --aw-accent:var(--dsw-alias-state-business-primary,#3b6fe0);
  --aw-accent-soft:color-mix(in srgb,var(--aw-accent) 14%,transparent);
  /* 主按钮填充 + 其上的文字色：这一对必须**成对**使用，且都取自 DSH 的
     button-primary 配对（浅色下自动反转），不能拿 accent 当填充。 */
  --aw-fill-primary:var(--dsw-alias-button-primary-fill,#3b6fe0);
  --aw-on-fill-primary:var(--dsw-alias-label-primary-foreground,#fff);
  /* 选中/激活的柔和填充（host 的 ghost-active 形态）：比纯色药丸更贴合宿主。 */
  --aw-fill-active:var(--dsw-alias-button-ghost-active-fill,#43454a);
  --aw-ok:var(--dsw-alias-state-success-primary,#1a7f5a);
  --aw-ok-soft:color-mix(in srgb,var(--aw-ok) 14%,transparent);
  --aw-warn:var(--dsw-alias-state-warn-primary,#9a6700);
  --aw-warn-soft:color-mix(in srgb,var(--aw-warn) 16%,transparent);
  --aw-bad:var(--dsw-alias-state-error-primary,#c0392b);
  --aw-bad-soft:color-mix(in srgb,var(--aw-bad) 14%,transparent);
  --aw-idle:var(--dsw-alias-state-idle-primary,#6b7280);
  --aw-idle-soft:color-mix(in srgb,var(--aw-idle) 12%,transparent);

  /* 主题适配：token 名必须与 DSH 实际定义一致。
     实测踩过的坑 —— 这几个名字在 DSH 里**不存在**，写了不会报错，
     只会静默回退成写死的深色值，表现为浅色主题下出现深色块：
       --dsw-alias-border-secondary（实际是 border-l1 / border-l2 / l3 / l4）
       --dsw-alias-bg-elevated    （实际是 bg-layer-1 / bg-layer-2）
       --dsw-font-family-sans     （实际是 --dsw-font-family）
       --dsw-font-family-mono     （实际是 --dsw-font-markdown-code-block） */
  --aw-line:var(--dsw-alias-border-l1,#d8dce3);
  --aw-line-strong:var(--dsw-alias-border-l2,#c2c8d0);
  --aw-bg:var(--dsw-alias-bg-layer-1,#f4f5f7);
  --aw-bg-2:var(--dsw-alias-bg-layer-2,#eceef1);
  --aw-bg-deep:var(--dsw-alias-bg-base,transparent);
  --aw-overlay:var(--dsw-alias-bg-overlay,#fff);
  --aw-ink:var(--dsw-alias-label-primary,#1f2328);
  --aw-ink-2:var(--dsw-alias-label-secondary,#5c6672);
  --aw-ink-3:var(--dsw-alias-label-caption,#8a929c);
  --aw-shadow:0 1px 2px rgba(16,24,40,.06),0 8px 24px -12px rgba(16,24,40,.14);
  --aw-mono:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Consolas,monospace);
  --aw-r-ctl:var(--dsw-radius-sm,7px);--aw-r-box:var(--dsw-radius-lg,12px);
  font-family:var(--dsw-font-family,inherit);color:var(--aw-ink);
  padding:20px 22px 40px;max-width:1240px;margin:0 auto;}
.aw-panel *{box-sizing:border-box}
.aw-panel code,.aw-mono{font-family:var(--aw-mono)}

/* 焦点可见性：键盘用户必须能看到焦点在哪。
   :focus-visible 而不是 :focus —— 鼠标点击不该留焦点环。 */
.aw-panel :focus-visible{outline:2px solid var(--aw-accent);outline-offset:2px;border-radius:var(--aw-r-ctl)}

/* 尊重系统的减少动效偏好。 */
@media (prefers-reduced-motion:reduce){
  .aw-panel *{transition-duration:.01ms !important;animation-duration:.01ms !important}
}

/* 跳转链接：键盘用户按一次 Tab 就能跳过标签栏直达内容。 */
.aw-skip{position:absolute;left:-9999px;top:0;z-index:10;background:var(--aw-overlay);
  border:1px solid var(--aw-accent);border-radius:var(--aw-r-ctl);padding:8px 14px;font-size:var(--aw-fs-sm)}
.aw-skip:focus{left:22px;top:14px}

/* 页头：标题 + 面包屑。面包屑回答「我在流程的哪一段」，
   这是原来 9 个平铺标签最缺的信息。 */
.aw-head{display:flex;align-items:flex-start;gap:12px;margin-bottom:var(--aw-sp-3)}
.aw-head-main{min-width:0}
.aw-head h2{margin:0;font-size:var(--aw-fs-xl);font-weight:650;letter-spacing:.2px;line-height:1.25}
.aw-breadcrumb{margin:2px 0 0;font-size:var(--aw-fs-xs);color:var(--aw-ink-3);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-sub{margin:0 0 var(--aw-sp-4);font-size:var(--aw-fs-sm);color:var(--aw-ink-2);line-height:1.6}
.aw-spacer{flex:1}

/* 查看中的任务条：粘顶，长页面滚动时始终知道自己看的是哪个任务。
   之前它混在正文里，滚下去就看不见了，容易看错任务。 */
.aw-taskbar{position:sticky;top:0;z-index:5;display:flex;align-items:center;gap:var(--aw-sp-2);
  padding:6px var(--aw-sp-3);margin-bottom:var(--aw-sp-3);
  background:var(--aw-accent-soft);border:1px solid var(--aw-accent);border-radius:var(--aw-r-ctl);
  backdrop-filter:blur(6px)}
.aw-taskbar code{flex:1;min-width:0;font-family:var(--aw-mono);font-size:var(--aw-fs-sm);
  overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

/* 标签栏：一级（推进/核查/任务组合）+ 二级（当前分组下的子页）。
   二级标签只在所属分组被选中时出现，避免 9 个标签平铺。 */
.aw-tabs{display:flex;align-items:center;gap:6px;flex-wrap:wrap;
  margin:0 0 var(--aw-sp-4);padding:5px;background:var(--aw-bg);border:1px solid var(--aw-line);
  border-radius:var(--aw-r-box);position:sticky;top:0;z-index:4}
.aw-tabset{display:flex;gap:2px;padding:2px;background:var(--aw-bg-2);border-radius:var(--aw-r-ctl)}
.aw-tab{border:1px solid transparent;background:transparent;color:var(--aw-ink-2);font:inherit;
  font-size:var(--aw-fs-md);padding:6px 13px;border-radius:var(--aw-r-ctl);cursor:pointer;
  transition:background .15s,color .15s,border-color .15s;white-space:nowrap}
.aw-tab:hover{color:var(--aw-ink);background:var(--aw-idle-soft)}
.aw-tab[data-on="1"]{background:var(--aw-fill-active);color:var(--dsw-alias-label-primary,currentColor);font-weight:550;
  border-color:var(--dsw-alias-button-ghost-active-border,var(--aw-line))}
/* 二级标签用描边而非实心底，与一级入口区分层级。 */
.aw-tab-sub[data-on="1"]{background:var(--aw-accent-soft);color:var(--aw-accent);
  border-color:var(--aw-accent);font-weight:550}
.aw-tabsep{width:1px;align-self:stretch;margin:2px 4px;background:var(--aw-line)}

/* 内容区：接受跳转链接焦点，不显示常驻焦点环（tabIndex=-1 只在被指向时聚焦）。 */
.aw-content{outline:none}

.aw-btn{border:1px solid var(--aw-line);background:var(--aw-bg);color:var(--aw-ink);font:inherit;font-size:var(--aw-fs-sm);
  min-height:30px;padding:5px 12px;border-radius:var(--aw-r-ctl);cursor:pointer;transition:border-color .15s,background .15s,opacity .15s;display:inline-flex;align-items:center;gap:6px}
.aw-btn-xs{min-height:24px;padding:2px 9px;font-size:var(--aw-fs-xs)}
.aw-btn:hover{border-color:var(--aw-accent);background:var(--aw-accent-soft)}
.aw-btn:disabled{opacity:.45;cursor:default}
.aw-btn[data-kind="primary"]{background:var(--aw-fill-primary);border-color:var(--aw-fill-primary);color:var(--aw-on-fill-primary);font-weight:550}
.aw-btn[data-kind="primary"]:hover{filter:brightness(1.1)}
.aw-btn[data-kind="danger"]:hover{border-color:var(--aw-bad);color:var(--aw-bad);background:var(--aw-bad-soft)}
.aw-btn[data-size="sm"]{min-height:26px;padding:3px 9px;font-size:var(--aw-fs-xs)}
.aw-input{border:1px solid var(--aw-line);background:var(--aw-bg-deep);color:var(--aw-ink);font:inherit;font-size:var(--aw-fs-sm);
  min-height:30px;padding:5px 10px;border-radius:var(--aw-r-ctl);min-width:180px;flex:1 1 220px}
.aw-input:focus{outline:none;border-color:var(--aw-accent)}

/* 徽章：状态由「彩色圆点 + 底色浅染」承担，文字用中性可读色。
   为什么不用状态色当文字：--dsw-alias-state-*-primary 是**填充色**语义，
   当文字用两个主题都不达标 —— 实测浅色下「非任务」1.48:1、「需关注」2.15:1、
   「健康」2.28:1，深色下 idle 2.44:1（AA 要求 4.5:1）。
   改成中性文字 + 彩色圆点后：状态照样一眼可见，文字两种主题都 ≥ 4.5:1。
   （圆点此前没有背景色，等于不存在 —— 状态只靠文字色表达，这正是上面那个坑。） */
.aw-badge{display:inline-flex;align-items:center;gap:5px;padding:2px 9px;border-radius:999px;
  font-size:var(--aw-fs-xs);font-weight:600;white-space:nowrap;
  color:var(--dsw-alias-label-secondary,#a1a1aa)}
.aw-badge i{width:6px;height:6px;border-radius:50%;flex:none;background:currentColor}
.aw-badge[data-tone="ok"]{background:var(--aw-ok-soft)}
.aw-badge[data-tone="ok"] i{background:var(--aw-ok)}
.aw-badge[data-tone="warn"]{background:var(--aw-warn-soft)}
.aw-badge[data-tone="warn"] i{background:var(--aw-warn)}
.aw-badge[data-tone="bad"]{background:var(--aw-bad-soft)}
.aw-badge[data-tone="bad"] i{background:var(--aw-bad)}
.aw-badge[data-tone="info"]{background:var(--aw-accent-soft)}
.aw-badge[data-tone="info"] i{background:var(--aw-accent)}
.aw-badge[data-tone="idle"]{background:var(--aw-idle-soft)}
.aw-badge[data-tone="idle"] i{background:var(--aw-idle)}

.aw-card{position:relative;background:var(--aw-bg);border:1px solid var(--aw-line);border-radius:var(--aw-r-box);padding:var(--aw-sp-4) var(--aw-sp-4) var(--aw-sp-3) calc(var(--aw-sp-4) + 3px);
  overflow:hidden;transition:border-color .15s,box-shadow .15s}
.aw-card:hover{border-color:var(--aw-accent);box-shadow:0 6px 20px rgba(0,0,0,.16)}
/* 左侧色条：健康度唯一语义指示（原来顶部色条 + 徽章 + 指标色彩三处重复表达）。 */
.aw-card::before{content:'';position:absolute;inset:0 auto 0 0;width:3px;background:var(--aw-idle-soft)}
.aw-card[data-health="ok"]::before{background:var(--aw-ok)}
.aw-card[data-health="warn"]::before{background:var(--aw-warn)}
.aw-card[data-health="bad"]::before{background:var(--aw-bad)}
.aw-card[data-health="info"]::before{background:var(--aw-accent)}
.aw-card h3{margin:0;font-size:var(--aw-fs-lg);font-weight:630;line-height:1.35}
.aw-card .aw-path{margin:3px 0 0;font-size:var(--aw-fs-xs);color:var(--aw-ink-2);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}

.aw-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:var(--aw-sp-4);align-items:stretch}
/* 卡片内部纵向弹性：底部按钮行始终贴底 —— 内容多寡不同也保持视觉基线一致。 */
.aw-card{display:flex;flex-direction:column}
.aw-card .aw-cardbody{flex:1}
.aw-formrow{display:flex;gap:var(--aw-sp-2);flex-wrap:wrap;align-items:center;margin:var(--aw-sp-3) 0}
.aw-formrow .aw-label{font-size:var(--aw-fs-sm);color:var(--aw-ink-2);white-space:nowrap}

.aw-stepper{display:flex;align-items:flex-start;margin:14px 0 6px}
.aw-step{flex:1;display:flex;flex-direction:column;align-items:center;gap:6px;position:relative;min-width:0}
.aw-step::before,.aw-step::after{content:'';position:absolute;top:9px;height:2px;width:50%;background:var(--aw-line)}
.aw-step::before{left:0}.aw-step::after{right:0}
.aw-step:first-child::before,.aw-step:last-child::after{display:none}
.aw-step[data-done="1"]::before,.aw-step[data-done="1"]::after{background:var(--aw-accent)}
.aw-step i{width:18px;height:18px;border-radius:50%;border:2px solid var(--aw-line);background:var(--aw-bg-deep);z-index:1;
  display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;color:var(--aw-ink-2);font-style:normal}
.aw-step[data-state="done"] i{background:var(--aw-accent);border-color:var(--aw-accent);color:var(--aw-on-fill-primary)}
.aw-step[data-state="current"] i{border-color:var(--aw-accent);color:var(--aw-accent);box-shadow:0 0 0 3px var(--aw-accent-soft)}
.aw-step span{font-size:var(--aw-fs-xs);color:var(--aw-ink-2);text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.aw-step[data-state="current"] span{color:var(--aw-accent);font-weight:600}
.aw-step[data-state="done"] span{color:var(--aw-ink)}

.aw-metrics{display:flex;gap:var(--aw-sp-1);flex-wrap:wrap;margin-top:var(--aw-sp-3)}
/* 指标 chip：数值 + 标签一体，除异常外统一用中性色 —— 颜色只传达「需要关注」。 */
.aw-metric{display:inline-flex;align-items:baseline;gap:5px;padding:3px 9px;border-radius:var(--aw-r-ctl);
  background:var(--aw-bg-deep);border:1px solid var(--aw-line)}
.aw-metric b{font-size:var(--aw-fs-sm);font-weight:650;color:var(--aw-ink);line-height:1.4}
.aw-metric b[data-tone="warn"]{color:var(--aw-warn)}
.aw-metric b[data-tone="bad"]{color:var(--aw-bad)}
.aw-metric b[data-tone="ok"]{color:var(--aw-ok)}
.aw-metric span{font-size:var(--aw-fs-xs);color:var(--aw-ink-2)}
.aw-metric[data-tone="warn"]{border-color:var(--aw-warn)}
.aw-metric[data-tone="bad"]{border-color:var(--aw-bad)}

.aw-bru{display:flex;gap:0;margin-top:var(--aw-sp-3);border:1px solid var(--aw-line);border-radius:var(--aw-r-ctl);overflow:hidden}
.aw-bru div{flex:1;padding:6px 10px;background:var(--aw-bg-deep)}
.aw-bru div + div{border-left:1px solid var(--aw-line)}
.aw-bru b{display:block;font-size:var(--aw-fs-sm);font-weight:620;font-variant-numeric:tabular-nums}
.aw-bru span{font-size:var(--aw-fs-xs);color:var(--aw-ink-2);letter-spacing:.4px}

.aw-bars{display:flex;align-items:flex-end;gap:3px;height:56px;padding:6px 6px 0;border-bottom:1px solid var(--aw-line);margin-top:10px}
.aw-bars i{flex:1;min-width:5px;max-width:18px;background:linear-gradient(180deg,var(--aw-accent),rgba(91,140,255,.35));
  border-radius:3px 3px 0 0;min-height:2px}
.aw-bars i[data-miss="1"]{background:var(--aw-idle-soft)}

.aw-sec{margin:18px 0 10px;display:flex;align-items:baseline;gap:10px}
.aw-sec h3{margin:0;font-size:15px;font-weight:630}
.aw-sec p{margin:0;font-size:12px;color:var(--aw-ink-2)}

.aw-box{background:var(--aw-bg);border:1px solid var(--aw-line);border-radius:var(--aw-r-box);padding:var(--aw-sp-4);margin-bottom:var(--aw-sp-4)}

.aw-list{list-style:none;margin:0;padding:0}
.aw-row{display:flex;align-items:center;gap:10px;padding:8px 2px;border-bottom:1px solid var(--aw-line);font-size:13px}
.aw-row:last-child{border-bottom:none}
.aw-row code{font-size:12px}

.aw-callobse{background:var(--aw-bg-deep);border:1px solid var(--aw-line);border-radius:var(--aw-r-ctl);padding:var(--aw-sp-3);
  font-size:var(--aw-fs-md);font-weight:550;margin-top:var(--aw-sp-3)}
.aw-note{font-size:11.5px;color:var(--aw-ink-2);margin:10px 0 0}
.aw-cmd{background:var(--aw-idle-soft);border-radius:5px;padding:1px 7px;font-size:11.5px}

.aw-empty{display:flex;flex-direction:column;align-items:center;gap:8px;padding:44px 20px;color:var(--aw-ink-2);
  border:1px dashed var(--aw-line);border-radius:14px;text-align:center}
.aw-empty b{font-size:14.5px;color:var(--aw-ink);font-weight:620}
.aw-empty p{margin:0;font-size:12.5px;max-width:460px;line-height:1.6}

/* 提示条：承载「不是任务」的条目（未初始化的进程默认根）。它不是卡片，
   因为工作台里并不存在这个任务；做成卡片会让人误以为有个任务在跑。 */
.aw-hintbar{display:flex;align-items:center;gap:var(--aw-sp-3);padding:var(--aw-sp-3) var(--aw-sp-4);
  border:1px dashed var(--aw-line);border-radius:var(--aw-r-box);margin-bottom:var(--aw-sp-4);
  font-size:var(--aw-fs-sm);color:var(--aw-ink-2);line-height:1.55}
.aw-hintbar b{color:var(--aw-ink);font-weight:620}
.aw-hintbar code{font-size:var(--aw-fs-xs);background:var(--aw-bg-deep);border-radius:4px;padding:1px 6px;
  overflow-wrap:anywhere}

/* 任务选择器：详情页在未选任务时的入口。卡片本身就是按钮，整块可点。 */
.aw-pick{display:flex;flex-direction:column;gap:5px;text-align:left;font:inherit;cursor:pointer;
  background:var(--aw-bg);border:1px solid var(--aw-line);border-radius:var(--aw-r-box);
  padding:var(--aw-sp-4);min-height:96px;transition:border-color .15s,background .15s}
.aw-pick:hover{border-color:var(--aw-accent);background:var(--aw-bg-deep)}
.aw-pick:focus-visible{outline:2px solid var(--aw-accent);outline-offset:2px}
.aw-pick b{font-size:var(--aw-fs-lg);font-weight:640;color:var(--aw-ink)}
.aw-pick code{font-size:var(--aw-fs-xs);color:var(--aw-ink-2);overflow-wrap:anywhere}
.aw-pick span{font-size:var(--aw-fs-sm);color:var(--aw-ink-2)}

/* 遮罩用中性半透明黑，两种主题下都能压暗底层内容。
   弹窗面板用 bg-overlay（真正的浮层色）而不是 bg-base ——
   bg-base 在浅色主题下是页面底色，拿来做弹窗会与背景糊在一起。 */
.aw-modal{position:fixed;inset:0;background:rgba(9,12,20,.55);display:flex;align-items:center;justify-content:center;z-index:60;backdrop-filter:blur(3px)}
.aw-modal>div{background:var(--aw-overlay);border:1px solid var(--aw-line-strong);border-radius:var(--aw-r-box);padding:20px 22px;
  max-width:780px;max-height:82vh;overflow:auto;width:92%;box-shadow:var(--aw-shadow),0 24px 64px rgba(0,0,0,.28)}
.aw-modal h3{margin:0;font-size:var(--aw-fs-lg)}
.aw-pre{max-height:300px;overflow:auto;background:var(--aw-bg-2);border:1px solid var(--aw-line);border-radius:var(--aw-r-ctl);padding:10px 12px;
  font-size:var(--aw-fs-xs);line-height:1.55;color:var(--aw-ink-2);white-space:pre-wrap;margin:8px 0 0;font-family:var(--aw-mono)}

.aw-table{border-collapse:collapse;font-size:12px;width:100%}
.aw-table th{text-align:left;padding:6px 10px;color:var(--aw-ink-2);font-weight:550;font-size:11px;letter-spacing:.4px;
  text-transform:uppercase;border-bottom:1px solid var(--aw-line);white-space:nowrap}
.aw-table td{padding:6px 10px;border-bottom:1px solid var(--aw-line);white-space:nowrap}
.aw-scroll{overflow-x:auto}

.aw-kicker{font-size:var(--aw-fs-xs);font-weight:650;letter-spacing:.8px;text-transform:uppercase;color:var(--aw-ink-2);margin:var(--aw-sp-4) 0 var(--aw-sp-2)}
`

    /* ── 小组件 ─────────────────────────────────────────────────────────── */

    const TONE = {
      RECOMMEND: 'ok', NEEDS_EVIDENCE: 'warn', REJECT: 'bad', PASS: 'ok', FAIL: 'bad',
      UNKNOWN: 'warn', complete: 'ok', running: 'info', stalled: 'warn', failed: 'bad',
      pending: 'idle', unknown: 'warn', 'never-probed': 'idle',
    }
    const TONE_TEXT = {
      RECOMMEND: '通过', NEEDS_EVIDENCE: '需补证', REJECT: '不通过', PASS: 'PASS', FAIL: 'FAIL',
      UNKNOWN: 'UNKNOWN', complete: '已完成', running: '运行中', stalled: '进程已不在',
      failed: '失败', pending: '待启动', unknown: '状态未知', 'never-probed': '从未探测',
    }

    function Badge({ tone = 'idle', children, dot = true }) {
      return h('span', { className: 'aw-badge', 'data-tone': tone }, dot ? h('i') : null, children)
    }

    function verdictBadge(verdict) {
      const key = verdict ?? 'never-probed'
      return h(Badge, { tone: TONE[key] ?? 'idle' }, verdict === null || verdict === undefined ? '未运行' : (TONE_TEXT[key] ?? String(verdict)))
    }

    /** 四阶段步进器。 */
    function Stepper({ currentOrder, doneCount }) {
      const names = ['领取', '命题', '迭代', '发布']
      return h('div', { className: 'aw-stepper' },
        names.map((label, index) => {
          const order = index + 1
          const state = order <= doneCount ? 'done' : (order === currentOrder ? 'current' : 'pending')
          return h('div', { key: label, className: 'aw-step', 'data-state': state, 'data-done': order <= doneCount ? '1' : '0' },
            h('i', null, state === 'done' ? '✓' : String(order)),
            h('span', null, label))
        }))
    }

    /** 指标 chip：数值 + 标签一体；boxTone 给整块着色（仅表示该指标需要动作）。 */
    function Metric({ value, label, tone, boxTone }) {
      return h('div', { className: 'aw-metric', 'data-tone': boxTone },
        h('b', { 'data-tone': tone }, value),
        h('span', null, label))
    }

    /** B/R/U 校准行。 */
    function BruRow({ calibration }) {
      if (!calibration || (calibration.baseline === null && calibration.upper === null)) return null
      const fmt = (value) => value === null || value === undefined ? '—' : String(value)
      return h('div', { className: 'aw-bru' },
        h('div', null, h('span', null, 'B 基线'), h('b', null, fmt(calibration.baseline))),
        h('div', null, h('span', null, 'R 参考'), h('b', null, fmt(calibration.reference))),
        h('div', null, h('span', null, 'U 上界'), h('b', null, fmt(calibration.upper))),
        h('div', null, h('span', null, 'σ 倍数'), h('b', null, fmt(calibration.sigmaMultiple))))
    }

    /** 轨迹迷你柱图：scores 为（数字 | null）数组，null 画灰色残桩。 */
    function MiniBars({ scores }) {
      const shown = (scores ?? []).slice(-24)
      const max = Math.max(...shown.filter((value) => value !== null), 0)
      return h('div', { className: 'aw-bars' },
        shown.map((value, index) => h('i', {
          key: index,
          title: value === null ? '未出分' : String(value),
          'data-miss': value === null ? '1' : '0',
          style: { height: value === null ? '6px' : `${Math.max(8, (value / (max || 1)) * 100)}%` },
        })))
    }

    function EmptyState({ title, children }) {
      return h('div', { className: 'aw-empty' }, h('b', null, title), children)
    }

    function Section({ title, subtitle, right }) {
      return h('div', { className: 'aw-sec' },
        h('h3', null, title),
        subtitle ? h('p', null, subtitle) : null,
        h('div', { style: { flex: 1 } }),
        right)
    }

    /* ── 数据获取 ─────────────────────────────────────────────────────────── */

    function withTask(path, task) {
      if (task === null || task === undefined || task === '') return path
      return `${path}${path.includes('?') ? '&' : '?'}task=${encodeURIComponent(task)}`
    }

    function useApi(path) {
      const [state, setState] = React.useState({ loading: path !== null, data: null, error: null })
      const reload = React.useCallback(() => {
        if (path === null) return
        setState((current) => ({ ...current, loading: true }))
        fetch(`${API}${path}`, { credentials: 'same-origin' })
          .then((response) => response.json().then((body) => ({ ok: response.ok, body })))
          .then(({ ok, body }) => {
            setState({ loading: false, data: ok ? body : null, error: ok ? null : (body.error ?? '请求失败') })
          })
          .catch((error) => setState({ loading: false, data: null, error: String(error.message ?? error) }))
      }, [path])
      React.useEffect(() => { reload() }, [reload])
      return { ...state, reload }
    }

    async function apiPost(path, body) {
      const response = await fetch(`${API}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify(body ?? {}),
      })
      const json = await response.json().catch(() => ({}))
      if (!response.ok) throw new Error(json.error ?? `HTTP ${response.status}`)
      return json
    }

    /* ── 任务组合（默认页） ───────────────────────────────────────────────── */

    function taskHealth(card) {
      if (card.notTaskRoot === true) return 'idle'
      if (card.error !== undefined) return 'bad'
      const blocking = card.gates?.blocking?.length ?? 0
      if (blocking > 0) return 'warn'
      if ((card.missingRequiredCount ?? 0) > 0) return 'warn'
      if ((card.remote?.unfinished?.length ?? 0) > 0) return 'info'
      return 'ok'
    }

    function TaskCard({ card, onOpen, onProbe, probing, onRemove }) {
      const health = taskHealth(card)
      const unfinished = card.remote?.unfinished?.length ?? 0
      const codex = card.trajectory?.codex
      const seed = card.trajectory?.seed
      const order = card.phase?.order ?? 1
      const blocking = card.gates?.blocking?.length ?? 0
      const missing = card.missingRequiredCount ?? 0

      // 信息层次（上→下）：身份 → 进度 → 关键缺口 → 次要指标 → 操作。
      // 颜色只表达「需要动作」：异常项着色，正常项中性 —— 之前橙/红/白/蓝
      // 混用没有规则，是「怪」的另一来源。
      return h('div', { className: 'aw-card', 'data-health': health },
        h('div', { style: { display: 'flex', alignItems: 'flex-start', gap: 'var(--aw-sp-2)' } },
          h('div', { style: { flex: 1, minWidth: 0 } },
            h('h3', null, card.identity?.title ?? card.name),
            h('p', { className: 'aw-path', title: card.path }, card.path)),
          h(Badge, { tone: health }, { ok: '健康', warn: '需关注', bad: '受阻', info: '运行中', idle: '未初始化' }[health] ?? health)),

        h('div', { className: 'aw-cardbody' },
          card.identity?.variant || card.identity?.taskType
            ? h('p', { className: 'aw-path', style: { marginTop: 2 } },
              [card.identity.taskType, card.identity.variant ? `变体 ${card.identity.variant}` : null]
                .filter(Boolean).join(' · '))
            : null,

          card.notTaskRoot === true
            ? h('p', { style: { fontSize: 'var(--aw-fs-sm)', color: 'var(--aw-warn)', margin: 'var(--aw-sp-3) 0 0', lineHeight: 1.6 } }, card.error)
            : h(React.Fragment, null,
              h(Stepper, { currentOrder: order, doneCount: Math.max(0, order - 1) }),

              h('div', { className: 'aw-metrics' },
                h(Metric, {
                  value: `${card.gates?.recommend ?? 0}/${card.gates?.total ?? 0}`,
                  label: '门禁',
                  tone: blocking > 0 ? 'warn' : undefined,
                  boxTone: blocking > 0 ? 'warn' : undefined,
                }),
                h(Metric, {
                  value: String(missing),
                  label: '缺失交付物',
                  tone: missing > 0 ? 'bad' : undefined,
                  boxTone: missing > 0 ? 'bad' : undefined,
                }),
                (codex?.rounds ?? 0) + (seed?.rounds ?? 0) > 0
                  ? h(Metric, {
                    value: `${codex?.rounds ?? 0}+${seed?.rounds ?? 0}`,
                    // 双轨未开跑时如实标明：这些轮次是出题过程记录，
                    // 不是两条长跑。否则「轨迹轮次 9」会被读成双轨已跑过。
                    label: card.dualTrack?.started === false ? '轨迹轮次（双轨未开跑）' : '轨迹轮次',
                    boxTone: card.dualTrack?.started === false ? 'warn' : undefined,
                  })
                  : null,
                codex?.best !== null && codex?.best !== undefined
                  ? h(Metric, { value: String(codex.best), label: 'codex 最佳分' })
                  : null,
                unfinished > 0
                  ? h(Metric, { value: String(unfinished), label: '远端任务', boxTone: 'warn' })
                  : null),

              h(BruRow, { calibration: card.calibration }))),

        h('div', { style: { display: 'flex', gap: 'var(--aw-sp-2)', alignItems: 'center', marginTop: 'var(--aw-sp-3)' } },
          card.notTaskRoot !== true
            ? h('button', { className: 'aw-btn', 'data-kind': 'primary', onClick: () => onOpen(card.path) }, '查看详情')
            : null,
          !card.notTaskRoot && unfinished > 0
            ? h('button', {
              className: 'aw-btn', disabled: probing === true,
              onClick: () => onProbe(card),
            }, probing === true ? '探测中…' : '探测远端')
            : null,
          h('div', { style: { flex: 1 } }),
          card.error !== undefined && card.notTaskRoot !== true ? h(Badge, { tone: 'bad' }, '读取失败') : null,
          typeof card.dualQaVerdict === 'string'
            ? h(Badge, { tone: card.dualQaVerdict === 'PASS' ? 'ok' : 'warn' }, `双路质检 ${card.dualQaVerdict}`)
            : null,
          // 移除入口常驻可见（原来是 hover 才出现的隐藏按钮 —— 违反「不依赖悬停」
          // 且在触屏上完全不可达）。
          typeof onRemove === 'function'
            ? h('button', {
              className: 'aw-btn', 'data-size': 'sm', 'data-kind': 'danger',
              onClick: onRemove,
            }, '移除')
            : null))
    }

    /* ── 任务选择器（详情页入口） ─────────────────────────────────────────── */

    /** 卡片上只展示父级链，完整路径挂在 title 上：长路径换行会把卡片撑得很难看。 */
    function parentPath(path) {
      const parts = String(path).split(/[\\/]/).filter(Boolean)
      if (parts.length <= 1) return String(path)
      const parent = parts.slice(0, -1)
      return parent.length <= 3 ? parent.join('\\') : `…\\${parent.slice(-3).join('\\')}`
    }

    /**
     * 详情页（模式/阶段/门禁/轨迹/双路/远端/证据）都是「某任务」的视图。以前
     * 没选任务时它们静默回退到进程默认根，于是用户点「模式」看到的是一个跟自己
     * 无关的目录 —— 看起来像页面坏了。现在显式要求先选任务。
     */
    function TaskPicker({ onPick, onGotoTasks }) {
      const { data, loading, error } = useApi('/tasks')
      const cards = (data?.cards ?? []).filter((card) => !card.notTaskRoot)
      return h(React.Fragment, null,
        h(Section, {
          title: '先选择一个任务',
          subtitle: '详情页按任务展示。从下面挑一个，或在对话里用 /autoresearch-task <路径> 绑定当前会话',
        }),
        error !== null ? h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error) : null,
        loading && data === null
          ? h('p', { className: 'aw-sub' }, '正在读取任务清单…')
          : (cards.length === 0
            ? h(EmptyState, { title: '还没有可查看的任务' },
              h('p', null, '先到「任务组合」登记一个任务根，或在对话里对当前目录运行 autoresearch_init 创建任务。'),
              h('button', { className: 'aw-btn', 'data-kind': 'primary', onClick: onGotoTasks }, '去登记任务'))
            : h('div', { className: 'aw-grid' },
              cards.map((card) => h('button', {
                key: card.path, className: 'aw-pick', title: card.path, onClick: () => onPick(card.path),
              },
                h('b', null, card.name),
                h('code', null, parentPath(card.path)),
                card.phase?.title !== null && card.phase?.title !== undefined
                  ? h('span', null, `阶段 ${card.phase.order} · ${card.phase.title}`)
                  : h('span', null, '状态未初始化'))))))
    }

    function TasksView({ onOpen }) {
      const { data, loading, error, reload } = useApi('/tasks')
      const [probing, setProbing] = React.useState(null)
      const [adding, setAdding] = React.useState(false)
      const [pathInput, setPathInput] = React.useState('')
      const [scanInput, setScanInput] = React.useState('')
      const [candidates, setCandidates] = React.useState(null)
      const [message, setMessage] = React.useState(null)

      const addPath = async (path) => {
        setAdding(true)
        setMessage(null)
        try {
          await apiPost('/tasks', { action: 'add', path })
          setPathInput('')
          setCandidates(null)
          reload()
        } catch (err) {
          setMessage(err.message)
        } finally {
          setAdding(false)
        }
      }

      const removePath = async (path) => {
        try {
          await apiPost('/tasks', { action: 'remove', path })
          reload()
        } catch (err) {
          setMessage(err.message)
        }
      }

      const scan = async () => {
        if (scanInput.trim() === '') return
        setCandidates('pending')
        try {
          const response = await fetch(`${API}/tasks?scan=${encodeURIComponent(scanInput.trim())}`, { credentials: 'same-origin' })
          const body = await response.json()
          setCandidates(response.ok ? body.candidates : [])
          if (!response.ok) setMessage(body.error ?? '扫描失败')
        } catch (err) {
          setMessage(err.message)
        }
      }

      const probeTask = async (card) => {
        setProbing(card.path)
        try {
          await apiPost('/remote/probe', { task: card.path, all: true })
          reload()
        } catch (err) {
          setMessage(err.message)
        } finally {
          setProbing(null)
        }
      }

      if (loading && data === null) {
        return h('p', { className: 'aw-sub' }, '正在读取任务清单…')
      }
      if (error !== null) {
        return h(EmptyState, { title: '任务清单读取失败' }, h('p', null, error))
      }

      const cards = data?.cards ?? []
      // 「进程默认根」尚未初始化时不是任务：以前它作为一张并列卡片混在任务列表里，
      // 看起来像工作台里真有一个卡住的任务。改成独立提示条，列表里只剩真任务。
      const defaultRoot = data?.defaultTaskRoot ?? null
      const tasks = cards.filter((card) => !(card.notTaskRoot && card.path === defaultRoot))
      const pendingRoot = cards.find((card) => card.notTaskRoot && card.path === defaultRoot) ?? null

      return h(React.Fragment, null,
        h(Section, {
          title: '任务组合',
          subtitle: '一个会话驱动一个任务：在对话里用 /autoresearch-task <路径> 绑定，这里总览全部注册任务',
          right: h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: reload }, '刷新'),
        }),

        h('div', { className: 'aw-formrow' },
          h('span', { className: 'aw-label' }, '任务根路径'),
          h('input', {
            className: 'aw-input', value: pathInput, placeholder: '绝对路径，如 D:\\…\\my-task',
            onChange: (event) => setPathInput(event.target.value),
          }),
          h('button', { className: 'aw-btn', 'data-kind': 'primary', disabled: adding || pathInput.trim() === '', onClick: () => addPath(pathInput.trim()) }, '登记任务'),
          h('span', { className: 'aw-label' }, '或扫描目录'),
          h('input', {
            className: 'aw-input', value: scanInput, placeholder: '父目录，找一级子目录里的任务根',
            onChange: (event) => setScanInput(event.target.value),
          }),
          h('button', { className: 'aw-btn', disabled: scanInput.trim() === '', onClick: scan }, '扫描')),

        candidates === 'pending'
          ? h('p', { className: 'aw-sub' }, '扫描中…')
          : Array.isArray(candidates)
            ? (candidates.length > 0
              ? h('div', { className: 'aw-formrow' },
                h('span', { className: 'aw-label' }, `发现 ${candidates.length} 个候选任务根：`),
                candidates.map((candidate) => h('button', {
                  key: candidate, className: 'aw-btn', 'data-size': 'sm', onClick: () => addPath(candidate),
                }, `+ ${candidate.split(/[\\/]/).pop()}`)))
              : h('p', { className: 'aw-sub' }, '该目录的一级子目录里没有发现任务根（需要 task.toml 或 autoresearch-state.json）。'))
            : null,

        message !== null ? h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, message) : null,

        pendingRoot !== null
          ? h('div', { className: 'aw-hintbar' },
            h(Badge, { tone: 'idle' }, '非任务'),
            h('div', { style: { flex: 1, minWidth: 0 } },
              h('b', null, '进程默认根尚未初始化：'),
              h('code', null, pendingRoot.path),
              h('div', null, '它是工作台进程的启动目录，还不是任务。在对话里对它运行 autoresearch_init 后才会出现在下面的任务列表里。')))
          : null,

        tasks.length === 0
          ? h(EmptyState, { title: '还没有登记任务' },
            h('p', null, '登记一个任务根（或用扫描自动发现）。在对话里对当前任务运行 autoresearch_init 也能创建新任务。'))
          : h('div', { className: 'aw-grid' },
            tasks.map((card) => h(TaskCard, {
              key: card.path, card,
              onOpen, onProbe: probeTask, probing: probing === card.path,
              onRemove: card.path !== defaultRoot
                ? () => removePath(card.path)
                : null,
            }))))
    }

    /* ── 门禁详情弹层 ────────────────────────────────────────────────────── */

    function GateDetail({ gate, task, onClose }) {
      const { data, loading, error } = useApi(withTask(`/gate?gate=${encodeURIComponent(gate)}`, task))
      // Esc 关闭：弹层的最基本退出方式，缺失即不人性化。
      // 同时锁定背景滚动：弹层是 fixed 层，滚轮会穿透到下面的面板。
      React.useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        const previousOverflow = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          window.removeEventListener('keydown', onKey)
          document.body.style.overflow = previousOverflow
        }
      }, [onClose])
      return h('div', { className: 'aw-modal', onClick: onClose },
        h('div', { onClick: (event) => event.stopPropagation() },
          h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 } },
            h('h3', null, gate, data?.title ? h('span', { style: { color: 'var(--aw-ink-2)', fontWeight: 400 } }, ` · ${data.title}`) : null),
            h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: onClose }, '关闭')),
          data?.milestone ? h('p', { className: 'aw-sub' }, `里程碑 ${data.milestone}`) : null,
          data?.verdict !== undefined && data?.verdict !== null ? verdictBadge(data.verdict) : null,
          loading ? h('p', { className: 'aw-sub' }, '加载中…') : null,
          error !== null ? h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error) : null,
          data?.note ? h('p', { className: 'aw-note' }, data.note) : null,
          data?.checks?.length
            ? h('ul', { className: 'aw-list', style: { marginTop: 10 } },
              data.checks.map((item) => h('li', { key: item.id, className: 'aw-row', style: { alignItems: 'flex-start', flexDirection: 'column', gap: 2 } },
                h('div', { style: { display: 'flex', gap: 8, alignItems: 'center' } },
                  verdictBadge(item.status),
                  h('code', null, item.id)),
                h('div', { style: { fontSize: 12.5, color: 'var(--aw-ink)' } }, item.detail),
                item.fix ? h('div', { style: { fontSize: 11.5, color: 'var(--aw-warn)' } }, `修复：${item.fix}`) : null)))
            : null))
    }

    /* ── 工作流模式页 ────────────────────────────────────────────────────── */

    function ModeView({ task }) {
      const { data, loading, error } = useApi(withTask('/mode', task))
      if (loading) return h('p', { className: 'aw-sub' }, '加载中…')
      if (error !== null) return h(EmptyState, { title: '读取失败' }, h('p', null, error))
      if (data === null) return null

      return h(React.Fragment, null,
        h('div', { className: 'aw-box' },
          Stepper({ currentOrder: data.phase.order ?? 1, doneCount: 0 }),
          h('h3', { style: { margin: '10px 0 2px', fontSize: 17 } },
            `阶段 ${data.phase.order ?? '?'}/4 · ${data.phase.title ?? data.phase.id}`),
          h('p', { className: 'aw-sub' }, data.phase.chapter ?? ''),
          h('p', { style: { fontSize: 13, margin: '4px 0 0', lineHeight: 1.6 } }, data.phase.goal ?? ''),
          h('div', { className: 'aw-callobse' }, data.nextAction),
          h('p', { className: 'aw-note' },
            '对话里输入 ', h('span', { className: 'aw-cmd' }, data.enterCommand),
            ' 进入模式；绑定任务用 ', h('span', { className: 'aw-cmd' }, data.bindCommand),
            '；退出用 ', h('span', { className: 'aw-cmd' }, data.exitCommand), '。')),

        h('div', { className: 'aw-kicker' }, '本阶段门禁'),
        h('ul', { className: 'aw-list' },
          data.gates.map((entry) => h('li', { key: entry.gate, className: 'aw-row' },
            verdictBadge(entry.verdict),
            h('code', null, entry.gate),
            h('span', { style: { flex: 1 } }, entry.title),
            h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, entry.milestone)))),

        data.missingRepository.length > 0
          ? h(React.Fragment, null,
            h('div', { className: 'aw-kicker' }, `缺失必需交付物（${data.missingRepository.length}）`),
            h('ul', { className: 'aw-list' },
              data.missingRepository.slice(0, 8).map((item) => h('li', { key: item.path, className: 'aw-row' },
                h('code', { style: { color: 'var(--aw-bad)' } }, item.path),
                item.note ? h('span', { style: { color: 'var(--aw-ink-2)', fontSize: 12 } }, item.note) : null))))
          : h('p', { className: 'aw-note', style: { color: 'var(--aw-ok)' } }, '必需交付物齐备'),

        h('p', { className: 'aw-note' },
          '模式激活后，每步开始前会自动把当前阶段指令注入会话（阶段或门禁状态变化时才注入，避免重复）。'))
    }

    /* ── 四阶段页 ────────────────────────────────────────────────────────── */

    function PhasesView({ overview, onGate }) {
      if (overview === null) return null
      return h(React.Fragment, null,
        overview.phases.map((phase) => h('div', { key: phase.id, className: 'aw-box' },
          h('div', { style: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' } },
            h('h3', { style: { margin: 0, fontSize: 15.5 } }, `${phase.order}. ${phase.title}`),
            h('span', { style: { fontSize: 11.5, color: 'var(--aw-ink-2)' } }, phase.chapter),
            h('div', { style: { flex: 1 } }),
            phase.status === 'current' ? h(Badge, { tone: 'info' }, '进行中')
              : phase.status === 'passed' ? h(Badge, { tone: 'ok' }, '已通过')
                : h(Badge, { tone: 'idle' }, '待开始')),
          h('p', { style: { fontSize: 12.5, color: 'var(--aw-ink-2)', margin: '6px 0 10px', lineHeight: 1.55 } }, phase.goal),

          h('div', { style: { display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 10 } },
            phase.gates.map((entry) => h('button', {
              key: entry.gate, type: 'button', className: 'aw-btn', 'data-size': 'sm',
              onClick: () => onGate(entry.gate),
            }, `${entry.gate} · ${entry.verdict === null ? '未运行' : (TONE_TEXT[entry.verdict] ?? entry.verdict)}`))),

          h('div', { className: 'aw-metrics' },
            h(Metric, { value: `${phase.presentCount}/${phase.totalCount}`, label: '交付物就位', tone: phase.missingRequired.length > 0 ? 'warn' : 'ok' })),

          phase.missingRequired.length > 0
            ? h('ul', { className: 'aw-list', style: { marginTop: 8 } },
              phase.missingRequired.map((item) => h('li', { key: item.path, className: 'aw-row' },
                h('code', { style: { color: 'var(--aw-bad)' } }, item.path))))
            : null,

          h('details', { style: { marginTop: 10 } },
            h('summary', { style: { fontSize: 12, cursor: 'pointer', color: 'var(--aw-ink-2)' } }, `全部交付物（${phase.totalCount}）`),
            h('ul', { className: 'aw-list' },
              phase.deliverables.map((item) => h('li', { key: item.path, className: 'aw-row' },
                h(Badge, { tone: item.status === 'PRESENT' ? 'ok' : (item.required ? 'bad' : 'idle'), dot: false },
                  item.status === 'PRESENT' ? '就位' : (item.required ? '缺失' : '可选')),
                h('code', null, item.path))))))))
    }

    /* ── 轨迹页 ──────────────────────────────────────────────────────────── */

    function TrajectoryView({ task }) {
      const [track, setTrack] = React.useState('codex')
      const { data, loading, error } = useApi(withTask(`/trajectory?track=${track}`, task))
      if (loading) return h('p', { className: 'aw-sub' }, '加载中…')
      if (error !== null) return h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error)

      const stats = data?.stats ?? null
      const dual = data?.dualTrack ?? null
      // 「未出分」不是失败：blocked_no_compute / *_no_run 这类是**诚实标注**的
      // 执行状态。早先一律计成「失败」，实测 AutoRe1852 显示 13/13 全失败 ——
      // 如实标注的人看到全红、谎报 ok 的人显示全绿，激励正好反了。
      const statusEntries = Object.entries(stats?.statusKinds ?? {})

      return h('div', null,
        // 双轨是否真的开跑 —— 放最前，因为「轨迹里有轮次」极易被误读成
        // 「双轨跑完了」。实测 AutoRe1841/1852 的轮次全是出题过程记录。
        dual !== null && dual.started === false
          ? h('div', {
            className: 'aw-box',
            style: { marginBottom: 10, borderLeft: '3px solid var(--aw-warn)', padding: '8px 12px' },
          },
          h('b', { style: { fontSize: 'var(--aw-fs-sm)' } }, '双轨尚未开跑'),
          h('p', {
            style: { margin: '4px 0 0', fontSize: 'var(--aw-fs-xs)', color: 'var(--aw-ink-2)', lineHeight: 1.6 },
          }, `${dual.note} 下方轮次是出题过程记录，不代表两条长程已完成。`))
          : null,
        dual !== null && dual.started === true
          ? h('div', { className: 'aw-box', style: { marginBottom: 10, padding: '8px 12px' } },
            h('b', { style: { fontSize: 'var(--aw-fs-sm)' } }, '双轨已开跑'),
            h('p', { style: { margin: '4px 0 0', fontSize: 'var(--aw-fs-xs)', color: 'var(--aw-ink-2)' } },
              dual.tracks.map((item) => `${item.model ?? item.runtime ?? '?'}：`
                + (item.durationHours === null ? '时长缺失' : `${item.durationHours}h`)).join(' · ')))
          : null,
        // 所有出分轮次其实都是标定常数 ⇒ 这一轨从未产出真实得分。
        data?.calibrationOnly === true
          ? h('div', {
            className: 'aw-box',
            style: { marginBottom: 10, borderLeft: '3px solid var(--aw-bad)', padding: '8px 12px' },
          },
          h('b', { style: { fontSize: 'var(--aw-fs-sm)' } }, '本轮次无真实得分'),
          h('p', {
            style: { margin: '4px 0 0', fontSize: 'var(--aw-fs-xs)', color: 'var(--aw-ink-2)', lineHeight: 1.6 },
          }, '所有带数值的 score 都与该题的标定常数逐位相同（B/R/U 定后不变），'
            + '不是本轮方法的实测得分。下方「最佳分」因此不代表任何实际成绩。'))
          : null,

        h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
          [['codex', 'Codex + GPT-5.6 Sol'], ['seed', 'Codex + Seed 2.1 Turbo']].map(([id, label]) =>
            h('button', {
              key: id, className: 'aw-btn', 'data-size': 'sm', 'data-kind': track === id ? 'primary' : undefined,
              onClick: () => setTrack(id),
            }, label))),
        data === null || data.rounds.length === 0
          ? h(EmptyState, { title: '暂无轮次记录' }, h('p', null, data?.note ?? '在对话里用 autoresearch_trajectory 记录每轮迭代。'))
          : h(React.Fragment, null,
            h('div', { className: 'aw-metrics', style: { marginBottom: 10 } },
              h(Metric, { value: String(stats.total), label: '总轮次' }),
              h(Metric, {
                value: String(stats.scored), label: '出分轮次',
                boxTone: stats.scored === 0 ? 'warn' : undefined,
              }),
              // 中性呈现：如实标注的「未出分」是正常状态，不该染红。
              h(Metric, { value: String(stats.noScore ?? 0), label: '未出分' }),
              stats.failed > 0
                ? h(Metric, { value: String(stats.failed), label: '失败', boxTone: 'bad', tone: 'bad' })
                : null,
              h(Metric, { value: String(stats.bestCount), label: '最佳标记' }),
              h(Metric, {
                value: stats.bestScore === null ? '—' : String(stats.bestScore),
                // 方向未知时不假装能取最佳 —— 如实标出。
                label: stats.direction === null ? '最佳分（方向未知）' : `最佳分（${stats.direction}）`,
                tone: stats.bestScore === null ? undefined : 'ok',
              }),
              h(Metric, { value: stats.latestScore === null ? '—' : String(stats.latestScore), label: '最新分' })),

            // 状态分布：判据保守（只有明确失败才计「失败」），所以把判断材料
            // 一并给出 —— 使用者一眼能看到这些轮次究竟是什么状态。
            statusEntries.length > 0
              ? h('p', { className: 'aw-sub', style: { marginBottom: 8 } },
                '轮次状态：',
                statusEntries.map(([name, count], index) => h('span', { key: name },
                  index > 0 ? ' · ' : '',
                  h('code', { style: { fontFamily: 'var(--aw-mono)', fontSize: 'var(--aw-fs-xs)' } }, name),
                  ` ×${count}`)))
              : null,

            h('div', { className: 'aw-box', style: { padding: 10 } },
              h(MiniBars, { scores: data.rounds.map((round) => (typeof round.score === 'number' ? round.score : null)) })),
            h('div', { className: 'aw-scroll', style: { marginTop: 12 } },
              h('table', { className: 'aw-table' },
                h('thead', null, h('tr', null,
                  TRAJECTORY_COLUMNS.map((column) => h('th', { key: column }, column)))),
                h('tbody', null, data.rounds.map((round) => h('tr', { key: round.round },
                  TRAJECTORY_COLUMNS.map((column) => h('td', { key: column },
                    trajectoryCell(round, column, data.calibrationFlags))))))))))
    }

    /** 轨迹表的列顺序（表头与单元格共用，避免两处漂移）。 */
    const TRAJECTORY_COLUMNS = ['round', 'policy_name', 'status', 'score', 'retained_best', 'time']

    /**
     * 渲染一个轨迹单元格。
     *
     * 抽成函数而不是内联三元链：`score` 列需要「标定常数」标注，
     * 内联后三元嵌套到四层，括号数错一个就整段语法失败（实测踩过）。
     */
    function trajectoryCell(round, column, calibrationFlags) {
      const value = round[column]
      if (value === null || value === undefined) {
        return h('span', { style: { color: 'var(--aw-ink-2)' } }, '—')
      }
      if (column === 'retained_best') {
        return value === true ? h(Badge, { tone: 'ok' }, 'best') : String(value)
      }
      if (column !== 'score') return String(value)

      // score 列：值与该题的标定常数（R 归一化值等）逐位相同时如实标出。
      // 只陈述事实（"等于哪个字段"），不作指控、也不改数据。
      const calibration = calibrationFlags?.[round.round] ?? null
      if (calibration === null) return String(value)
      return h('span', null,
        String(value),
        h('span', {
          title: `该值与 ${calibration} 逐位相同 —— 那是标定常数（B/R/U 定后不变），`
            + '不是本轮方法的实测得分',
          style: { marginLeft: 4, color: 'var(--aw-warn)', fontSize: 'var(--aw-fs-xs)' },
        }, '标定常数?'))
    }

    /** 双路配置器：两路各选路由 + 模型；保存到 DSH_HOME 供 qa_dual 使用。 */
    function LaneConfigurator({ onChanged }) {
      const { data, loading, error, reload } = useApi('/qa/lanes')
      const [draft, setDraft] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [saving, setSaving] = React.useState(false)

      // 首次加载时把保存的两路（或空槽）填进草稿。
      React.useEffect(() => {
        if (data !== null && draft === null) {
          const lanes = data.lanes ?? []
          setDraft([
            { route: lanes[0]?.route ?? '', model: lanes[0]?.model ?? '' },
            { route: lanes[1]?.route ?? '', model: lanes[1]?.model ?? '' },
          ])
        }
      }, [data, draft])

      if (loading && data === null) return h('p', { className: 'aw-sub' }, '加载中…')
      if (error !== null) return h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error)

      const routes = data?.routes ?? []
      const modelsOf = (routeId) => routes.find((entry) => entry.route === routeId)?.models ?? []
      const identityOf = (lane) => `${lane.route}/${lane.model}`

      const same = draft !== null && draft[0].route !== '' && draft[1].route !== ''
        && identityOf(draft[0]) === identityOf(draft[1])

      const update = (index, patch) => {
        const next = [...draft]
        next[index] = { ...next[index], ...patch }
        setDraft(next)
        setMessage(null)
      }

      const save = async () => {
        setSaving(true)
        setMessage(null)
        try {
          const result = await apiPost('/qa/lanes', { lanes: draft })
          setMessage(result.issues?.length > 0
            ? `已保存，但还有问题：${result.issues.join('；')}`
            : '两路配置已保存，可以直接在对话里跑 autoresearch_qa_dual。')
          reload()
          onChanged?.()
        } catch (err) {
          setMessage(`失败：${err.message}`)
        } finally {
          setSaving(false)
        }
      }

      return h('div', { className: 'aw-box' },
        h('div', { className: 'aw-kicker', style: { margin: '0 0 8px' } }, '两路模型配置'),
        routes.length === 0
          ? h('p', { className: 'aw-note', style: { margin: 0 } },
            '还没有声明任何路由 —— 先到「API 配置」页添加端点与密钥。')
          : h(React.Fragment, null,
            h('div', { style: { display: 'flex', gap: 14, flexWrap: 'wrap' } },
              [0, 1].map((index) => h('div', {
                key: index,
                style: {
                  flex: 1, minWidth: 280, border: '1px solid var(--aw-line)', borderRadius: 10, padding: '12px 14px',
                  background: 'var(--aw-bg-deep)',
                },
              },
                h('div', { style: { fontSize: 12.5, fontWeight: 620, marginBottom: 8 } }, `第 ${index + 1} 路`),
                h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap' } },
                  h('select', {
                    className: 'aw-input', style: { minWidth: 140, flex: 1 }, value: draft?.[index]?.route ?? '',
                    onChange: (event) => update(index, { route: event.target.value, model: '' }),
                  },
                    h('option', { value: '' }, '选择路由…'),
                    routes.map((entry) => h('option', {
                      key: entry.route, value: entry.route,
                    }, `${entry.route}${entry.keyPresent === false ? '（密钥缺失）' : ''}`))),
                  h('select', {
                    className: 'aw-input', style: { minWidth: 160, flex: 1 }, value: draft?.[index]?.model ?? '',
                    disabled: (draft?.[index]?.route ?? '') === '',
                    onChange: (event) => update(index, { model: event.target.value }),
                  },
                    h('option', { value: '' }, '选择模型…'),
                    modelsOf(draft?.[index]?.route ?? '').map((model) => h('option', { key: model, value: model }, model)))),
                (() => {
                  const route = routes.find((entry) => entry.route === draft?.[index]?.route)
                  if (route === undefined) return null
                  return h('p', { className: 'aw-note', style: { margin: '8px 0 0' } },
                    `${route.api ?? '?'} @ ${route.baseURL ?? '默认地址'}｜密钥 ${route.keyEnv ?? '—'}`,
                    route.keyPresent === false ? h('span', { style: { color: 'var(--aw-bad)' } }, '（缺失，去 API 配置页补）') : null)
                })()))),

            same
              ? h('p', { className: 'aw-note', style: { color: 'var(--aw-warn)' } },
                '两路身份相同 —— 发布门要求两份报告来自不同 provider/model，请改成不同组合（同一网关的不同路由名也算不同身份）。')
              : null,
            data?.issues?.length > 0
              ? h('ul', { className: 'aw-list', style: { marginTop: 8 } },
                data.issues.map((issue, index) => h('li', { key: index, className: 'aw-row', style: { color: 'var(--aw-warn)', fontSize: 12 } }, issue)))
              : null,

            h('div', { style: { display: 'flex', gap: 8, marginTop: 12, alignItems: 'center' } },
              h('button', {
                className: 'aw-btn', 'data-kind': 'primary',
                disabled: saving || draft === null || draft.some((lane) => lane.route === '' || lane.model === ''),
                onClick: save,
              }, saving ? '保存中…' : '保存两路配置'),
              h('span', { className: 'aw-note', style: { margin: 0 } },
                data?.configured ? `已配置（更新于 ${data.updatedAt ?? '—'}）` : '尚未配置'),
              h('div', { style: { flex: 1 } }),
              h('span', { className: 'aw-note', style: { margin: 0 } },
                '保存后对话里直接说「跑双路质检」，编排器按这份配置起两个隔离会话。'))),

        message !== null
          ? h('p', { className: 'aw-note', style: { color: message.startsWith('失败') ? 'var(--aw-bad)' : 'var(--aw-ok)' } }, message)
          : null)
    }

    /* ── 双路质检页 ──────────────────────────────────────────────────────── */

    function DualQaView({ task, onChanged }) {
      const { data, loading, error } = useApi(withTask('/dual-qa', task))
      const [refreshKey, setRefreshKey] = React.useState(0)

      return h('div', null,
        h(Section, {
          title: '双路独立质检',
          subtitle: '两个隔离会话 + 两个不同身份各出一份报告，fail-closed 聚合；发布门按此判定',
          right: h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: () => setRefreshKey((key) => key + 1) }, '刷新'),
        }),
        h(LaneConfigurator, { key: refreshKey, onChanged }),
        h('div', { style: { height: 8 } }),
        h(DualQaResult, { task, data, loading, error }))
    }

    function DualQaResult({ data, loading, error }) {
      if (loading && data === null) return h('p', { className: 'aw-sub' }, '加载中…')
      if (error !== null) return h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error)
      if (data === null || data.ran !== true) {
        return h(EmptyState, { title: '尚未运行双路质检' },
          h('p', null, data?.note ?? ''),
          h('p', null, '配好上面两路后，在对话里说「跑双路质检」（autoresearch_qa_dual）：编排器会起两个独立 headless 会话，各自只看到同一份 ZIP，产出带来源绑定的报告。'))
      }

      return h(React.Fragment, null,
        h('div', { style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 } },
          h(Badge, { tone: data.releaseGateSatisfied ? 'ok' : 'bad' },
            data.releaseGateSatisfied ? '满足发布门' : '未满足发布门'),
          data.consensus?.status ? h(Badge, { tone: data.consensus.status === 'PASS' ? 'ok' : 'warn' }, `聚合 ${data.consensus.status}`) : null,
          h('span', { style: { fontSize: 12, color: 'var(--aw-ink-2)' } }, `运行于 ${data.ranAt ?? '—'}`)),
        h('p', { className: 'aw-note', style: { marginBottom: 10 } },
          '提交包 SHA-256：', h('code', null, (data.artifactSha256 ?? '—').slice(0, 24)), '…',
          data.skill ? ` · 技能 ${data.skill.name}/${data.skill.version}` : ''),
        h('div', { className: 'aw-scroll' },
          h('table', { className: 'aw-table' },
            h('thead', null, h('tr', null, ['路', 'provider / model', '会话', '结论', 'clean_context', '耗时'].map((column) => h('th', { key: column }, column)))),
            h('tbody', null, (data.lanes ?? []).map((lane) => h('tr', { key: lane.laneIndex },
              h('td', null, String(lane.laneIndex)),
              h('td', null, `${lane.identity?.provider ?? '—'} / ${lane.identity?.model ?? '—'}`),
              h('td', { className: 'aw-mono', style: { fontSize: 11 } }, (lane.identity?.session_id ?? '—').slice(0, 12)),
              h('td', null, lane.decision ?? '未出报告'),
              h('td', null, lane.cleanContext === null ? '—' : (lane.cleanContext ? '是' : '否')),
              h('td', null, `${((lane.durationMs ?? 0) / 1000).toFixed(1)}s`)))))),
        (data.problems ?? []).length > 0
          ? h(React.Fragment, null,
            h('div', { className: 'aw-kicker' }, '未满足项'),
            h('ul', { className: 'aw-list' },
              data.problems.map((problem, index) => h('li', { key: index, className: 'aw-row' },
                h('span', { style: { color: 'var(--aw-bad)', fontSize: 12.5 } }, problem)))))
          : h('p', { className: 'aw-note', style: { color: 'var(--aw-ok)' } }, '两份报告同源、身份两两不同、逐项判定无分歧。'))
    }

    /* ── 远端实验页 ──────────────────────────────────────────────────────── */

    function JobRow({ job, onProbe, probing, showTask }) {
      return h('li', { className: 'aw-row', style: { alignItems: 'flex-start', flexWrap: 'wrap', rowGap: 4 } },
        verdictBadge(job.phase),
        h('code', null, job.jobId),
        h(Badge, { tone: 'idle', dot: false }, job.kind),
        showTask ? h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, `@${showTask}`) : h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, `@${job.targetId}`),
        h('span', { style: { flex: 1 } }),
        h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, `探测 ${job.lastProbeAt ?? '从未'}`),
        onProbe
          ? h('button', { className: 'aw-btn', 'data-size': 'sm', disabled: probing === true, onClick: () => onProbe(job.jobId) },
            probing === true ? '…' : '探测')
          : null,
        job.logTail
          ? h('details', { style: { width: '100%' } },
            h('summary', { style: { fontSize: 11, cursor: 'pointer', color: 'var(--aw-ink-2)' } }, '日志尾'),
            h('div', { className: 'aw-pre' }, job.logTail))
          : null)
    }

    function ScopeToggle({ scope, setScope }) {
      return h('div', { style: { display: 'flex', gap: 6, marginBottom: 12 } },
        h('button', {
          className: 'aw-btn', 'data-size': 'sm', 'data-kind': scope === 'task' ? 'primary' : undefined,
          onClick: () => setScope('task'),
        }, '本任务'),
        h('button', {
          className: 'aw-btn', 'data-size': 'sm', 'data-kind': scope === 'all' ? 'primary' : undefined,
          onClick: () => setScope('all'),
        }, '全部任务'))
    }

    function RemoteView({ task }) {
      const [scope, setScope] = React.useState('task')
      const local = useApi(scope === 'task' ? withTask('/remote', task) : null)
      const aggregate = useApi(scope === 'all' ? '/remote?all=1' : null)
      const [probing, setProbing] = React.useState(null)

      const probeJob = async (jobId) => {
        setProbing(jobId)
        try {
          await apiPost('/remote/probe', { task: task ?? undefined, jobs: [jobId] })
          local.reload()
        } catch { /* 单个失败不影响其它 */ } finally {
          setProbing(null)
        }
      }

      const probeAll = async () => {
        setProbing('__all__')
        try {
          await apiPost('/remote/probe', { task: task ?? undefined, all: true })
          local.reload()
        } finally {
          setProbing(null)
        }
      }

      if (scope === 'all') {
        const tasks = aggregate.data?.tasks ?? []
        return h(React.Fragment, null,
          h(ScopeToggle, { scope, setScope }),
          aggregate.loading && tasks.length === 0
            ? h('p', { className: 'aw-sub' }, '加载中…')
            : tasks.length === 0
              ? h(EmptyState, { title: '没有任何任务登记过远端目标' }, h('p', null, '在对应任务的对话里先用 autoresearch_remote_target 登记。'))
              : tasks.map((entry) => h('div', { key: entry.taskRoot, className: 'aw-box' },
                h('div', { style: { display: 'flex', gap: 10, alignItems: 'center' } },
                  h('strong', { style: { fontSize: 13.5 } }, entry.name),
                  h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, `${entry.targets.length} 目标 · ${entry.jobs.length} 任务`),
                  h('div', { style: { flex: 1 } })),
                entry.jobs.length === 0
                  ? h('p', { className: 'aw-note' }, '无投递记录')
                  : h('ul', { className: 'aw-list' }, entry.jobs.map((job) =>
                    h(JobRow, { key: job.jobId, job, showTask: entry.name }))))),
          aggregate.data?.note ? h('p', { className: 'aw-note' }, aggregate.data.note) : null)
      }

      const data = local.data
      if (local.loading && data === null) return h('p', { className: 'aw-sub' }, '加载中…')
      if (local.error !== null) return h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, local.error)
      if (data === null || data.registered !== true) {
        return h(React.Fragment, null,
          h(ScopeToggle, { scope, setScope }),
          h(EmptyState, { title: '本任务尚未登记远端目标' },
            h('p', null, data?.note ?? 'B/R/U 实验、双轨训练都跑在云 GPU 上。流程：autoresearch_remote_target 登记 → autoresearch_remote_submit 投递自驱动任务（setsid 脱离，SSH 断开不影响）。')))
      }

      const kinds = [...new Set(data.jobs.map((job) => job.kind))].sort()
      const unfinished = data.unfinished.length

      return h(React.Fragment, null,
        h(ScopeToggle, { scope, setScope }),

        h('div', { className: 'aw-metrics', style: { marginBottom: 12 } },
          h(Metric, { value: String(data.targets.length), label: '远端目标' }),
          h(Metric, { value: String(data.jobs.length), label: '累计任务' }),
          h(Metric, { value: String(unfinished), label: '未完成', tone: unfinished > 0 ? 'info' : 'ok' }),
          h(Metric, { value: String(data.snapshots.length), label: '机外快照', tone: data.snapshots.length > 0 ? 'ok' : 'warn' }),
          h('div', { style: { flex: 1 } }),
          unfinished > 0
            ? h('button', { className: 'aw-btn', 'data-kind': 'primary', disabled: probing !== null, onClick: probeAll },
              probing === '__all__' ? '探测中…' : '全部重探')
            : null),

        data.targets.length > 0
          ? h('div', { className: 'aw-formrow', style: { marginTop: 0 } },
            data.targets.map((target) => h(Badge, { key: target.id, tone: 'idle', dot: false },
              `${target.id}：${target.user ? `${target.user}@` : ''}${target.host}${target.port ? `:${target.port}` : ''}`)))
          : null,

        data.jobs.length === 0
          ? h(EmptyState, { title: '没有投递过远端任务' }, h('p', null, '用 autoresearch_remote_submit 投递；kind 标注实验类别（train / build / nop-trial / baseline / reference / upper / qa）便于分组。'))
          : kinds.map((kind) => h('div', { key: kind, className: 'aw-kicker' },
            `${kind}（${data.jobs.filter((job) => job.kind === kind).length}）`,
            h('ul', { className: 'aw-list', style: { marginTop: 4 } },
              data.jobs.filter((job) => job.kind === kind).map((job) =>
                h(JobRow, { key: job.jobId, job, onProbe: probeJob, probing: probing === job.jobId }))))),

        data.snapshots.length === 0
          ? h('p', { className: 'aw-note', style: { color: 'var(--aw-warn)' } },
            '尚无机外快照 —— 教程 M4 要求快照与恢复 probe：机器被回收时，快照决定你能否续接。')
          : h(React.Fragment, null,
            h('div', { className: 'aw-kicker' }, `机外快照（${data.snapshots.length}）`),
            h('ul', { className: 'aw-list' },
              data.snapshots.map((snapshot) => h('li', { key: snapshot.name, className: 'aw-row' },
                h('code', null, snapshot.name),
                h('span', { style: { flex: 1 } }),
                h('span', { style: { fontSize: 11, color: 'var(--aw-ink-2)' } }, `${snapshot.bytes} 字节 · ${snapshot.modified}`))))),
        h('p', { className: 'aw-note' }, data.note))
    }

    /* ── 证据浏览 ────────────────────────────────────────────────────────── */

    function EvidenceView({ task }) {
      const [path, setPath] = React.useState('')
      const [fileContent, setFileContent] = React.useState(null)
      const url = withTask(`/browse?path=${encodeURIComponent(path)}`, task)
      const { data, loading, error } = useApi(url)

      React.useEffect(() => { setFileContent(null) }, [path, task])

      const fileRef = React.useRef(null)
      const openFile = (entryPath) => {
        fetch(withTask(`/browse?path=${encodeURIComponent(entryPath)}`, task), { credentials: 'same-origin' })
          .then((response) => response.json())
          .then((body) => setFileContent(body))
          .catch(() => setFileContent({ error: '读取失败' }))
      }
      // 打开文件后定位到内容：长列表里点完文件内容渲染在视口外，等于没打开。
      React.useEffect(() => {
        if (fileContent !== null) fileRef.current?.scrollIntoView?.({ block: 'nearest' })
      }, [fileContent])

      const crumbs = path === '' ? [] : path.split('/')

      return h('div', null,
        h('div', { style: { display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap', marginBottom: 10, fontSize: 12.5 } },
          h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: () => setPath('') }, '任务根'),
          crumbs.map((part, index) => h(React.Fragment, { key: `${part}-${index}` },
            h('span', { style: { color: 'var(--aw-ink-2)' } }, '/'),
            h('button', {
              className: 'aw-btn', 'data-size': 'sm',
              onClick: () => setPath(crumbs.slice(0, index + 1).join('/')),
            }, part)))),
        loading ? h('p', { className: 'aw-sub' }, '加载中…') : null,
        error !== null ? h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error) : null,
        data?.kind === 'dir'
          ? h('div', { className: 'aw-box', style: { padding: '6px 12px' } },
            h('ul', { className: 'aw-list' },
              data.entries.map((entry) => h('li', { key: entry.path, className: 'aw-row' },
                h('button', {
                  type: 'button',
                  onClick: () => (entry.kind === 'dir' ? setPath(entry.path) : (entry.viewable ? openFile(entry.path) : null)),
                  disabled: entry.kind === 'file' && !entry.viewable,
                  style: {
                    cursor: entry.kind === 'file' && !entry.viewable ? 'default' : 'pointer',
                    border: 'none', background: 'transparent', textAlign: 'left', width: '100%',
                    fontFamily: 'inherit', color: entry.kind === 'dir' ? 'var(--aw-accent)' : 'var(--aw-ink)', fontSize: 13,
                  },
                },
                  entry.kind === 'dir' ? '▸ ' : '  ',
                  entry.name,
                  entry.size !== null && entry.kind === 'file'
                    ? h('span', { style: { color: 'var(--aw-ink-2)', marginLeft: 8, fontSize: 11 } }, `${entry.size} B`) : null)))))
          : null,
        fileContent
          ? h('div', { className: 'aw-box', style: { marginTop: 12 }, ref: fileRef },
            h('div', { style: { display: 'flex', justifyContent: 'space-between', alignItems: 'center' } },
              h('code', { style: { fontSize: 12 } }, fileContent.path),
              h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: () => setFileContent(null) }, '关闭')),
            fileContent.note ? h('p', { className: 'aw-note' }, fileContent.note) : null,
            typeof fileContent.content === 'string'
              ? h('div', { className: 'aw-pre' }, fileContent.content)
              : null)
          : null)
    }

    /* ── API 配置页 ──────────────────────────────────────────────────────── */

    function ApiView({ onChanged }) {
      const { data, loading, error, reload } = useApi('/api')
      const [busy, setBusy] = React.useState(null)
      const [message, setMessage] = React.useState(null)
      const [form, setForm] = React.useState({
        route: '', api: 'openai-completions', baseURL: '', keyEnv: '',
        models: '', apiKey: '', setDefault: false,
      })

      const notify = (text) => setMessage(text)
      const refresh = () => { reload(); onChanged?.() }

      const runAction = async (key, body, okText) => {
        setBusy(key)
        setMessage(null)
        try {
          const result = await apiPost('/api', body)
          notify(typeof okText === 'function' ? okText(result) : okText)
          refresh()
        } catch (err) {
          notify(`失败：${err.message}`)
        } finally {
          setBusy(null)
        }
      }

      if (loading && data === null) return h('p', { className: 'aw-sub' }, '加载中…')
      if (error !== null) return h('p', { className: 'aw-note', style: { color: 'var(--aw-bad)' } }, error)

      const routes = data?.routes ?? []
      const protocols = data?.protocols ?? ['openai-completions', 'openai-responses', 'anthropic-messages']

      return h('div', null,
        h(Section, {
          title: '自定义 API 接入',
          subtitle: '任意 OpenAI 兼容 / Anthropic 兼容端点与任意模型名；密钥只进凭据文档（0600），profile 只保存引用名',
          right: h('button', { className: 'aw-btn', 'data-size': 'sm', onClick: refresh }, '刷新'),
        }),

        h('div', { style: { display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 12 } },
          h(Badge, { tone: 'info' }, `${routes.length} 个路由`),
          data?.defaultModel
            ? h(Badge, { tone: 'ok' }, `默认 ${data.defaultModel.provider} / ${data.defaultModel.model}`)
            : h(Badge, { tone: 'warn' }, '未设默认模型')),

        message !== null
          ? h('p', { className: 'aw-note', style: { color: message.startsWith('失败') ? 'var(--aw-bad)' : 'var(--aw-ok)' } }, message)
          : null,

        h('div', { className: 'aw-box' },
          h('div', { className: 'aw-kicker', style: { margin: '0 0 8px' } }, '添加 / 覆盖路由'),
          h('div', { className: 'aw-formrow', style: { margin: '0 0 8px' } },
            h('span', { className: 'aw-label' }, '路由 id'),
            h('input', {
              className: 'aw-input', style: { minWidth: 150 }, value: form.route, placeholder: 'my-gateway',
              onChange: (event) => setForm({ ...form, route: event.target.value }),
            }),
            h('span', { className: 'aw-label' }, '协议'),
            h('select', {
              className: 'aw-input', style: { minWidth: 170 }, value: form.api,
              onChange: (event) => setForm({ ...form, api: event.target.value }),
            }, protocols.map((protocol) => h('option', { key: protocol, value: protocol }, protocol)))),
          h('div', { className: 'aw-formrow', style: { margin: '0 0 8px' } },
            h('span', { className: 'aw-label' }, '端点地址'),
            h('input', {
              className: 'aw-input', style: { flex: 1 }, value: form.baseURL, placeholder: 'https://api.example.com/v1',
              onChange: (event) => setForm({ ...form, baseURL: event.target.value }),
            })),
          h('div', { className: 'aw-formrow', style: { margin: '0 0 8px' } },
            h('span', { className: 'aw-label' }, '模型（逗号分隔多个）'),
            h('input', {
              className: 'aw-input', style: { flex: 1 }, value: form.models,
              placeholder: 'model-a, model-b；留空 = 保留现有列表',
              onChange: (event) => setForm({ ...form, models: event.target.value }),
            })),
          h('p', { className: 'aw-note', style: { margin: '0 0 8px' } },
            '编辑已有路由时：留空的字段保留现值 —— 只补密钥或加模型都不必重打其它项。'),
          h('div', { className: 'aw-formrow', style: { margin: '0 0 8px' } },
            h('span', { className: 'aw-label' }, '密钥引用名'),
            h('input', {
              className: 'aw-input', style: { minWidth: 180 }, value: form.keyEnv, placeholder: '留空按路由推导',
              onChange: (event) => setForm({ ...form, keyEnv: event.target.value }),
            }),
            h('span', { className: 'aw-label' }, '密钥（明文保存到本机）'),
            h('input', {
              className: 'aw-input', style: { minWidth: 220 }, type: 'password', value: form.apiKey,
              placeholder: '留空 = 保留现有密钥',
              onChange: (event) => setForm({ ...form, apiKey: event.target.value }),
            })),
          h('div', { className: 'aw-formrow', style: { margin: 0 } },
            h('label', { style: { fontSize: 12, display: 'flex', alignItems: 'center', gap: 6 } },
              h('input', {
                type: 'checkbox', checked: form.setDefault,
                onChange: (event) => setForm({ ...form, setDefault: event.target.checked }),
              }), '同时设为默认模型'),
            h('div', { style: { flex: 1 } }),
            h('button', {
              className: 'aw-btn', 'data-kind': 'primary',
              disabled: busy !== null || form.route.trim() === '',
              onClick: () => runAction('add', {
                action: 'add',
                route: form.route.trim(),
                api: form.api,
                baseURL: form.baseURL.trim() === '' ? undefined : form.baseURL.trim(),
                // 空输入 → 空数组 = 保留该路由现有模型列表（编辑密钥/地址时不必重打）。
                models: form.models.split(',').map((item) => item.trim()).filter(Boolean),
                keyEnv: form.keyEnv.trim() === '' ? undefined : form.keyEnv.trim(),
                apiKey: form.apiKey === '' ? undefined : form.apiKey,
                setDefault: form.setDefault,
              }, (result) => [
                `已写入路由 ${result.added}。`,
                result.effectiveModels?.length > 0 ? `当前模型：${result.effectiveModels.join('、')}` : null,
                result.probe ? `端点探测：${result.probe.reachable ? `可达（HTTP ${result.probe.status}）` : `不可达 —— ${result.probe.reason}`}` : null,
                result.keyWritten ? `密钥已明文写入 ${result.credentialsPath ?? '凭据文档'}。` : '未写入密钥（沿用现有值）。',
              ].filter(Boolean).join(' ')),
            }, busy === 'add' ? '写入中…' : '保存路由'))),

        routes.length === 0
          ? h(EmptyState, { title: '尚未声明路由' }, h('p', null, '用上面的表单添加第一个端点；也可以直接用内置「设置 → 模型」页。'))
          : h('div', { className: 'aw-scroll' },
            h('table', { className: 'aw-table' },
              h('thead', null, h('tr', null, ['路由', '协议', '地址', '模型', '密钥', '操作'].map((column) => h('th', { key: column }, column)))),
              h('tbody', null, routes.map((route) => h('tr', { key: route.route },
                h('td', null, h('code', null, route.route)),
                h('td', null, route.api ?? '—'),
                h('td', { className: 'aw-mono', style: { fontSize: 11 } }, route.baseURL ?? '（默认）'),
                h('td', null, route.models.length > 0 ? route.models.join(', ') : '—'),
                h('td', null, route.keyEnv === null ? '—'
                  : h(Badge, { tone: route.keyPresent ? 'ok' : 'bad' }, `${route.keyEnv}${route.keyPresent ? ' 有值' : ' 无值'}`)),
                h('td', null,
                  h('div', { style: { display: 'flex', gap: 4 } },
                    h('button', {
                      className: 'aw-btn', 'data-size': 'sm', disabled: busy !== null,
                      onClick: () => {
                        // 编辑 = 填表：带出当前配置（含多模型逗号列表）。
                        // 密钥留空（不回显），语义是「保留现有密钥」。
                        setForm({
                          route: route.route,
                          api: route.api ?? 'openai-completions',
                          baseURL: route.baseURL ?? '',
                          keyEnv: route.keyEnv ?? '',
                          models: route.models.join(', '),
                          apiKey: '',
                          setDefault: false,
                        })
                        setMessage(`已把 ${route.route} 填入表单：改完点「保存路由」覆盖。密钥留空即保留现有。`)
                      },
                    }, '编辑'),
                    h('button', {
                      className: 'aw-btn', 'data-size': 'sm', disabled: busy !== null,
                      onClick: () => runAction(`probe:${route.route}`, { action: 'probe', route: route.route },
                        (result) => `${route.route} 探测：${result.reachable ? `可达（HTTP ${result.status}）` : `不可达 —— ${result.reason}`}`),
                    }, busy === `probe:${route.route}` ? '…' : '探测'),
                    route.models.length > 0
                      ? h('button', {
                        className: 'aw-btn', 'data-size': 'sm', disabled: busy !== null,
                        onClick: () => runAction(`default:${route.route}`, {
                          action: 'default', provider: route.route, model: route.models[0],
                        }, `默认模型已指向 ${route.route} / ${route.models[0]}。`),
                      }, busy === `default:${route.route}` ? '…' : '设默认')
                      : null,
                    h('button', {
                      className: 'aw-btn', 'data-size': 'sm', 'data-kind': 'danger', disabled: busy !== null,
                      onClick: () => runAction(`remove:${route.route}`, { action: 'remove', route: route.route },
                        `已删除路由 ${route.route}（凭据文档里的密钥保留）。`),
                    }, busy === `remove:${route.route}` ? '…' : '删除')))))))),

        h('p', { className: 'aw-note' },
          '写入只动 DSH_HOME 下的 profile 补丁与凭据文档，不触碰任务目录。主会话重启 harness 后生效；',
          '双路质检每路现读配置，无需重启。'),
        h('p', { className: 'aw-note' },
          '密钥以明文保存在本机（单机使用的有意设计）：',
          h('code', { style: { fontSize: 11 } }, data?.credentialsPath ?? '（路径加载后显示）'),
          '，需要直接查看或编辑时打开该文件；页面不回显密钥本体。'))
    }

    /* ── 主面板 ──────────────────────────────────────────────────────────── */

    /**
     * 标签按**用户意图**分两组，而不是平铺 9 个。
     *
     * 分组的判据是「现在要做什么」而不是「数据来自哪个模块」：
     *   · 推进 —— 跟着四阶段走，看当前该做什么（模式 / 四阶段 / 门禁）
     *   · 核查 —— 跑完之后的取证与复算（轨迹 / 双路质检 / 远端实验 / 证据）
     * 「任务组合」和「API 配置」是全局设置，不属于任何任务，单独放右侧。
     *
     * 顺序沿用工作流顺序，不按重要性排 —— 使用者是按流程走的，不是按热度。
     * `phase` 字段用于在标签上显示阶段归属，让使用者知道自己在流程哪一段。
     */
    const TAB_GROUPS = [
      {
        id: 'progress',
        label: '推进',
        tabs: [
          ['mode', '模式'],
          ['phases', '四阶段'],
          ['gates', '门禁'],
        ],
      },
      {
        id: 'verify',
        label: '核查',
        tabs: [
          ['trajectory', '轨迹'],
          ['dualqa', '双路质检'],
          ['remote', '远端实验'],
          ['evidence', '证据浏览'],
        ],
      },
    ]

    /**
     * 一级入口。`推进` 与 `核查` 各自展开为下面的二级标签，
     * 点一级入口默认落到该组第一页（按工作流顺序，不按热度）。
     */
    const GROUPS = [
      { id: 'progress', label: '推进', tabs: TAB_GROUPS[0].tabs },
      { id: 'verify', label: '核查', tabs: TAB_GROUPS[1].tabs },
    ]

    // 展平后仍是同一份 id → label 映射，供查找标题用。
    const TABS = [
      ['tasks', '任务组合'],
      ...TAB_GROUPS.flatMap((group) => group.tabs),
      ['api', 'API 配置'],
    ]

    // 除「任务组合」和「API 配置」外都是某个任务的视图。未选任务时必须先让用户选，
    // 不能静默回退到进程默认根 —— 那会展示一个与用户无关的目录，看起来像页面坏了。
    const DETAIL_TABS = new Set(TAB_GROUPS.flatMap((group) => group.tabs.map(([id]) => id)))

    // 标签 → 所属分组，用于给内容区加一个阶段说明条。
    const TAB_GROUP_OF = new Map(
      TAB_GROUPS.flatMap((group) => group.tabs.map(([id]) => [id, group.label])))

    function GateCatalogView({ overview, onGate }) {
      if (overview === null) return null
      return h('div', null,
        h('p', { className: 'aw-sub' },
          `Reference 归一化区间 [${overview.calibration.referenceRange[0]}, ${overview.calibration.referenceRange[1]}] · 正向改善需 ≥ ${overview.calibration.requiredSigmaMultiple}σ_B`),
        h('div', { className: 'aw-box', style: { padding: '4px 16px' } },
          h('ul', { className: 'aw-list' },
            overview.gateCatalog.map((entry) => {
              const recorded = overview.phases.flatMap((phase) => phase.gates)
                .find((item) => item.gate === entry.gate)
              return h('li', { key: entry.gate, className: 'aw-row' },
                h('button', {
                  type: 'button', onClick: () => onGate(entry.gate),
                  style: {
                    cursor: 'pointer', border: 'none', background: 'transparent', fontFamily: 'var(--aw-mono)',
                    fontSize: 'var(--aw-fs-sm)', color: 'var(--aw-accent)', padding: 0,
                  },
                }, entry.gate),
                h('span', { style: { flex: 1 } }, entry.title),
                h(Badge, { tone: 'idle', dot: false }, entry.milestone),
                verdictBadge(recorded?.verdict ?? null))
            }))))
    }

    function Panel() {
      const [tab, setTab] = React.useState('tasks')
      const [task, setTask] = React.useState(null)
      const [gate, setGate] = React.useState(null)
      // API 页改动（加路由/删路由）后强制重建双路配置器的下拉选项。
      const [configVersion, setConfigVersion] = React.useState(0)
      // /autoresearch 命令成功后 apply 层广播刷新：绑定/登记的结果立即可见，
      // 而不是只留在对话流里那张折叠的命令卡片里（实测用户完全无感）。
      const [refreshKey, setRefreshKey] = React.useState(0)
      React.useEffect(() => {
        const onRefresh = () => setRefreshKey((value) => value + 1)
        window.addEventListener('autoresearch:refresh', onRefresh)
        return () => window.removeEventListener('autoresearch:refresh', onRefresh)
      }, [])
      // 滚动容器在 .autoresearch-panel 承载层上；切页/换任务后回到顶部，
      // 否则新页面从上个页面留下的滚动位置中间开始 —— 对抗审查发现的第三处。
      const scrollRef = React.useRef(null)
      const contentRef = React.useRef(null)
      React.useEffect(() => {
        scrollRef.current?.scrollTo?.(0, 0)
      }, [tab, task])

      // 未选任务就点详情页 → 先给选择器，而不是偷偷展示进程默认根。
      const needsTask = DETAIL_TABS.has(tab) && task === null

      // 详情页数据源：总览只在阶段/门禁类页面需要，且必须有明确任务；null 表示不请求。
      const overview = useApi(
        (tab === 'phases' || tab === 'gates') && task !== null ? withTask('/overview', task) : null)

      const openTask = (path) => {
        setTask(path)
        setTab('mode')
      }

      // 当前标签的完整路径，用于浏览器式面包屑。
      const tabLabel = TABS.find(([id]) => id === tab)?.[1] ?? tab
      const tabGroupLabel = TAB_GROUP_OF.get(tab) ?? null

      return h('div', { className: 'aw-panel', ref: scrollRef },
        // 键盘用户按一次 Tab 就被问「要不要跳过导航」，不必逐个穿过 9 个标签。
        h('a', {
          className: 'aw-skip', href: '#aw-content',
          onClick: (event) => {
            event.preventDefault()
            contentRef.current?.focus?.()
          },
        }, '跳到内容'),

        h('header', { className: 'aw-head' },
          h('div', { className: 'aw-head-main' },
            h('h2', null, 'AutoResearch 工作台'),
            h('p', { className: 'aw-breadcrumb' },
              task === null ? '未选择任务' : tabGroupLabel === null ? tabLabel : `${tabGroupLabel} / ${tabLabel}`)),
          h('div', { className: 'aw-spacer' }),
          task !== null
            ? h('button', {
              type: 'button', className: 'aw-btn',
              onClick: () => { setTask(null); setTab('tasks') },
            }, '返回任务组合')
            : null),

        task !== null
          ? h('div', { className: 'aw-taskbar' },
            h(Badge, { tone: 'info' }, '查看中的任务'),
            h('code', { title: task }, task),
            h('button', {
              type: 'button', className: 'aw-btn aw-btn-xs',
              title: '复制任务根路径',
              onClick: () => { navigator.clipboard?.writeText?.(task) },
            }, '复制'))
          : null,

        h('nav', { className: 'aw-tabs', 'aria-label': '工作台分区' },
          // 全局入口：不属于任何任务的推进/核查流程。
          h('div', { className: 'aw-tabset' },
            GROUPS.map((group) => h('button', {
              key: group.id,
              type: 'button',
              className: 'aw-tab',
              'data-on': group.tabs.some(([id]) => id === tab) ? '1' : '0',
              'aria-current': group.tabs.some(([id]) => id === tab) ? 'page' : undefined,
              onClick: () => setTab(group.tabs[0][0]),
            }, group.label)),

            h('span', { className: 'aw-tabsep', 'aria-hidden': 'true' }),

            h('button', {
              key: 'tasks', type: 'button', className: 'aw-tab',
              'data-on': tab === 'tasks' ? '1' : '0',
              'aria-current': tab === 'tasks' ? 'page' : undefined,
              onClick: () => setTab('tasks'),
            }, '任务组合'),

            // 二级标签：只显示当前分组下的子页，避免 9 个标签平铺。
            TAB_GROUPS.filter((group) => group.tabs.some(([id]) => id === tab))
              .flatMap((group) => group.tabs)
              .map(([id, label]) => h('button', {
                key: id, type: 'button', className: 'aw-tab aw-tab-sub',
                'data-on': tab === id ? '1' : '0',
                'aria-current': tab === id ? 'page' : undefined,
                onClick: () => setTab(id),
              }, label))),

          h('div', { className: 'aw-spacer' }),
          h('button', {
            key: 'api', type: 'button', className: 'aw-tab',
            'data-on': tab === 'api' ? '1' : '0',
            'aria-current': tab === 'api' ? 'page' : undefined,
            onClick: () => setTab('api'),
          }, 'API 配置')),

        // 内容区包一层：接受跳转链接的焦点，并承载统一的内边距与过渡。
        h('main', {
          id: 'aw-content', ref: contentRef, tabIndex: -1,
          className: 'aw-content', 'aria-live': 'polite',
        },
          tab === 'tasks' ? h(TasksView, { key: `tasks-${refreshKey}`, onOpen: openTask }) : null,
          tab === 'api' ? h(ApiView, { onChanged: () => setConfigVersion((value) => value + 1) }) : null,

          needsTask
            ? h(TaskPicker, {
              onPick: openTask,
              onGotoTasks: () => setTab('tasks'),
            })
            : h(React.Fragment, null,
              tab === 'mode' ? h(ModeView, { key: `mode-${refreshKey}`, task }) : null,
              tab === 'phases' ? h(PhasesView, { overview: overview.data, onGate: setGate }) : null,
              tab === 'gates' ? h(GateCatalogView, { overview: overview.data, onGate: setGate }) : null,
              tab === 'trajectory' ? h(TrajectoryView, { task }) : null,
              tab === 'dualqa' ? h(DualQaView, { key: configVersion, task, onChanged: () => setConfigVersion((value) => value + 1) }) : null,
              tab === 'remote' ? h(RemoteView, { task }) : null,
              tab === 'evidence' ? h(EvidenceView, { task }) : null)),

        gate !== null ? h(GateDetail, { gate, task, onClose: () => setGate(null) }) : null)
    }

    /** 侧边栏面板行图标；面板出现导航入口靠 sidebar.panellist 注册。 */
    function PanelGlyph({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: active ? '#5b8cff' : 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
        h('path', { d: 'M9 3h6M10 3v5.5L4.8 17a3 3 0 0 0 2.6 4.5h9.2a3 3 0 0 0 2.6-4.5L14 8.5V3' }),
        h('path', { d: 'M7.5 14h9' }))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const id = 'dsh-autoresearch-ui-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.dataset.pluginCss = 'dsh-autoresearch-ui'
        style.textContent = STYLESHEET
        document.head.appendChild(style)
        return () => style.remove()
      }, 'autoresearch-ui: styles')

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL,
      }, function AutoResearchPanel(props) {
        return h('div', { className: 'autoresearch-panel' }, h(Panel, props))
      }))

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL,
        order: 20,
        label: 'AutoResearch',
      }, PanelGlyph))

      // /autoresearch 成功后的强反馈：命令的结果文本只会渲染成对话流里一张
      // 折叠的小卡片（实测用户完全无感，认为「啥也没变化」）。这里监听
      // command/executed，把主面板切到工作台并广播刷新 —— 绑定了哪个任务、
      // 登记成功与否，打完命令立刻看得见。
      ctx.on('command/executed', (sessionId, name, result) => {
        if (name !== 'autoresearch' || result?.kind !== 'success') return
        try {
          ctx.layout.selectPanel(PANEL)
        } catch { /* 面板未注册时不切换（不该发生） */ }
        window.dispatchEvent(new CustomEvent('autoresearch:refresh'))
      })
    }

    // layout：命令成功后 selectPanel 切到工作台（未声明 inject 的服务访问会被
    // cordis 拒绝 —— 实测 selectPanel 抛 cannot get property without inject）。
    return { apply, inject: ['slots', 'layout'] }
  },
})
