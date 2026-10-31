export const ACCOUNT_ERROR_COPY = Object.freeze({
  invalid_grant: {
    zh: '本次登录授权已失效，请重新发起登录。',
    en: 'This sign-in authorization is no longer valid. Start sign-in again.'
  },
  pkce_verification_failed: {
    zh: '登录验证失败，请重新发起登录。',
    en: 'Sign-in verification failed. Start sign-in again.'
  },
  authorization_expired: {
    zh: '登录授权已过期，请重新登录。',
    en: 'This sign-in authorization has expired. Sign in again.'
  },
  authorization_conflict: {
    zh: '本次登录状态发生冲突，请重新发起登录。',
    en: 'This sign-in conflicted with another attempt. Start sign-in again.'
  },
  invalid_access_token: {
    zh: '登录凭证已失效，请重新登录。',
    en: 'Your sign-in credential is no longer valid. Sign in again.'
  },
  invalid_refresh_token: {
    zh: '登录已失效，请重新登录。',
    en: 'Your sign-in is no longer valid. Sign in again.'
  },
  refresh_token_reused: {
    zh: '登录状态已失效，请重新登录。',
    en: 'Your sign-in state is no longer valid. Sign in again.'
  },
  session_expired: {
    zh: '登录会话已过期，请重新登录。',
    en: 'Your sign-in session has expired. Sign in again.'
  },
  session_revoked: {
    zh: '本次登录会话已失效，请重新登录。',
    en: 'This sign-in session is no longer valid. Sign in again.'
  },
  seat_not_assigned: {
    zh: '当前服务版本不支持直接登录，请联系管理员升级平台。',
    en: 'This server uses a legacy sign-in policy. Ask your administrator to upgrade the platform.'
  },
  seat_revoked: {
    zh: '当前登录已失效，请重新登录。',
    en: 'Your sign-in is no longer valid. Sign in again.'
  },
  seat_limit_reached: {
    zh: '当前平台仍启用了旧版接入限制，请联系管理员升级。',
    en: 'This server still enforces a legacy access limit. Ask your administrator to upgrade.'
  },
  license_invalid: {
    zh: '平台客户端授权无效，请联系管理员。',
    en: 'The platform client license is invalid. Contact your administrator.'
  },
  license_expired: {
    zh: '平台客户端授权已过期，请联系管理员。',
    en: 'The platform client license has expired. Contact your administrator.'
  },
  dsh_disabled: {
    zh: '管理员已关闭客户端功能，请联系管理员。',
    en: 'An administrator has turned off the client. Contact your administrator.'
  },
  user_disabled: {
    zh: '当前账号不可用，请联系管理员。',
    en: 'This account is unavailable. Contact your administrator.'
  },
  tenant_unavailable: {
    zh: '账号所属组织暂不可用，请联系管理员。',
    en: 'Your organization is temporarily unavailable. Contact your administrator.'
  },
  authorization_unavailable: {
    zh: '平台授权服务暂不可用，请稍后重试。',
    en: 'The authorization service is temporarily unavailable. Try again later.'
  },
  too_many_requests: {
    zh: '操作过于频繁，请稍后重试。',
    en: 'Too many attempts. Try again later.'
  },
  internal_error: {
    zh: '平台服务异常，请稍后重试或联系管理员。',
    en: 'The platform service failed. Try again later or contact an administrator.'
  },
  access_denied: {
    zh: '你已取消本次登录授权。',
    en: 'You cancelled this sign-in.'
  },
  authorization_failed: {
    zh: '本次登录授权失败，请重新发起登录。',
    en: 'This sign-in authorization failed. Start sign-in again.'
  },
  network_error: {
    zh: '无法连接企业平台，请检查地址和网络。',
    en: 'Could not reach the enterprise platform. Check the service address and your network.'
  },
  invalid_response: {
    zh: '平台响应异常，请检查服务地址或联系管理员。',
    en: 'The platform returned an unexpected response. Check the service address or contact your administrator.'
  },
  contract_incompatible: {
    zh: '客户端与平台版本不兼容，请联系管理员更新。',
    en: 'This client is incompatible with the platform. Ask your administrator to update it.'
  },
  model_not_allowed: {
    zh: '当前模型未获授权或已不可用，请刷新模型列表或联系管理员。',
    en: 'This model is not authorized or is unavailable. Refresh the model list or contact your administrator.'
  },
  vault_decrypt_failed: {
    zh: '企业登录凭证无法解密。',
    en: 'Enterprise credential vault could not be decrypted.'
  }
})

export const NO_MODELS_COPY = Object.freeze({
  zh: '暂无可用模型，请联系管理员授权。',
  en: 'No models are available. Ask your administrator to authorize one.'
})

