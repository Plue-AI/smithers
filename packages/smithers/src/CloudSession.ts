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
  return {
    origin,
    get: async (path, signal) => {
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
        headers: { authorization: `token ${token}`, accept: "application/json" },
        redirect: "error",
        signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout])
      })
      if (!response.ok) {
        throw new CliError.Refused({
          fault: response.status === 401 || response.status === 403 ? "user" : "infra",
          code: "cloud_request_failed",
          message: `${path}: HTTP ${response.status}`
        })
      }
      const body = await response.text()
      if (body.length > maxBytes) {
        throw new CliError.Refused({
          fault: "infra",
          code: "cloud_response_too_large",
          message: `${path}: the response is larger than ${maxBytes} bytes`
        })
      }
      try {
        return JSON.parse(body) as unknown
      } catch {
        throw new CliError.Refused({
          fault: "infra",
          code: "cloud_response_invalid",
          message: `${path}: the response is not JSON`
        })
      }
    }
  }
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
