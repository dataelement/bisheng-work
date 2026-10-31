export interface EnterpriseWebSession {
  base: string
  cookie: string
  cookieName: string
  expiresAt: number
  connectionKey: string
}

/** The platform declares its ingress cookie; the host fixes its origin and flags. */
export function parseWebSession(value: unknown, base: string, connectionKey: string, now = Date.now()): EnterpriseWebSession {
  if (!value || typeof value !== 'object') throw new Error('Invalid enterprise web session.')
  const body = value as Record<string, unknown>
  const cookieName = body.cookie_name === undefined ? 'access_token_cookie' : body.cookie_name
  if (typeof cookieName !== 'string' || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(cookieName)) {
    throw new Error('Invalid enterprise web session cookie name.')
  }
  if (typeof body.cookie !== 'string' || body.cookie.length < 20 || body.cookie.length > 16384 ||
    !/^[A-Za-z0-9._-]+$/u.test(body.cookie) || typeof body.expires_in !== 'number' ||
    !Number.isInteger(body.expires_in) || body.expires_in < 30 || body.expires_in > 600) {
    throw new Error('Invalid enterprise web session.')
  }
  return { base, cookie: body.cookie, cookieName, expiresAt: now + body.expires_in * 1000, connectionKey }
}
