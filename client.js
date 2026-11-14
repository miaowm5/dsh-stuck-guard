/**
 * dsh-stuck-guard 的浏览器半截：在「插件」页的 bundle 详情里画一张配置表单。
 *
 * 为什么需要它：DSH 0.2.2-rc.3 的「设置 → 内置插件」是只读清单，插件自己的配置页
 * 必须由插件的浏览器半截注册（`plugins.bundle.config` 或 `plugins.row.config`）。
 * 只有 Host 半截的插件，`Config` 里声明再多 `.volatile()` 字段也不会有入口。
 *
 * 数据从哪来：宿主 `settings` 的 Remote（`settings/describe` / `settings/update`）。
 * 它按 profile 条目 id 暴露 volatile 字段的当前值和 revision，写入走 compare-and-set，
 * 和插件自己的 `Config` 引用是同一份状态——写成功后宿主重载该行，规则立刻生效。
 *
 * 约束：浏览器半截不允许 require 任何 Harness 客户端包（见 DSH 插件实践），所以表单控件、
 * 样式、字典都写在这里，只用 `--dsw-alias-*` 主题 token。
 *
 * 所有 Remote 调用都在 try/catch 与超时之内：一个插件绝不能把宿主页面弄白。
 */
window.__ModuleLoader__.load({
  id: 'dsh-stuck-guard',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    /** 本插件的字典命名空间。 */
    const NS = 'dsh-stuck-guard'
    /** 配置区挂在 bundle 详情页：key 是包名（plugins.bundle.config 的约定）。 */
    const SLOT = 'plugins.bundle.config'
    const KEY = 'dsh-stuck-guard'
    /** 可能的 settings 命名空间：条目 id 可能是 patch id，也可能是 include:<id>。 */
    const ENTRY_IDS = ['dsh-stuck-guard', 'include:dsh-stuck-guard']
    /** 表单管理的四个字段，全部在 index.js 里声明为 `.volatile()`。 */
    const ALL_FIELDS = ['failureThreshold', 'maxEvidence', 'injectReminder', 'ignoreTools']

    /** 每个字段的形态与取值范围，和 index.js 的 Config 对齐。 */
    const FIELD_SPEC = {
      failureThreshold: { kind: 'number', min: 1, max: 20, fallback: 3 },
      maxEvidence: { kind: 'number', min: 1, max: 8, fallback: 3 },
      injectReminder: { kind: 'boolean', fallback: true },
      ignoreTools: { kind: 'list', fallback: [] },
    }

    /** 客户端服务依赖：槽位、字典、以及承载配置读写的 settings Remote。 */
    const inject = ['slots', 'locale', 'remote', 'remote.settings']

    const zh = {
      title: '配置',
      hint: '连续工具调用失败达到阈值后，把停机检查点注入系统提示。',
      loading: '正在读取配置…',
      retry: '重试',
      absent: '当前 profile 没有为该插件提供可编辑配置，可能装的是没有配置表单的旧版本。',
      readonly: '这份配置为只读，无法从这里保存。',
      error: '读取配置失败：{error}',
      threshold: '触发阈值',
      thresholdDesc: '连续失败多少次后触发一次检查点（1–20）。',
      evidence: '证据条数',
      evidenceDesc: '检查点里最多带几条失败证据（1–8）。',
      ignore: '忽略的工具',
      ignoreDesc: '这些工具的失败不计入连续失败；一行一个名字。',
      ignorePlaceholder: '一行一个工具名，例如 read',
      reminder: '检查点开关',
      reminderDesc: '关掉后只保留协议正文，不再注入停机检查点。',
      reminderName: '启用检查点',
      save: '保存',
      saving: '保存中…',
      saved: '已保存',
      dirty: '有未保存的修改',
      clean: '与当前配置一致',
      invalid: '请先把标红的字段改成合法值。',
      invalidField: '请输入 {min}–{max} 的整数',
      writeFailed: '保存失败：{error}',
      patchOnly: 'enabled / injectProtocol / maxSessions 不在此表单中：需要改 cordis.patch.yml 并重载插件。',
      partial: '{fields} 只能通过 cordis.patch.yml 修改。',
    }

    const en = {
      title: 'Configuration',
      hint: 'After consecutive tool failures reach the threshold, a stop checkpoint is injected into the system prompt.',
      loading: 'Reading configuration…',
      retry: 'Retry',
      absent: 'This profile does not expose editable configuration for this plugin. The installed copy may predate the settings form.',
      readonly: 'This configuration is read-only here.',
      error: 'Could not read the configuration: {error}',
      threshold: 'Trigger threshold',
      thresholdDesc: 'Consecutive failures before a checkpoint (1–20).',
      evidence: 'Evidence lines',
      evidenceDesc: 'How many failure entries a checkpoint may quote (1–8).',
      ignore: 'Ignored tools',
      ignoreDesc: 'Failures of these tools are not counted; one name per line.',
      ignorePlaceholder: 'One tool name per line, for example read',
      reminder: 'Checkpoint',
      reminderDesc: 'When off, only the protocol text stays; no stop checkpoint is injected.',
      reminderName: 'Enable checkpoint',
      save: 'Save',
      saving: 'Saving…',
      saved: 'Saved',
      dirty: 'Unsaved changes',
      clean: 'Matches the current configuration',
      invalid: 'Fix the highlighted fields first.',
      invalidField: 'Enter an integer from {min} to {max}',
      writeFailed: 'Save failed: {error}',
      patchOnly: 'enabled / injectProtocol / maxSessions are not in this form: edit cordis.patch.yml and reload the plugin.',
      partial: '{fields} can only be changed in cordis.patch.yml.',
    }

    const CSS = [
      '.sg{display:flex;flex-direction:column;gap:2px;color:var(--dsw-alias-label-primary);font-size:14px;line-height:1.5}',
      '.sg__head{display:flex;flex-wrap:wrap;align-items:baseline;gap:4px 12px;padding:2px 0 8px}',
      '.sg__title{font-weight:600}',
      '.sg__hint{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sg__row{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:10px 0;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.sg__label{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.sg__label-title{font-weight:500}',
      '.sg__label-desc{color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sg__control{display:flex;flex:0 0 auto;align-items:center;gap:8px}',
      '.sg__input{width:72px;padding:4px 8px;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;font-variant-numeric:tabular-nums}',
      '.sg__input[data-invalid="true"]{border-color:var(--dsw-alias-state-error-primary)}',
      '.sg__input:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.sg__textarea{width:260px;min-height:68px;padding:6px 8px;box-sizing:border-box;border:1px solid var(--dsw-alias-border-l1);border-radius:6px;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);font:inherit;resize:vertical}',
      '.sg__textarea:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:1px}',
      '.sg__switch{position:relative;width:36px;height:20px;margin:0;padding:0;border:1px solid var(--dsw-alias-border-l2);border-radius:999px;background:var(--dsw-alias-bg-layer-2);cursor:pointer;transition:background-color .12s ease,border-color .12s ease}',
      '.sg__switch[data-on="true"]{background:var(--dsw-alias-brand-primary);border-color:var(--dsw-alias-brand-primary)}',
      '.sg__switch:disabled{opacity:.55;cursor:default}',
      '.sg__switch:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.sg__thumb{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;background:var(--dsw-alias-bg-base);transition:transform .12s ease}',
      '.sg__switch[data-on="true"] .sg__thumb{transform:translateX(16px)}',
      '.sg__footer{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:10px 0 2px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.sg__save{padding:4px 14px;border:1px solid var(--dsw-alias-brand-primary);border-radius:6px;background:var(--dsw-alias-brand-primary);color:#fff;font:inherit;font-size:13px;cursor:pointer}',
      '.sg__save[disabled]{opacity:.5;cursor:default}',
      '.sg__save:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}',
      '.sg__status{font-size:12px;color:var(--dsw-alias-label-secondary)}',
      '.sg__status[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.sg__status[data-tone="ok"]{color:var(--dsw-alias-state-success-primary)}',
      '.sg__note{padding-top:8px;color:var(--dsw-alias-label-secondary);font-size:12px}',
      '.sg__skeleton{height:34px;border-top:1px solid var(--dsw-alias-border-l1);background:linear-gradient(90deg,transparent,var(--dsw-alias-bg-layer-2),transparent);background-size:200% 100%;animation:sg-shimmer 1.2s ease-in-out infinite}',
      '@keyframes sg-shimmer{0%{background-position:200% 0}100%{background-position:-200% 0}}',
    ].join('')

    /* ---------------------------------------------------------------- helpers */

    /**
     * Remote 协议回答 `{ ok, value }`。裸服务桩（测试里的假 remote）没有 ok 字段，
     * 原样返回，方便离线自测。
     * @param {any} response
     */
    function unwrap(response) {
      if (response === null || typeof response !== 'object' || typeof response.ok !== 'boolean') return response
      if (!response.ok) {
        const error = response.error
        const message = error !== null && typeof error === 'object' && typeof error.message === 'string'
          ? error.message
          : 'settings request was refused'
        throw new Error(message)
      }
      return response.value
    }

    /**
     * 给 Remote 调用加截止时间：连接尚未就绪时请求会一直挂着，界面不能永远停在 loading。
     * @param {Promise<any>} promise
     * @param {number} ms
     * @param {string} label
     */
    function withTimeout(promise, ms, label) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms} ms`)), ms)
        Promise.resolve(promise).then(
          (value) => { clearTimeout(timer); resolve(value) },
          (error) => { clearTimeout(timer); reject(error) },
        )
      })
    }

    /** @param {unknown} error */
    function describeError(error) {
      if (error === null || error === undefined) return 'unknown error'
      if (typeof error === 'string') return error
      if (typeof error.message === 'string' && error.message !== '') return error.message
      return String(error)
    }

    /**
     * 从 settings 的 schema 投影里收集字段名。投影可能套在 anyOf/oneOf/items 里，
     * 也可能用 `dict`，所以递归找 `properties` / `dict`。
     * @param {unknown} schema
     * @returns {Set<string> | undefined} 空集合视为「没有 schema 信息」。
     */
    function schemaFieldNames(schema) {
      const names = new Set()
      const walk = (node, depth) => {
        if (node === null || typeof node !== 'object' || depth > 6) return
        if (Array.isArray(node)) {
          for (const item of node) walk(item, depth + 1)
          return
        }
        const properties = node.properties
        if (properties !== null && typeof properties === 'object') {
          for (const key of Object.keys(properties)) names.add(key)
        }
        const dict = node.dict
        if (dict !== null && typeof dict === 'object' && !Array.isArray(dict)) {
          for (const key of Object.keys(dict)) names.add(key)
        }
        for (const key of ['anyOf', 'oneOf', 'allOf', 'items', 'additionalProperties']) {
          if (node[key] !== undefined) walk(node[key], depth + 1)
        }
      }
      walk(schema, 0)
      return names.size > 0 ? names : undefined
    }

    /**
     * 在 `settings/describe` 的命名空间里认出本插件的那一条。
     * 先按条目 id 精确匹配，再按 `:dsh-stuck-guard` 后缀、值形态、schema 形态兜底——
     * 绝不按位置取第一条（那是别人的配置）。
     * @param {unknown} namespaces
     */
    function pickNamespace(namespaces) {
      if (!Array.isArray(namespaces)) return undefined
      for (const id of ENTRY_IDS) {
        const exact = namespaces.find(view => view && view.ns === id)
        if (exact !== undefined) return exact
      }
      const suffix = namespaces.find(view => view && typeof view.ns === 'string' && view.ns.endsWith(':dsh-stuck-guard'))
      if (suffix !== undefined) return suffix
      const byValue = namespaces.find((view) => {
        const value = view && view.value
        if (value === null || typeof value !== 'object') return false
        return typeof value.failureThreshold === 'number'
          || typeof value.maxEvidence === 'number'
          || Array.isArray(value.ignoreTools)
      })
      if (byValue !== undefined) return byValue
      return namespaces.find((view) => {
        const names = schemaFieldNames(view && view.schema)
        return names !== undefined && (names.has('failureThreshold') || names.has('maxEvidence'))
      })
    }

    /**
     * 表单实际可编辑的字段：schema 投影给了名单就按名单，否则四个都显示。
     * @param {any} view - settings/describe 里的命名空间视图。
     * @returns {string[]}
     */
    function editableFields(view) {
      const names = schemaFieldNames(view && view && view.schema)
      if (names === undefined) return ALL_FIELDS.slice()
      return ALL_FIELDS.filter(field => names.has(field))
    }

    /**
     * 从 describe 的值里取出四个字段的规范值（缺省走默认值）。
     * @param {unknown} value
     */
    function baselineFrom(value) {
      const source = value !== null && typeof value === 'object' ? value : {}
      const threshold = Number(source.failureThreshold)
      const evidence = Number(source.maxEvidence)
      return {
        failureThreshold: Number.isFinite(threshold) && threshold > 0 ? Math.round(threshold) : FIELD_SPEC.failureThreshold.fallback,
        maxEvidence: Number.isFinite(evidence) && evidence > 0 ? Math.round(evidence) : FIELD_SPEC.maxEvidence.fallback,
        injectReminder: source.injectReminder !== false,
        ignoreTools: Array.isArray(source.ignoreTools) ? source.ignoreTools.filter(name => typeof name === 'string' && name !== '') : [],
      }
    }

    /** @param {unknown} raw */
    function normalizeList(raw) {
      const text = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.join('\n') : ''
      const seen = new Set()
      for (const line of text.split(/\r?\n/)) {
        const name = line.trim()
        if (name !== '') seen.add(name)
      }
      return [...seen].slice(0, 100)
    }

    /**
     * 表单草稿 → 规范值；数字字段无效时返回 invalid 标记。
     * @param {any} draft
     * @param {string[]} fields
     */
    function normalizeDraft(draft, fields) {
      const source = draft !== null && typeof draft === 'object' ? draft : {}
      const value = {}
      const invalid = {}
      for (const field of fields) {
        const spec = FIELD_SPEC[field]
        if (spec === undefined) continue
        if (spec.kind === 'number') {
          const raw = source[field]
          const number = Number(raw)
          const valid = raw !== '' && raw !== undefined && raw !== null
            && Number.isFinite(number) && Number.isInteger(number)
            && number >= spec.min && number <= spec.max
          if (!valid) invalid[field] = true
          else value[field] = number
        } else if (spec.kind === 'boolean') {
          value[field] = source[field] !== false
        } else {
          value[field] = normalizeList(source[field])
        }
      }
      return { value, invalid: Object.keys(invalid).length > 0 ? invalid : null }
    }

    /** @param {unknown} draft */
    function draftFrom(value) {
      const base = baselineFrom(value)
      return {
        failureThreshold: String(base.failureThreshold),
        maxEvidence: String(base.maxEvidence),
        injectReminder: base.injectReminder,
        ignoreTools: base.ignoreTools.join('\n'),
      }
    }

    /** @param {string[]} a @param {string[]} b */
    function sameList(a, b) {
      if (a.length !== b.length) return false
      for (let index = 0; index < a.length; index += 1) if (a[index] !== b[index]) return false
      return true
    }

    /** @param {string} field */
    function sameField(field, a, b) {
      if (Array.isArray(a) && Array.isArray(b)) return sameList(a, b)
      return a === b
    }

    /* ------------------------------------------------------------------ store */

    const store = {
      /** 'loading' | 'ready' | 'absent' | 'error' */
      phase: 'loading',
      /** 最近一次成功读取的命名空间、revision、可写标记。 */
      ns: undefined,
      revision: undefined,
      writable: false,
      /** 宿主投影的当前值。 */
      value: {},
      /** 表单草稿（数字存成字符串，便于编辑）。 */
      draft: undefined,
      /** schema 明确支持的字段；空数组时相关控件不显示。 */
      fields: ALL_FIELDS.slice(),
      /** 读取失败的原因。 */
      error: '',
      /** '' | 'invalid' | 'failed' */
      writeError: '',
      writeDetail: '',
      busy: false,
      saved: false,
    }

    const listeners = new Set()
    let refreshPending = undefined

    function emit() {
      for (const listener of [...listeners]) {
        try { listener() } catch {}
      }
    }

    /** @param {() => void} listener */
    function subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }

    /**
     * 读一次配置。并发调用合并成一次，避免页面里多个入口同时打 describe。
     * @param {{settings: {describe: () => Promise<any>}}} remote
     */
    function refresh(remote) {
      if (refreshPending !== undefined) return refreshPending
      const run = (async () => {
        store.phase = 'loading'
        emit()
        try {
          const result = unwrap(await withTimeout(remote.settings.describe(), 6000, 'settings/describe'))
          const view = pickNamespace(result && result.namespaces)
          if (view === undefined) {
            store.phase = 'absent'
            store.ns = undefined
            store.revision = undefined
            store.draft = undefined
            store.value = {}
            store.error = ''
            emit()
            return
          }
          store.phase = 'ready'
          store.ns = view.ns
          store.revision = typeof view.revision === 'number' ? view.revision : undefined
          store.writable = !(result && result.writable === false)
          store.value = view.value !== null && typeof view.value === 'object' ? view.value : {}
          store.fields = editableFields(view)
          store.draft = draftFrom(store.value)
          store.error = ''
          store.writeError = ''
          store.writeDetail = ''
          store.saved = false
        } catch (error) {
          store.phase = 'error'
          store.error = describeError(error)
        }
        emit()
      })()
      refreshPending = run
      return run.finally(() => { refreshPending = undefined })
    }

    /**
     * 只提交改动过的字段。revision 是 compare-and-set 的依据；别人先写过时宿主拒绝，
     * 这里读回最新值并把原因交给界面，而不是假装成功。
     * @param {{settings: {update: (ns: string, patch: object, revision?: number) => Promise<any>}}} remote
     */
    async function save(remote) {
      if (store.phase !== 'ready' || !store.writable || store.busy || store.draft === undefined) return
      const { value, invalid } = normalizeDraft(store.draft, store.fields)
      if (invalid !== null) {
        store.writeError = 'invalid'
        store.writeDetail = ''
        store.saved = false
        emit()
        return
      }
      const base = baselineFrom(store.value)
      const patch = {}
      for (const field of store.fields) {
        if (field in value && !sameField(field, value[field], base[field])) patch[field] = value[field]
      }
      if (Object.keys(patch).length === 0) {
        store.writeError = ''
        store.writeDetail = ''
        store.saved = true
        emit()
        return
      }
      store.busy = true
      store.writeError = ''
      store.writeDetail = ''
      emit()
      try {
        unwrap(await withTimeout(remote.settings.update(store.ns, patch, store.revision), 15000, 'settings/update'))
        store.busy = false
        await refresh(remote)
        store.saved = true
        emit()
      } catch (error) {
        store.busy = false
        const detail = describeError(error)
        // 先重读拿最新 revision，再把原因写回：refresh 会清掉 writeError。
        await refresh(remote)
        store.writeError = 'failed'
        store.writeDetail = detail
        emit()
      }
    }

    /* -------------------------------------------------------------------- UI */

    /**
     * 一行配置：左边标题 + 说明，右边控件。
     * @param {{ t: any, field: string, title: string, desc: string, control: any, invalid?: boolean }} options
     */
    function row(options) {
      return h('div', { className: 'sg__row', key: options.field },
        h('div', { className: 'sg__label' },
          h('span', { className: 'sg__label-title' }, options.title),
          h('span', { className: 'sg__label-desc' }, options.desc),
        ),
        h('div', { className: 'sg__control' }, options.control),
      )
    }

    /** 表单组件。owner props 里的 view 用于兼容 summary 视图。 */
    function StuckGuardConfig(props) {
      const t = props.t
      const remote = props.remote
      const [, force] = React.useState(0)

      React.useEffect(() => {
        const unsubscribe = subscribe(() => force(value => value + 1))
        if (store.phase !== 'ready') void refresh(remote)
        return unsubscribe
      }, [])

      if (props.view === 'summary') return null

      if (store.phase === 'loading' || store.draft === undefined) {
        return h('div', { className: 'sg' },
          h('div', { className: 'sg__status' }, t('loading')),
          h('div', { className: 'sg__skeleton' }),
          h('div', { className: 'sg__skeleton' }),
        )
      }

      if (store.phase === 'error') {
        return h('div', { className: 'sg' },
          h('div', { className: 'sg__status', 'data-tone': 'error' }, t('error', { error: store.error })),
          h('div', { className: 'sg__footer', style: { borderTop: '0', paddingTop: '4px' } },
            h('button', {
              type: 'button', className: 'sg__save', onClick: () => void refresh(remote),
            }, t('retry')),
          ),
        )
      }

      if (store.phase === 'absent') {
        return h('div', { className: 'sg' },
          h('div', { className: 'sg__status' }, t('absent')),
          h('div', { className: 'sg__footer', style: { borderTop: '0', paddingTop: '4px' } },
            h('button', {
              type: 'button', className: 'sg__save', onClick: () => void refresh(remote),
            }, t('retry')),
          ),
        )
      }

      const draft = store.draft
      const fields = store.fields
      const { invalid } = normalizeDraft(draft, fields)
      const base = baselineFrom(store.value)
      const normalized = normalizeDraft(draft, fields).value
      const dirty = fields.some(field => !sameField(field, normalized[field], base[field]))
      const disabled = store.busy || !store.writable

      const setDraft = (field, value) => {
        store.draft = { ...store.draft, [field]: value }
        store.saved = false
        if (store.writeError === 'invalid') {
          store.writeError = ''
          store.writeDetail = ''
        }
        emit()
      }

      const status = (() => {
        if (store.writeError === 'invalid') return { text: t('invalid'), tone: 'error' }
        if (store.writeError === 'failed') return { text: t('writeFailed', { error: store.writeDetail }), tone: 'error' }
        if (!store.writable) return { text: t('readonly'), tone: '' }
        if (store.busy) return { text: t('saving'), tone: '' }
        if (store.saved) return { text: t('saved'), tone: 'ok' }
        if (dirty) return { text: t('dirty'), tone: '' }
        return { text: t('clean'), tone: '' }
      })()

      const rows = []
      if (fields.includes('failureThreshold')) {
        rows.push(row({
          field: 'failureThreshold',
          title: t('threshold'),
          desc: t('thresholdDesc'),
          invalid: Boolean(invalid && invalid.failureThreshold),
          control: h('div', { className: 'sg__control' },
            h('input', {
              type: 'number',
              inputMode: 'numeric',
              min: FIELD_SPEC.failureThreshold.min,
              max: FIELD_SPEC.failureThreshold.max,
              step: 1,
              className: 'sg__input',
              'data-invalid': String(Boolean(invalid && invalid.failureThreshold)),
              'aria-label': t('threshold'),
              disabled,
              value: draft.failureThreshold,
              onChange: event => setDraft('failureThreshold', event.target.value),
            }),
            invalid && invalid.failureThreshold
              ? h('span', { className: 'sg__status', 'data-tone': 'error' },
                t('invalidField', { min: FIELD_SPEC.failureThreshold.min, max: FIELD_SPEC.failureThreshold.max }))
              : null,
          ),
        }))
      }
      if (fields.includes('maxEvidence')) {
        rows.push(row({
          field: 'maxEvidence',
          title: t('evidence'),
          desc: t('evidenceDesc'),
          control: h('div', { className: 'sg__control' },
            h('input', {
              type: 'number',
              inputMode: 'numeric',
              min: FIELD_SPEC.maxEvidence.min,
              max: FIELD_SPEC.maxEvidence.max,
              step: 1,
              className: 'sg__input',
              'data-invalid': String(Boolean(invalid && invalid.maxEvidence)),
              'aria-label': t('evidence'),
              disabled,
              value: draft.maxEvidence,
              onChange: event => setDraft('maxEvidence', event.target.value),
            }),
            invalid && invalid.maxEvidence
              ? h('span', { className: 'sg__status', 'data-tone': 'error' },
                t('invalidField', { min: FIELD_SPEC.maxEvidence.min, max: FIELD_SPEC.maxEvidence.max }))
              : null,
          ),
        }))
      }
      if (fields.includes('injectReminder')) {
        const checked = draft.injectReminder !== false
        rows.push(row({
          field: 'injectReminder',
          title: t('reminder'),
          desc: t('reminderDesc'),
          control: h('button', {
            type: 'button',
            role: 'switch',
            'aria-checked': checked ? 'true' : 'false',
            'aria-label': t('reminderName'),
            className: 'sg__switch',
            'data-on': String(checked),
            disabled,
            onClick: () => setDraft('injectReminder', !checked),
          }, h('span', { className: 'sg__thumb' })),
        }))
      }
      if (fields.includes('ignoreTools')) {
        rows.push(h('div', { className: 'sg__row', key: 'ignoreTools' },
          h('div', { className: 'sg__label' },
            h('span', { className: 'sg__label-title' }, t('ignore')),
            h('span', { className: 'sg__label-desc' }, t('ignoreDesc')),
          ),
          h('div', { className: 'sg__control' },
            h('textarea', {
              className: 'sg__textarea',
              rows: 3,
              'aria-label': t('ignore'),
              placeholder: t('ignorePlaceholder'),
              disabled,
              value: draft.ignoreTools,
              onChange: event => setDraft('ignoreTools', event.target.value),
            }),
          ),
        ))
      }

      const hidden = ALL_FIELDS.filter(field => !fields.includes(field))

      return h('div', { className: 'sg' },
        h('div', { className: 'sg__head' },
          h('span', { className: 'sg__title' }, t('title')),
          h('span', { className: 'sg__hint' }, t('hint')),
        ),
        rows,
        h('div', { className: 'sg__footer' },
          h('button', {
            type: 'button',
            className: 'sg__save',
            disabled: disabled || invalid !== null || !dirty,
            onClick: () => void save(remote),
          }, store.busy ? t('saving') : t('save')),
          h('span', { className: 'sg__status', 'data-tone': status.tone }, status.text),
        ),
        hidden.length > 0
          ? h('div', { className: 'sg__note' }, t('partial', { fields: hidden.join(' / ') }))
          : null,
        h('div', { className: 'sg__note' }, t('patchOnly')),
      )
    }

    /* ----------------------------------------------------------------- apply */

    /**
     * 注册字典、样式和配置区。
     * @param {any} ctx - Client 根上下文。
     */
    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, 'zh-CN': zh, en }), 'dsh-stuck-guard: dictionaries')
      const t = ctx.locale.bind(NS)

      ctx.effect(() => {
        if (typeof document === 'undefined' || document.head === null) return
        const selector = 'style[data-plugin-css="dsh-stuck-guard/config"]'
        if (document.querySelector(selector) !== null) return
        const tag = document.createElement('style')
        tag.dataset.plugin = 'dsh-stuck-guard'
        tag.dataset.pluginCss = 'dsh-stuck-guard/config'
        tag.textContent = CSS
        document.head.appendChild(tag)
        return () => tag.remove()
      }, 'dsh-stuck-guard: config styles')

      const remote = ctx.remote
      try {
        ctx.slots.inject(SLOT, () => ctx.slots.register({
          name: SLOT,
          key: KEY,
          locale: NS,
        }, (ownerProps) => h(StuckGuardConfig, { ...ownerProps, remote, t })))
      } catch (error) {
        ctx.logger?.warn?.('dsh-stuck-guard: config page not registered: %s', describeError(error))
      }
    }

    return {
      inject,
      apply,
      // 离线自测入口（不参与运行时逻辑）。
      __test: {
        store,
        refresh,
        save,
        pickNamespace,
        unwrap,
        schemaFieldNames,
        editableFields,
        normalizeList,
        normalizeDraft,
        draftFrom,
        baselineFrom,
        FIELD_SPEC,
      },
    }
  },
})
