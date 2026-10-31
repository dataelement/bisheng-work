import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { inject as enterpriseInject } from '../packages/dsh-desktop-enterprise/index.js'
import {
  ACCOUNT_ERROR_COPY,
  LEGACY_ACCOUNT_PHRASES,
  NO_MODELS_COPY,
  resolveAccountError
} from '../packages/dsh-desktop-enterprise/error-copy.js'

const projectRoot = path.resolve(import.meta.dirname, '..')
const execFileAsync = promisify(execFile)

/** CI runners export a proxy, and Node prints this experimental warning on stderr before the script runs. */
function stripExperimentalProxyWarning(stderr: string): string {
  return stderr.replaceAll(
    /\(node:\d+\) \[UNDICI-EHPA\] Warning: EnvHttpProxyAgent is experimental, expect them to change at any time\.\r?\n\(Use `node --trace-warnings \.\.\.` to show where the warning was created\)\r?\n/g,
    ''
  )
}

describe('DSH Desktop enterprise package', () => {
  it('separates provider labels while preserving model paths', async () => {
    const client = await readFile(path.join(projectRoot, 'packages/dsh-desktop-enterprise/client.js'), 'utf8')
    const body = client.match(/function modelDisplayParts\(displayName\) \{([\s\S]*?)\n    \}/)?.[1]
    expect(body).toBeDefined()
    const parts = new Function('displayName', body!)
    expect(parts('阿里云百炼 / kimi/kimi-k3')).toEqual({ provider: '阿里云百炼', name: 'kimi/kimi-k3' })
    expect(parts('volces / deepseek-v4-pro')).toEqual({ provider: 'volces', name: 'deepseek-v4-pro' })
    expect(parts('kimi/kimi-k3')).toEqual({ provider: '', name: 'kimi/kimi-k3' })
    expect(parts('custom / ')).toEqual({ provider: '', name: 'custom / ' })
  })

  it('marks models available when routing and their quota both allow use', async () => {
    const client = await readFile(path.join(projectRoot, 'packages/dsh-desktop-enterprise/client.js'), 'utf8')
    const body = client.match(/function isModelAvailable\(state, usage\) \{([\s\S]*?)\n    \}/)?.[1]
    expect(body).toBeDefined()
    const available = new Function('state', 'usage', body!)
    const usage = { quota_state: 'available', used: 5, limit: 10 }
    expect(available({ modelsAvailable: true }, usage)).toBe(true)
    expect(available({ modelsAvailable: false }, usage)).toBe(false)
    expect(available({ modelsAvailable: true }, undefined)).toBe(false)
    for (const update of [{ quota_state: 'unavailable' }, { quota_state: 'exhausted' }, { limit: 0 }, { used: 10 }, { used: 11 }, { used: null }]) {
      expect(available({ modelsAvailable: true }, { ...usage, ...update })).toBe(false)
    }
  })

  it('keeps model information without per-model quotas and uses shared credits for availability', async () => {
    const client = await readFile(path.join(projectRoot, 'packages/dsh-desktop-enterprise/client.js'), 'utf8')
    const names = ['modelDisplayParts', 'isModelAvailable', 'renderModelRow']
    const functions = names.map(name => client.match(new RegExp(`    function ${name}\\([^]*?\\n    \\}`))?.[0])
    expect(functions.every(Boolean)).toBe(true)
    const require = createRequire(import.meta.url)
    const React = require('react') as { createElement: (...args: unknown[]) => unknown }
    const { renderToStaticMarkup } = require('react-dom/server') as { renderToStaticMarkup: (node: unknown) => string }
    const render = new Function('h', `${functions.join('\n')}; return renderModelRow`)(React.createElement)
    const model = { id: 'model', display_name: 'Provider / Model' }
    for (const remaining of [true, false]) {
      const html = renderToStaticMarkup(render(model, {
        modelsAvailable: true,
        usage: { used: remaining ? 25 : 100, limit: 100, quota_state: 'available' },
        modelUsage: { model: { used: 0, limit: 100, quota_state: 'available' } }
      }, 'en', (key: string) => key))
      expect(html).toContain('>Model</span>')
      expect(html).toContain('>Provider</span>')
      expect(html.includes('dshEnterpriseModelStatus')).toBe(remaining)
      expect(html).not.toContain('progressbar')
      expect(html).not.toContain('dshEnterpriseModelUsage')
      expect(html).not.toContain('%')
    }
    expect(client).not.toContain('modelUsageProgress')
    expect(client).not.toContain('modelUsagePercentage')
    expect(client).not.toContain('.dshEnterpriseModelUsage')
  })

  it('uses native DSH settings card tokens for enterprise model rows', async () => {
    const client = await readFile(path.join(projectRoot, 'packages/dsh-desktop-enterprise/client.js'), 'utf8')
    const row = client.match(/\.dshEnterpriseModels li \{([^}]+)\}/)?.[1]
    const list = client.match(/\.dshEnterpriseModels \{([^}]+)\}/)?.[1]
    expect(row).toContain('border: .5px solid var(--dsw-alias-settings-card-stroke);')
    expect(row).toContain('background: var(--dsw-alias-settings-card-fill);')
    expect(row).toContain('border-radius: var(--dsw-radius-xl);')
    expect(row).toContain('padding: 12px 14px;')
    expect(list).toContain('gap: 8px;')
  })

  it('exports the declared Client bundle for the Harness module loader', async () => {
    const packageJson = JSON.parse(await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-enterprise', 'package.json'),
      'utf8'
    )) as {
      dsh?: { client?: { inject?: string[] } }
      exports?: Record<string, unknown>
    }

    expect(packageJson.dsh?.client).toBeTruthy()
    expect(packageJson.dsh?.client).toMatchObject({
      inject: ['@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-primitives', '@deepseek-ai/dsh-client-ui-settings', '@deepseek-ai/dsh-client-ui-settings-plugins']
    })
    expect(packageJson.exports?.['./client']).toBe('./client.js')
  })

  it('ships a syntactically valid Client module-loader bundle', async () => {
    const clientPath = path.join(
      projectRoot,
      'packages',
      'dsh-desktop-enterprise',
      'client.js'
    )

    const checked = await execFileAsync(process.execPath, ['--check', clientPath])
    expect(stripExperimentalProxyWarning(checked.stderr)).toBe('')
  })

  it('keeps the last BiSheng platform URL after enterprise sign-out', async () => {
    const client = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-enterprise', 'client.js'),
      'utf8'
    )

    expect(client).toContain('dshDesktopEnterprise.lastBase')
    expect(client).toContain('localStorage.setItem(LAST_BASE_KEY')
    expect(client).not.toContain("setBase('')")
  })

  it('opens the enterprise settings section when an enterprise login link arrives', async () => {
    const client = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-enterprise', 'client.js'),
      'utf8'
    )

    expect(client).toContain("const ENTERPRISE_SECTION_ID = 'enterprise-account'")
    expect(client).toContain("const OPEN_SETTINGS_SECTION_EVENT = 'dsh-desktop:open-settings-section'")
    expect(client).toContain('function openEnterpriseSettingsSection()')
    expect(client).toContain('new CustomEvent(OPEN_SETTINGS_SECTION_EVENT, { detail: { id: ENTERPRISE_SECTION_ID } })')
    expect(client).toContain('return bridge.onLoginLink(() => openEnterpriseSettingsSection())')
    expect(client).toContain('bridge.consumeLoginLink?.()')
    expect(client).toContain('void inspectDeepLink(url)')
    expect(client).toContain('id: ENTERPRISE_SECTION_ID')
    expect(client).toContain('confirmation && !connected')
  })

