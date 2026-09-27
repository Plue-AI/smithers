/**
 * Shared HTTP status and provider vocabulary classification.
 *
 * @since 0.1.0
 */

import { isContextOverflow, isQuotaExhausted, type ModelErrorCode } from "./ModelError.ts"

/**
 * Classifies normalized provider error fields. Protocols own envelope decoding
 * and provider-specific overrides; HTTP and vocabulary precedence live here.
 *
 * @category utilities
 * @since 0.1.0
 */
export const classifyHttpStatus = (
  status: number | undefined,
  code: string | undefined,
  message: string
): ModelErrorCode => {
  const normalized = `${code ?? ""} ${message}`.toLowerCase()
  if (status === 401 || status === 403) return "authentication"
  if (status === 402 || isQuotaExhausted(code, message)) return "quota_exceeded"
  if (
    /authentication|invalid[-_\s]?api[-_\s]?key|incorrect[-_\s]?api[-_\s]?key|permission[-_\s]?denied/.test(normalized)
  ) {
    return "authentication"
  }
  if (status === 429 || /rate[-_\s]?limit|usage[-_\s]?limit|too many requests/.test(normalized)) return "rate_limited"
  if (/content[-_\s]?policy|content[-_\s]?filter|safety/.test(normalized)) return "content_policy"
  // Quota and overflow must precede their generic invalid-request envelopes.
  if (isContextOverflow(code, message)) return "context_overflow"
  if (
    status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ||
    /invalid[-_\s]?request/.test(normalized)
  ) return "invalid_request"
  // A stream that fails after HTTP 200 carries no status, only the provider's
  // words: ChatGPT's `response.failed` says "Our servers are currently
  // overloaded" and Anthropic's event says `overloaded_error`. Both are the
  // provider's transient fault, so they retry like the 5xx they stand for.
  if (
    (status !== undefined && status >= 500) ||
    /server[-_\s]?error|internal[-_\s]?error|overloaded|service[-_\s]?unavailable/.test(normalized)
  ) {
    return "provider_internal"
  }
  return "unknown"
}
