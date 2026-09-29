import { clientRefusal, refusalOf, retryAfterHeader } from "@smthrs/rpc/Refusal"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { refusalLine } from "@smthrs/rpc/RefusalCopy"
import { refusalWords } from "./SeamContext"
import type { SeamContext } from "./SeamContext"

/**
 * A transport failure has no HTTP status; response metadata stays available to
 * domain policy.
 *
 * Every failure now also carries its `refusal` — the one shape the whole app
 * renders, retries on and hands to the chat model (`@smthrs/rpc/Refusal`).
 * The flat fields beside it are the same facts, kept because a dozen call
 * sites read them; `refusal` is the one that also answers whose FAULT it was,
 * which none of them could previously tell.
 */
export interface CloudFailure {
  readonly error: string
  readonly code: string | null
  readonly status: number | null
  readonly retryAfterSeconds: number | null
  readonly refusal: Refusal
}

export type CloudResult =
  | { readonly body: unknown; readonly status: number; readonly response: Response }
  | CloudFailure

/** Cloud currently supplies delta-seconds, not HTTP dates. */
export const retryAfterSecondsOf = (response: Response): number | null => retryAfterHeader(response.headers)

export const cloudFailure = async (response: Response, fallback: string): Promise<CloudFailure> => {
  const body: unknown = await response.json().catch(() => null)
  /*
   * plue states `code` and `fault`, and the Worker's pass-through preserves
   * `code` and `retry_after` but not `fault` (apps/server proxies.ts), so the
   * The shared refusalOf also preserves plan_key, limit_kind, and
   * upgrade_plan_key for sandbox-limit cards and their upgrade door. The
   * verdict is finished here against the vendored registry rather than left
   * for each surface to infer from the sentence.
   */
  const refusal = refusalOf({
    body,
    status: response.status,
    message: refusalWords(body, fallback, response.status),
    retryAfterSeconds: retryAfterHeader(response.headers)
  })
  return {
    error: refusalLine(refusal, fallback),
    code: refusal.rawCode,
    status: refusal.status,
    retryAfterSeconds: refusal.retryAfter,
    refusal
  }
}

/**
 * A request that never reached Smithers Cloud: infra-class, because nothing
 * judged it. The thrown text is not copy; the tapped fetch recorded it.
 */
export const cloudUnreachable = (error: unknown): CloudFailure => {
  const refusal = clientRefusal(error, "Could not reach Smithers Cloud.")
  return { error: refusalLine(refusal, "Could not reach Smithers Cloud."), code: null, status: null, retryAfterSeconds: null, refusal }
}

/** Domain seams share transport; authorization, DTOs, and retry decisions remain in the seam. */
export const createCloudClient = (ctx: Pick<SeamContext, "http" | "baseUrl">) => {
  const url = (path: string): string => `${ctx.baseUrl}/api${path}`
  const request = async (
    method: string,
    path: string,
    body?: Record<string, unknown>,
    label = path,
    signal?: AbortSignal
  ): Promise<CloudResult> => {
    let response: Response
    try {
      response = await ctx.http(
        url(path),
        method === "GET" ? (signal === undefined ? undefined : { signal }) : {
          method,
          ...(signal === undefined ? {} : { signal }),
          ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
        }
      )
    } catch (error) {
      return cloudUnreachable(error)
    }
    if (!response.ok) {
      return cloudFailure(
        response,
        method === "GET"
          ? `Reading ${label} failed (${response.status})`
          : `The ${method} to ${label} failed (${response.status})`
      )
    }
    return { body: await response.json().catch(() => null), status: response.status, response }
  }
  return { url, get: (path: string, label?: string, signal?: AbortSignal) => request("GET", path, undefined, label, signal), send: request }
}