it('keeps sign-in focused and shows unified credits without model quotas', async () => {
    const client = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-enterprise', 'client.js'),
      'utf8'
    )

    expect(client).not.toContain('copy.lead')
    expect(client).not.toContain('copy.disconnected')
    expect(client).not.toContain('copy.platformHint')
    expect(client).not.toContain('copy.sessionExpires')
    expect(client).toContain('MANUAL_FALLBACK_DELAY_MS')
    expect(client).toContain('setManualFallbackReady')
    expect(client).toContain("className: 'dshEnterpriseManual'")
    expect(client).toContain("autoComplete: 'one-time-code'")
    expect(client).toContain('/api/enterprise.login.manual')
    expect(client).toContain('identityTicket')
    expect(client).toContain("ticket: '一次性登录码'")
    expect(client).toContain("submitTicket: '完成登录'")
    expect(client).toContain("const inject = ['slots', 'locale']")
    expect(client).toContain("ctx.locale.register(NS, { zh, en })")
    expect(client).toContain("const t = ctx.locale.bind(NS)")
    expect(client).toContain("label: () => t('nav')")
    expect(client).toContain("nav: '账号与用量'")
    expect(client).toContain("nav: 'Account and usage'")
    expect(client).toContain("title: 'Account and usage'")
    expect(client).toContain("children: { 'desktop.account.usage': { kind: 'single', scope: 'root' } }")
    expect(client).toContain("platform: '企业平台地址'")
    expect(client).toContain("platform: 'Enterprise platform URL'")
    expect(client).not.toContain('navigator.language')
    expect(client).not.toContain('copy.manualTitle')
    expect(client).not.toContain('copy.manualHint')
    expect(client).not.toContain('copy.manualToggle')
    expect(client).not.toContain('manualExpanded')
    expect(client).not.toContain('dshEnterpriseManualToggle')
    expect(client).not.toContain('dshEnterpriseCard')
    expect(client).not.toContain("h('dt', null, copy.platform)")
    expect(client).not.toContain('copy.connected')
    expect(client).not.toContain('state.tenant?.name')
    expect(client).toContain("const userLabel = state?.user?.display_name || state?.user?.username || state?.user?.id || '—'")
    expect(client).not.toContain('state.usage)')
    expect(client).not.toContain("h('div', { className: 'dshEnterpriseCard' }, status, accountContent, errorPanel)")
    expect(client).toContain('const usage = state.usage')
    expect(client).not.toContain('state.modelUsage?.[model.id]')
    expect(client).toContain("usageLabel: '剩余积分'")
    expect(client).toContain("usageLabel: 'Credits remaining'")
    expect(client).toContain("refresh: '刷新'")
    expect(client).toContain("learnMore: '了解企业版'")
    expect(client).toContain("learnMore: 'Learn about Enterprise'")
    expect(client).toContain("const LEARN_MORE_URL = 'https://dshdesktop.com/zh/enterprise/deployment/'")
    expect(client).toContain("className: 'dshEnterpriseLearnMoreShell'")
    expect(client).toContain("className: 'dshEnterpriseLearnMore'")
    expect(client).toContain("window.open(LEARN_MORE_URL, '_blank', 'noopener,noreferrer')")
    expect(client).toContain('.dshEnterpriseTitleRow {')
    expect(client).toContain('.dshEnterpriseTitleRow h2 {')
    expect(client).toContain('color: var(--dsw-alias-label-primary);')
    expect(client).toContain('font-size: 18px;')
    expect(client).toContain('font-weight: 600;')
    expect(client).toContain('.dshEnterpriseLearnMoreShell {')
    expect(client).toContain('color: var(--dsw-alias-label-primary);')
    expect(client).toContain('background: var(--dsw-alias-interactive-bg-hover);')
    expect(client).not.toContain("background: '#fff'")
    expect(client).not.toContain('body[data-ds-dark-theme] .dshEnterpriseLearnMoreShell')
    expect(client).toContain('border: 1px solid var(--ds-border, #ccd0d5);')
    expect(client).toContain("className: 'dshEnterpriseIconButton'")
    expect(client).toContain("'aria-label': t('refresh')")
    expect(client).toContain("loginAgain: '重新登录'")
    expect(client).toContain("loginAgain: 'Sign in again'")
    expect(client).toContain('dshEnterprisePendingSpinner')
    expect(client).toContain('@keyframes dshEnterprisePendingSpin')
    expect(client).toContain("role: 'status'")
    expect(client).toContain("state?.phase === 'authorizing' ? t('loginAgain') : t('login')")
    expect(client).toContain('@media (prefers-reduced-motion: reduce)')
    expect(client).toContain("h('span', { 'aria-hidden': 'true' }, '↻')")
    expect(client).toContain('.dshEnterpriseButton.login {')
    expect(client).toContain("className: 'dshEnterpriseButton login'")
    expect(client).toContain('disabled: busy || !base.trim()')
    expect(client).toContain("const inspected = await api('/api/enterprise.base.inspect', { base })")
    expect(client).toContain('inspected.insecurePrivateHttp')
    expect(client).toContain('confirmInsecurePrivateHttp: true')
    expect(client).toContain("insecureTitle: '确保服务地址可信'")
    expect(client).toContain("insecureLead: '登录信息会明文传输，确保以下服务地址由可信来源提供。'")
    expect(client).toContain("insecureConfirm: '确认为可信来源'")
    expect(client).toContain("insecureTitle: 'Make sure the service URL is trusted'")
    expect(client).toContain("insecureConfirm: 'Confirm as a trusted source'")
    expect(client).not.toContain("h('button', { className: 'dshEnterpriseButton primary', disabled: busy || !base.trim()")
    expect(client).toContain('formatEnterpriseSettingsError(error, errorCode, t)')
    expect(client).toContain('formatEnterpriseSettingsError(state?.error, state?.errorCode, t)')
    expect(client).not.toContain('state?.requestId')
    expect(client).not.toContain("t('requestId')")
    const formatterSource = client.slice(
      client.indexOf('const LEGACY_ACCOUNT_PHRASES'),
      client.indexOf('function failureParts')
    )
    expect(formatterSource).toContain('function formatEnterpriseSettingsError')
    const formatSettingsError = new Function(`${formatterSource}; return formatEnterpriseSettingsError`)() as (
      failure: unknown,
      errorCode: unknown,
      t: (key: string) => string
    ) => string
    const zhCopy = new Function(`return ${client.match(/const zh = (\{[\s\S]*?\n    \})/)?.[1]}`)() as Record<string, string>
    const enCopy = new Function(`return ${client.match(/const en = (\{[\s\S]*?\n    \})/)?.[1]}`)() as Record<string, string>
    expect(zhCopy.noModels).toBe(NO_MODELS_COPY.zh)
    expect(enCopy.noModels).toBe(NO_MODELS_COPY.en)
    for (const [code, copy] of Object.entries(ACCOUNT_ERROR_COPY)) {
      expect(zhCopy[code]).toBe(copy.zh)
      expect(enCopy[code]).toBe(copy.en)
    }
    for (const phrase of Object.keys(LEGACY_ACCOUNT_PHRASES)) {
      expect(formatterSource).toContain(`'${phrase}'`)
    }
    const zhT = (key: string) => zhCopy[key] ?? key
    expect(formatSettingsError('seat revoked.', 'seat_revoked', zhT)).toBe(ACCOUNT_ERROR_COPY.seat_revoked?.zh)
    expect(formatSettingsError('unknown upstream', 'seat_revoked', zhT)).toBe(ACCOUNT_ERROR_COPY.seat_revoked?.zh)
    expect(formatSettingsError('internal error', undefined, zhT)).toBe(ACCOUNT_ERROR_COPY.internal_error?.zh)
    expect(formatSettingsError('raw platform text', 'internal_error', zhT)).toBe(ACCOUNT_ERROR_COPY.internal_error?.zh)
    expect(formatSettingsError('账户额度不足，请联系服务商咨询用量限制。', undefined, zhT))
      .toBe('账户额度不足，请联系服务商咨询用量限制。')
    expect(formatSettingsError('<html><body>secret</body></html>', 'unknown_error', zhT))
      .toBe(ACCOUNT_ERROR_COPY.invalid_response?.zh)
    expect(formatSettingsError('seat not assigned', 'unknown_error', zhT)).toBe('seat not assigned')
    for (const [copy, language] of [[zhCopy, 'zh'], [enCopy, 'en']] as const) {
      const t = (key: string) => copy[key] ?? key
      expect(formatSettingsError('upstream message', 'seat_not_assigned', t)).toBe(ACCOUNT_ERROR_COPY.seat_not_assigned?.[language])
      expect(formatSettingsError('seat not assigned', undefined, t)).toBe(ACCOUNT_ERROR_COPY.seat_not_assigned?.[language])
      expect(formatSettingsError(' Seat not assigned. ', 'request_failed', t)).toBe(ACCOUNT_ERROR_COPY.seat_not_assigned?.[language])
      expect(formatSettingsError('other failure', 'unknown_error', t)).toBe('other failure')
      for (const [phrase, code] of Object.entries(LEGACY_ACCOUNT_PHRASES)) {
        expect(formatSettingsError(phrase, undefined, t)).toBe(ACCOUNT_ERROR_COPY[code]?.[language])
        expect(resolveAccountError(undefined, phrase)).toEqual({ code })
      }
      for (const code of Object.keys(ACCOUNT_ERROR_COPY)) {
        expect(formatSettingsError('raw platform text', code, t)).toBe(ACCOUNT_ERROR_COPY[code]?.[language])
        expect(resolveAccountError(code, 'raw platform text')).toEqual({ code })
      }
    }
  })

  it('waits for connection, llm and loader before applying the Harness adapter', () => {
    expect(enterpriseInject).toEqual(['connection', 'llm', 'loader'])
  })

  it('registers the chat adapter from settings state reads instead of waiting for the idle poll', async () => {
    const source = await readFile(
      path.join(projectRoot, 'packages', 'dsh-desktop-enterprise', 'index.js'),
      'utf8'
    )
    expect(source).toContain('ingestEnterpriseState(state)')
    expect(source).toContain('const delay = [\'authorizing\', \'refreshing\'].includes(latest.phase)')
    expect(source).not.toContain('!modelsAvailable ||')
  })

  it('does not override enterprise service inject from the desktop patch', async () => {
    const desktopPatch = (await readFile(
      path.join(projectRoot, 'build', 'dsh-desktop.patch.yml'),
      'utf8'
    )).replaceAll('\r\n', '\n')
    const start = desktopPatch.indexOf('- id: dsh-desktop-enterprise')
    expect(start).toBeGreaterThanOrEqual(0)
    const rest = desktopPatch.slice(start)
    const nextPlugin = rest.search(/\n[ \t]*- id:/u)
    const enterpriseBlock = nextPlugin === -1 ? rest : rest.slice(0, nextPlugin)
    expect(enterpriseBlock).toContain('name: dsh-desktop-enterprise')
    expect(enterpriseBlock).not.toMatch(/\binject:/u)
  })
})
