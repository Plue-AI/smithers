/**
 * Prepublication check using the schema bundled into this candidate's frontend.
 *
 * @since 0.1.0
 */
import { APP_BOOTSTRAP_PATH, AppBootstrapSchema, type AppBootstrap } from "@smthrs/rpc/AppBootstrap"

/**
 * The backend identity accepted by the candidate frontend before publication.
 *
 * @since 0.1.0
 * @category models
 */
export interface BootstrapCompatibilityReceipt {
  readonly checkedAt: string
  readonly backendOrigin: string
  readonly backendBuildSha: string
  readonly apiVersion: AppBootstrap["apiVersion"]
  readonly capabilities: AppBootstrap["capabilities"]
}

/**
 * Validate the live upstream with the candidate frontend schema. Failures never
 * retain a backend body, which may contain private data.
 *
 * @since 0.1.0
 * @category checks
 */
export const checkBootstrapCompatibility = async (
  backendOrigin: string,
  read: (input: URL, init: RequestInit) => Promise<Response> = fetch
): Promise<BootstrapCompatibilityReceipt> => {
  let origin: URL
  try { origin = new URL(backendOrigin) }
  catch { throw new Error("BOOTSTRAP_COMPATIBILITY_ORIGIN") }
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash)
    throw new Error("BOOTSTRAP_COMPATIBILITY_ORIGIN")
  let response: Response
  try {
    response = await read(new URL(APP_BOOTSTRAP_PATH, origin), {
      headers: { accept: "application/json", "cache-control": "no-cache" },
      signal: AbortSignal.timeout(30_000), redirect: "error"
    })
  } catch { throw new Error("BOOTSTRAP_COMPATIBILITY_UNREACHABLE") }
  if (!response.ok) throw new Error(`BOOTSTRAP_COMPATIBILITY_HTTP_${response.status}`)
  let body: unknown
  try { body = await response.json() }
  catch { throw new Error("BOOTSTRAP_COMPATIBILITY_JSON") }
  const parsed = AppBootstrapSchema.safeParse(body)
  if (!parsed.success) throw new Error("BOOTSTRAP_COMPATIBILITY_SCHEMA")
  return {
    checkedAt: new Date().toISOString(), backendOrigin: origin.origin,
    backendBuildSha: parsed.data.buildSha, apiVersion: parsed.data.apiVersion,
    capabilities: parsed.data.capabilities
  }
}
