export const ACCOUNT_ERROR_COPY: Readonly<Record<string, { zh: string, en: string }>>
export const NO_MODELS_COPY: Readonly<{ zh: string, en: string }>
export const LEGACY_ACCOUNT_PHRASES: Readonly<Record<string, string>>

export function normalizeAccountPhrase(value: string): string
export function accountMessageLooksLikeHtml(value: string): boolean
export function sanitizeAccountMessage(value: string): string
export function resolveAccountError(
  code: unknown,
  message: unknown
): { code: string, message?: undefined } | { code?: undefined, message: string }


export type ContentSafetyCode = 'CONTENT_FILTERED' | 'CONTENT_CHECK_UNAVAILABLE'
export const CONTENT_SAFETY_ERROR_COPY: Readonly<Record<
  ContentSafetyCode,
  Readonly<{ zh: string, en: string, ja: string }>
>>
export function resolveContentSafetyError(
  code: unknown,
  message: unknown
): { code: ContentSafetyCode, message?: string } | null