export const LEGACY_ACCOUNT_PHRASES = Object.freeze({
  'seat not assigned': 'seat_not_assigned',
  'seat revoked': 'seat_revoked',
  'dsh seat revoked': 'seat_revoked',
  'session revoked': 'session_revoked',
  'dsh session revoked': 'session_revoked',
  'session expired': 'session_expired',
  'dsh session expired': 'session_expired',
  'invalid access token': 'invalid_access_token',
  'invalid dsh access token': 'invalid_access_token',
  'invalid refresh token': 'invalid_refresh_token',
  'invalid refresh token; sign in again': 'invalid_refresh_token',
  'refresh token reused': 'refresh_token_reused',
  'refresh token reuse detected; sign in again': 'refresh_token_reused',
  'authorization unavailable': 'authorization_unavailable',
  'dsh authorization is temporarily unavailable': 'authorization_unavailable',
  'invalid grant': 'invalid_grant',
  'pkce verification failed': 'pkce_verification_failed',
  'authorization expired': 'authorization_expired',
  'authorization conflict': 'authorization_conflict',
  'user disabled': 'user_disabled',
  'tenant unavailable': 'tenant_unavailable',
  'dsh disabled': 'dsh_disabled',
  'model not allowed': 'model_not_allowed',
  'too many requests': 'too_many_requests',
  'internal error': 'internal_error',
  'could not reach the bisheng platform': 'network_error',
  'bisheng dsh contract version is incompatible with this desktop build': 'contract_incompatible',
  'enterprise credential vault could not be decrypted': 'vault_decrypt_failed'
})

const MESSAGE_LIMIT = 300

export function normalizeAccountPhrase(value) {
  return value.trim().replace(/\.$/u, '').trim().toLowerCase()
}

export function accountMessageLooksLikeHtml(value) {
  return /<[a-z!/][^>]*>/iu.test(value)
}

export function sanitizeAccountMessage(value) {
  return value
    .replace(/<[^>]*>/gu, ' ')
    .replace(/[\u0000-\u001f\u007f]/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim()
    .slice(0, MESSAGE_LIMIT)
}

export function resolveAccountError(code, message) {
  const normalizedCode = typeof code === 'string' ? code.trim() : ''
  const text = typeof message === 'string' ? message.trim() : ''
  if (
    normalizedCode &&
    normalizedCode !== 'request_failed' &&
    Object.hasOwn(ACCOUNT_ERROR_COPY, normalizedCode)
  ) {
    return { code: normalizedCode }
  }
  if (!normalizedCode || normalizedCode === 'request_failed') {
    const legacy = LEGACY_ACCOUNT_PHRASES[normalizeAccountPhrase(text)]
    if (typeof legacy === 'string' && Object.hasOwn(ACCOUNT_ERROR_COPY, legacy)) return { code: legacy }
  }
  if (accountMessageLooksLikeHtml(text)) return { code: 'invalid_response' }
  return { message: sanitizeAccountMessage(text) }
}


export const CONTENT_SAFETY_ERROR_COPY = Object.freeze({
  CONTENT_FILTERED: Object.freeze({
    zh: '内容包含敏感词，本次请求已停止。',
    en: 'This request was stopped because sensitive words were detected.',
    ja: '制限された語句が検出されたため、このリクエストを停止しました。'
  }),
  CONTENT_CHECK_UNAVAILABLE: Object.freeze({
    zh: '暂时无法检查内容，请稍后重试。',
    en: 'Content checking is temporarily unavailable. Try again later.',
    ja: '現在、コンテンツを確認できません。しばらくしてから再試行してください。'
  })
})

const CONTENT_SAFETY_ALIASES = Object.freeze({
  content_blocked: 'CONTENT_FILTERED',
  content_filter: 'CONTENT_FILTERED',
  content_filtered: 'CONTENT_FILTERED',
  check_unavailable: 'CONTENT_CHECK_UNAVAILABLE',
  content_check_unavailable: 'CONTENT_CHECK_UNAVAILABLE'
})

/** Normalize explicit safety signals without changing account or quota failures. */
export function resolveContentSafetyError(code, message) {
  if (typeof code !== 'string') return null
  const key = code.trim().toLowerCase()
  if (!Object.hasOwn(CONTENT_SAFETY_ALIASES, key)) return null
  const result = { code: CONTENT_SAFETY_ALIASES[key] }
  // Tenant replies are display text, never dictionary keys or HTML error pages.
  if (typeof message !== 'string' || accountMessageLooksLikeHtml(message)) return result
  const safeMessage = sanitizeAccountMessage(message)
  return safeMessage ? { ...result, message: safeMessage } : result
}
