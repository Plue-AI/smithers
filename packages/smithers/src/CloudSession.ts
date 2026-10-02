/**
 * The signed-in Smithers Cloud session, for hosts other than the CLI: the
 * terminal UI reads the factory's issue list with it. The token comes from
 * where `smthrs auth login` put it (`SMITHERS_TOKEN`, then the keyring, the
 * auth file, the config), and the origin from `SMITHERS_API_ORIGIN` or the
 * configured `api_origin`. Nothing here stores or prints a token.
 *
 * @since 1.0.0
 */

import * as CliError from "./CliError.ts"
import { processHost, resolveRepo } from "./commands/Open.ts"
import { Session } from "./internal/backend/Session.ts"

/** A read that hangs gives up here. */
const timeoutMs = 30_000
/** A body larger than this is refused, as the CLI's own client refuses it. */
const maxBytes = 4 * 1024 * 1024

/**
 * An authenticated Cloud origin.
 *
 * @category models
 * @since 1.0.0
 */
export interface Cloud {
  readonly origin: string
  /** GETs `path` (starting `/api/`) as the signed-in person; resolves the parsed JSON body. */
  readonly get: (path: string, signal?: AbortSignal) => Promise<unknown>
  /** POSTs the JSON `body` to `path` (starting `/api/`) as the signed-in person; resolves the parsed JSON body. */
  readonly post: (path: string, body: unknown, signal?: AbortSignal) => Promise<unknown>
}

/**
 * The signed-in session, or undefined when there is no origin or no login.
 *
 * @category constructors
 * @since 1.0.0
 */
export const signedIn = async (env: Readonly<Record<string, string | undefined>>): Promise<Cloud | undefined> => {
  const session = new Session(env)
  let resolved: Awaited<ReturnType<Session["resolve"]>>
  try {
    resolved = await session.resolve()
  } catch {
    return undefined
  }
  if (resolved === undefined) return undefined
  const { api_url: origin, token } = resolved
  const call = async (method: "GET" | "POST", path: string, body: unknown, signal?: AbortSignal): Promise<unknown> => {
    // Only a path on this origin: the token never goes to another host.
    if (!path.startsWith("/") || path.startsWith("//")) {
      throw new CliError.Refused({
        fault: "bug",
        code: "cloud_path_refused",
        message: `Not a Cloud API path: ${path}`
      })
    }
    const timeout = AbortSignal.timeout(timeoutMs)
    const response = await fetch(origin + path, {
      method,
      headers: {
        authorization: `token ${token}`,
        accept: "application/json",
        ...(method === "POST" ? { "content-type": "application/json" } : {})
      },
      ...(method === "POST" ? { body: JSON.stringify(body) } : {}),
      redirect: "error",
      signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
    })
    if (!response.ok) {
      const status = response.status
      throw new CliError.Refused({
        fault: status === 401 || status === 403 ? "user" : "infra",
        code: "cloud_request_failed",
        message: `${path}: HTTP ${status}`,
        ...(Number.isInteger(status) && status >= 100 && status <= 599 ? { httpStatus: status } : {})
      })
    }
    const text = await response.text()
    if (text.length > maxBytes) {
      throw new CliError.Refused({
        fault: "infra",
        code: "cloud_response_too_large",
        message: `${path}: the response is larger than ${maxBytes} bytes`
      })
    }
    try {
      return JSON.parse(text) as unknown
    } catch {
      throw new CliError.Refused({
        fault: "infra",
        code: "cloud_response_invalid",
        message: `${path}: the response is not JSON`
      })
    }
  }
  return {
    origin,
    get: (path, signal) => call("GET", path, undefined, signal),
    post: (path, body, signal) => call("POST", path, body, signal)
  }
}

/**
 * Whether Cloud refused authentication. Only the response's own 401/403
 * status is final; older typed Cloud refusals retain their user-fault meaning.
 * Unknown failures and malformed present statuses remain uncertain.
 *
 * @category guards
 * @since 1.0.0
 */
export const isAuthenticationRefusal = (error: unknown): boolean => {
  if (
    typeof error !== "object" || error === null || !("_tag" in error) || error._tag !== "/cli/Refused" ||
    !("code" in error) || error.code !== "cloud_request_failed"
  ) return false
  if (!("httpStatus" in error)) return "fault" in error && error.fault === "user"
  const status = error.httpStatus
  return typeof status === "number" && Number.isInteger(status) && (status === 401 || status === 403)
}

/**
 * The Cloud repository a checkout names, `owner/name`, from its git or jj
 * remote the way `smthrs open` reads it; undefined when no remote names one.
 *
 * @category constructors
 * @since 1.0.0
 */
export const repository = (
  directory: string,
  env: Readonly<Record<string, string | undefined>>
): string | undefined => {
  try {
    return resolveRepo(processHost(env), directory)
  } catch {
    return undefined
  }
}
