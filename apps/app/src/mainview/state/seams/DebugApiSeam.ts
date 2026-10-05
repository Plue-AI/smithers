import type { DebugApiCard, HttpMethod } from "@smthrs/rpc/DebugApiCard"
import type { FormField } from "@smthrs/rpc/CardAction"

export interface ApiSchema { $ref?: string; type?: string; format?: string; enum?: string[]; properties?: Record<string, ApiSchema>; items?: ApiSchema; required?: string[] }
export interface ApiParameter { name: string; in: string; required?: boolean; schema?: ApiSchema; $ref?: string }
export interface ApiOperation {
  operationId?: string; summary?: string; tags?: string[]; "x-composition"?: string;
  parameters?: ApiParameter[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: ApiSchema }> };
  responses?: Record<string, unknown>
}
export interface ApiResponse { $ref?: string; content?: Record<string, { schema?: ApiSchema }> }
export interface OpenApiDocument {
  paths: Record<string, { parameters?: ApiParameter[] } & Partial<Record<Lowercase<HttpMethod>, ApiOperation>> & { "x-composition"?: string }>;
  components?: { schemas?: Record<string, ApiSchema>; parameters?: Record<string, ApiParameter>; responses?: Record<string, ApiResponse> }
}
export interface DebugApiInput {
  operationId?: string; intent?: "open" | "send" | "confirm"; values?: Record<string, string>; confirmation?: string
}
export interface DebugApiGates { view: boolean; catalog: boolean; authorizer: boolean }
/**
 * `instance` and `epoch` name the seam and its account generation; the
 * Container keys the View by both so no form draft outlives either. `target`
 * is the pending confirmation's random id, held by the pending request.
 */
