import { createHash } from 'node:crypto'
import { parseWorkSkillRequest, readSkillBytes } from './work-skills'
import { parseWorkResourceRequest, readResourceJson } from './work-resources'
import { parseWorkMcpRequest, sendWorkMcp } from './work-mcp'
import { parseWebSession, type EnterpriseWebSession } from './web-session'
import { parseMarketRequest } from './enterprise-market'
import { parseEnterpriseResponsesPayload } from './enterprise-responses'
import { discardWorkbenchArtifact, rememberWorkbenchArtifact, releaseWorkbenchArtifact as releaseRetainedWorkbenchArtifact, verifyWorkbenchArtifactResponse, WORKBENCH_ARTIFACT_LIMIT } from './workbench-artifact'
import { randomUUID } from 'node:crypto'
import { EnterpriseAuthError, EnterpriseAuthTransport, type EnterpriseAuthState } from './enterprise-auth'
import { createEnterpriseFetch } from './platform-fetch'
import { resolveEnterpriseEndpoint } from './enterprise-request'
import type { ServerResponse } from 'node:http'
import type { AuditContextField } from 'dsh-desktop-enterprise/contract'
import {
  CHAT_HEADER_TIMEOUT_MS,
  CHAT_IDLE_TIMEOUT_MS,
  CHAT_MAX_CONCURRENT,
  CHAT_TOTAL_TIMEOUT_MS,
  desktopChatAbortError,
  enterpriseHeaderTimeoutAbortReason,
  enterpriseSessionChangedAbortReason,
  isSseContentType,
  parseEnterpriseChatPayload
} from './enterprise-chat'
import {
  hashEnterpriseOrigin,
  isInvalidRefreshError,
  isTransientPlatformError,
  loadEnterpriseContract,
  requestEnterpriseJson,
  requestEnterpriseStream,
  EnterprisePlatformError
} from './enterprise-request'
import {
  ENTERPRISE_CALLBACK_FLOW_TIMEOUT_MS,
  startLoginCallbackServer,
  type EnterpriseLoginCallbackServer,
  type LoginCallbackAccepted
} from './login-callback-server'
import type { EnterpriseFetch } from './platform-fetch'
import {
  EnterpriseVaultError,
  type EnterpriseCredentialSession,
  type SecureEnterpriseCredentialVault
} from './secure-credential-vault'

export type EnterprisePhase =
  | 'disabled'
  | 'idle'
  | 'authorizing'
  | 'refreshing'
  | 'connected'
  | 'degraded'
  | 'reauthRequired'
  | 'error'

export interface EnterprisePublicIdentity {
  id?: string
  username?: string
  display_name?: string
  name?: string
}

export interface EnterprisePublicUsage {
  source?: 'live' | 'persisted' | 'unavailable'
  quota_state?: 'available' | 'exhausted' | 'unavailable'
  used?: number | null
  limit?: number | null
  remaining?: number | null
  as_of?: string | null
  month?: string
  billing_timezone?: string
  period_start?: string
  reset_at?: string
}

export interface EnterprisePublicModel {
  id: string
  display_name: string
  reasoning?: { efforts: Array<{ id: string; name: string }>; defaultEffort?: string }
  capabilities: {
    streaming: boolean
    tools: boolean
    reasoning_content: boolean
    vision?: boolean
    responses?: boolean
  }
}

export interface EnterprisePublicState {
  connected: boolean
  secureStorageAvailable: boolean
  phase: EnterprisePhase
  revision: number
  models: EnterprisePublicModel[]
  modelsAvailable: boolean
  base?: string
  user?: EnterprisePublicIdentity
  tenant?: EnterprisePublicIdentity
  usage?: EnterprisePublicUsage
  modelUsage?: Record<string, EnterprisePublicUsage>
  error?: string
  errorCode?: string
  requestId?: string
  desktopVersion?: string
  connectionKey?: string
  sessionExpiresAt?: string
  loginExpiresAt?: string
  audit_context?: { fields: AuditContextField[] }
  audit_conversation_title?: { version: 1 }
  auditTitleEpoch?: number
}

export interface EnterpriseLoginStartResult {
  authorizationUrl: string
  expiresIn: number
  base: string
}

export interface EnterpriseServiceNote {
  event: string
  status?: number
  requestId?: string
  originHash?: string
  pluginId?: string
  path?: string
  duration?: number
}

export interface EnterpriseServiceOptions {
  desktopVersion?: string
  activateDesktop?: () => Promise<void> | void
  vault: SecureEnterpriseCredentialVault
  fetchImpl: EnterpriseFetch
  allowInsecureLoopback: boolean
  note?: (entry: EnterpriseServiceNote) => void
  onStateChange?: (state: EnterprisePublicState) => void
  now?: () => number
  startCallback?: typeof startLoginCallbackServer
}

interface PendingLogin {
  epoch: number
  authEpoch: number
  base: string
  codeVerifier: string
  state: string
  authId?: string
  expiresAt: number
  callback: EnterpriseLoginCallbackServer
}

const MODELS_INTERVAL_MS = 5 * 60 * 1000
const MODELS_JITTER_MS = 15_000
const DEGRADED_BACKOFF_MS = 30_000
const MAX_DEGRADED_BACKOFF_MS = 5 * 60 * 1000

export class EnterpriseService {
  private mutation: Promise<unknown> = Promise.resolve()
  private refreshInFlight: Promise<EnterprisePublicState> | undefined
  private epoch = 0
  private revision = 0
  private phase: EnterprisePhase
  private session: EnterpriseCredentialSession | null = null
  private vaultGeneration = 0
  private models: EnterprisePublicModel[] = []
  private modelsAvailable = false
  private usage: EnterprisePublicUsage | undefined
  private modelUsage: Record<string, EnterprisePublicUsage> = {}
  private error: string | undefined
  private errorCode: string | undefined
  private requestId: string | undefined
  private pendingLogin: PendingLogin | undefined
  private modelsRefresh: { epoch: number; promise: Promise<void> } | undefined
  private modelsTimer: NodeJS.Timeout | undefined
  private loginExpiryTimer: NodeJS.Timeout | undefined
  private modelsAttempt = 0
  private lastPublicSignature = ''
  private chatInFlight = 0
  private readonly chatControllers = new Set<AbortController>()
  private readonly authenticatedControllers = new Set<AbortController>()
  private allowPrivateHttpForSession = false
  private readonly authTransport = new EnterpriseAuthTransport()
  private readonly authVersionPrefix = randomUUID()
  private authEpoch = 0
  private authEnabled = false
  private auditFields: AuditContextField[] = []
  private auditRefreshGeneration = 0
  private auditTitleAvailable = false
  private auditTitleInFlight = false

  constructor(private readonly options: EnterpriseServiceOptions) {
    this.phase = options.vault.available ? 'idle' : 'disabled'
    if (!options.vault.available) {
      this.error = options.vault.unavailableReason ?? 'Operating-system secure storage is unavailable.'
    }
  }

  async readState(): Promise<EnterprisePublicState> {
    await this.expirePendingLoginIfDue()
    return this.snapshot()
  }

