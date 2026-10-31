window.__ModuleLoader__.load({
  id: 'dsh-desktop-settings',
  factory: (require) => {
    const React = require('react')
    const { createElement: h, useEffect, useRef, useState } = React
    const { SegmentedControl, Tooltip, Menu, MenuItemButton, Modal, IconSettingsOutlineRegular, IconChecklistOutlineRegular, IconChecklistOutlineMedium, IconPaperPlaneOutlineMedium, IconAlarmClockOutlineMedium, IconGaugeOutlineMedium, IconApiOutlineMedium, IconInfoOutlineMedium, IconUserOutlineMedium, IconChevronDownOutlineRegular, IconCloseOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const NS = 'desktop.settings'
    const COPY = {
      zh: {
        accountMenu: '账号菜单', enterpriseAccount: '企业账号', signedOut: '未登录', deviceOnly: '本机模式', signInHint: '登录后可使用企业功能', identityLoading: '正在读取账号…', identityError: '暂时无法读取账号', settings: '设置', accountSettings: '账号设置', approvals: '消息', approvalsPending: '待处理审批', phone: '连接手机', login: '登录企业账号', logout: '退出登录', logoutBody: '退出后需要重新登录企业账号。本机设置、已安装插件和本地数据保留。', logoutFailed: '退出登录未完成，请重试。', cancel: '取消', again: '重试', close: '关闭', loggingOut: '正在退出登录…',
        creditsRemaining: '剩余积分', creditsUnavailable: '积分暂不可用',
        activity: '用量活动', period: '统计范围：{start} — {end}', less: '少', more: '多', totalTokens: '累计 Token', totalMessages: '累计消息',
        tokenWan: '{value}万', tokenYi: '{value}亿', numberLocale: 'zh-CN', modelUsage: '模型用量', tokens: 'Token 用量', messages: '消息数', storage: '个人存储空间', unlimited: '不限', storageValue: '已使用 {used} / {limit}', breakdown: '输入 {input} Token · 输出 {output} Token', missingUsage: '{count} 条记录缺少 Token 用量', usageError: '用量统计加载失败，请重试。', storageError: '存储空间加载失败，请重试。', noUsage: '暂无用量记录', unavailable: '—',
        openContent: '进入设置内容', usage: '用量与存储', about: '关于与帮助', tasks: '我的审批', requests: '我的申请', notifications: '通知', ai: 'AI 助手接入', loading: '正在加载企业设置…', error: '暂时无法加载企业设置，请检查连接后重试。', restart: '请完全退出并重新启动客户端，以启用统一设置。', unsupported: '平台暂不支持统一设置，请联系管理员更新平台。', retry: '重新连接', signIn: '登录企业账号后可查看', openAccount: '前往账号设置', desktopVersion: 'BISHENG 版本', harnessVersion: 'Harness 版本', infoError: '无法读取版本信息', update: '检查更新', logs: '查看日志', recovery: '安全模式与插件恢复', localHint: '本机设置仍可正常使用。', actionError: '操作未完成，请重试。',
      },
      en: {
        accountMenu: 'Account menu', enterpriseAccount: 'Enterprise account', signedOut: 'Not signed in', deviceOnly: 'Device only', signInHint: 'Sign in to use enterprise features', identityLoading: 'Loading account…', identityError: 'Account unavailable', settings: 'Settings', accountSettings: 'Account settings', approvals: 'Messages', approvalsPending: 'Pending approvals', phone: 'Connect phone', login: 'Sign in', logout: 'Log out', logoutBody: 'You will need to sign in again. Device settings, installed plugins and local data are kept.', logoutFailed: 'Logout did not complete. Try again.', cancel: 'Cancel', again: 'Retry', close: 'Close', loggingOut: 'Logging out…',
        creditsRemaining: 'Credits remaining', creditsUnavailable: 'Credits unavailable',
        activity: 'Usage activity', period: 'Reporting period: {start} — {end}', less: 'Less', more: 'More', totalTokens: 'Total tokens', totalMessages: 'Total messages',
        tokenWan: '{value} ten thousand', tokenYi: '{value} hundred million', numberLocale: 'en-US', modelUsage: 'Model usage', tokens: 'Token usage', messages: 'Messages', storage: 'Personal storage', unlimited: 'Unlimited', storageValue: 'Used {used} / {limit}', breakdown: 'Input {input} tokens · Output {output} tokens', missingUsage: '{count} records are missing token usage', usageError: 'Usage statistics failed to load. Please retry.', storageError: 'Storage failed to load. Please retry.', noUsage: 'No usage recorded', unavailable: '—',
        openContent: 'Enter settings content', usage: 'Usage and storage', about: 'About and help', tasks: 'My approvals', requests: 'My requests', notifications: 'Notifications', ai: 'AI assistant access', loading: 'Loading enterprise settings…', error: 'Enterprise settings could not load. Check the connection and try again.', restart: 'Quit and restart the desktop app to enable unified settings.', unsupported: 'This platform does not support unified settings yet. Ask your administrator to update it.', retry: 'Reconnect', signIn: 'Sign in to view enterprise settings', openAccount: 'Open account settings', desktopVersion: 'BISHENG version', harnessVersion: 'Harness version', infoError: 'Could not read version information', update: 'Check for updates', logs: 'Show logs', recovery: 'Safe Mode and plugin recovery', localHint: 'Device settings remain available.', actionError: 'The action did not complete. Try again.',
      }
    }
    const openAccount = () => window.dispatchEvent(new CustomEvent('dsh-desktop:open-settings-section', { detail: { id: 'enterprise-account' } }))

    /** The approvals rail is a vertical list, so it answers the up/down keys the settings nav uses. */
    function navigateSections(event, ids, active, select, refs) {
      if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key) || !ids.length) return
      event.preventDefault()
      const index = Math.max(0, ids.indexOf(active))
      const next = ids[event.key === 'Home' ? 0 : event.key === 'End' ? ids.length - 1 : (index + (event.key === 'ArrowUp' ? -1 : 1) + ids.length) % ids.length]
      select(next); refs.current[next]?.focus()
    }

    /** A single surface owner feeds geometry to the existing Chat/Work presenter. */
    function RemoteSettings({ section, t }) {
      const target = useRef(null)
      const [state, setState] = useState({ phase: 'idle', connected: false })
      const [failed, setFailed] = useState(false)
      const alive = useRef(true)
      useEffect(() => {
        const bridge = window.dshEnterpriseChat
        if (!bridge) return
        alive.current = true
        let disposed = false, revision = 0
        const receive = next => { revision++; if (!disposed) setState(next) }
        const unsubscribe = bridge.subscribe(receive)
        const request = revision
        void bridge.state().then(next => { if (!disposed && request === revision) receive(next) }).catch(() => { if (!disposed && request === revision) setFailed(true) })
        return () => { disposed = true; alive.current = false; unsubscribe() }
      }, [])
      useEffect(() => {
        if (!state.connected || state.settingsProtocolVersion !== 1 || !target.current) return
        const token = `${section}:${Math.random()}`
        const node = target.current
        const publish = () => {
          const rect = node.getBoundingClientRect()
          const clip = node.closest('[data-dsh-settings-content], [data-dsh-approvals-content]')?.getBoundingClientRect() || rect
          const x = Math.max(rect.x, clip.x), y = Math.max(rect.y, clip.y)
          window.dispatchEvent(new CustomEvent('dsh-desktop:settings-surface', { detail: { token, section, bounds: { x: Math.max(0, x), y: Math.max(0, y), width: Math.max(0, Math.min(rect.right, clip.right) - x), height: Math.max(0, Math.min(rect.bottom, clip.bottom) - y) } } }))
        }
        const resize = new ResizeObserver(publish)
        resize.observe(node)
        const clip = node.closest('[data-dsh-settings-content], [data-dsh-approvals-content]')
        if (clip) resize.observe(clip)
        window.addEventListener('resize', publish)
        window.addEventListener('scroll', publish, true)
        publish()
        return () => {
          resize.disconnect(); window.removeEventListener('resize', publish); window.removeEventListener('scroll', publish, true)
          window.dispatchEvent(new CustomEvent('dsh-desktop:settings-surface', { detail: { token, close: true } }))
        }
      }, [section, state.connected, state.settingsProtocolVersion])
      useEffect(() => {
        const focus = event => {
          if (event.detail?.section !== section) return
          const approvals = target.current?.closest('[data-dsh-approvals]')
          if (approvals) {
            approvals.querySelector(event.detail.direction === 'previous' ? '[data-dsh-approvals-nav] [aria-current=true]' : '[data-dsh-approvals-close]')?.focus()
          } else {
            document.querySelector(event.detail.direction === 'previous' ? '[data-dsh-settings-section] [aria-current="true"]' : '[data-dsh-settings-close]')?.focus()
          }
        }
        window.addEventListener('dsh-desktop:settings-focus', focus)
        return () => window.removeEventListener('dsh-desktop:settings-focus', focus)
      }, [section])
      const failure = failed || state.settingsFailure || state.phase === 'error'
      const supported = state.settingsProtocolVersion === 1
      const ready = supported && state.settingsSection === section && state.settingsReady
      return h('div', { ref: target, className: 'dshSettingsRemote', tabIndex: ready ? 0 : -1, role: 'group', 'aria-label': t('openContent'), onFocus: () => { if (ready) void window.dshEnterpriseChat.focusSettings().catch(() => { if (alive.current) setFailed(true) }) }, 'aria-busy': state.connected && supported && !ready && !failure },
        !state.connected ? h('div', { className: 'dshSettingsStatus' },
          h('p', null, t('signIn')), h('p', { className: 'dshSettingsHint' }, t('localHint')),
          h('button', { type: 'button', onClick: openAccount }, t('openAccount')))
          : !supported ? h('div', { className: 'dshSettingsStatus', role: 'status' }, h('p', null, t('restart')))
          : !ready && h('div', { className: 'dshSettingsStatus', role: failure ? 'alert' : 'status' },
            h('p', null, t(state.settingsFailure === 'unsupported' ? 'unsupported' : failure ? 'error' : 'loading')),
            failure && h('button', { type: 'button', onClick: () => { setFailed(false); setState(previous => ({ ...previous, phase: 'loading', settingsFailure: undefined, settingsReady: false })); void window.dshEnterpriseChat.retry().catch(() => { if (alive.current) setFailed(true) }) } }, t('retry'))))
    }

    function Usage({ t, credits, creditsLabel, creditsHelp, models }) {
      const [state, setState] = useState({ phase: 'loading' })
      const [metric, setMetric] = useState('tokens')
      const [attempt, setAttempt] = useState(0)
      const id = React.useId()
      useEffect(() => {
        let disposed = false, revision = 0, identity, phase, pending = false
        const bridge = window.dshEnterpriseChat
        const receive = (next, requested = false) => {
          if (!bridge?.usage) { setState({ phase: 'unsupported' }); return }
          const key = `${next.epoch}:${next.connected}`
          const changed = key !== identity
          const ready = next.phase === 'ready' && phase !== 'ready'
          identity = key
          phase = next.phase
          if (changed) { revision++; pending = false }
          if (!next.connected) { setState({ phase: 'signedOut' }); return }
          if (next.phase === 'error' && !requested) { setState({ phase: 'error' }); return }
          if (pending || (!changed && !ready && !requested)) return
          const request = ++revision
          pending = true
          setState({ phase: 'loading' })
          void bridge.usage().then(data => {
            if (!disposed && request === revision) { pending = false; setState({ phase: 'ready', data }) }
          }).catch(() => {
            if (!disposed && request === revision) { pending = false; setState({ phase: 'error' }) }
          })
        }
        const unsubscribe = bridge?.subscribe(next => { if (!disposed) receive(next) })
        const initial = revision
        if (bridge?.usage) void bridge.state().then(next => { if (!disposed && initial === revision) receive(next, true) }).catch(() => { if (!disposed && initial === revision) setState({ phase: 'error' }) })
        else setState({ phase: 'unsupported' })
        return () => { disposed = true; revision++; unsubscribe?.() }
      }, [attempt])
      const locale = t('numberLocale')
      const amount = value => value == null ? t('unavailable') : new Intl.NumberFormat(locale, { notation: 'compact', maximumFractionDigits: 2 }).format(value)
      const tokenAmount = value => {
        if (value == null) return t('unavailable')
        if (locale.startsWith('zh')) {
          const hundredMillion = value >= 100_000_000
          return t(hundredMillion ? 'tokenYi' : 'tokenWan', { value: (value / (hundredMillion ? 100_000_000 : 10_000)).toFixed(1) })
        }
        return new Intl.NumberFormat(locale, { notation: 'compact', minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(value)
      }
      const size = (value, unit) => `${Number((unit === 'MB' ? value * 1024 : value).toFixed(2))} ${unit}`
      const data = state.data?.summary.status === 'ready' ? state.data.summary.data : null
      const storage = state.data?.storage
      const quota = storage?.status === 'ready' ? storage.data : null
      const unit = (quota?.limit === -1 ? quota.used : quota?.limit) < 1 ? 'MB' : 'GB'
      const failure = key => h('div', { className: 'dshSettingsStatus', role: 'alert' }, h('p', null, t(key)), h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, t('again')))
      let content
      if (state.phase === 'signedOut') content = h('div', { className: 'dshSettingsStatus' }, h('p', null, t('signIn')), h('button', { type: 'button', onClick: openAccount }, t('openAccount')))
      else if (state.phase !== 'ready') content = h('div', { className: 'dshSettingsStatus', role: state.phase === 'error' ? 'alert' : 'status' }, h('p', null, t(state.phase === 'unsupported' ? 'restart' : state.phase === 'error' ? 'usageError' : 'loading')), state.phase === 'error' && h('button', { type: 'button', onClick: () => setAttempt(value => value + 1) }, t('again')))
      else if (!data) content = failure('usageError')
      else {
        const value = point => metric === 'tokens' ? point.total_tokens : point.message_count
        const max = Math.max(1, ...data.points.map(point => value(point) || 0))
        // Sunday-first calendar columns, matching the enterprise daily buckets in Shanghai.
        const first = data.points[0]
        const offset = first ? new Date(`${first.start_at.slice(0, 10)}T00:00:00Z`).getUTCDay() : 0
        const months = []
        let previousMonth
        data.points.forEach((point, index) => {
          const date = point.start_at.slice(0, 10), month = date.slice(0, 7)
          if (month !== previousMonth) {
            months.push({ date: new Date(`${date}T00:00:00Z`), column: Math.floor((index + offset) / 7) + 1 })
            previousMonth = month
          }
        })
        // A partial starting month can share a week with the next month. Prefer
        // the complete month label and reserve three columns per visible label.
        const visibleMonths = months.filter((month, index) => !months[index + 1] || months[index + 1].column - month.column >= 3)
        const columns = Math.max(1, Math.ceil((data.points.length + offset) / 7))
        content = h(React.Fragment, null,
          h('dl', { className: 'dshUsageOverview' },
            ...[[creditsLabel, credits, creditsHelp], [t('totalTokens'), tokenAmount(data.totals.total_tokens)], [t('totalMessages'), amount(data.totals.message_count)]].map(([label, count, help], index) => h('div', { key: index, title: help }, h('dt', null, label), h('dd', null, count ?? t('unavailable'))))),
          first && h('p', { className: 'dshSettingsHint dshUsagePeriod' }, t('period', { start: first.start_at.slice(0, 10), end: data.points[data.points.length - 1].start_at.slice(0, 10) })),
          h('section', { className: 'dshUsageModel' },
            h('header', { className: 'dshUsageHeader' }, h('h3', null, t('activity')), h(SegmentedControl, { id, value: metric, label: t('modelUsage'), options: [{ value: 'tokens', label: t('tokens') }, { value: 'messages', label: t('messages') }], onChange: setMetric })),
            h('div', { id: `${id}-${metric}-panel`, role: 'tabpanel', 'aria-labelledby': `${id}-${metric}`, tabIndex: 0 },
              h('div', { className: 'dshUsageCalendarScroll' },
                h('div', { className: 'dshUsageMonths', style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` }, 'aria-hidden': true }, ...visibleMonths.map(({ date, column }) => h('span', { key: date.toISOString(), style: { gridColumn: `${column} / span ${Math.min(3, columns - column + 1)}`, gridRow: 1 } }, new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' }).format(date)))),
                h('div', { className: 'dshUsageGrid', role: 'list', 'aria-label': t(metric), style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` } }, ...data.points.map((point, index) => {
                  const count = value(point)
                  const label = `${point.start_at.slice(0, 10)} · ${t(metric)}: ${metric === 'tokens' ? tokenAmount(count) : count == null ? t('unavailable') : count.toLocaleString(locale)}`
                  return h(Tooltip, { key: point.start_at, label, side: 'top', portal: true },
                    h('div', { role: 'listitem', tabIndex: 0, 'aria-label': label, className: 'dshUsageDay', 'data-level': count == null ? 'unknown' : count === 0 ? 0 : Math.max(1, Math.ceil(count / max * 4)), style: { gridColumn: Math.floor((index + offset) / 7) + 1, gridRow: (index + offset) % 7 + 1 } }))
                }))),
              !data.points.some(point => (value(point) || 0) > 0) && h('p', { className: 'dshSettingsHint' }, t('noUsage')),
              h('div', { className: 'dshUsageFooter' },
                h('p', { className: 'dshSettingsHint', style: { visibility: metric === 'tokens' ? 'visible' : 'hidden' }, 'aria-hidden': metric !== 'tokens' }, t('breakdown', { input: tokenAmount(data.totals.input_tokens), output: tokenAmount(data.totals.output_tokens) })),
                h('div', { className: 'dshUsageLegend', 'aria-hidden': true }, t('less'), ...[0, 1, 2, 3, 4].map(level => h('span', { key: level, className: 'dshUsageDay', 'data-level': level })), t('more'))),
              data.totals.missing_usage_count > 0 && h('p', { role: 'status', className: 'dshSettingsHint' }, t('missingUsage', { count: data.totals.missing_usage_count })))),
        )
      }
      return h('section', { className: 'dshSettingsSection dshUsage', 'aria-busy': state.phase === 'loading' },
        content,
        models,
        storage?.status === 'error' ? failure('storageError') : storage?.status === 'ready' && h(React.Fragment, null,
          h('div', { className: 'dshUsageStorage' }, h('span', null, t('storage')), h('span', null, quota ? t('storageValue', { used: size(quota.used, unit), limit: quota.limit === -1 ? t('unlimited') : size(quota.limit, unit) }) : t('unavailable'))),
          quota && quota.limit !== -1 && h('progress', { className: 'dshUsageProgress', value: quota.limit > 0 ? Math.min(1, quota.used / quota.limit) : 1, max: 1, 'aria-label': t('storage') })))
    }

    function AiAccess({ t }) { return h('section', { className: 'dshSettingsSection' }, h('h2', null, t('ai')), h(RemoteSettings, { section: 'ai-access', t })) }
    const APPROVAL_SECTIONS = [['my-tasks', 'tasks'], ['my-requests', 'requests'], ['notifications', 'notifications']]

    /** Rail glyphs follow the native settings nav: one 16px outline icon per section. */
    function approvalsIcon(id) {
      if (id === 'my-requests') return h(IconPaperPlaneOutlineMedium, { className: 'dshApprovalsNavIcon', size: 16 })
      if (id === 'notifications') return h(IconAlarmClockOutlineMedium, { className: 'dshApprovalsNavIcon', size: 16 })
      return h(IconChecklistOutlineMedium, { className: 'dshApprovalsNavIcon', size: 16 })
    }

    /** Same two-column frame as the native settings panel: a section rail beside one owned content column. */
    function ApprovalsPanel({ onClose, t }) {
      const titleId = React.useId()
      const refs = useRef({})
      const [section, setSection] = useState('my-tasks')
      return h('div', { 'data-dsh-approvals': '', className: 'dshApprovalsPanel' },
        h('nav', { 'data-dsh-approvals-nav': '', className: 'dshApprovalsNav', 'aria-labelledby': titleId },
          h('div', { className: 'dshApprovalsNavTitle', id: titleId }, t('approvals')),
          h('div', { className: 'dshApprovalsNavList', onKeyDown: event => navigateSections(event, APPROVAL_SECTIONS.map(([id]) => id), section, setSection, refs) },
            ...APPROVAL_SECTIONS.map(([id, key]) => h('button', { key: id, ref: node => { refs.current[id] = node }, type: 'button', className: 'dshApprovalsNavCell', 'aria-current': section === id ? 'true' : undefined, 'data-modal-autofocus': section === id ? '' : undefined, onClick: () => setSection(id) },
              approvalsIcon(id), h('span', { className: 'dshApprovalsNavLabel' }, t(key)))))),
        h('div', { className: 'dshApprovalsContent' },
          h('div', { className: 'dshApprovalsHeader' },
            h('button', { type: 'button', className: 'dshApprovalsClose', 'data-dsh-approvals-close': '', 'aria-label': t('close'), onClick: onClose }, h(IconCloseOutlineRegular, { size: 14 }))),
          h('div', { 'data-dsh-approvals-content': '', className: 'dshApprovalsOptions' }, h(RemoteSettings, { key: section, section, t }))))
    }
    function About({ t }) {
      const [info, setInfo] = useState()
      const alive = useRef(true)
      const [error, setError] = useState('')
      const [busy, setBusy] = useState(false)
      useEffect(() => {
        let disposed = false
        alive.current = true
        void window.dshDesktop?.settingsInfo?.().then(value => { if (!disposed) setInfo(value) }).catch(() => { if (!disposed) setError('infoError') })
        return () => { disposed = true; alive.current = false }
      }, [])
      const run = async action => {
        setBusy(true); setError('')
        try { await window.dshDesktop.settingsAction(action) }
        catch { if (alive.current) setError('actionError') }
        finally { if (alive.current) setBusy(false) }
      }
      return h('section', { className: 'dshSettingsSection' },
        h('h2', null, t('about')),
        h('dl', { className: 'dshSettingsVersions' }, ...[['desktopVersion', info?.desktopVersion], ['harnessVersion', info?.harnessVersion]].flatMap(([key, value]) => [h('dt', { key: `${key}:label` }, t(key)), h('dd', { key }, value || '—')])),
        h('div', { className: 'dshSettingsButtons' },
          ...[['check-for-updates', 'update'], ['show-harness-log', 'logs'], ['safe-mode', 'recovery']].map(([action, label]) => h('button', { key: action, type: 'button', disabled: busy, onClick: () => run(action) }, t(label)))),
        error && h('p', { role: 'alert' }, t(error)))
    }
    /** Reuse the host enterprise endpoints; neither credentials nor account storage live here. */
    async function accountRequest(operation, signal) {
      const path = operation === 'logout' ? '/api/enterprise.logout' : '/api/enterprise.state'
      const response = await fetch(path, { credentials: 'same-origin', signal, ...(operation === 'logout' ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' } : {}) })
      const result = await response.json()
      if (!response.ok || !result || typeof result !== 'object' || typeof result.connected !== 'boolean' || result.ok === false || (operation === 'logout' && result.connected)) throw new Error('Enterprise account request failed')
      return result
    }

    function useAccountIdentity() {
      const [account, setAccount] = useState()
      const [error, setError] = useState(false)
      const [busy, setBusy] = useState(false)
      const lifetime = useRef({ alive: true, revision: 0, request: undefined })
      const refresh = React.useCallback(async () => {
        const current = lifetime.current
        current.request?.abort()
        const request = new AbortController(), revision = ++current.revision
        current.request = request
        try {
          const next = await accountRequest('state', request.signal)
          if (current.alive && revision === current.revision) { setAccount(next); setError(false) }
        } catch {
          if (current.alive && revision === current.revision && !request.signal.aborted) setError(true)
        }
      }, [])
      useEffect(() => {
        lifetime.current.alive = true
        const changed = () => { void refresh() }
        let identity
        const unsubscribe = window.dshEnterpriseChat?.subscribe(next => {
          const key = `${next.epoch}:${next.connected}`
          if (key === identity) return
          identity = key
          if (!next.connected) setAccount({ connected: false })
          void refresh()
        })
        window.addEventListener('dsh-desktop:enterprise-account-changed', changed)
        void refresh()
        return () => {
          lifetime.current.alive = false; lifetime.current.revision++; lifetime.current.request?.abort(); lifetime.current.action?.abort()
          unsubscribe?.(); window.removeEventListener('dsh-desktop:enterprise-account-changed', changed)
        }
      }, [refresh])
      const logout = async () => {
        const current = lifetime.current
        current.request?.abort(); current.revision++
        const request = new AbortController()
        current.action = request
        setBusy(true)
        try {
          const next = await accountRequest('logout', request.signal)
          if (current.alive) { setAccount(next); setError(false); window.dispatchEvent(new CustomEvent('dsh-desktop:enterprise-account-changed')) }
        } finally { if (current.alive) setBusy(false) }
      }
      return { account, error, busy, refresh, logout }
    }

    function ApprovalsDialog({ open, onClose, t }) {
      useEffect(() => {
        window.dispatchEvent(new CustomEvent('dsh-desktop:approvals-visibility', { detail: { open } }))
        return () => window.dispatchEvent(new CustomEvent('dsh-desktop:approvals-visibility', { detail: { open: false } }))
      }, [open])
      return h(Modal, { open, onClose, title: t('approvals'), headless: true, className: 'dshApprovalsDialog' },
        open && h(ApprovalsPanel, { onClose, t }))
    }

    function AccountAvatar({ name }) {
      return h('span', { className: 'dshAccountAvatar', 'aria-hidden': 'true' }, name ? Array.from(name).slice(0, 2).join('').toLocaleUpperCase() : h('svg', { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5 }, h('circle', { cx: 12, cy: 8, r: 4 }), h('path', { d: 'M4 22v-2a8 8 0 0 1 16 0v2' })))
    }

    function AccountMenuIcon({ kind }) {
      const frame = { width: 18, height: 18, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.5, 'aria-hidden': 'true' }
      if (kind === 'phone') return h('svg', frame, h('rect', { x: 6, y: 2, width: 12, height: 20, rx: 2 }), h('path', { d: 'M10 5h4M11 19h2' }))
      if (kind === 'account') return h('svg', frame, h('circle', { cx: 12, cy: 8, r: 3.5 }), h('path', { d: 'M5 21a7 7 0 0 1 14 0' }))
      // Sign in points into the panel; sign out points away from it.
      return h('svg', frame, h('path', { d: kind === 'login' ? 'M15 4h4a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2h-4M10 8l4 4-4 4M3 12h11' : 'M9 4H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h4M13 7l5 5-5 5M8 12h13' }))
    }

    function AccountBadge({ count }) {
      return h('span', { className: 'dshAccountBadge' }, count > 99 ? '99+' : String(count))
    }

    /** Outstanding approvals are advisory presentation data reported by the enterprise document. */
    function useApprovalsPending() {
      const [pending, setPending] = useState(0)
      useEffect(() => {
        const bridge = window.dshEnterpriseChat
        if (!bridge) return undefined
        let disposed = false
        const read = next => {
          if (disposed) return
          const value = next?.connected ? next.navigation?.approvals?.pending : 0
          setPending(Number.isInteger(value) && value > 0 ? value : 0)
        }
        const unsubscribe = bridge.subscribe(read)
        void bridge.state().then(read).catch(() => { /* The badge stays hidden until the host reports again. */ })
        return () => { disposed = true; unsubscribe() }
      }, [])
      return pending
    }

    /** Signing out is destructive, so it is confirmed outside the menu and keeps its own retry. */
    function LogoutDialog({ open, busy, failed, onCancel, onConfirm, t }) {
      useEffect(() => {
        if (!open) return undefined
        const publish = value => window.dispatchEvent(new CustomEvent('dsh-desktop:account-dialog-visibility', { detail: { open: value } }))
        publish(true)
        return () => publish(false)
      }, [open])
      return h(Modal, {
        open, title: t('logout'), closeLabel: t('close'), description: t('logoutBody'), className: 'dshAccountDialog',
        onClose: () => { if (!busy) onCancel() },
        footer: h('div', { className: 'dshAccountDialogActions' },
          h('button', { type: 'button', 'data-modal-autofocus': '', disabled: busy, onClick: onCancel }, t('cancel')),
          h('button', { type: 'button', className: 'dshAccountDialogDanger', 'data-dsh-logout-confirm': '', disabled: busy, onClick: onConfirm }, t(busy ? 'loggingOut' : 'logout')))
      }, failed && h('p', { className: 'dshAccountDialogError', role: 'alert' }, t('logoutFailed')))
    }

    function AccountLauncher({ wide, settingsOpen, openSettings, settingsShortcut, t }) {
      const identity = useAccountIdentity()
      const pending = useApprovalsPending()
      const [menuOpen, setMenuOpen] = useState(false)
      const [approvalsOpen, setApprovalsOpen] = useState(false)
      const [logoutOpen, setLogoutOpen] = useState(false)
      const [logoutFailed, setLogoutFailed] = useState(false)
      const [actionBusy, setActionBusy] = useState(false)
      const [actionError, setActionError] = useState(false)
      const alive = useRef(true)
      const trigger = useRef(null)
      const closeApprovals = React.useCallback(() => { setApprovalsOpen(false); trigger.current?.focus() }, [])
      const closeLogout = React.useCallback(() => { setLogoutOpen(false); setLogoutFailed(false); trigger.current?.focus() }, [])
      useEffect(() => {
        alive.current = true
        // Sign-in also broadcasts this event at startup; only an open dialog owns return focus.
        const close = () => {
          if (approvalsOpen) closeApprovals()
          if (logoutOpen) closeLogout()
        }
        window.addEventListener('dsh-desktop:close-settings', close)
        return () => { alive.current = false; window.removeEventListener('dsh-desktop:close-settings', close) }
      }, [approvalsOpen, logoutOpen, closeApprovals, closeLogout])
      useEffect(() => { if (settingsOpen) { setMenuOpen(false); setApprovalsOpen(false); setLogoutOpen(false); setLogoutFailed(false) } }, [settingsOpen])
      useEffect(() => {
        if (identity.account?.connected === false) { setApprovalsOpen(false); setLogoutOpen(false) }
      }, [identity.account?.connected])
      const name = [identity.account?.user?.display_name, identity.account?.user?.username, identity.account?.user?.id].find(value => typeof value === 'string' && value.trim())
      const label = name || t(identity.account ? 'signedOut' : identity.error ? 'identityError' : 'identityLoading')
      const connected = identity.account?.connected === true
      const quota = identity.account?.usage
      const credits = !identity.error && quota && quota.source !== 'unavailable' && quota.quota_state !== 'unavailable'
        && Number.isFinite(quota.limit) && Number.isFinite(quota.used)
        ? new Intl.NumberFormat(t('numberLocale'), { minimumFractionDigits: 1, maximumFractionDigits: 1 }).format(Math.max(0, quota.limit - quota.used) / 1_000_000)
        : null
      const busy = actionBusy || identity.busy
      useEffect(() => {
        if (!menuOpen || busy) return undefined
        // Clicking the native Chat WebContents does not emit pointerdown in this document.
        const close = () => setMenuOpen(false)
        window.addEventListener('blur', close)
        return () => window.removeEventListener('blur', close)
      }, [menuOpen, busy])
      // A failed read and a failed action share one retry row; the action takes precedence.
      const failure = actionError ? 'actionError' : identity.error ? 'identityError' : undefined
      const pairPhone = async () => {
        if (busy) return
        setActionBusy(true); setActionError(false)
        try {
          await window.dshDesktop.openPhonePairing()
          if (alive.current) { setMenuOpen(false); setApprovalsOpen(false) }
        } catch { if (alive.current) { setActionError(true); setMenuOpen(true) } }
        finally { if (alive.current) setActionBusy(false) }
      }
      const openAccountSettings = () => { setMenuOpen(false); openSettings(); openAccount() }
      const confirmLogout = async () => {
        if (busy) return
        setActionBusy(true); setLogoutFailed(false)
        try {
          await identity.logout()
          if (alive.current) { setLogoutOpen(false); setApprovalsOpen(false); trigger.current?.focus() }
        } catch { if (alive.current) setLogoutFailed(true) }
        finally { if (alive.current) setActionBusy(false) }
      }
      const badge = pending > 0 ? h(AccountBadge, { count: pending }) : null
      const triggerLabel = `${t('accountMenu')}: ${label}${pending > 0 ? ` · ${t('approvalsPending')} ${pending}` : ''}`
      // The sidebar menu does not cover the native Chat view or own its presentation.
      return h('div', { className: 'dshAccountLauncher', 'data-dsh-account-launcher': '' },
        h(Menu, { open: menuOpen, onClose: () => { if (!busy) setMenuOpen(false) }, side: 'top', align: 'start', portal: true, autoFocus: true, className: 'dshAccountMenuAnchor', listClassName: `dshAccountMenu${wide ? ' dshAccountMenuWide' : ''}`,
          anchor: h('button', { ref: trigger, type: 'button', className: `dshAccountTrigger${wide ? '' : ' dshAccountTriggerRail'}`, 'aria-label': triggerLabel, title: wide ? undefined : label, 'aria-haspopup': 'menu', 'aria-expanded': menuOpen, disabled: settingsOpen || busy, onClick: () => { setMenuOpen(previous => !previous); setActionError(false); void identity.refresh() } },
            h('span', { className: 'dshAccountAvatarWrap' }, h(AccountAvatar, { name }), badge),
            wide && h('span', { className: 'dshAccountTriggerCopy' }, h('span', null, label)), wide && h(IconChevronDownOutlineRegular)) },
          h('div', { className: 'dshAccountMenuIdentity' }, h(AccountAvatar, { name }), h('div', null, h('strong', null, label), h('small', null, t(connected ? 'enterpriseAccount' : 'signInHint'))),
            connected && h('div', { className: 'dshAccountMenuCredits', role: 'status' }, h('strong', null, credits ?? '—'), h('small', null, t(credits === null ? 'creditsUnavailable' : 'creditsRemaining')))),
          h(MenuItemButton, { icon: h(IconSettingsOutlineRegular), shortcut: settingsShortcut, disabled: busy, onSelect: () => { setMenuOpen(false); openSettings() } }, t('settings')),
          connected && h(MenuItemButton, { icon: h(AccountMenuIcon, { kind: 'account' }), disabled: busy, onSelect: openAccountSettings }, t('accountSettings')),
          h(MenuItemButton, { icon: h(IconChecklistOutlineRegular), disabled: busy || !connected, onSelect: () => { setMenuOpen(false); setApprovalsOpen(true) } },
            h('span', { className: 'dshAccountMenuRow' }, t('approvals'), badge)),
          h(MenuItemButton, { icon: h(AccountMenuIcon, { kind: 'phone' }), disabled: busy, onSelect: () => { void pairPhone() } }, t('phone')),
          connected
            ? h(MenuItemButton, { icon: h(AccountMenuIcon, { kind: 'logout' }), separatorBefore: true, danger: true, disabled: busy, onSelect: () => { setMenuOpen(false); setLogoutFailed(false); setLogoutOpen(true) } }, t('logout'))
            : h(MenuItemButton, { icon: h(AccountMenuIcon, { kind: 'login' }), separatorBefore: true, disabled: busy, onSelect: openAccountSettings }, t('login')),
          failure && h('p', { className: 'dshAccountMenuError', role: 'alert' }, t(failure)),
          failure && h(MenuItemButton, { disabled: busy, onSelect: () => { if (actionError) { void pairPhone(); return } setActionError(false); void identity.refresh() } }, t('again'))),
        h(ApprovalsDialog, { open: approvalsOpen, onClose: closeApprovals, t }),
        h(LogoutDialog, { open: logoutOpen, busy, failed: logoutFailed, onCancel: closeLogout, onConfirm: () => { void confirmLogout() }, t }))
    }

    const NAV_GLYPHS = { 'enterprise-account': IconUserOutlineMedium, 'desktop-usage': IconGaugeOutlineMedium, 'desktop-ai-access': IconApiOutlineMedium, 'desktop-about': IconInfoOutlineMedium }
    function SettingsNavigation({ rows, renderEntry }) {
      return rows.map(row => renderEntry(row, NAV_GLYPHS[row.id] ? { icon: NAV_GLYPHS[row.id] } : undefined))
    }

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, COPY), 'desktop-settings: dictionaries')
      const t = ctx.locale.bind(NS)
      ctx.effect(() => {
        const style = document.createElement('style')
        // Claim ownership immediately: a different lazy factory must not adopt
        // this effect-created stylesheet and remove it during its own HMR.
        style.dataset.plugin = 'dsh-desktop-settings'
        style.dataset.pluginCss = 'dsh-desktop-settings'
        style.textContent = `
          .dshUsage{min-width:0}.dshUsageStorage{display:flex;flex-wrap:wrap;justify-content:space-between;gap:8px;font-size:14px}.dshUsageStorage>span:last-child,.dshUsage .dshSettingsHint{color:var(--dsw-alias-label-secondary)}.dshUsageProgress{width:100%;height:6px;margin-top:10px;accent-color:var(--dsw-alias-state-business-primary)}
          .dshUsageModel{margin-top:28px}.dshUsageHeader{display:flex;align-items:center;justify-content:space-between;flex-wrap:wrap;gap:12px;margin-bottom:20px}.dshUsageHeader h3{margin:0;font-size:16px;font-weight:600}.dshUsageCalendarScroll{overflow-x:auto;padding-bottom:4px}.dshUsageMonths{display:grid;min-width:440px;gap:3px;margin-bottom:8px;color:var(--dsw-alias-label-secondary);font-size:12px}.dshUsageMonths span{white-space:nowrap;min-width:0;overflow:hidden;text-overflow:clip}.dshUsageMonths span:last-child{text-align:right}.dshUsageGrid{display:grid;grid-template-rows:repeat(7,1fr);min-width:440px;gap:3px}.dshUsageDay{aspect-ratio:1;border-radius:2px;background:var(--dsw-alias-interactive-bg-hover)}.dshUsageDay[data-level='1']{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 25%,var(--dsw-alias-interactive-bg-hover))}.dshUsageDay[data-level='2']{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 45%,var(--dsw-alias-interactive-bg-hover))}.dshUsageDay[data-level='3']{background:color-mix(in srgb,var(--dsw-alias-state-business-primary) 70%,var(--dsw-alias-interactive-bg-hover))}.dshUsageDay[data-level='4']{background:var(--dsw-alias-state-business-primary)}.dshUsageDay[data-level='unknown']{outline:1px dashed var(--dsw-alias-border-l2);outline-offset:-1px;background:transparent}.dshUsageTotals{margin:26px 0 12px}.dshUsageTotals dt{font-size:14px;color:var(--dsw-alias-label-secondary)}.dshUsageTotals dd{margin:8px 0 0;font-size:24px;font-weight:600;font-variant-numeric:tabular-nums}.dshUsage .dshSettingsHint{font-size:12px;line-height:1.6}

          .dshUsageOverview{display:flex;margin:0;border:1px solid var(--dsw-alias-border-l2);border-radius:12px;padding:14px 0;gap:0}.dshUsageOverview>div{flex:1;min-width:0;text-align:center;padding:0 10px;display:flex;flex-direction:column-reverse;gap:6px}.dshUsageOverview>div+div{border-left:1px solid var(--dsw-alias-border-l2)}.dshUsageOverview dt{font-size:12px;color:var(--dsw-alias-label-secondary)}.dshUsageOverview dd{margin:0;font-size:18px;font-weight:500;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.dshUsagePeriod{margin:10px 0 0}.dshUsageCalendarScroll{display:flex;flex-direction:column}.dshUsageMonths{order:1;margin:8px 0 0}.dshUsageFooter{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;flex-wrap:wrap;margin-top:10px}.dshUsageFooter>.dshSettingsHint{margin:0}.dshUsageLegend{display:flex;align-items:center;justify-content:flex-end;flex:none;margin-left:auto;gap:4px;font-size:11px;color:var(--dsw-alias-label-secondary)}.dshUsageLegend .dshUsageDay{width:9px;height:9px}.dshUsageStorage{margin-top:24px;padding-top:20px;border-top:1px solid var(--dsw-alias-border-l2)}
          .dshSettingsSection{color:var(--dsw-alias-label-primary)}.dshSettingsSection h2{font-size:18px;font-weight:600;margin:0 0 20px}.dshSettingsRemote{height:max(360px,calc(min(800px,100vh - 80px) - 220px));position:relative;min-width:0}
          .dshSettingsStatus{padding:24px 0;font-size:14px}.dshSettingsTabs{display:flex;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l2);padding-bottom:12px;margin-bottom:8px}
          .dshSettingsSection button:not([role=tab]),.dshSettingsStatus button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:7px 12px;cursor:pointer}
          .dshSettingsSection button:not([role=tab]):hover,.dshSettingsStatus button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshSettingsSection button:not([role=tab])[aria-selected=true]{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.dshSettingsSection button:not([role=tab]):disabled{opacity:.5;cursor:default}
          .dshSettingsVersions{display:grid;grid-template-columns:1fr auto;gap:20px;padding:20px 0;border-bottom:1px solid var(--dsw-alias-border-l2);font-size:14px}.dshSettingsVersions dd{margin:0;color:var(--dsw-alias-label-secondary)}.dshSettingsButtons{display:flex;gap:12px;padding:20px 0;flex-wrap:wrap}
          .dshAccountLauncher,.dshAccountMenuAnchor{display:block;width:100%;min-width:0}.dshAccountTrigger{anchor-name:--dsh-desktop-account-trigger;display:flex;align-items:center;gap:10px;width:100%;min-width:0;height:48px;box-sizing:border-box;padding:6px 10px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer}.dshAccountTrigger:hover,.dshAccountTrigger[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover)}.dshAccountTrigger:focus-visible{outline:2px solid var(--dsw-alias-state-business-primary);outline-offset:-2px}.dshAccountTrigger:disabled{cursor:default}.dshAccountTriggerRail{width:36px;height:36px;padding:4px;margin:auto;justify-content:center}.dshAccountTrigger>svg{flex:none;color:var(--dsw-alias-label-tertiary)}
          .dshAccountAvatar{display:flex;align-items:center;justify-content:center;flex:none;width:28px;height:28px;border-radius:50%;background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary);font-size:11px;font-weight:600}.dshAccountAvatarWrap{position:relative;display:flex;flex:none}.dshAccountBadge{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-width:16px;height:16px;padding:0 4px;border-radius:8px;background:var(--dsw-alias-state-error-primary);color:#fff;font-size:10px;font-weight:600;line-height:1}.dshAccountAvatarWrap>.dshAccountBadge{position:absolute;top:-4px;right:-6px}.dshAccountMenuRow{display:flex;align-items:center;gap:8px;min-width:0}.dshAccountTriggerCopy{display:flex;flex-direction:column;gap:2px;flex:1;min-width:0;font-size:13px}.dshAccountTriggerCopy>span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshAccountTriggerCopy small,.dshAccountMenuIdentity small{color:var(--dsw-alias-label-secondary);font-size:11px;font-weight:400}
          /* The portal follows the real trigger width; override Menu's inline 12px viewport clamp to keep both edges aligned. */
          .dshAccountMenu{min-width:248px;max-width:min(320px,calc(100vw - 24px))}.dshAccountMenuWide{position-anchor:--dsh-desktop-account-trigger;box-sizing:border-box;width:anchor-size(width);min-width:0;max-width:none;left:anchor(left)!important}.dshAccountMenuIdentity{display:flex;align-items:center;gap:12px;padding:10px 10px 14px;margin-bottom:4px;border-bottom:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-primary)}.dshAccountMenuIdentity>div{display:flex;flex-direction:column;gap:4px;min-width:0}.dshAccountMenuIdentity strong{font-size:14px;font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.dshAccountMenuError{font-size:12px;line-height:1.5;padding:4px 10px;color:var(--dsw-alias-label-secondary)}
          .dshAccountMenuIdentity>.dshAccountMenuCredits{flex:none;margin-left:auto;text-align:right;max-width:48%}.dshAccountMenuCredits strong{font-variant-numeric:tabular-nums}.dshAccountMenuIdentity>div:not(.dshAccountMenuCredits){flex:1;min-width:0}
          .dshAccountDialog{width:min(420px,100%)}.dshAccountDialogActions{display:flex;justify-content:flex-end;gap:8px}.dshAccountDialogActions button{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-2);border-radius:var(--dsw-radius-md);padding:7px 14px;cursor:pointer}.dshAccountDialogActions button:hover{background:var(--dsw-alias-interactive-bg-hover)}.dshAccountDialogActions button:disabled{opacity:.5;cursor:default}.dshAccountDialogActions .dshAccountDialogDanger{border-color:transparent;background:var(--dsw-alias-state-error-primary);color:#fff}.dshAccountDialogActions .dshAccountDialogDanger:hover{background:var(--dsw-alias-state-error-primary);opacity:.9}.dshAccountDialogError{margin:0;font-size:13px;line-height:1.5;color:var(--dsw-alias-state-error-primary)}
          /* 1080 = 188 导航 + 48 内边距 + 844 嵌入视口。网页的审批列表/详情双栏挂在 Tailwind md(768px) 视口断点上，
             嵌入区窄于 768px 会退回单栏，所以弹窗宽度要留出这条余量；窗口放不下时仍按 100% 收缩并回到单栏。 */
          .dshApprovalsDialog{width:min(1080px,100%);height:min(800px,100%);max-height:100%;padding:0;gap:0}.dshApprovalsPanel{display:flex;flex:1;min-height:0;min-width:0}
          .dshApprovalsNav{box-sizing:border-box;display:flex;flex-direction:column;flex:none;gap:18px;width:188px;min-height:0;padding:22px 12px;overflow-y:auto}.dshApprovalsNavTitle{padding:0 12px;color:var(--dsw-alias-label-primary);font-size:16px;font-weight:500;line-height:24px}.dshApprovalsNavList{display:flex;flex-direction:column;gap:4px;overflow-y:auto}
          .dshApprovalsNavCell{box-sizing:border-box;display:flex;align-items:center;gap:8px;height:40px;padding:9px 16px 9px 12px;border:0;border-radius:var(--dsw-radius-md);background:transparent;color:var(--dsw-alias-label-primary);font:inherit;font-size:14px;font-weight:400;line-height:22px;text-align:left;cursor:pointer}.dshApprovalsNavCell:hover{background:var(--dsw-specific-sidebar-nav-item-hover)}.dshApprovalsNavCell[aria-current=true]{background:var(--dsw-specific-sidebar-nav-item-active)}.dshApprovalsNavIcon{flex:none}.dshApprovalsNavLabel{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
          .dshApprovalsContent{display:flex;flex-direction:column;flex:1;min-width:0}.dshApprovalsHeader{box-sizing:border-box;display:flex;flex:none;align-items:flex-start;justify-content:flex-end;gap:8px;height:54px;padding:20px 14px 8px 10px}.dshApprovalsClose{display:inline-flex;align-items:center;justify-content:center;width:28px;height:28px;border:0;border-radius:var(--dsw-radius-sm);background:transparent;color:var(--dsw-alias-label-primary);cursor:pointer}.dshApprovalsClose:hover{background:var(--dsw-alias-interactive-bg-hover)}
          .dshApprovalsOptions{display:flex;flex-direction:column;flex:1;min-height:0;padding:0 24px 24px}.dshApprovalsOptions .dshSettingsRemote{flex:1;min-height:0;height:auto}

          @media(max-width:640px){.dshSettingsRemote{height:max(300px,calc(100vh - 280px))}.dshApprovalsNav{width:152px;gap:14px;padding:18px 8px}.dshApprovalsOptions{padding:0 16px 16px}}
        `
        document.head.appendChild(style)
        return () => style.remove()
      }, 'desktop-settings: owned styles')
      const register = (name, id, Component, extra = {}) => ctx.slots.inject(name, () => ctx.slots.register({ name, id, locale: NS, ...extra, inject: () => ({ t }) }, Component))
      register('desktop.account.usage', 'desktop-usage', Usage)
      register('settings.section', 'desktop-about', About, { order: 90, label: () => t('about') })
      ctx.effect(() => {
        let disposed = false, disposeEntry, revision = 0
        const sync = state => {
          revision++
          const allowed = state.connected && state.navigation?.settings?.aiAccess === true
          if (allowed && !disposeEntry) disposeEntry = register('settings.section', 'desktop-ai-access', AiAccess, { order: 80, label: () => t('ai') })
          if (!allowed) { disposeEntry?.(); disposeEntry = undefined }
        }
        const unsubscribe = window.dshEnterpriseChat?.subscribe(sync)
        const request = revision
        void window.dshEnterpriseChat?.state().then(state => { if (!disposed && request === revision) sync(state) }).catch(() => { /* Unavailable capability stays hidden until the next host state. */ })
        return () => { disposed = true; unsubscribe?.(); disposeEntry?.() }
      }, 'desktop-settings: account capabilities')
      register('settings.launcher', 'desktop-account-menu', AccountLauncher)
      // The shell only has glyphs for its native sections and falls back to the gear; the Bisheng
      // sections get theirs here, through the shell's own row so selection and focus stay native.
      ctx.slots.inject('settings.navigation', () => ctx.slots.register({ name: 'settings.navigation', id: 'desktop-nav-glyphs', inject: () => ({ t }) }, SettingsNavigation))
    }
    return { apply, inject: ['slots', 'locale'] }
  }
})