export type DebugApiSnapshot = { model: DebugApiCard; fields: FormField[]; confirmation?: string; busy?: boolean; epoch?: number; instance?: number; target?: string }
const METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
const mutation = (method: string) => method !== "GET" && method !== "HEAD"
const secretBody = (body?: string) => !!body && /"(?:value|password|token|secret|api[_-]?key)"\s*:/i.test(body)
const validPath = (path: string) => /^\/api(?:\/|$)/.test(path) && !/[\\?#\u0000-\u0020]/.test(path) && !/%(?:2f|5c|2e)/i.test(path) && !path.split("/").some(part => part === "." || part === "..")
/** §6.2.4: the install serves rows with no composition marker; `install` is explicit. Anything else is not the install's. */
const installComposition = (composition?: string) => composition === undefined || composition === "install"
const adminPath = (path: string) => /^\/api\/admin(?:\/|$)/.test(path)

/**
 * Credential-minting operations: their response, request echo, URL values and
 * confirm prefills are withheld whole. Everything else is the viewer's own
 * data, readable with their session anyway, and shows as returned (T-APP-21
 * residual risk, smithers-8a 2026-10-05). OpenApi.test pins this list and
 * fails when a new install operation's success schema names a credential
 * field without being listed or exempted with a reason.
 */
export const CREDENTIAL_OPERATIONS: ReadonlySet<string> = new Set([
  // SSE and live tickets
  "post_api_auth_sse_ticket", "post_api_v1_sse_ticket",
  // OAuth codes, token exchanges and sign-in handoffs
  "get_api_oauth2_authorize", "post_api_oauth2_authorize", "post_api_oauth2_token", "post_api_auth_github_token_exchange",
  "get_api_auth_github_callback", "get_api_auth_auth0_callback", "get_api_auth_github_cli", "get_api_auth_github_cli_consent", "post_api_auth_github_cli_consent",
  // GitHub App manifest state and setup credentials
  "post_api_install_setup_app", "post_api_install_setup_models", "post_api_model_credential",
  "post_api_user_provider_connections", "post_api_orgs_org_provider_connections", "post_api_user_provider_connections_codex_device",
  "post_api_user_provider_connections_codex_device_id", "post_api_user_provider_connections_id_refresh",
  // Token mints and SSH access
  "post_api_user_tokens", "post_api_repos_owner_repo_build_cache_tokens", "get_api_user_emails_verify_token", "post_api_user_emails_verify_token",
  "get_api_repos_owner_repo_workspace_sessions_id_ssh", "get_api_repos_owner_repo_workspaces_id_ssh",
  // Workspace previews mint a preview ticket into the 307 Location
  // (backend routes/workspace.go withPreviewTicket); the OpenAPI rows do not
  // document the redirect, so the schema check cannot find them.
  "get_api_repos_owner_repo_workspaces_id_preview_port", "get_api_repos_owner_repo_workspaces_id_preview_port_path"
])
const WITHHELD = "[withheld]"
/** Field names a schema uses for credential material; an operation whose success schema declares one is withheld like a pinned one. */
const credentialName = (key: string) =>
  /token|ticket|secret|passw|cookie|credential|api[-_]?key|private[-_]?key|access[-_]?key|session[-_]?(?:id|key)|client[-_]?secret|code[-_]?verifier/i.test(key)
/** Text responses show up to this many characters; the rest is summarized. */
export const RESPONSE_TEXT_CAP = 256 * 1024

/** Headers that may show, each with the only values it may carry; every other header is hidden. */
const MEDIA_TYPES: ReadonlySet<string> = new Set(["application/json", "application/problem+json", "text/plain", "text/html",
  "application/octet-stream", "application/x-www-form-urlencoded", "multipart/form-data"])
const mediaType = (contentType: string | null) => {
  const type = contentType?.split(";")[0]?.trim().toLowerCase()
  return type !== undefined && MEDIA_TYPES.has(type) ? type : undefined
}
const HTTP_DATE = /^[A-Z][a-z]{2}, \d{2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}:\d{2} GMT$/
const HEADER_RULES: Readonly<Record<string, (value: string) => string | undefined>> = {
  "content-type": value => mediaType(value),
  "content-length": value => /^\d{1,12}$/.test(value) ? value : undefined,
  etag: value => /^(?:W\/)?"[\w.:+=-]{1,128}"$/.test(value) ? value : undefined,
  "x-request-id": value => /^[\w.:-]{1,128}$/.test(value) ? value : undefined,
  "retry-after": value => /^\d{1,9}$/.test(value) || HTTP_DATE.test(value) ? value : undefined,
  date: value => HTTP_DATE.test(value) ? value : undefined
}
const safeHeaders = (headers: Headers): [string, string][] => [...headers.entries()].flatMap(([key, value]): [string, string][] => {
  const shown = Object.hasOwn(HEADER_RULES, key) ? HEADER_RULES[key]!(value) : undefined
  return shown === undefined ? [] : [[key, shown]]
})
const TEXT_TYPES: ReadonlySet<string> = new Set(["application/json", "application/problem+json", "text/plain", "text/html", "application/x-www-form-urlencoded"])
const byteLength = (body: string) => new TextEncoder().encode(body).length
/** The viewer's own response: JSON pretty-printed, text as-is up to the cap, anything else summarized by size and allowlisted media type. */
const shownBody = (body: string, contentType: string | null) => {
  if (body === "") return ""
  const type = mediaType(contentType)
  try { return JSON.stringify(JSON.parse(body), null, 2) } catch {}
  if (type === undefined || !TEXT_TYPES.has(type)) return `[not shown: ${byteLength(body)} bytes, ${type ?? "other"}]`
  return body.length <= RESPONSE_TEXT_CAP ? body : `${body.slice(0, RESPONSE_TEXT_CAP)}\n[truncated: ${byteLength(body)} bytes, ${type}]`
}
/** §6.2.3 failure classes; anything else is unclassified, never echoed. */
const FAILURE_LABELS: Readonly<Record<string, string>> = { user: "user", permission: "permission", capacity: "capacity", github: "github", infra: "infra", conflict: "conflict", never: "never" }
const failureClass = (value: unknown) => typeof value === "string" && Object.hasOwn(FAILURE_LABELS, value) ? FAILURE_LABELS[value]! : "unclassified"

let instances = 0

export const installOperations = (document: OpenApiDocument) => {
  const operations: (DebugApiCard["operations"][number] & { spec: ApiOperation; parameters: ApiParameter[] })[] = []
  for (const [path, row] of Object.entries(document.paths)) {
    if (!validPath(path) || adminPath(path) || !installComposition(row["x-composition"])) continue
    for (const key of Object.keys(row)) {
      const method = key.toUpperCase() as HttpMethod
      if (!METHODS.includes(method)) continue
      const spec = row[key as Lowercase<HttpMethod>]
      if (!spec?.operationId || !installComposition(spec["x-composition"])) continue
      if (operations.some(operation => operation.id === spec.operationId)) throw Error("Duplicate OpenAPI operation")
      operations.push({ id: spec.operationId, method, path, summary: spec.summary ?? "", group: spec.tags?.[0] ?? "API", spec,
        parameters: [...(row.parameters ?? []), ...(spec.parameters ?? [])] })
    }
  }
  return operations
}

/** Pinned, or a success response schema that declares a credential-named field. */
const credentialOperation = (document: OpenApiDocument | undefined, operation: { id: string; spec: ApiOperation }) => {
  if (CREDENTIAL_OPERATIONS.has(operation.id)) return true
  const resolve = (schema?: ApiSchema, depth = 0): ApiSchema | undefined =>
    schema?.$ref?.startsWith("#/components/schemas/") && depth < 8 ? resolve(document?.components?.schemas?.[schema.$ref.slice(21)], depth + 1) : schema
  const declares = (schema?: ApiSchema, depth = 0): boolean => {
    const resolved = resolve(schema)
    return !!resolved?.properties && depth < 4 && Object.entries(resolved.properties).some(([name, child]) => credentialName(name) || declares(child, depth + 1))
  }
  return Object.entries(operation.spec.responses ?? {}).some(([status, response]) => /^2/.test(status) && typeof response === "object" && response !== null &&
    Object.values((response as { content?: Record<string, { schema?: ApiSchema }> }).content ?? {}).some(media => declares(media.schema)))
}

/** Session-local exchange, using the viewer's cookie and the install's route authorizer. */
export const createDebugApiSeam = (options: {
  document: () => Promise<OpenApiDocument>; gates: () => DebugApiGates; fetch: (url: string, init: RequestInit) => Promise<Response>; origin: string;
  uuid?: () => string; now?: () => number
}) => {
  let document: OpenApiDocument | undefined, operations: ReturnType<typeof installOperations> = []
  let snapshot: DebugApiSnapshot
  const listeners = new Set<() => void>(), keys = new Map<string, string>()
  let pending: { signature: string; confirmation: string; target: string; input: DebugApiInput } | undefined
  let generation = 0, epoch = 0, disposed = false
  const instance = ++instances
  let abort: AbortController | undefined
  let loading: Promise<void> | undefined
  const uuid = options.uuid ?? (() => crypto.randomUUID()), now = options.now ?? (() => performance.now())
  snapshot = { model: { operations: [] }, fields: [], epoch, instance }
  const publish = (value: DebugApiSnapshot) => { if (disposed) return; snapshot = { ...value, epoch, instance }; for (const listener of [...listeners]) listener() }
  const available = () => !disposed && Object.values(options.gates()).every(Boolean)
  const refuse = (message: string) => { throw Error(message) }
  const guard = () => { if (!available()) refuse("Debug API is unavailable") }
  const resolveParameter = (parameter: ApiParameter) => parameter.$ref?.startsWith("#/components/parameters/")
    ? document?.components?.parameters?.[parameter.$ref.slice(24)] ?? parameter : parameter
  const fieldsFor = (operation: typeof operations[number]): FormField[] => [
    ...operation.parameters.map(resolveParameter).filter(parameter => ["path", "query"].includes(parameter.in)).map(parameter => ({
      name: `${parameter.in}:${parameter.name}`, label: parameter.name, required: parameter.in === "path" || !!parameter.required,
      ...(parameter.schema?.enum ? { kind: "choice" as const, choices: parameter.schema.enum } : { kind: "text" as const })
    })),
    ...(operation.spec.requestBody?.content?.["application/json"] ? [{ name: "body", label: "JSON", kind: "text" as const,
      multiline: true, required: !!operation.spec.requestBody.required }] : [])
  ]
  const select = (id?: string) => {
    guard()
    const selected = id ?? operations[0]?.id
    const operation = operations.find(operation => operation.id === selected)
    if (!operation) refuse("Unknown API operation")
    generation++; pending = undefined
    publish({ model: { operations: snapshot.model.operations, selected }, fields: fieldsFor(operation!) })
  }
  const open = async (id?: string) => {
    guard()
    if (!document) {
      loading ??= options.document().then(value => { guard(); document = value; operations = installOperations(value)
        publish({ model: { operations: operations.map(({ spec: _spec, parameters: _parameters, ...operation }) => operation) }, fields: [] })
      }).finally(() => { loading = undefined })
      await loading
    }
    select(id)
  }
  const request = (input: DebugApiInput) => {
    const operation = operations.find(operation => operation.id === input.operationId)
    if (!operation) refuse("Unknown API operation")
    if (!validPath(operation!.path)) refuse("Invalid API path")
    const values = input.values ?? {}, fields = fieldsFor(operation!)
    if (Object.keys(values).some(name => !fields.some(field => field.name === name))) refuse("Unknown API parameter")
    for (const field of fields) if (field.required && !values[field.name]?.trim()) refuse(`Missing ${field.label}`)
    let path = operation!.path, shownPath = operation!.path
    const query = new URLSearchParams(), shownQuery: string[] = []
    // The echo is the request sent, except that a credential-minting
    // operation shows no parameter value.
    const credential = credentialOperation(document, operation!)
    for (const parameter of operation!.parameters.map(resolveParameter)) {
      const value = values[`${parameter.in}:${parameter.name}`]
      if (value === undefined || value === "") continue
      const shown = credential ? WITHHELD : encodeURIComponent(value)
      if (parameter.in === "path") {
        if (value === "." || value === ".." || /[\\/]/.test(value)) refuse("Invalid path parameter")
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
        shownPath = shownPath.replace(`{${parameter.name}}`, shown)
      } else if (parameter.in === "query") {
        query.append(parameter.name, value)
        shownQuery.push(`${encodeURIComponent(parameter.name)}=${shown}`)
      }
    }
    if (/[{}]/.test(path) || !validPath(path)) refuse("Invalid API path")
    const url = new URL(path, options.origin)
    if (url.origin !== new URL(options.origin).origin || url.username || url.password) refuse("Cross-origin API request")
    url.search = query.toString()
    const body = values.body
    if (body !== undefined && body !== "") { try { JSON.parse(body) } catch { refuse("Invalid JSON body") } }
    const shownSearch = shownQuery.length ? `?${shownQuery.join("&")}` : ""
    // Secret values written to a secrets path never echo (§8.8); neither does a credential exchange's body.
    const withholdBody = credential || /(?:^|\/)secrets(?:\/|$)/.test(url.pathname) || secretBody(body)
    return { req: { method: operation!.method, url: url.href, ...(body ? { body } : {}) },
      shown: { url: `${url.origin}${shownPath}${shownSearch}`, target: `${shownPath}${shownSearch}`, credential, withholdBody } }
  }
  const send = async (input: DebugApiInput) => {
    guard()
    if (snapshot.busy) return
    const effective = input.intent === "confirm" && pending && pending.confirmation === input.confirmation
      ? { ...input, values: { ...pending.input.values, ...input.values } } : input
    const { req, shown } = request(effective), signature = JSON.stringify(req)
    const operation = operations.find(operation => operation.id === input.operationId)!
    if (mutation(req.method) && input.intent !== "confirm") {
      // The confirmation id is random and held by the pending request; it is
      // never derived from the request, so it reveals nothing about the body.
      const confirmation = uuid(), target = uuid().replace(/-/g, "").slice(0, 8)
      pending = { signature, confirmation, target, input: { ...input, values: { ...input.values } } }
      const prefilled = shown.credential ? [] : fieldsFor(operation).flatMap(field =>
        field.name === "body" && shown.withholdBody ? [] : [{ ...field, value: input.values?.[field.name] }])
      publish({ ...snapshot, fields: prefilled, confirmation, target, model: { ...snapshot.model, pending: { method: req.method, path: shown.target } } })
      return
    }
    if (mutation(req.method)) {
      const confirmed = pending
      // One confirmation authorizes one execution: it is consumed here, before
      // fetch, whether it matches or not. A retry needs a fresh confirmation;
      // the idempotency key (by signature) is the separate retry identity.
      pending = undefined
      if (!confirmed || confirmed.signature !== signature || confirmed.confirmation !== input.confirmation) {
        publish({ ...snapshot, fields: fieldsFor(operation), confirmation: undefined, target: undefined, model: { ...snapshot.model, pending: undefined } })
        refuse("API confirmation is stale")
      }
    }
    const headers = new Headers()
    if (req.body) headers.set("Content-Type", "application/json")
    if (mutation(req.method)) { if (!keys.has(signature)) keys.set(signature, uuid()); headers.set("Idempotency-Key", keys.get(signature)!) }
    const seq = ++generation, account = epoch, started = now()
    const current = () => seq === generation && account === epoch
    const credential = shown.credential
    const exchange: NonNullable<DebugApiCard["exchange"]> = { request: { method: req.method, url: shown.url, headers: safeHeaders(headers),
      ...(req.body ? { body: shown.withholdBody ? WITHHELD : shownBody(req.body, "application/json") } : {}) } }
    // The cancellation exists before any subscriber hears of the Send, so a
    // reentrant endAccount aborts it; the epoch is rechecked right before fetch.
    const controller = abort = new AbortController()
    publish({ ...snapshot, busy: true, confirmation: undefined, target: undefined, model: { ...snapshot.model, pending: undefined, exchange } })
    if (!current() || controller.signal.aborted) return
    try {
      guard()
      if (!current()) return
      const response = await options.fetch(req.url, { signal: controller.signal, method: req.method, headers, body: req.body, credentials: "same-origin", redirect: "error" })
      if (response.redirected || (response.url && new URL(response.url).origin !== new URL(options.origin).origin)) refuse("API redirect refused")
      const body = await response.text()
      if (account !== epoch) return
      if (response.ok && mutation(req.method)) keys.delete(signature)
      const contentType = response.headers.get("content-type")
      // The viewer's own response, held only in this seam's memory. A
      // credential-minting operation's body is withheld whole.
      exchange.response = { status: response.status, headers: safeHeaders(response.headers),
        body: credential && body !== "" ? WITHHELD : shownBody(body, contentType), duration_ms: Math.max(0, now() - started) }
      if (!response.ok) {
        let error: { class?: unknown; message?: unknown } = {}
        try { const decoded: unknown = JSON.parse(body); if (decoded && typeof decoded === "object") error = decoded } catch {}
        exchange.failure = { class: error.class === undefined ? "infra" : failureClass(error.class),
          message: typeof error.message === "string" && !credential ? error.message : `HTTP ${response.status}`, status: response.status }
      }
    } catch (cause) { exchange.failure = { class: "infra", message: cause instanceof Error && cause.message === "API redirect refused" ? cause.message : "API request failed" } }
    if (current()) publish({ ...snapshot, fields: fieldsFor(operation), busy: false, confirmation: undefined, target: undefined, model: { ...snapshot.model, pending: undefined, exchange } })
  }
  /** The account that owned every exchange, confirmation and retry key is gone: drop them and fence late answers. */
  const endAccount = () => {
    epoch++; generation++; abort?.abort(); abort = undefined; pending = undefined; keys.clear()
    publish({ model: { operations: snapshot.model.operations }, fields: [] })
  }
  return { available, open, select, send, endAccount, get: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { disposed = true; abort?.abort(); generation++; epoch++; pending = undefined; keys.clear(); listeners.clear(); document = undefined; operations = []; snapshot = { model: { operations: [] }, fields: [], instance } } }
}
export type DebugApiSeam = ReturnType<typeof createDebugApiSeam>
/** Durable copy for a failed exchange: status and class only, never the response's words. */
export const debugApiFailureCopy = (failure: { class: string; status?: number }) => {
  const kind = failureClass(failure.class)
  return failure.status === undefined ? `The API request failed (${kind}).` : `The API answered HTTP ${failure.status} (${kind}).`
}
