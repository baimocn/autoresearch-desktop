/**
 * dsh-model-council 的浏览器半边 —— 独立的「模型议会」面板。
 *
 * 与 AutoResearch 工作台完全独立：独立侧边栏入口、独立面板、独立数据源
 * （/api/model-council/*）。它不读任务目录，也不显示任何门禁信息。
 *
 * 两页：
 *   · 议会配置 —— 每路独立设置 地址 / 协议 / 密钥 / 模型（模型靠探测选择）
 *   · 议事厅   —— 对话框：议题 → 开一轮（议员陈述、对抗者攻击）→ 裁决者裁定
 *
 * 可见性协议（见 docs/client-ui.md）：`main` 是 keyed 槽，用户入口必须另注册
 * `sidebar.panellist`，两者 id 必须相同。注册进 main 的页面必须自带滚动容器。
 */
window.__ModuleLoader__.load({
  id: 'dsh-model-council',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    // 成员陈述是模型输出的 markdown（表格、代码块、编号列表很常见），
    // 用 shell 自己的渲染器而不是 pre-wrap 纯文本 —— 否则表格会糊成一行。
    const { MarkdownText } = require('@deepseek-ai/dsh-client-ui-primitives')

    const API = '/api/model-council'
    const PANEL = 'council'

    /**
     * markdown 渲染器的标签文案。**必须是引用稳定的模块级常量**：
     * 每次渲染新建一个对象会让渲染器的缓存失效（其类型声明里写明）。
     */
    const MD_LABELS = Object.freeze({
      code: { copyLabel: '复制', copiedLabel: '已复制' },
      footnotes: '脚注',
    })

    /* ── 样式表 ─────────────────────────────────────────────────────────────
     * 只走 shell 的 --dsw-alias-* 语义变量（深浅主题都成立），回退值按深色调。
     * 前缀 mc- 与工作台的 aw- 完全隔离，两个面板可以同时存在而不互相污染。 */
    const STYLESHEET = `
.model-council-panel{height:100%;overflow-y:auto;overscroll-behavior:contain}
.mc-panel{
  --mc-fs-xs:11px;--mc-fs-sm:12px;--mc-fs-md:13px;--mc-fs-lg:15px;--mc-fs-xl:19px;
  --mc-sp-1:4px;--mc-sp-2:8px;--mc-sp-3:12px;--mc-sp-4:16px;--mc-sp-5:24px;
  --mc-line:var(--dsw-alias-border-l1,#2a2f3a);
  --mc-line-2:var(--dsw-alias-border-l2,#3a4150);
  --mc-bg-1:var(--dsw-alias-bg-layer-1,#171a21);
  --mc-bg-2:var(--dsw-alias-bg-layer-2,#1e222b);
  --mc-text:var(--dsw-alias-label-primary,#e6e9ef);
  --mc-text-2:var(--dsw-alias-label-secondary,#9aa4b6);
  --mc-text-3:var(--dsw-alias-label-caption,#6f7a8c);
  --mc-accent:var(--dsw-alias-state-business-primary,#5b8cff);
  --mc-ok:var(--dsw-alias-state-success-primary,#3fb950);
  --mc-warn:var(--dsw-alias-state-warn-primary,#d29922);
  --mc-bad:var(--dsw-alias-state-error-primary,#f85149);
  --mc-idle:var(--dsw-alias-state-idle-primary,#8b949e);
  --mc-fill-primary:var(--dsw-alias-button-primary-fill,#2f6fed);
  --mc-on-fill:var(--dsw-alias-label-primary-foreground,#ffffff);
  --mc-r-ctl:var(--dsw-radius-sm,7px);--mc-r-box:var(--dsw-radius-lg,12px);
  --mc-mono:var(--dsw-font-markdown-code-block,ui-monospace,SFMono-Regular,Menlo,monospace);
  --mc-sans:var(--dsw-font-family,system-ui,-apple-system,"Segoe UI",sans-serif);
  color:var(--mc-text);font-family:var(--mc-sans);font-size:var(--mc-fs-md);
}
.mc-panel *{box-sizing:border-box}
.mc-head{display:flex;align-items:flex-end;gap:var(--mc-sp-3);flex-wrap:wrap;
  padding:var(--mc-sp-4) var(--mc-sp-5) var(--mc-sp-3);border-bottom:1px solid var(--mc-line)}
.mc-head h2{margin:0;font-size:var(--mc-fs-xl);font-weight:600;letter-spacing:.01em}
.mc-head p{margin:2px 0 0;color:var(--mc-text-3);font-size:var(--mc-fs-sm)}
.mc-spacer{flex:1}
.mc-tabs{display:flex;gap:var(--mc-sp-1);padding:var(--mc-sp-3) var(--mc-sp-5) 0;flex-wrap:wrap}
.mc-cmdbar{display:flex;align-items:center;gap:var(--mc-sp-2);flex-wrap:wrap;
  padding:var(--mc-sp-2) var(--mc-sp-5);border-bottom:1px solid var(--mc-line);
  background:var(--mc-bg-1);font-size:var(--mc-fs-xs)}
.mc-cmdbar code{padding:1px var(--mc-sp-1);border:1px solid var(--mc-line-2);
  border-radius:var(--mc-r-ctl);background:var(--mc-bg-2)}
.mc-tab{min-height:30px;padding:0 var(--mc-sp-3);border:1px solid transparent;border-radius:var(--mc-r-ctl);
  background:transparent;color:var(--mc-text-2);font-size:var(--mc-fs-sm);cursor:pointer;font-family:inherit}
.mc-tab:hover{color:var(--mc-text);background:var(--mc-bg-2)}
.mc-tab[data-on="1"]{color:var(--mc-text);background:var(--mc-bg-2);border-color:var(--mc-line-2)}
.mc-content{padding:var(--mc-sp-4) var(--mc-sp-5) var(--mc-sp-5)}
.mc-btn{min-height:30px;padding:0 var(--mc-sp-3);border:1px solid var(--mc-line-2);border-radius:var(--mc-r-ctl);
  background:var(--mc-bg-2);color:var(--mc-text);font-size:var(--mc-fs-sm);cursor:pointer;font-family:inherit}
.mc-btn:hover{border-color:var(--mc-accent)}
.mc-btn:disabled{opacity:.5;cursor:not-allowed}
.mc-btn-primary{background:var(--mc-fill-primary);color:var(--mc-on-fill);border-color:transparent}
.mc-btn-xs{min-height:26px;padding:0 var(--mc-sp-2);font-size:var(--mc-fs-xs)}
.mc-grid{display:grid;gap:var(--mc-sp-3);grid-template-columns:repeat(auto-fill,minmax(320px,1fr))}
.mc-card{border:1px solid var(--mc-line);border-radius:var(--mc-r-box);background:var(--mc-bg-1);
  padding:var(--mc-sp-3);display:flex;flex-direction:column;gap:var(--mc-sp-2)}
.mc-card-head{display:flex;align-items:center;gap:var(--mc-sp-2)}
.mc-card-head strong{font-size:var(--mc-fs-md)}
.mc-field{display:flex;flex-direction:column;gap:2px}
.mc-field label{font-size:var(--mc-fs-xs);color:var(--mc-text-3)}
.mc-input,.mc-select{min-height:28px;padding:2px var(--mc-sp-2);border:1px solid var(--mc-line-2);
  border-radius:var(--mc-r-ctl);background:var(--mc-bg-2);color:var(--mc-text);font-size:var(--mc-fs-sm);
  font-family:inherit;width:100%}
.mc-input:focus-visible,.mc-select:focus-visible{outline:2px solid var(--mc-accent);outline-offset:1px}
.mc-mono{font-family:var(--mc-mono);font-size:var(--mc-fs-xs)}
.mc-row{display:flex;align-items:center;gap:var(--mc-sp-2);flex-wrap:wrap}
.mc-badge{display:inline-flex;align-items:center;gap:5px;padding:1px var(--mc-sp-2);border-radius:999px;
  border:1px solid var(--mc-line-2);background:var(--mc-bg-2);font-size:var(--mc-fs-xs);color:var(--mc-text-2)}
.mc-dot{width:7px;height:7px;border-radius:50%;flex:none}
.mc-hint{color:var(--mc-text-3);font-size:var(--mc-fs-xs);margin:0}
.mc-box{border:1px solid var(--mc-line);border-radius:var(--mc-r-box);background:var(--mc-bg-1);padding:var(--mc-sp-3)}
.mc-alert{border:1px solid var(--mc-bad);border-radius:var(--mc-r-ctl);padding:var(--mc-sp-2) var(--mc-sp-3);
  color:var(--mc-text);font-size:var(--mc-fs-sm);background:var(--mc-bg-1)}
.mc-alert-ok{border-color:var(--mc-ok)}
.mc-layout{display:grid;grid-template-columns:240px 1fr;gap:var(--mc-sp-4);align-items:start}
.mc-sessions{display:flex;flex-direction:column;gap:var(--mc-sp-1)}
.mc-session{text-align:left;padding:var(--mc-sp-2);border:1px solid transparent;border-radius:var(--mc-r-ctl);
  background:transparent;color:var(--mc-text-2);cursor:pointer;font-family:inherit;font-size:var(--mc-fs-sm)}
.mc-session:hover{background:var(--mc-bg-2)}
.mc-session[data-on="1"]{background:var(--mc-bg-2);border-color:var(--mc-line-2);color:var(--mc-text)}
.mc-session small{display:block;color:var(--mc-text-3);font-size:var(--mc-fs-xs)}
.mc-chat{display:flex;flex-direction:column;gap:var(--mc-sp-3);min-height:320px}
.mc-transcript{display:flex;flex-direction:column;gap:var(--mc-sp-3);
  max-height:60vh;overflow-y:auto;padding-right:var(--mc-sp-1)}
.mc-turn{display:flex;flex-direction:column;gap:var(--mc-sp-1);border-left:3px solid var(--mc-idle);
  padding-left:var(--mc-sp-3)}
.mc-turn[data-tier="councilor"]{border-left-color:var(--mc-accent)}
.mc-turn[data-tier="adversary"]{border-left-color:var(--mc-warn)}
.mc-turn[data-tier="adjudicator"]{border-left-color:var(--mc-ok)}
.mc-turn[data-tier="user"]{border-left-color:var(--mc-text-3)}
.mc-turn[data-kind="error"]{border-left-color:var(--mc-bad)}
.mc-turn-head{display:flex;align-items:center;gap:var(--mc-sp-2);flex-wrap:wrap}
.mc-turn-head .mc-meta{color:var(--mc-text-3);font-size:var(--mc-fs-xs)}
.mc-turn-body{line-height:1.6;font-size:var(--mc-fs-md);color:var(--mc-text)}
.mc-turn-body>:first-child{margin-top:0}
.mc-turn-body>:last-child{margin-bottom:0}
.mc-turn[data-kind="error"] .mc-turn-body{color:var(--mc-bad)}
.mc-composer{display:flex;gap:var(--mc-sp-2);align-items:flex-end}
.mc-composer textarea{flex:1;min-height:56px;resize:vertical;padding:var(--mc-sp-2);
  border:1px solid var(--mc-line-2);border-radius:var(--mc-r-ctl);background:var(--mc-bg-2);
  color:var(--mc-text);font-family:inherit;font-size:var(--mc-fs-sm)}
.mc-empty{border:1px dashed var(--mc-line-2);border-radius:var(--mc-r-box);padding:var(--mc-sp-4);
  color:var(--mc-text-3);font-size:var(--mc-fs-sm);text-align:center}
.mc-kv{display:grid;grid-template-columns:auto 1fr;gap:2px var(--mc-sp-3);font-size:var(--mc-fs-sm)}
.mc-kv dt{color:var(--mc-text-3)}
.mc-kv dd{margin:0}
@media (max-width:760px){.mc-layout{grid-template-columns:1fr}}
`

    /* ── 数据访问 ─────────────────────────────────────────────────────────── */

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

    async function apiSend(path, method, body) {
      const response = await fetch(`${API}${path}`, {
        method,
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      const json = await response.json().catch(() => ({}))
      if (!response.ok) {
        const error = new Error(json.error ?? `HTTP ${response.status}`)
        error.problems = json.problems ?? []
        throw error
      }
      return json
    }

    const apiPost = (path, body) => apiSend(path, 'POST', body ?? {})

    /* ── 共用小件 ─────────────────────────────────────────────────────────── */

    const TIER_COLOR = { councilor: 'var(--mc-accent)', adversary: 'var(--mc-warn)', adjudicator: 'var(--mc-ok)' }

    function TierBadge({ tier, label }) {
      return h('span', { className: 'mc-badge' },
        h('span', { className: 'mc-dot', style: { background: TIER_COLOR[tier] ?? 'var(--mc-idle)' } }),
        label ?? tier)
    }

    function field(label, control) {
      return h('div', { className: 'mc-field' }, h('label', null, label), control)
    }

    /* ── 议会配置 ─────────────────────────────────────────────────────────── */

    const BLANK = {
      id: '', name: '', tier: 'councilor', api: 'openai-completions',
      baseURL: '', model: '', apiKey: '', maxTokens: 1200, timeoutMs: 300000,
    }

    function ConfigView({ config, onSaved }) {
      const [members, setMembers] = React.useState([])
      const [saving, setSaving] = React.useState(false)
      const [message, setMessage] = React.useState(null)
      const [problems, setProblems] = React.useState([])
      // 每路的探测状态与结果：key 是成员在数组中的下标。
      const [probes, setProbes] = React.useState({})

      React.useEffect(() => {
        if (config.data === null) return
        setMembers(config.data.participants.map((item) => ({ ...item, apiKey: '' })))
      }, [config.data])

      const presence = config.data?.keyPresence ?? {}
      const protocols = config.data?.protocols ?? ['openai-completions']
      const tiers = config.data?.tiers ?? []

      const patch = (index, changes) => {
        setMembers((current) => current.map((item, i) => (i === index ? { ...item, ...changes } : item)))
      }

      const addMember = () => {
        setMembers((current) => [...current, { ...BLANK, id: `p${current.length + 1}` }])
      }

      const removeMember = (index) => {
        setMembers((current) => current.filter((_, i) => i !== index))
      }

      const probe = async (index) => {
        const member = members[index]
        setProbes((current) => ({ ...current, [index]: { loading: true } }))
        try {
          const result = await apiPost('/probe', {
            api: member.api, baseURL: member.baseURL,
            apiKey: member.apiKey, keyRef: member.keyRef, headers: member.headers,
          })
          setProbes((current) => ({ ...current, [index]: { loading: false, ...result } }))
          // 探测成功且这一路还没选模型 → 默认选第一个，省一次点击。
          if (result.ok && result.models.length > 0 && (member.model ?? '') === '') {
            patch(index, { model: result.models[0] })
          }
        } catch (error) {
          setProbes((current) => ({ ...current, [index]: { loading: false, ok: false, error: error.message } }))
        }
      }

      const save = async () => {
        setSaving(true)
        setMessage(null)
        setProblems([])
        try {
          const result = await apiPost('/config', { participants: members })
          setMessage(`已保存 ${result.participants.length} 位成员；密钥引用：${result.keyRefs.length} 个`)
          onSaved?.()
        } catch (error) {
          setProblems(error.problems.length > 0 ? error.problems : [error.message])
        } finally {
          setSaving(false)
        }
      }

      const count = (tier) => members.filter((item) => item.tier === tier).length

      if (config.loading && config.data === null) return h('p', { className: 'mc-hint' }, '正在读取议会配置…')
      if (config.error !== null) return h('div', { className: 'mc-alert' }, `读取配置失败：${config.error}`)

      return h('div', null,
        h('div', { className: 'mc-row', style: { marginBottom: 'var(--mc-sp-3)' } },
          h('span', { className: 'mc-badge' },
            h('span', { className: 'mc-dot', style: { background: 'var(--mc-accent)' } }), `议员 ${count('councilor')}`),
          h('span', { className: 'mc-badge' },
            h('span', { className: 'mc-dot', style: { background: 'var(--mc-warn)' } }), `对抗者 ${count('adversary')}`),
          h('span', { className: 'mc-badge' },
            h('span', { className: 'mc-dot', style: { background: 'var(--mc-ok)' } }), `裁决者 ${count('adjudicator')}`),
          h('div', { className: 'mc-spacer' }),
          h('button', { type: 'button', className: 'mc-btn mc-btn-xs', onClick: addMember }, '添加成员'),
          h('button', {
            type: 'button', className: 'mc-btn mc-btn-primary', disabled: saving, onClick: save,
          }, saving ? '保存中…' : '保存议会')),

        h('p', { className: 'mc-hint', style: { marginBottom: 'var(--mc-sp-3)' } },
          '每位成员可独立设置地址、协议与模型（模型点「探测」拉列表再选）。'
          + '密钥写进凭据文档，本页只显示有值/无值。裁决者必须恰好 1 位。'),

        problems.length > 0
          ? h('div', { className: 'mc-alert', style: { marginBottom: 'var(--mc-sp-3)' } },
            h('strong', null, '配置不合法：'),
            h('ul', { style: { margin: '4px 0 0', paddingLeft: '18px' } },
              problems.map((problem, index) => h('li', { key: index }, problem))))
          : null,
        message !== null ? h('div', { className: 'mc-alert mc-alert-ok', style: { marginBottom: 'var(--mc-sp-3)' } }, message) : null,

        members.length === 0
          ? h('div', { className: 'mc-empty' }, '还没有成员。点右上「添加成员」开始配置议会。')
          : h('div', { className: 'mc-grid' }, members.map((member, index) => {
            const probeState = probes[index] ?? {}
            const hasStoredKey = presence[member.id] === true
            return h('div', { key: member.id ?? index, className: 'mc-card' },
              h('div', { className: 'mc-card-head' },
                h('strong', null, `成员 ${index + 1}`),
                h(TierBadge, { tier: member.tier, label: tiers.find((t) => t.id === member.tier)?.label }),
                h('div', { className: 'mc-spacer' }),
                h('button', {
                  type: 'button', className: 'mc-btn mc-btn-xs',
                  title: '移除该成员', onClick: () => removeMember(index),
                }, '移除')),

              h('div', { className: 'mc-row' },
                h('div', { style: { flex: '1 1 120px' } }, field('名称',
                  h('input', {
                    className: 'mc-input', value: member.name, placeholder: '如 议员甲',
                    onChange: (event) => patch(index, { name: event.target.value }),
                  }))),
                h('div', { style: { flex: '1 1 110px' } }, field('身份',
                  h('select', {
                    className: 'mc-select', value: member.tier,
                    onChange: (event) => patch(index, { tier: event.target.value }),
                  }, tiers.map((tier) => h('option', { key: tier.id, value: tier.id }, tier.label)))))),

              h('div', { className: 'mc-row' },
                h('div', { style: { flex: '1 1 130px' } }, field('协议',
                  h('select', {
                    className: 'mc-select', value: member.api,
                    onChange: (event) => patch(index, { api: event.target.value }),
                  }, protocols.map((protocol) => h('option', { key: protocol, value: protocol }, protocol))))),
                h('div', { style: { flex: '2 1 180px' } }, field('地址 baseURL',
                  h('input', {
                    className: 'mc-input mc-mono', value: member.baseURL, placeholder: 'https://…/v1',
                    onChange: (event) => patch(index, { baseURL: event.target.value }),
                  })))),

              field(hasStoredKey ? '密钥（已保存，留空即不修改）' : '密钥',
                h('input', {
                  className: 'mc-input mc-mono', type: 'password', value: member.apiKey,
                  placeholder: hasStoredKey ? '••••••（已保存）' : 'sk-…',
                  onChange: (event) => patch(index, { apiKey: event.target.value }),
                })),

              field('模型（探测后选择）',
                h('div', { className: 'mc-row' },
                  probeState.ok && probeState.models.length > 0
                    ? h('select', {
                      className: 'mc-select', style: { flex: 1 }, value: member.model,
                      onChange: (event) => patch(index, { model: event.target.value }),
                    },
                    h('option', { value: '' }, '— 请选择 —'),
                    probeState.models.map((id) => h('option', { key: id, value: id }, id)))
                    : h('input', {
                      className: 'mc-input mc-mono', style: { flex: 1 }, value: member.model,
                      placeholder: '探测后从列表选择，或手填模型 id',
                      onChange: (event) => patch(index, { model: event.target.value }),
                    }),
                  h('button', {
                    type: 'button', className: 'mc-btn mc-btn-xs',
                    disabled: probeState.loading === true || member.baseURL === '',
                    onClick: () => probe(index),
                  }, probeState.loading ? '探测中…' : '探测模型'))),

              probeState.error !== undefined && probeState.error !== null
                ? h('p', { className: 'mc-hint', style: { color: 'var(--mc-bad)' } },
                  `探测失败：${probeState.error}`)
                : null,
              probeState.ok === true
                ? h('p', { className: 'mc-hint' },
                  `探测到 ${probeState.models.length} 个模型（${probeState.url}）`)
                : null,

              h('div', { className: 'mc-row' },
                h('div', { style: { flex: '1 1 100px' } }, field('最大 tokens',
                  h('input', {
                    className: 'mc-input', type: 'number', min: 1, value: member.maxTokens,
                    onChange: (event) => patch(index, { maxTokens: Number(event.target.value) }),
                  }))),
                h('div', { style: { flex: '1 1 100px' } }, field('超时（毫秒）',
                  h('input', {
                    className: 'mc-input', type: 'number', min: 1000, step: 1000, value: member.timeoutMs,
                    onChange: (event) => patch(index, { timeoutMs: Number(event.target.value) }),
                  })))))
          })),

        h('p', { className: 'mc-hint', style: { marginTop: 'var(--mc-sp-3)' } },
          '密钥文档：', h('code', { className: 'mc-mono' }, config.data?.credentialsPath ?? '（加载后显示）'),
          '，需要直接查看或编辑时打开该文件；本页不回显密钥本体。'))
    }

    /* ── 议事厅 ───────────────────────────────────────────────────────────── */

    function Turn({ entry }) {
      const tierLabelOf = { councilor: '议员', adversary: '对抗者', adjudicator: '裁决者', user: '主持人' }
      return h('div', {
        className: 'mc-turn',
        'data-tier': entry.kind === 'user' ? 'user' : (entry.tier ?? ''),
        'data-kind': entry.kind === 'error' ? 'error' : 'speech',
      },
      h('div', { className: 'mc-turn-head' },
        h(TierBadge, { tier: entry.tier, label: tierLabelOf[entry.kind === 'user' ? 'user' : entry.tier] }),
        h('strong', null, entry.speakerName ?? '成员'),
        entry.kind === 'ruling' ? h('span', { className: 'mc-badge' }, '裁定') : null,
        h('span', { className: 'mc-meta' },
          [entry.model, entry.elapsedMs === undefined ? null : `${(entry.elapsedMs / 1000).toFixed(1)}s`]
            .filter(Boolean).join(' · '))),
      h('div', { className: 'mc-turn-body' },
        h(MarkdownText, { text: entry.text, labels: MD_LABELS, variant: 'compact' })))
    }

    function CouncilView({ onGotoConfig }) {
      const [activeId, setActiveId] = React.useState(null)
      const [topic, setTopic] = React.useState('')
      const [draft, setDraft] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const [tick, setTick] = React.useState(0)

      const sessions = useApi('/sessions')
      const detail = useApi(activeId === null ? null : `/session?id=${encodeURIComponent(activeId)}`)
      const session = detail.data?.session ?? null
      const isRunningNow = session?.running === true

      // 运行中每 1.5s 轮询一次：长任务不能在请求里同步等，页面靠轮询读进度。
      React.useEffect(() => {
        if (!isRunningNow) return undefined
        const timer = setInterval(() => { detail.reload() }, 1500)
        return () => clearInterval(timer)
      }, [isRunningNow, detail])

      const transcriptRef = React.useRef(null)
      React.useEffect(() => {
        const node = transcriptRef.current
        if (node !== null) node.scrollTop = node.scrollHeight
      }, [session?.transcript?.length, activeId])

      const create = async () => {
        setError(null)
        setBusy(true)
        try {
          const result = await apiPost('/session', { topic })
          setActiveId(result.created)
          setTopic('')
          sessions.reload()
          setTick((value) => value + 1)
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }

      const action = async (path, body) => {
        setError(null)
        setBusy(true)
        try {
          await apiPost(path, body)
          detail.reload()
          sessions.reload()
        } catch (caught) {
          setError(caught.message)
        } finally {
          setBusy(false)
        }
      }

      const send = async () => {
        if (draft.trim() === '') return
        await action('/session/say', { id: activeId, text: draft })
        setDraft('')
      }

      const remove = async (id) => {
        setError(null)
        try {
          await apiSend(`/session?id=${encodeURIComponent(id)}`, 'DELETE')
          if (activeId === id) setActiveId(null)
          sessions.reload()
        } catch (caught) {
          setError(caught.message)
        }
      }

      const list = sessions.data?.sessions ?? []

      return h('div', { className: 'mc-layout' },
        h('div', null,
          h('div', { className: 'mc-box', style: { marginBottom: 'var(--mc-sp-3)' } },
            h('strong', { style: { fontSize: 'var(--mc-fs-sm)' } }, '新建会话'),
            h('p', { className: 'mc-hint', style: { margin: '4px 0' } }, '输入议题，议会成员按身份依次发言。'),
            h('textarea', {
              className: 'mc-input', style: { minHeight: '56px', fontFamily: 'inherit' },
              value: topic, placeholder: '要审议的方向或决策问题…',
              onChange: (event) => setTopic(event.target.value),
            }),
            h('button', {
              type: 'button', className: 'mc-btn mc-btn-primary', style: { marginTop: 'var(--mc-sp-2)' },
              disabled: busy || topic.trim() === '', onClick: create,
            }, '创建会话')),

          h('div', { className: 'mc-box' },
            h('strong', { style: { fontSize: 'var(--mc-fs-sm)' } }, `历史会话（${list.length}）`),
            list.length === 0
              ? h('p', { className: 'mc-hint', style: { marginTop: '4px' } }, '还没有会话。')
              : h('div', { className: 'mc-sessions', style: { marginTop: 'var(--mc-sp-2)' } },
                list.map((item) => h('div', { key: item.id, className: 'mc-row' },
                  h('button', {
                    type: 'button', className: 'mc-session', style: { flex: 1 },
                    'data-on': item.id === activeId ? '1' : '0',
                    onClick: () => setActiveId(item.id),
                  },
                  item.topic,
                  h('small', null,
                    `${item.members} 位 · ${item.rounds} 轮 · ${item.entries} 条`
                    + (item.hasRuling ? ' · 已裁定' : '') + (item.status === 'running' ? ' · 运行中' : ''))),
                  h('button', {
                    type: 'button', className: 'mc-btn mc-btn-xs', title: '删除会话',
                    onClick: () => remove(item.id),
                  }, '×')))))),

        activeId === null
          ? h('div', { className: 'mc-empty' },
            '左侧选一个会话，或新建一个。还没有配好议会？',
            h('div', { style: { marginTop: 'var(--mc-sp-2)' } },
              h('button', { type: 'button', className: 'mc-btn', onClick: onGotoConfig }, '去配置议会')))
          : h('div', { className: 'mc-chat' },
            error !== null ? h('div', { className: 'mc-alert' }, error) : null,

            h('div', { className: 'mc-box' },
              h('dl', { className: 'mc-kv' },
                h('dt', null, '议题'), h('dd', null, session?.topic ?? ''),
                h('dt', null, '成员'), h('dd', null, (session?.participants ?? []).map((item) => item.name).join('、')),
                h('dt', null, '轮次'), h('dd', null, String(session?.rounds ?? 0))),
              h('div', { className: 'mc-row', style: { marginTop: 'var(--mc-sp-3)' } },
                h('button', {
                  type: 'button', className: 'mc-btn mc-btn-primary',
                  disabled: busy || isRunningNow, onClick: () => action('/session/round', { id: activeId }),
                }, isRunningNow ? '进行中…' : '开一轮（议员 → 对抗者）'),
                h('button', {
                  type: 'button', className: 'mc-btn',
                  disabled: busy || isRunningNow, onClick: () => action('/session/ruling', { id: activeId }),
                }, '请裁决者裁定'),
                h('button', { type: 'button', className: 'mc-btn', onClick: () => detail.reload() }, '刷新'),
                session?.lastError != null
                  ? h('span', { className: 'mc-hint', style: { color: 'var(--mc-bad)' } }, `上次错误：${session.lastError}`)
                  : null)),

            h('div', { className: 'mc-transcript', ref: transcriptRef },
              (session?.transcript ?? []).length === 0
                ? h('div', { className: 'mc-empty' }, '还没有发言。点「开一轮」让议员与对抗者开始陈述。')
                : (session?.transcript ?? []).map((entry) => h(Turn, { key: entry.seq, entry })),
              session?.current != null
                ? h('p', { className: 'mc-hint' }, `正在等待 ${session.current.name}（${session.current.tier}）发言…`)
                : null),

            h('div', { className: 'mc-composer' },
              h('textarea', {
                value: draft, placeholder: '以主持人身份插入一条发言（会进入议事记录，影响后续发言者）…',
                onChange: (event) => setDraft(event.target.value),
              }),
              h('button', {
                type: 'button', className: 'mc-btn',
                disabled: busy || draft.trim() === '', onClick: send,
              }, '发送'))))
    }

    /* ── 主面板 ───────────────────────────────────────────────────────────── */

    function Panel() {
      const [tab, setTab] = React.useState('council')
      const [version, setVersion] = React.useState(0)
      const config = useApi('/config')
      const scrollRef = React.useRef(null)

      React.useEffect(() => { scrollRef.current?.scrollTo?.(0, 0) }, [tab])

      return h('div', { className: 'mc-panel', ref: scrollRef },
        h('header', { className: 'mc-head' },
          h('div', null,
            h('h2', null, '模型议会'),
            h('p', null, '多模型按身份对抗审议一个方向：议员提案 · 对抗者攻击 · 裁决者定夺')),
          h('div', { className: 'mc-spacer' }),
          h('span', { className: 'mc-badge' }, `成员 ${config.data?.participants?.length ?? 0}`)),

        // 把议会接入普通会话的命令。放在面板上而不是只写进文档 ——
        // 使用者不读文档，但会看这里。
        h('div', { className: 'mc-cmdbar' },
          h('span', { className: 'mc-hint' }, '接入普通会话：'),
          h('code', { className: 'mc-mono' }, '/council'),
          h('span', { className: 'mc-hint' }, '建议式'),
          h('code', { className: 'mc-mono' }, '/council-strict'),
          h('span', { className: 'mc-hint' }, '强制式'),
          h('code', { className: 'mc-mono' }, '/council-off'),
          h('span', { className: 'mc-hint' }, '退出')),

        h('nav', { className: 'mc-tabs', 'aria-label': '议会分区' },
          h('button', {
            type: 'button', className: 'mc-tab', 'data-on': tab === 'council' ? '1' : '0',
            'aria-current': tab === 'council' ? 'page' : undefined,
            onClick: () => setTab('council'),
          }, '议事厅'),
          h('button', {
            type: 'button', className: 'mc-tab', 'data-on': tab === 'config' ? '1' : '0',
            'aria-current': tab === 'config' ? 'page' : undefined,
            onClick: () => setTab('config'),
          }, '议会配置')),

        h('main', { className: 'mc-content' },
          tab === 'config'
            ? h(ConfigView, { key: `config-${version}`, config, onSaved: () => { config.reload(); setVersion((v) => v + 1) } })
            : h(CouncilView, { key: `council-${version}`, onGotoConfig: () => setTab('config') })))
    }

    /** 侧边栏图标：三足鼎（议会）。 */
    function CouncilGlyph({ size, active }) {
      return h('svg', {
        width: size, height: size, viewBox: '0 0 24 24', fill: 'none',
        stroke: active ? '#5b8cff' : 'currentColor',
        strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': 'true',
      },
      h('circle', { cx: 12, cy: 5, r: 2.2 }),
      h('circle', { cx: 5.5, cy: 18, r: 2.2 }),
      h('circle', { cx: 18.5, cy: 18, r: 2.2 }),
      h('path', { d: 'M12 7.2 6.6 15.9M12 7.2l5.4 8.7M7.7 18h8.6' }))
    }

    function apply(ctx) {
      ctx.effect(() => {
        const id = 'dsh-model-council-style'
        if (document.getElementById(id)) return
        const style = document.createElement('style')
        style.id = id
        style.dataset.pluginCss = 'dsh-model-council'
        style.textContent = STYLESHEET
        document.head.appendChild(style)
        return () => style.remove()
      }, 'model-council: styles')

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: PANEL,
      }, function ModelCouncilPanel() {
        return h('div', { className: 'model-council-panel' }, h(Panel))
      }))

      // 侧边栏入口：id 必须等于 main 的 key，否则面板挂载但永远不显示。
      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: PANEL,
        order: 21,
        label: '模型议会',
      }, CouncilGlyph))
    }

    return { apply, inject: ['slots', 'layout'] }
  },
})