  snapshot(): EnterprisePublicState {
    const connected = Boolean(this.session?.access_token) && (this.phase === 'connected' || this.phase === 'degraded' || this.phase === 'refreshing')
    return {
      connected,
      ...(connected && this.auditFields.length ? { audit_context: { fields: [...this.auditFields] } } : {}),
      ...(connected && this.auditTitleAvailable ? { audit_conversation_title: { version: 1 as const }, auditTitleEpoch: this.epoch } : {}),
      secureStorageAvailable: this.options.vault.available,
      phase: this.phase,
      revision: this.revision,
      desktopVersion: this.options.desktopVersion,
      ...(this.session?.access_token ? { connectionKey: this.connectionKey() } : {}),
      ...(this.session?.session_expires_at ? { sessionExpiresAt: this.session.session_expires_at } : {}),
      models: this.models.map((model) => ({
        id: model.id,
        display_name: model.display_name,
        ...(model.reasoning === undefined ? {} : { reasoning: structuredClone(model.reasoning) }),
        capabilities: { ...model.capabilities }
      })),
      modelsAvailable: this.modelsAvailable && (this.phase === 'connected' || this.phase === 'refreshing'),
      ...(this.session?.base ? { base: this.session.base } : {}),
      ...(publicIdentity(this.session?.user) ? { user: publicIdentity(this.session?.user) } : {}),
      ...(publicIdentity(this.session?.tenant) ? { tenant: publicIdentity(this.session?.tenant) } : {}),
      ...(this.usage ? { usage: { ...this.usage } } : {}),
      ...(Object.keys(this.modelUsage).length > 0 ? { modelUsage: { ...this.modelUsage } } : {}),
      ...(this.error ? { error: this.error } : {}),
      ...(this.error && this.errorCode ? { errorCode: this.errorCode } : {}),
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.pendingLogin?.expiresAt
        ? { loginExpiresAt: new Date(this.pendingLogin.expiresAt).toISOString() }
        : {})
    }
  }

  async restore(): Promise<void> {
    if (!this.options.vault.available) return
    try {
      const stored = await this.options.vault.read()
      this.vaultGeneration = stored.generation
      if (!stored.session) return
      this.session = stored.session
      this.authEnabled = true
      const { isInsecurePrivateHttpOrigin } = await import('dsh-desktop-enterprise/deep-link')
      this.allowPrivateHttpForSession = isInsecurePrivateHttpOrigin(stored.session.base ?? '')
      this.phase = 'connected'
      await this.refreshAuditCapability()
      this.clearError()
      this.publish()
      this.scheduleModels(0)
    } catch (error) {
      this.session = null
      this.allowPrivateHttpForSession = false
      this.phase = 'error'
      this.error = error instanceof EnterpriseVaultError
        ? error.message
        : 'Enterprise credential vault could not be opened.'
      this.errorCode = undefined
      this.publish()
    }
  }

  async inspectBase(baseValue: string): Promise<{ base: string, insecurePrivateHttp?: boolean }> {
    const { isInsecurePrivateHttpOrigin, normalizeEnterpriseServerUrl } = await import(
      'dsh-desktop-enterprise/deep-link'
    )
    const base = normalizeEnterpriseServerUrl(baseValue, {
      ...this.platformRequestOptions(),
      allowInsecurePrivateHttp: true
    })
    return {
      base,
      ...(isInsecurePrivateHttpOrigin(base) ? { insecurePrivateHttp: true } : {})
    }
  }

  async startLogin(
    baseValue: string,
    options: { confirmInsecurePrivateHttp?: boolean } = {}
  ): Promise<EnterpriseLoginStartResult> {
    this.invalidateAuthSession()
    const authEpoch = this.authEpoch
    return this.enqueueMutation(async () => {
      if (!this.options.vault.available) {
        throw Object.assign(new Error(this.options.vault.unavailableReason ?? 'Secure storage is unavailable.'), {
          status: 503
        })
      }
      const { isInsecurePrivateHttpOrigin, normalizeEnterpriseServerUrl } = await import(
        'dsh-desktop-enterprise/deep-link'
      )
      const preview = normalizeEnterpriseServerUrl(baseValue, {
        ...this.platformRequestOptions(),
        allowInsecurePrivateHttp: true
      })
      if (isInsecurePrivateHttpOrigin(preview) && options.confirmInsecurePrivateHttp !== true) {
        throw Object.assign(new Error('HTTP intranet addresses require explicit confirmation.'), {
          status: 400
        })
      }
      const base = normalizeEnterpriseServerUrl(baseValue, {
        ...this.platformRequestOptions(),
        allowInsecurePrivateHttp: options.confirmInsecurePrivateHttp === true
      })
      this.allowPrivateHttpForSession = isInsecurePrivateHttpOrigin(base)
      const contract = await loadEnterpriseContract()
      await this.cancelPendingLogin()
      this.epoch += 1
      for (const controller of this.chatControllers) controller.abort(enterpriseSessionChangedAbortReason())
      this.chatControllers.clear()
      for (const controller of this.authenticatedControllers) controller.abort(enterpriseSessionChangedAbortReason())
      this.authenticatedControllers.clear()
      const loginEpoch = this.epoch
      this.pauseSessionForRelogin()
      const config = contract.parseConfig((await requestEnterpriseJson(
        this.options.fetchImpl, base, contract.API_PATHS.config, this.platformRequestOptions()
      )).body)
      if (!config.enabled) throw Object.assign(new Error('Enterprise login is disabled.'), { status: 503 })
      const pkce = contract.createPkceTransaction()
      let expectedAuthId: string | undefined
      const callback = await (this.options.startCallback ?? startLoginCallbackServer)({
        expectedState: pkce.state,
        expectedAuthId: () => expectedAuthId,
        timeoutMs: ENTERPRISE_CALLBACK_FLOW_TIMEOUT_MS,
        onAccepted: (result) => {
          void this.completeLogin(loginEpoch, result)
        },
        onExpired: () => {
          void this.expirePendingLoginIfDue()
        }
      })
      try {
        const authorization = contract.parseAuthorization(
          (
            await requestEnterpriseJson(this.options.fetchImpl, base, contract.API_PATHS.authorizations, {
              method: 'POST',
              ...this.platformRequestOptions(),
              body: {
                client_id: contract.CLIENT_ID,
                redirect_uri: callback.redirectUri,
                code_challenge: pkce.codeChallenge,
                code_challenge_method: 'S256',
                state: pkce.state,
                device_name: 'BISHENG',
                ...(this.options.desktopVersion ? { client_version: this.options.desktopVersion } : {})
              }
            })
          ).body,
          base
        )
        expectedAuthId = authorization.auth_id
        const lifetimeMs = Math.min(authorization.expires_in * 1000, ENTERPRISE_CALLBACK_FLOW_TIMEOUT_MS)
        const expiresAt = this.now() + lifetimeMs
        callback.alignTimeout(lifetimeMs)
        this.pendingLogin = {
          epoch: loginEpoch,
          authEpoch,
          base,
          codeVerifier: pkce.codeVerifier,
          state: pkce.state,
          authId: authorization.auth_id,
          expiresAt,
          callback
        }
        this.scheduleLoginExpiry(loginEpoch)
        this.phase = 'authorizing'
        this.session = this.session ? { ...this.session, base } : { base }
        this.clearError()
        this.publish()
        this.note('login_started', { originHash: hashEnterpriseOrigin(base) })
        return {
          authorizationUrl: authorization.authorize_url,
          expiresIn: authorization.expires_in,
          base
        }
      } catch (error) {
        this.clearLoginExpiryTimer()
        await callback.close()
        if (this.epoch === loginEpoch) this.pendingLogin = undefined
        this.rememberRequest(error)
        if (!this.session?.access_token) this.phase = this.options.vault.available ? 'idle' : 'disabled'
        this.publish()
        throw error
      }
    })
  }

  async submitManualTicket(identityTicket: string): Promise<EnterprisePublicState> {
    return this.enqueueMutation(async () => {
      const pending = this.pendingLogin
      if (!pending?.authId || this.phase !== 'authorizing') {
        throw Object.assign(new Error('No enterprise login is waiting for a code.'), { status: 409 })
      }
      const ticket = identityTicket.trim()
      if (!ticket || Buffer.byteLength(ticket) > 32 * 1024) {
        throw Object.assign(new Error('The one-time login code is invalid.'), { status: 400 })
      }
      await this.completeLoginLocked(pending.epoch, {
        authId: pending.authId,
        state: pending.state,
        identityTicket: ticket
      })
      return this.snapshot()
    })
  }

  async refresh(): Promise<EnterprisePublicState> {
    if (this.refreshInFlight) return this.refreshInFlight
    this.refreshInFlight = this.enqueueMutation(async () => this.refreshLocked()).finally(() => {
      this.refreshInFlight = undefined
    })
    return this.refreshInFlight
  }

  /** Synchronize catalog metadata using the current account's host-held credentials. */
  async refreshModels(includeUsage = false): Promise<EnterprisePublicState> {
    const epoch = this.epoch
    let refresh = this.modelsRefresh
    if (refresh?.epoch !== epoch) {
      refresh = { epoch, promise: this.tickModels() }
      this.modelsRefresh = refresh
    }
    try {
      await refresh.promise
    } finally {
      if (this.modelsRefresh === refresh) this.modelsRefresh = undefined
    }
    if (includeUsage && this.epoch === epoch && this.phase === 'connected') {
      await this.refreshUsageCatalog(epoch)
      if (this.epoch === epoch) this.scheduleModels(this.modelsDelay())
    }
    return this.snapshot()
  }

  async logout(): Promise<EnterprisePublicState> {
    this.invalidateAuthSession()
    return this.enqueueMutation(async () => {
      const current = this.session
      await this.cancelPendingLogin()
      if (current?.base && (current.access_token || current.refresh_token)) {
        try {
          const contract = await loadEnterpriseContract()
          await requestEnterpriseJson(this.options.fetchImpl, current.base, contract.API_PATHS.logout, {
            method: 'POST',
            ...this.platformRequestOptions(),
            uncertainOnTransport: true,
            ...(current.access_token
              ? { accessToken: current.access_token }
              : { body: { refresh_token: current.refresh_token } })
          })
        } catch {
          this.note('logout_remote_failed')
        }
      }
      await this.clearLocalSession('idle')
      this.note('logout_committed')
      return this.snapshot()
    })
  }

  async proxyChat(payload: unknown, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const parsed = parseEnterpriseChatPayload(payload, this.auditFields)
    await this.proxyModel(parsed, response, signal)
  }

  async proxyResponses(payload: unknown, response: ServerResponse, signal: AbortSignal): Promise<void> {
    const parsed = parseEnterpriseResponsesPayload(payload, this.auditFields)
    if (parsed.connectionKey !== this.connectionKey()) {
      throw Object.assign(new Error('Enterprise session changed.'), { status: 409 })
    }
    if (!this.models.some((model) => model.id === parsed.model && model.capabilities.responses === true)) {
      throw Object.assign(new Error('Native Responses is unavailable for this model.'), { status: 403 })
    }
    await this.proxyModel(parsed, response, signal)
  }

  private async proxyModel(parsed: ReturnType<typeof parseEnterpriseChatPayload> | ReturnType<typeof parseEnterpriseResponsesPayload>, response: ServerResponse, signal: AbortSignal): Promise<void> {
    if (!this.session?.base || !this.session.access_token || !this.modelsAvailable) {
      throw Object.assign(new Error('Enterprise models are unavailable.'), { status: 409 })
    }
    if (!this.models.some((model) => model.id === parsed.model)) {
      throw Object.assign(new Error('Model is not assigned to this account.'), { status: 403 })
    }
    if (this.chatInFlight >= CHAT_MAX_CONCURRENT) {
      throw Object.assign(new Error('Too many enterprise chats.'), { status: 429 })
    }
    const epoch = this.epoch
    const sessionController = new AbortController()
    this.chatControllers.add(sessionController)
    this.chatInFlight += 1
    try {
      await this.runChat(parsed, response, signal, sessionController.signal, epoch, false)
    } finally {
      this.chatControllers.delete(sessionController)
      this.chatInFlight -= 1
    }
  }

  async stop(): Promise<void> {
    this.invalidateAuthSession()
    this.auditFields = []
    await this.cancelPendingLogin()
    this.clearModelsTimer()
    this.epoch += 1
    for (const controller of this.chatControllers) controller.abort(enterpriseSessionChangedAbortReason())
    this.chatControllers.clear()
    for (const controller of this.authenticatedControllers) controller.abort(enterpriseSessionChangedAbortReason())
    this.authenticatedControllers.clear()
  }

  private async completeLogin(expectedEpoch: number, result: LoginCallbackAccepted): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.completeLoginLocked(expectedEpoch, result)
    })
  }

  private async completeLoginLocked(expectedEpoch: number, result: LoginCallbackAccepted): Promise<void> {
    const pending = this.pendingLogin
    if (!pending || pending.epoch !== expectedEpoch || this.epoch !== expectedEpoch) return
    this.clearLoginExpiryTimer()
    this.pendingLogin = undefined
    await pending.callback.close().catch(() => undefined)
    if (result.error || !result.identityTicket) {
      this.phase = this.session?.access_token ? 'connected' : 'idle'
      if (
        result.error === 'access_denied' ||
        result.error === 'authorization_expired' ||
        result.error === 'authorization_failed'
      ) {
        this.error = result.error
        this.errorCode = result.error
      } else {
        this.error = 'Enterprise login was cancelled.'
        this.errorCode = undefined
      }
      this.publish()
      this.note('login_cancelled')
      return
    }
    this.phase = 'refreshing'
    this.publish()
    try {
      const contract = await loadEnterpriseContract()
      const token = contract.parseToken(
        (
          await requestEnterpriseJson(this.options.fetchImpl, pending.base, contract.API_PATHS.token, {
            method: 'POST',
            ...this.platformRequestOptions(),
            body: {
              grant_type: 'identity_ticket',
              identity_ticket: result.identityTicket,
              auth_id: result.authId,
              code_verifier: pending.codeVerifier
            }
          })
        ).body,
        pending.base,
        this.now()
      )
      if (this.epoch !== expectedEpoch) return
      await this.commitSession(token as EnterpriseCredentialSession, expectedEpoch)
      if (this.authEpoch === pending.authEpoch && this.session?.access_token) this.authEnabled = true
      await this.syncCatalog(expectedEpoch, { includeUsage: true })
      this.note('login_committed', { originHash: hashEnterpriseOrigin(pending.base) })
      try {
        await this.options.activateDesktop?.()
      } catch {
        // A window activation failure must not invalidate a committed login.
        this.note('desktop_activation_failed')
      }
    } catch (error) {
      if (this.epoch !== expectedEpoch) return
      this.rememberRequest(error)
      this.phase = 'idle'
      this.publish()
      this.note('login_failed', noteFromError(error))
    }
  }

  private async refreshLocked(): Promise<EnterprisePublicState> {
    if (!this.session?.base || !this.session.refresh_token) {
      throw Object.assign(new Error('No enterprise session is available to refresh.'), { status: 409 })
    }
    if (this.phase === 'disabled' || this.phase === 'reauthRequired') {
      throw Object.assign(new Error(this.error ?? 'Enterprise login is disabled.'), { status: 503 })
    }
    const epoch = this.epoch
    const generation = this.vaultGeneration
    this.phase = 'refreshing'
    this.clearError()
    this.publish()
    try {
      const contract = await loadEnterpriseContract()
      const token = contract.parseToken(
        (
          await requestEnterpriseJson(this.options.fetchImpl, this.session.base, contract.API_PATHS.token, {
            method: 'POST',
            ...this.platformRequestOptions(),
            body: {
              grant_type: 'refresh_token',
              refresh_token: this.session.refresh_token
            }
          })
        ).body,
        this.session.base,
        this.now()
      )
      if (this.epoch !== epoch) return this.snapshot()
      await this.commitSession(token as EnterpriseCredentialSession, epoch, generation)
      await this.syncCatalog(epoch, { includeUsage: true })
      this.note('refresh_committed')
      return this.snapshot()
    } catch (error) {
      if (this.epoch !== epoch) return this.snapshot()
      this.rememberRequest(error)
      if (isInvalidRefreshError(error)) {
        await this.endSessionKeepingError('idle')
        this.note('refresh_invalid', noteFromError(error))
        return this.snapshot()
      }
      if (isTransientPlatformError(error)) {
        this.phase = this.session ? 'degraded' : 'idle'
        this.modelsAvailable = false
        this.publish()
        this.scheduleModels(this.degradedDelay())
        this.note('refresh_degraded', noteFromError(error))
        return this.snapshot()
      }
      this.phase = this.session ? 'degraded' : 'error'
      this.publish()
      this.note('refresh_failed', noteFromError(error))
      throw error
    }
  }

  private async commitSession(
    session: EnterpriseCredentialSession,
    expectedEpoch: number,
    expectedGeneration = this.vaultGeneration
  ): Promise<void> {
    if (this.epoch !== expectedEpoch) return
    try {
      const stored = await this.options.vault.replace(expectedGeneration, session)
      if (this.epoch !== expectedEpoch) return
      this.vaultGeneration = stored.generation
      this.session = stored.session
      this.clearError()
      this.modelsAttempt = 0
      // Leave phase as refreshing; syncCatalog flips to connected after usage.
    } catch {
      this.invalidateAuthSession()
      this.session = null
      this.auditFields = []
      this.allowPrivateHttpForSession = false
      this.models = []
      this.modelsAvailable = false
      this.usage = undefined
      this.modelUsage = {}
      this.phase = 'reauthRequired'
      this.error = 'Enterprise credentials could not be saved. Sign in again.'
      this.errorCode = undefined
      this.clearModelsTimer()
      this.publish()
      try {
        await this.options.vault.clear()
      } catch {
        // Isolation of the previous vault is best-effort.
      }
      this.note('vault_write_failed')
    }
  }

  private async syncCatalog(expectedEpoch: number, options: { includeUsage: boolean }): Promise<void> {
    if (this.epoch !== expectedEpoch || !this.session?.base || !this.session.access_token) return
    const contract = await loadEnterpriseContract()
    await this.refreshAuditCapability()
    if (this.epoch !== expectedEpoch) return
    try {
      const modelsResult = await requestEnterpriseJson(
        this.options.fetchImpl,
        this.session.base,
        contract.API_PATHS.models,
        {
          accessToken: this.session.access_token,
          ...this.platformRequestOptions()
        }
      )
      if (this.epoch !== expectedEpoch) return
      const parsedModels = contract.parseModelsLenient(modelsResult.body)
      this.models = parsedModels.map((model) => ({
        id: model.id,
        display_name: model.display_name,
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        capabilities: model.capabilities
      }))
      this.modelsAvailable = this.models.length > 0
      const seededUsage: Record<string, EnterprisePublicUsage> = {}
      for (const model of parsedModels) {
        if (model.usage) seededUsage[model.id] = model.usage
      }
      if (Object.keys(seededUsage).length > 0) {
        this.modelUsage = { ...this.modelUsage, ...seededUsage }
      }
      this.publish()
      this.rememberRequest(undefined, modelsResult.requestId)
    } catch (error) {
      if (this.epoch !== expectedEpoch) return
      this.modelsAvailable = false
      this.rememberRequest(error)
      if (isTransientPlatformError(error)) this.phase = 'degraded'
    }
    if (options.includeUsage) await this.refreshUsageCatalog(expectedEpoch)
    if (this.epoch !== expectedEpoch) return
    if (this.phase === 'refreshing') this.phase = 'connected'
    if (this.phase === 'connected' || this.phase === 'degraded') this.scheduleModels(this.modelsDelay())
    this.publish()
  }

  private async tickModels(accessRetried = false): Promise<void> {
    if (!this.session?.base || !this.session.access_token) return
    const epoch = this.epoch
    try {
      const contract = await loadEnterpriseContract()
      let accessToken = this.session.access_token
      if (contract.accessNeedsRefresh(this.session as { access_expires_at: string }, this.now())) {
        await this.refresh()
        if (this.epoch !== epoch || !this.session?.access_token) return
        accessToken = this.session.access_token
      }
      const modelsResult = await requestEnterpriseJson(
        this.options.fetchImpl,
        this.session.base,
        contract.API_PATHS.models,
        {
          accessToken,
          ...this.platformRequestOptions()
        }
      )
      if (this.epoch !== epoch) return
      const parsedModels = contract.parseModelsLenient(modelsResult.body)
      this.models = parsedModels.map((model) => ({
        id: model.id,
        display_name: model.display_name,
        ...(model.reasoning === undefined ? {} : { reasoning: model.reasoning }),
        capabilities: model.capabilities
      }))
      this.modelsAvailable = this.models.length > 0
      if (this.phase === 'degraded') this.phase = 'connected'
      this.modelsAttempt = 0
      this.clearError()
      this.publish()
    } catch (error) {
      if (this.epoch !== epoch) return
      if (!accessRetried && error instanceof EnterprisePlatformError && error.code === 'invalid_access_token') {
        try {
          await this.refresh()
        } catch {
          return
        }
        if (this.epoch !== epoch || !this.session?.access_token) return
        await this.tickModels(true)
        return
      }
      if (isInvalidRefreshError(error)) {
        await this.enqueueMutation(async () => this.endSessionKeepingError('idle', error))
        return
      }
      this.modelsAvailable = false
      this.phase = this.session ? 'degraded' : this.phase
      this.rememberRequest(error)
      this.publish()
      this.modelsAttempt += 1
      this.scheduleModels(this.degradedDelay())
    }
  }

  private async runChat(
    parsed: ReturnType<typeof parseEnterpriseChatPayload> | ReturnType<typeof parseEnterpriseResponsesPayload>,
    response: ServerResponse,
    callerSignal: AbortSignal,
    sessionSignal: AbortSignal,
    epoch: number,
    retried: boolean
  ): Promise<void> {
    if (this.epoch !== epoch) throw enterpriseSessionChangedAbortReason()
    const accessToken = await this.ensureAccess(epoch)
    const contract = await loadEnterpriseContract()
    const totalTimeout = AbortSignal.timeout(CHAT_TOTAL_TIMEOUT_MS)
    const headerController = new AbortController()
    const headerTimer = setTimeout(() => headerController.abort(enterpriseHeaderTimeoutAbortReason()), CHAT_HEADER_TIMEOUT_MS)
    const lifetime = AbortSignal.any([callerSignal, sessionSignal])
    const upstreamSignal = AbortSignal.any([lifetime, headerController.signal, totalTimeout])
    let upstream: Response
    try {
      upstream = await requestEnterpriseStream(
        this.options.fetchImpl,
        this.session!.base!,
        'protocol' in parsed ? contract.API_PATHS.responses : contract.API_PATHS.chat,
        {
          body: parsed.request,
          accessToken,
          signal: upstreamSignal,
          ...this.platformRequestOptions(),
          attribution: parsed.attribution
        }
      )
    } catch (error) {
      const classified = desktopChatAbortError(upstreamSignal.reason)
      if (classified !== undefined) throw classified
      throw error
    } finally {
      clearTimeout(headerTimer)
    }
    if (upstream.status === 401 && !retried && !response.headersSent) {
      await upstream.body?.cancel().catch(() => undefined)
      await this.refresh()
      if (this.epoch !== epoch) throw enterpriseSessionChangedAbortReason()
      await this.runChat(parsed, response, callerSignal, sessionSignal, epoch, true)
      return
    }
    const contentType = upstream.headers.get('content-type')
    if (!upstream.ok || !isSseContentType(contentType)) {
      const text = await this.boundedResponseText(upstream)
      this.handleChatStatus(upstream.status, text, parsed.model, epoch)
      this.writeForwarded(response, upstream, text)
      return
    }
    await this.pipeSse(upstream, response, lifetime, 'protocol' in parsed)
    if (this.epoch === epoch) void this.syncUsage(epoch, parsed.model)
  }

  private connectionKey(): string {
    return hashEnterpriseOrigin(JSON.stringify([this.session?.base, this.session?.tenant?.id, this.session?.user?.id]))
  }

  authState(): EnterpriseAuthState {
    const connected = this.authEnabled && Boolean(this.session?.base && this.session.access_token) &&
      ['connected', 'degraded', 'refreshing'].includes(this.phase) &&
      (this.session?.session_expires_at === undefined || Date.parse(this.session.session_expires_at) > this.now())
    return {
      connected,
      sessionVersion: this.authVersionPrefix + ':' + this.authEpoch,
      ...(connected && this.session?.tenant?.id ? { enterpriseId: this.session.tenant.id } : {}),
      ...(connected && this.session?.user?.id ? { userId: this.session.user.id } : {})
    }
  }

  private invalidateAuthSession(): void {
    this.authEpoch += 1
    this.authEnabled = false
    this.authTransport.invalidate()
  }

  async authRequest(plugin: { pluginId: string; instanceId: string }, input: unknown, signal: AbortSignal): Promise<Response> {
    const epoch = this.epoch
    const assertSession = (version: string) => {
      const state = this.authState()
      if (state.sessionVersion !== version) throw new EnterpriseAuthError('session_changed', 409)
      if (!state.connected) throw new EnterpriseAuthError('not_connected', 401)
    }
    return this.authTransport.request(plugin, input, signal, {
      assertSession,
      access: async request => {
        const accessToken = await this.ensureAccess(epoch)
        assertSession(request.sessionVersion)
        const base = this.session?.base
        if (!base) throw new EnterpriseAuthError('not_connected', 401)
        const { endpoint } = await resolveEnterpriseEndpoint(base, request.path,
          this.options.allowInsecureLoopback, this.platformRequestOptions().allowInsecurePrivateHttp)
        assertSession(request.sessionVersion)
        if (endpoint.origin !== new URL(base).origin) throw new EnterpriseAuthError('invalid_request', 400)
        return { endpoint: endpoint.toString(), accessToken }
      },
      fetch: this.options.fetchImpl,
      audit: entry => this.note('auth_request', entry)
    })
  }

  async reportAuditTitle(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const invalid = () => Object.assign(new Error('Invalid audit title request.'), { status: 400 })
    if (!input || typeof input !== 'object' || Array.isArray(input) ||
        Object.keys(input).sort().join(',') !== 'auditTitleEpoch,connectionKey,update') throw invalid()
    const request = input as Record<string, unknown>
    const contract = await loadEnterpriseContract()
    let update
    try { update = contract.parseAuditTitleUpdate(request.update) } catch { throw invalid() }
    const epoch = this.epoch
    const assertConnection = () => {
      if (!this.session?.base || !this.snapshot().connected || !this.auditTitleAvailable ||
          epoch !== this.epoch || request.auditTitleEpoch !== epoch || request.connectionKey !== this.connectionKey() ||
          (this.session.session_expires_at !== undefined && !(Date.parse(this.session.session_expires_at) > this.now()))) {
        throw Object.assign(new Error('Enterprise audit title connection changed.'), { status: 409 })
      }
      signal?.throwIfAborted()
    }
    const controller = new AbortController()
    assertConnection()
    if (this.auditTitleInFlight) throw Object.assign(new Error('Audit title synchronization busy.'), { status: 429 })
    this.auditTitleInFlight = true
    this.chatControllers.add(controller)
    const combined = AbortSignal.any([controller.signal, ...(signal ? [signal] : [])])
    try {
      assertConnection()
      for (let attempt = 0; attempt < 2; attempt++) {
        const accessToken = await this.ensureAccess(epoch)
        assertConnection()
        const base = this.session?.base
        if (!base) throw Object.assign(new Error('Enterprise account changed.'), { status: 409 })
        try {
          const result = await requestEnterpriseJson(this.options.fetchImpl, base, contract.API_PATHS.auditTitle, {
            ...this.platformRequestOptions(), method: 'POST', body: update, accessToken, timeoutMs: 5000, signal: combined
          })
          assertConnection()
          const body = result.body
          if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid()
          const value = body as Record<string, unknown>
          if (!['UPDATED', 'UNCHANGED', 'STALE', 'CONFLICT', 'DISABLED', 'NOT_READY'].includes(String(value.status)) ||
              (value.title_event_seq !== undefined && (!Number.isSafeInteger(value.title_event_seq) || Number(value.title_event_seq) < 0))) throw invalid()
          return { status: value.status, ...(value.title_event_seq === undefined ? {} : { title_event_seq: value.title_event_seq }) }
        } catch (error) {
          assertConnection()
          if (error instanceof EnterprisePlatformError && error.status === 401 && attempt === 0) {
            await this.refresh()
            assertConnection()
            continue
          }
          const status = error instanceof EnterprisePlatformError ? error.status ?? 503 : 503
          throw Object.assign(new Error('Audit title synchronization unavailable.'), { status })
        }
      }
    } finally {
      this.auditTitleInFlight = false
      this.chatControllers.delete(controller)
    }
  }

  async marketRequest(input: unknown): Promise<{ bytes: Buffer, binary: boolean }> {
    const request = parseMarketRequest(input)
    const epoch = this.epoch
    const assertConnection = () => {
      if (!this.session?.base || !this.snapshot().connected || (this.session.session_expires_at !== undefined && !(Date.parse(this.session.session_expires_at) > this.now())) ||
          this.epoch !== epoch || this.connectionKey() !== request.connectionKey) {
        throw Object.assign(new Error('Enterprise account changed. Refresh the plugin list.'), { status: 409 })
      }
    }
    assertConnection()
    for (let attempt = 0; attempt < 2; attempt++) {
      const accessToken = await this.ensureAccess(epoch)
      assertConnection()
      const base = this.session?.base
      if (!base) throw Object.assign(new Error('Enterprise account changed.'), { status: 409 })
      const { endpoint } = await resolveEnterpriseEndpoint(base, request.path,
        this.options.allowInsecureLoopback, this.platformRequestOptions().allowInsecurePrivateHttp)
      const response = await createEnterpriseFetch(this.options.fetchImpl)(endpoint.toString(), {
        method: request.body === undefined ? 'GET' : 'POST',
        signal: AbortSignal.timeout(request.binary ? 120_000 : 15_000),
        headers: { authorization: `Bearer ${accessToken}`, ...(request.body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(request.body === undefined ? {} : { body: JSON.stringify(request.body) })
      })
      assertConnection()
      if (response.status === 401 && attempt === 0) {
        await response.body?.cancel()
        await this.refresh()
        continue
      }
      if (!response.ok) {
        const code = await readMarketErrorCode(response)
        throw Object.assign(new Error(`Enterprise market request failed (${response.status}).`), {
          status: response.status,
          ...(code ? { code } : {})
        })
      }
      const limit = request.binary ? 512 * 1024 * 1024 : 16 * 1024 * 1024
      const chunks: Uint8Array[] = []
      let length = 0
      if (response.body) for await (const chunk of response.body) {
        assertConnection()
        length += chunk.length
        if (length > limit) throw Object.assign(new Error('Market response exceeds the allowed size.'), { status: 413 })
        chunks.push(chunk)
      }
      assertConnection()
      return { bytes: Buffer.concat(chunks), binary: request.binary }
    }
    throw Object.assign(new Error('Enterprise login required.'), { status: 401 })
  }

  async workSkills(input: unknown, signal?: AbortSignal): Promise<{ bytes: Buffer; binary: boolean }> {
    const request = parseWorkSkillRequest(input)
    const epoch = this.epoch
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (!this.snapshot().connected || this.connectionKey() !== request.connectionKey || this.epoch !== epoch) {
        throw Object.assign(new Error('Enterprise account changed. Select skills again.'), { status: 409 })
      }
    }
    assertCurrent()
    const credential = await this.webSession(request.connectionKey)
    assertCurrent()
    const binary = request.operation === 'bundle'
    const path = binary ? `/api/v1/linsight/skill/runtime/${request.id}/bundle?version=${request.version}`
      : request.operation === 'dependencies' ? `/api/v1/dsh/work/skills/${request.id}/dependencies?version=${request.version}`
      : '/api/v1/linsight/skill/runtime/catalog'
    const { endpoint } = await resolveEnterpriseEndpoint(credential.base, path,
      this.options.allowInsecureLoopback, this.platformRequestOptions().allowInsecurePrivateHttp)
    assertCurrent()
    const timeout = AbortSignal.timeout(120_000)
    const response = await createEnterpriseFetch(this.options.fetchImpl)(endpoint.toString(), {
      method: 'GET', signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      headers: { cookie: `${credential.cookieName}=${credential.cookie}` }
    })
    const bytes = await readSkillBytes(response, binary ? 256 * 1024 * 1024 : 4 * 1024 * 1024)
    assertCurrent()
    if (binary) {
      if (!response.headers.get('content-type')?.includes('application/zip') ||
          createHash('sha256').update(bytes).digest('hex') !== response.headers.get('x-skill-archive-sha256')) throw new Error('Skill bundle verification failed.')
    } else {
      const result = JSON.parse(bytes.toString('utf8'))
      if (result?.status_code !== 200 || !Array.isArray(result.data)) throw new Error('Skill catalog unavailable.')
      return { bytes: Buffer.from(JSON.stringify(result.data)), binary }
    }
    this.options.note?.({ event: 'work_skill_bundle_read', status: 200 })
    return { bytes, binary }
  }

  async workMcp(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = parseWorkMcpRequest(input)
    const epoch = this.epoch
    const controller = new AbortController()
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal
    const assertCurrent = () => {
      combined.throwIfAborted()
      if (!this.snapshot().connected || this.connectionKey() !== request.connectionKey || this.epoch !== epoch) {
        throw Object.assign(new Error('Enterprise account changed. Refresh Work capabilities.'), { status: 409 })
      }
    }
    assertCurrent()
    this.authenticatedControllers.add(controller)
    try {
      // webSession performs the verified Desktop exchange and access refresh.
      const credential = await this.webSession(request.connectionKey)
      assertCurrent()
      const result = await sendWorkMcp({ request, credential, assertCurrent,
        fetchImpl: this.options.fetchImpl, allowInsecureLoopback: this.options.allowInsecureLoopback,
        allowInsecurePrivateHttp: this.platformRequestOptions().allowInsecurePrivateHttp, signal: combined })
      this.options.note?.({ event: 'work_mcp_request', status: 200 })
      return result
    } finally { this.authenticatedControllers.delete(controller) }
  }

  async workResources(input: unknown, signal?: AbortSignal): Promise<unknown> {
    const request = parseWorkResourceRequest(input)
    const epoch = this.epoch
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (!this.snapshot().connected || this.connectionKey() !== request.connectionKey || this.epoch !== epoch) {
        throw Object.assign(new Error('Enterprise account changed. Select knowledge spaces again.'), { status: 409 })
      }
    }
    assertCurrent()
    const credential = await this.webSession(request.connectionKey)
    assertCurrent()
    const call = async (path: string, body?: unknown) => {
      const { endpoint } = await resolveEnterpriseEndpoint(credential.base, path,
        this.options.allowInsecureLoopback, this.platformRequestOptions().allowInsecurePrivateHttp)
      assertCurrent()
      const timeout = AbortSignal.timeout(60_000)
      const response = await createEnterpriseFetch(this.options.fetchImpl)(endpoint.toString(), {
        method: body === undefined ? 'GET' : 'POST',
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        headers: { cookie: `${credential.cookieName}=${credential.cookie}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      const data = await readResourceJson(response)
      assertCurrent()
      return data
    }
    if (request.operation === 'retrieve') {
      const data = await call('/api/v1/knowledge/space/retrieve', { query: request.query, space_ids: request.spaceIds })
      this.options.note?.({ event: 'work_knowledge_retrieved', status: 200 })
      return data
    }
    const spaces: { id: number, name: string, description: string, group: string, updatedAt: string }[] = []
    const seen = new Set<number>()
    for (const group of ['department', 'mine', 'joined']) {
      const data = await call(`/api/v1/knowledge/space/${group}`)
      if (!Array.isArray(data)) throw new Error('Knowledge space list is invalid.')
      for (const row of data) {
        if (!Number.isSafeInteger(row.id) || row.id <= 0 || typeof row.name !== 'string') continue
        if (seen.has(row.id)) continue
        seen.add(row.id)
        spaces.push({ id: row.id, name: row.name, description: typeof row.description === 'string' ? row.description : '', group, updatedAt: typeof row.update_time === 'string' ? row.update_time : '' })
      }
    }
    return { spaces }
  }

  /** Host-only exchange. Credentials never cross the renderer or Harness Broker. */
  async webSession(connectionKey: string): Promise<EnterpriseWebSession> {
    const epoch = this.epoch
    const assertCurrent = () => {
      if (!this.snapshot().connected || this.connectionKey() !== connectionKey || this.epoch !== epoch) {
        throw new Error('Enterprise account changed.')
      }
    }
    assertCurrent()
    let accessToken = await this.ensureAccess(epoch)
    assertCurrent()
    const base = this.session?.base
    if (!base) throw new Error('Enterprise login required.')
    const exchange = () => requestEnterpriseJson(this.options.fetchImpl, base, '/api/v1/dsh/web-session', {
      ...this.platformRequestOptions(), method: 'POST', body: {}, accessToken
    })
    let result
    try { result = await exchange() }
    catch (error) {
      if (!(error instanceof EnterprisePlatformError) || error.status !== 401) throw error
      await this.refresh()
      assertCurrent()
      accessToken = await this.ensureAccess(epoch)
      result = await exchange()
    }
    assertCurrent()
    this.options.note?.({ event: 'web_session_created', status: result.status })
    return parseWebSession(result.body, base, connectionKey, this.now())
  }

  async verifyWorkbenchArtifact(input: unknown): Promise<{ ok: boolean, stage?: string, error?: string }> {
    const result = await this.transferWorkbenchArtifact(input, false)
    if (result.path) await discardWorkbenchArtifact(result.path)
    return result.ok ? { ok: true } : { ok: false, stage: result.stage, error: result.error }
  }

  async materializeWorkbenchArtifact(input: unknown): Promise<{ ok: boolean, path?: string, ticket?: string, connectionKey?: string, stage?: string, error?: string }> {
    const result = await this.transferWorkbenchArtifact(input, true)
    if (!result.ok || !result.path) {
      if (result.path) await discardWorkbenchArtifact(result.path)
      return { ok: false, stage: result.stage, error: result.error }
    }
    const connectionKey = (input as { connectionKey?: unknown }).connectionKey
    if (typeof connectionKey !== 'string' || this.connectionKey() !== connectionKey || !this.snapshot().connected) {
      await discardWorkbenchArtifact(result.path)
      return { ok: false, stage: 'account', error: 'Enterprise account changed.' }
    }
    return { ok: true, path: result.path, ticket: rememberWorkbenchArtifact(result.path, connectionKey), connectionKey }
  }

  async releaseWorkbenchArtifact(input: unknown): Promise<{ ok: true }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: true }
    const value = input as Record<string, unknown>
    if (typeof value.ticket === 'string' && typeof value.connectionKey === 'string') {
      await releaseRetainedWorkbenchArtifact(value.ticket, value.connectionKey)
    }
    return { ok: true }
  }

  private async transferWorkbenchArtifact(input: unknown, retain: boolean): Promise<{ ok: boolean, path?: string, stage?: string, error?: string }> {
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return { ok: false, stage: 'detail', error: 'Workbench artifact metadata is not verifiable.' }
    }
    const value = input as Record<string, unknown>
    const id = value.id
    const versionId = value.versionId
    const sha256 = value.sha256
    const sizeBytes = value.sizeBytes
    const connectionKey = value.connectionKey
    if (typeof id !== 'string' || typeof versionId !== 'string' || typeof sha256 !== 'string' || typeof connectionKey !== 'string' ||
        !/^[a-f0-9]{32}$/u.test(id) || !/^[a-f0-9]{32}$/u.test(versionId) || !/^[a-f0-9]{64}$/u.test(sha256) ||
        !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) <= 0 || (sizeBytes as number) > WORKBENCH_ARTIFACT_LIMIT) {
      return { ok: false, stage: 'detail', error: 'Workbench artifact metadata is not verifiable.' }
    }
    const epoch = this.epoch
    const assertConnection = () => {
      if (!this.session?.base || !this.snapshot().connected || this.epoch !== epoch || this.connectionKey() !== connectionKey) {
        throw Object.assign(new Error('Enterprise account changed.'), { status: 409 })
      }
    }
    try {
      assertConnection()
      const accessToken = await this.ensureAccess(epoch)
      assertConnection()
      const base = this.session?.base
      if (!base) throw Object.assign(new Error('Enterprise account changed.'), { status: 409 })
      const path = `/api/v1/dsh/market/workbenches/${id}/versions/${versionId}/artifact`
      const { endpoint } = await resolveEnterpriseEndpoint(base, path,
        this.options.allowInsecureLoopback, this.platformRequestOptions().allowInsecurePrivateHttp)
      const signal = AbortSignal.timeout(120_000)
      const response = await createEnterpriseFetch(this.options.fetchImpl)(endpoint.toString(), {
        method: 'GET',
        signal,
        headers: { authorization: `Bearer ${accessToken}` }
      })
      assertConnection()
      return await verifyWorkbenchArtifactResponse(response, {
        expectedSha256: sha256,
        expectedSize: sizeBytes as number,
        retain,
        signal,
        assertConnection
      })
    } catch (error) {
      const status = Number((error as { status?: number }).status)
      if (status === 409) return { ok: false, stage: 'account', error: 'Enterprise account changed.' }
      return { ok: false, stage: 'download', error: error instanceof Error ? error.message : 'Workbench artifact verification failed.' }
    }
  }

  private async ensureAccess(epoch: number): Promise<string> {
    if (!this.session?.base || !this.session.access_token) {
      throw Object.assign(new Error('Enterprise models are unavailable.'), { status: 409 })
    }
    const contract = await loadEnterpriseContract()
    if (
      this.session.access_expires_at &&
      contract.accessNeedsRefresh(this.session as { access_expires_at: string }, this.now())
    ) {
      await this.refresh()
    }
    if (this.epoch !== epoch || !this.session?.access_token) {
      throw Object.assign(new Error('Enterprise models are unavailable.'), { status: 409 })
    }
    return this.session.access_token
  }

  private handleChatStatus(status: number, text: string, model: string, epoch: number): void {
    let code: string | undefined
    try {
      const payload = JSON.parse(text) as { error?: { code?: string } }
      code = payload.error?.code
    } catch {
      code = undefined
    }
    if (status === 403 && code === 'model_not_allowed') {
      void this.syncCatalog(epoch, { includeUsage: false })
    }
    if (status === 429) {
      void this.syncUsage(epoch, model)
    }
    this.note('chat_upstream', { status })
  }

  private async readUsage(path: string) {
    const contract = await loadEnterpriseContract()
    const usageResult = await requestEnterpriseJson(
      this.options.fetchImpl,
      this.session!.base!,
      path,
      {
        accessToken: this.session!.access_token,
        ...this.platformRequestOptions()
      }
    )
    return contract.parseUsageLenient(usageResult.body)
  }

  private async refreshUsageCatalog(expectedEpoch: number): Promise<void> {
    if (this.epoch !== expectedEpoch || !this.session?.base || !this.session.access_token) return
    const contract = await loadEnterpriseContract()
    try {
      this.usage = await this.readUsage(contract.API_PATHS.usage)
    } catch {
      this.usage = contract.unavailableUsage()
    }
    if (this.epoch !== expectedEpoch) return
    const nextModelUsage = { ...this.modelUsage }
    await Promise.all(this.models.map(async (model) => {
      try {
        const next = await this.readUsage(
          `${contract.API_PATHS.usage}?model=${encodeURIComponent(model.id)}`
        )
        if (next.used !== null || next.limit !== null || !nextModelUsage[model.id]) {
          nextModelUsage[model.id] = next
        }
      } catch {
        if (!nextModelUsage[model.id]) nextModelUsage[model.id] = contract.unavailableUsage()
      }
    }))
    if (this.epoch !== expectedEpoch) return
    this.modelUsage = nextModelUsage
  }

  private async syncUsage(expectedEpoch: number, modelId?: string): Promise<void> {
    if (this.epoch !== expectedEpoch || !this.session?.base || !this.session.access_token) return
    const contract = await loadEnterpriseContract()
    try {
      this.usage = await this.readUsage(contract.API_PATHS.usage)
    } catch {
      this.usage = contract.unavailableUsage()
    }
    if (this.epoch !== expectedEpoch) return
    if (modelId) {
      try {
        this.modelUsage = {
          ...this.modelUsage,
          [modelId]: await this.readUsage(
            `${contract.API_PATHS.usage}?model=${encodeURIComponent(modelId)}`
          )
        }
      } catch {
        // Keep the last known per-model usage.
      }
    }
    if (this.epoch === expectedEpoch) this.publish()
  }

  private writeForwarded(response: ServerResponse, upstream: Response, text: string): void {
    if (response.headersSent) return
    const requestId = sanitizeRequestId(upstream.headers.get('x-request-id') ?? undefined)
    const contentType = upstream.headers.get('content-type') ?? 'application/json; charset=utf-8'
    response.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {})
    })
    response.end(text)
  }

  private async boundedResponseText(upstream: Response): Promise<string> {
    if (!upstream.body) return ''
    const reader = upstream.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2 * 1024 * 1024) throw new Error('Enterprise error response is too large.')
        chunks.push(value)
      }
      return Buffer.concat(chunks).toString('utf8')
    } finally {
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async pipeSse(upstream: Response, response: ServerResponse, signal: AbortSignal, native = false): Promise<void> {
    if (response.headersSent) return
    const requestId = sanitizeRequestId(upstream.headers.get('x-request-id') ?? undefined)
    const contentType = upstream.headers.get('content-type') ?? 'text/event-stream'
    response.writeHead(upstream.status, {
      'content-type': contentType,
      'cache-control': 'no-store',
      ...(requestId ? { 'x-request-id': requestId } : {})
    })
    if (!upstream.body) {
      response.end()
      return
    }
    const reader = upstream.body.getReader()
    let totalBytes = 0
    let idle = setTimeout(() => response.destroy(), CHAT_IDLE_TIMEOUT_MS)
    const resetIdle = () => {
      clearTimeout(idle)
      idle = setTimeout(() => response.destroy(), CHAT_IDLE_TIMEOUT_MS)
    }
    const onAbort = () => {
      void reader.cancel().catch(() => undefined)
      if (!response.writableEnded) response.destroy()
    }
    signal.addEventListener('abort', onAbort, { once: true })
    try {
      while (true) {
        if (signal.aborted) break
        const { value, done } = await reader.read()
        if (done) break
        resetIdle()
        const chunk = Buffer.from(value)
        totalBytes += chunk.byteLength
        if (native && totalBytes > 32 * 1024 * 1024) throw new Error('Enterprise response is too large.')
        if (!response.write(chunk)) {
          await waitForDrain(response, signal)
        }
      }
      if (!response.writableEnded) response.end()
    } finally {
      clearTimeout(idle)
      signal.removeEventListener('abort', onAbort)
      await reader.cancel().catch(() => undefined)
      reader.releaseLock()
    }
  }

  private async endSessionKeepingError(phase: EnterprisePhase, error?: unknown): Promise<void> {
    if (error !== undefined) this.rememberRequest(error)
    const message = this.error
    const code = this.errorCode
    const requestId = this.requestId
    await this.clearLocalSession(phase)
    if (this.phase === 'error') return
    this.error = message
    this.errorCode = code
    this.requestId = requestId
    this.publish()
  }

  private async clearLocalSession(phase: EnterprisePhase): Promise<void> {
    this.invalidateAuthSession()
    this.auditFields = []
    this.epoch += 1
    this.clearModelsTimer()
    for (const controller of this.chatControllers) controller.abort(enterpriseSessionChangedAbortReason())
    this.chatControllers.clear()
    for (const controller of this.authenticatedControllers) controller.abort(enterpriseSessionChangedAbortReason())
    this.authenticatedControllers.clear()
    await this.cancelPendingLogin()
    this.session = null
    this.allowPrivateHttpForSession = false
    this.models = []
    this.modelsAvailable = false
    this.usage = undefined
    this.modelUsage = {}
    this.phase = this.options.vault.available ? phase : 'disabled'
    this.clearError()
    try {
      if (this.options.vault.available) {
        const cleared = await this.options.vault.clear()
        this.vaultGeneration = cleared.generation
      }
    } catch {
      this.phase = 'error'
      this.error = 'Enterprise credentials could not be cleared.'
      this.errorCode = undefined
    }
    this.publish()
  }

  private platformRequestOptions() {
    return {
      allowInsecureLoopback: this.options.allowInsecureLoopback,
      allowInsecurePrivateHttp: this.allowPrivateHttpForSession
    }
  }

  private pauseSessionForRelogin(): void {
    this.auditFields = []
    this.modelsAvailable = false
    this.publish()
  }

  private async cancelPendingLogin(): Promise<void> {
    this.clearLoginExpiryTimer()
    const pending = this.pendingLogin
    this.pendingLogin = undefined
    if (pending) await pending.callback.close()
  }

  async refreshAuditCapability(): Promise<void> {
    const generation = ++this.auditRefreshGeneration
    this.auditFields = []
    this.auditTitleAvailable = false
    this.publish()
    const epoch = this.epoch
    const base = this.session?.base
    const connectionKey = this.connectionKey()
    if (!base || !this.session?.access_token) return
    try {
      const contract = await loadEnterpriseContract()
      const config = contract.parseConfig((await requestEnterpriseJson(
        this.options.fetchImpl, base, contract.API_PATHS.config, this.platformRequestOptions()
      )).body)
      if (generation !== this.auditRefreshGeneration || epoch !== this.epoch ||
          base !== this.session?.base || connectionKey !== this.connectionKey()) return
      this.auditFields = config.enabled ? config.audit_context?.fields ?? [] : []
      this.auditTitleAvailable = config.enabled && config.audit_conversation_title?.version === 1
    } catch {
      // Only optional audit capability is lost; do not replay or reject model calls.
      if (generation === this.auditRefreshGeneration && epoch === this.epoch) this.note('audit_capability_unavailable')
    }
    if (generation === this.auditRefreshGeneration && epoch === this.epoch) this.publish()
  }

  private scheduleLoginExpiry(epoch: number): void {
    this.clearLoginExpiryTimer()
    const pending = this.pendingLogin
    if (!pending || pending.epoch !== epoch) return
    const delay = Math.max(0, pending.expiresAt - this.now())
    this.loginExpiryTimer = setTimeout(() => {
      void this.expirePendingLoginIfDue()
    }, delay)
    this.loginExpiryTimer.unref?.()
  }

  private clearLoginExpiryTimer(): void {
    if (this.loginExpiryTimer) clearTimeout(this.loginExpiryTimer)
    this.loginExpiryTimer = undefined
  }

  private async expirePendingLoginIfDue(): Promise<void> {
    const pending = this.pendingLogin
    if (!pending || this.phase !== 'authorizing' || pending.expiresAt > this.now()) return
    const epoch = pending.epoch
    await this.enqueueMutation(async () => {
      const current = this.pendingLogin
      if (!current || current.epoch !== epoch || this.phase !== 'authorizing' || current.expiresAt > this.now()) return
      await this.completeLoginLocked(epoch, {
        authId: current.authId ?? '',
        state: current.state,
        error: 'authorization_expired'
      })
    })
  }

  private scheduleModels(delayMs: number): void {
    this.clearModelsTimer()
    if (!this.session?.access_token) return
    this.modelsTimer = setTimeout(() => {
      void this.refreshModels(true)
    }, delayMs)
    this.modelsTimer.unref?.()
  }

  private clearModelsTimer(): void {
    if (this.modelsTimer) clearTimeout(this.modelsTimer)
    this.modelsTimer = undefined
  }

  private modelsDelay(): number {
    return MODELS_INTERVAL_MS + Math.floor(Math.random() * MODELS_JITTER_MS)
  }

  private degradedDelay(): number {
    return Math.min(MAX_DEGRADED_BACKOFF_MS, DEGRADED_BACKOFF_MS * 2 ** Math.min(this.modelsAttempt, 4))
  }

  private enqueueMutation<T>(work: () => Promise<T>): Promise<T> {
    const run = this.mutation.then(work, work)
    this.mutation = run.then(() => undefined, () => undefined)
    return run
  }

  private publish(): void {
    const snapshot = this.snapshot()
    const signature = publicStateSignature(snapshot)
    if (signature === this.lastPublicSignature) return
    this.revision += 1
    this.lastPublicSignature = publicStateSignature({ ...snapshot, revision: this.revision })
    this.options.onStateChange?.(this.snapshot())
  }

  private clearError(): void {
    this.error = undefined
    this.errorCode = undefined
    this.requestId = undefined
  }

  private rememberRequest(error?: unknown, requestId?: string): void {
    if (error instanceof EnterprisePlatformError) {
      this.error = error.message
      this.errorCode = typeof error.code === 'string' && error.code.length > 0 ? error.code : undefined
      this.requestId = sanitizeRequestId(error.requestId)
      return
    }
    if (error instanceof Error) {
      this.error = error.message
      this.errorCode = undefined
    }
    if (requestId) this.requestId = sanitizeRequestId(requestId)
  }

  private note(event: string, details: Omit<EnterpriseServiceNote, 'event'> = {}): void {
    this.options.note?.({
      event,
      ...(details.status ? { status: details.status } : {}),
      ...(sanitizeRequestId(details.requestId) ? { requestId: sanitizeRequestId(details.requestId) } : {}),
      ...(details.originHash ? { originHash: details.originHash } : {}),
      ...(details.pluginId ? { pluginId: details.pluginId } : {}),
      ...(details.path ? { path: details.path } : {}),
      ...(details.duration !== undefined ? { duration: details.duration } : {})
    })
  }

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }
}

async function readMarketErrorCode(response: Response): Promise<string | undefined> {
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    if (response.body) {
      for await (const chunk of response.body as AsyncIterable<Uint8Array>) {
        length += chunk.byteLength
        if (length > 4096) break
        chunks.push(chunk)
      }
    }
  } catch {
    return undefined
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { data?: { code?: unknown }, detail?: { code?: unknown } }
    const candidate = parsed.data?.code ?? parsed.detail?.code
    return typeof candidate === 'string' && /^[a-z0-9_]{1,64}$/u.test(candidate) ? candidate : undefined
  } catch {
    return undefined
  }
}

function publicIdentity(value?: EnterprisePublicIdentity): EnterprisePublicIdentity | undefined {
  if (!value) return undefined
  const identity: EnterprisePublicIdentity = {
    ...(value.id ? { id: value.id } : {}),
    ...(value.username ? { username: value.username } : {}),
    ...(value.display_name ? { display_name: value.display_name } : {}),
    ...(value.name ? { name: value.name } : {})
  }
  return Object.keys(identity).length > 0 ? identity : undefined
}

function publicStateSignature(state: EnterprisePublicState): string {
  return JSON.stringify({
    connected: state.connected,
    secureStorageAvailable: state.secureStorageAvailable,
    phase: state.phase,
    models: state.models,
    modelsAvailable: state.modelsAvailable,
    audit_context: state.audit_context,
    audit_conversation_title: state.audit_conversation_title,
    auditTitleEpoch: state.auditTitleEpoch,
    base: state.base,
    user: state.user,
    tenant: state.tenant,
    usage: state.usage,
    modelUsage: state.modelUsage,
    desktopVersion: state.desktopVersion,
    connectionKey: state.connectionKey,
    sessionExpiresAt: state.sessionExpiresAt,
    error: state.error,
    errorCode: state.errorCode,
    requestId: state.requestId
  })
}

function sanitizeRequestId(value?: string): string | undefined {
  if (!value || !/^[A-Za-z0-9._:-]{1,64}$/u.test(value)) return undefined
  return value
}

function waitForDrain(response: ServerResponse, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason ?? new Error('aborted'))
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      response.off('drain', onDrain)
      response.off('error', onError)
      signal.removeEventListener('abort', onAbort)
    }
    const onDrain = () => {
      cleanup()
      resolve()
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    const onAbort = () => {
      cleanup()
      reject(signal.reason ?? new Error('aborted'))
    }
    response.once('drain', onDrain)
    response.once('error', onError)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

function noteFromError(error: unknown): Omit<EnterpriseServiceNote, 'event'> {
  if (error instanceof EnterprisePlatformError) {
    return {
      ...(error.status ? { status: error.status } : {}),
      ...(sanitizeRequestId(error.requestId) ? { requestId: sanitizeRequestId(error.requestId) } : {})
    }
  }
  return {}
}
