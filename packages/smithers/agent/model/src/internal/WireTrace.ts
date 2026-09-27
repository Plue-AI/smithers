/**
 * Opt-in wire trace for prompt-cache debugging.
 *
 * `SMITHERS_WIRE_TRACE=<file>` appends one JSON line per outgoing model
 * request: the route, the cache key and `session-id` header (both public,
 * never the signed credential), whether a remembered affinity token rides
 * along, a short hash of the instructions, a hash and kind for each input
 * item, and how many leading input items match the previous request on the
 * same cache key. A prefix that stops growing while the transcript grows is
 * the signature of a request the provider cannot read back from cache.
 *
 * @since 1.0.0-rc.1
 * @internal
 */

import * as CanonicalJson from "../CanonicalJson.ts"

interface Traced {
  readonly routeId: string
  readonly protocolId: string
  readonly publicHeaders: Readonly<Record<string, string>>
  readonly bodyText: string
  /** Whether the request leaves with a remembered affinity token. */
  readonly affinity?: boolean | undefined
}

interface Body {
  readonly instructions?: unknown
  readonly input?: unknown
  readonly messages?: unknown
  readonly prompt_cache_key?: unknown
}

type Item = { readonly type?: unknown; readonly role?: unknown } | null

const previous = new Map<string, ReadonlyArray<string>>()

/**
 * The trace line for one prepared request; `history` is per process.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const line = (
  prepared: Traced,
  history: Map<string, ReadonlyArray<string>> = previous
): Record<string, unknown> => {
  // Every built-in protocol body is a JSON object; `bodyText` is its bytes.
  const body = JSON.parse(prepared.bodyText) as Body
  const list = body.input ?? body.messages
  const input: ReadonlyArray<Item> = Array.isArray(list) ? list : []
  const items = input.map((item) => CanonicalJson.shortHash(JSON.stringify(item)))
  const kinds = input.map((item) => String(item?.type ?? item?.role))
  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : null
  const slot = cacheKey ?? prepared.routeId
  const before = history.get(slot) ?? []
  let common = 0
  while (common < before.length && before[common] === items[common]) common++
  history.set(slot, items)
  return {
    at: new Date().toISOString(),
    routeId: prepared.routeId,
    protocolId: prepared.protocolId,
    cacheKey,
    sessionIdHeader: prepared.publicHeaders["session-id"] ?? null,
    affinity: prepared.affinity ?? false,
    instructions: typeof body.instructions === "string" ? CanonicalJson.shortHash(body.instructions) : null,
    bytes: prepared.bodyText.length,
    items,
    kinds,
    commonPrefixItems: common,
    previousItems: before.length
  }
}

interface NodeProcess {
  readonly env: Record<string, string | undefined>
  readonly getBuiltinModule: (id: "node:fs") => { readonly appendFileSync: (path: string, data: string) => void }
}

/**
 * Appends one trace line when `SMITHERS_WIRE_TRACE` names a file. Tracing
 * never fails a model call: a runtime without `process` records nothing.
 *
 * @category models
 * @since 1.0.0-rc.1
 */
export const record = (
  prepared: Traced,
  node: NodeProcess | undefined = (globalThis as { readonly process?: NodeProcess }).process
): void => {
  const file = node?.env.SMITHERS_WIRE_TRACE
  if (node === undefined || file === undefined || file === "") return
  try {
    node.getBuiltinModule("node:fs").appendFileSync(file, `${JSON.stringify(line(prepared))}\n`)
  } catch {
    // An unwritable trace file is the tracer's problem, not the call's.
  }
}
