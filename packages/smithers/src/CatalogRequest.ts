/**
 * The product command catalog's shared HTTP encoding for CLI and host callers.
 * Payload validation and actor authorization belong to the invoking boundary.
 *
 * @since 1.0.0
 */

/**
 * The HTTP binding emitted from an operation descriptor.
 *
 * @category models
 * @since 1.0.0
 */
export interface CatalogHttpBinding {
  readonly method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE"
  readonly path: string
  readonly body?: Readonly<Record<string, string>>
  readonly defaults?: Readonly<Record<string, unknown>>
  readonly query?: Readonly<Record<string, string>>
  /** Optional nested request objects, emitted only when their source field is present. */
  readonly objects?: Readonly<Record<string, {
    readonly when: string
    readonly body: Readonly<Record<string, string>>
    readonly defaults?: Readonly<Record<string, unknown>>
  }>>
}

/**
 * An encoded request without credentials or transport authority.
 *
 * @category models
 * @since 1.0.0
 */
export interface CatalogHttpRequest {
  readonly method: CatalogHttpBinding["method"]
  readonly path: string
  readonly body?: Record<string, unknown>
}

/**
 * Encode a validated payload using the operation's declared HTTP binding.
 * No network request, confirmation, or policy decision happens here.
 *
 * @category encoding
 * @since 1.0.0
 */
export const catalogRequest = (
  descriptor: { readonly http: CatalogHttpBinding | null },
  payload: Readonly<Record<string, unknown>>
): CatalogHttpRequest => {
  const binding = descriptor.http
  if (binding === null) throw new Error("Command HTTP binding is unavailable")
  if (
    !/^(GET|POST|PATCH|PUT|DELETE)$/.test(binding.method) ||
    !binding.path.startsWith("/api/") || /[?#\\]/.test(binding.path)
  ) throw new Error("Invalid command HTTP binding")
  const body: Record<string, unknown> = binding.body
    ? Object.fromEntries(
      Object.entries(binding.body).filter(([, source]) => payload[source] !== undefined)
        .map(([field, source]) => [field, payload[source]])
    )
    : { ...payload }
  Object.assign(body, structuredClone(binding.defaults))
  for (const [field, nested] of Object.entries(binding.objects ?? {})) {
    if (payload[nested.when] === undefined || payload[nested.when] === null) continue
    body[field] = {
      ...Object.fromEntries(Object.entries(nested.body)
        .filter(([, source]) => payload[source] !== undefined)
        .map(([key, source]) => [key, payload[source]])),
      ...structuredClone(nested.defaults)
    }
  }
  const used = new Set<string>()
  let path = binding.path.replace(/\{([^}]+)\}/g, (_, field: string) => {
    const value = payload[field]
    if (value === undefined || value === null || typeof value === "object") {
      throw new Error(`Missing or invalid ${field}`)
    }
    const segment = String(value)
    if (segment === "" || segment === "." || segment === "..") throw new Error(`Invalid ${field}`)
    used.add(field)
    return encodeURIComponent(segment)
  })
  if (/[{}]/.test(path) || path.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("Invalid command HTTP binding")
  }
  for (const key of used) delete body[key]
  if (binding.method === "GET") {
    const query = new URLSearchParams()
    const values = binding.query === undefined ? body : Object.fromEntries(
      Object.entries(binding.query)
        .filter(([, source]) => payload[source] !== undefined).map(([field, source]) => [field, payload[source]])
    )
    for (const [field, value] of Object.entries(values)) if (value !== undefined) query.set(field, String(value))
    if (query.size) path += `?${query}`
    return { method: binding.method, path }
  }
  return { method: binding.method, path, body }
}
