import type { DebugApiCard, HttpMethod } from "@smthrs/rpc/DebugApiCard"
import type { FormField } from "@smthrs/rpc/CardAction"

export interface ApiSchema { $ref?: string; type?: string; enum?: string[]; properties?: Record<string, ApiSchema>; required?: string[] }
export interface ApiParameter { name: string; in: string; required?: boolean; schema?: ApiSchema; $ref?: string }
export interface ApiOperation {
  operationId?: string; summary?: string; tags?: string[]; "x-composition"?: string;
  parameters?: ApiParameter[]; requestBody?: { required?: boolean; content?: Record<string, { schema?: ApiSchema }> };
  responses?: Record<string, unknown>
}
export interface OpenApiDocument {
  paths: Record<string, { parameters?: ApiParameter[] } & Partial<Record<Lowercase<HttpMethod>, ApiOperation>> & { "x-composition"?: string }>;
  components?: { schemas?: Record<string, ApiSchema>; parameters?: Record<string, ApiParameter> }
}
export interface DebugApiInput {
  operationId?: string; intent?: "open" | "send" | "confirm"; values?: Record<string, string>; confirmation?: string
}
export interface DebugApiGates { view: boolean; catalog: boolean; authorizer: boolean }
/** `epoch` names the account generation; the Container keys the View by it so no form draft outlives its account. */
export type DebugApiSnapshot = { model: DebugApiCard; fields: FormField[]; confirmation?: string; busy?: boolean; epoch?: number }
const METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
const mutation = (method: string) => method !== "GET" && method !== "HEAD"
const secretBody = (body?: string) => !!body && /"(?:value|password|token|secret|api[_-]?key)"\s*:/i.test(body)
const validPath = (path: string) => /^\/api(?:\/|$)/.test(path) && !/[\\?#\u0000-\u0020]/.test(path) && !/%(?:2f|5c|2e)/i.test(path) && !path.split("/").some(part => part === "." || part === "..")
/** §6.2.4: the install serves rows with no composition marker; `install` is explicit. Anything else is not the install's. */
const installComposition = (composition?: string) => composition === undefined || composition === "install"
const adminPath = (path: string) => /^\/api\/admin(?:\/|$)/.test(path)

/**
 * Operations whose whole response is a credential the person must not see
 * pasted into a pane (tickets, tokens, OAuth codes, callback handoffs).
 * Pinned because their OpenAPI rows declare AnyJSON or no body; OpenApi.test
 * checks each id is a release install operation. Schema-declared credential
 * fields are found from the document as well (`credentialOperation`).
 */
export const CREDENTIAL_OPERATIONS: ReadonlySet<string> = new Set([
  "post_api_auth_sse_ticket", "post_api_v1_sse_ticket", "post_api_auth_github_token_exchange", "get_api_auth_github_callback",
  "get_api_auth_auth0_callback", "get_api_oauth2_authorize", "post_api_oauth2_authorize", "post_api_oauth2_token", "post_api_user_tokens",
  "post_api_repos_owner_repo_build_cache_tokens", "get_api_user_emails_verify_token", "post_api_user_emails_verify_token",
  "get_api_repos_owner_repo_workspace_sessions_id_ssh", "post_api_model_credential"
])
const REDACTED = "[redacted]"
/** Field names that carry a credential. Unclassified fields fail closed on name; a bare `value` is a secret's value. */
const credentialName = (key: string) =>
  /^value$|token|ticket|secret|passw|cookie|credential|api[-_]?key|private[-_]?key|access[-_]?key|^key$|authorization|session[-_]?(?:id|key)|client[-_]?secret|code[-_]?verifier/i.test(key)
const TOKEN_SHAPES = [
  /eyJ[\w-]+\.[\w-]+\.[\w-]*/g, // JWT
  /\b(?:gh[pousr]_|github_pat_|sk-|smt_|xox[abpr]-|AKIA)[\w-]{8,}/g, // provider prefixes
  /\b[0-9a-f]{48,}(?:\.[\w-]+)?/gi, // 192-bit+ hex secrets (ticket, digest); commit SHAs (40) stay
  /\b(?=[\w-]*[A-Z])(?=[\w-]*[a-z])(?=[\w-]*\d)[\w-]{32,}/g // mixed-case base64url
]
const tokenShaped = (value: string) => TOKEN_SHAPES.some(shape => { shape.lastIndex = 0; return shape.test(value) })
/** Text with every token-shaped run replaced. */
export const maskText = (text: string) => TOKEN_SHAPES.reduce((masked, shape) => masked.replace(shape, REDACTED), text)
/** Header names that carry credentials are dropped; every other value is token-shape masked. */
const safeHeaders = (headers: Headers): [string, string][] => [...headers.entries()].filter(([key]) =>
  !/(authorization|cookie|token|secret|api[-_]key)/i.test(key)).map(([key, value]) => [key, maskText(value)])
/** What an unclassified body shows instead of itself. */
const withheld = (body: string, contentType: string | null) =>
  `[withheld: ${new TextEncoder().encode(body).length} bytes, ${contentType?.split(";")[0]?.trim() || "unknown type"}]`
/** §6.2.3 failure classes; anything else is unclassified, never echoed. */
const FAILURE_LABELS: Readonly<Record<string, string>> = { user: "user", permission: "permission", capacity: "capacity", github: "github", infra: "infra", conflict: "conflict", never: "never" }
const failureClass = (value: unknown) => typeof value === "string" && Object.hasOwn(FAILURE_LABELS, value) ? FAILURE_LABELS[value]! : "unclassified"
/** Every string under a credential-named key is masked, as is any token-shaped string anywhere. */
const maskValue = (value: unknown, sensitive = false): unknown => {
  if (typeof value === "string") return sensitive || tokenShaped(value) ? REDACTED : value
  if (Array.isArray(value)) return value.map(item => maskValue(item, sensitive))
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, maskValue(item, sensitive || credentialName(name))]))
  return value
}
/**
 * A body for display: credential operations and secret paths are redacted
 * whole; JSON is masked per field; anything else is withheld (size and type only).
 */
export const displayedBody = (body: string, path: string, credential = false, contentType: string | null = null) => {
  if (body === "") return ""
  if (credential || /(?:^|\/)secrets(?:\/|$)/.test(path)) return REDACTED
  let decoded: unknown
  try { decoded = JSON.parse(body) } catch { return withheld(body, contentType) }
  return JSON.stringify(maskValue(decoded))
}

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
  let snapshot: DebugApiSnapshot = { model: { operations: [] }, fields: [] }
  const listeners = new Set<() => void>(), keys = new Map<string, string>()
  let pending: { signature: string; confirmation: string; input: DebugApiInput } | undefined
  let generation = 0, epoch = 0, disposed = false
  let abort: AbortController | undefined
  let loading: Promise<void> | undefined
  const uuid = options.uuid ?? (() => crypto.randomUUID()), now = options.now ?? (() => performance.now())
  const publish = (value: DebugApiSnapshot) => { if (disposed) return; snapshot = { ...value, epoch }; for (const listener of [...listeners]) listener() }
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
    // The echo is built apart from the request sent: a credential operation
    // shows no parameter value, and any other value is masked by name or shape.
    const credential = credentialOperation(document, operation!)
    const shown = (name: string, value: string) => credential || credentialName(name) || tokenShaped(value) ? REDACTED : encodeURIComponent(value)
    for (const parameter of operation!.parameters.map(resolveParameter)) {
      const value = values[`${parameter.in}:${parameter.name}`]
      if (value === undefined || value === "") continue
      if (parameter.in === "path") {
        if (value === "." || value === ".." || /[\\/]/.test(value)) refuse("Invalid path parameter")
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
        shownPath = shownPath.replace(`{${parameter.name}}`, shown(parameter.name, value))
      } else if (parameter.in === "query") { query.append(parameter.name, value); shownQuery.push(`${encodeURIComponent(parameter.name)}=${shown(parameter.name, value)}`) }
    }
    if (/[{}]/.test(path) || !validPath(path)) refuse("Invalid API path")
    const url = new URL(path, options.origin)
    if (url.origin !== new URL(options.origin).origin || url.username || url.password) refuse("Cross-origin API request")
    url.search = query.toString()
    const body = values.body
    if (body !== undefined && body !== "") { try { JSON.parse(body) } catch { refuse("Invalid JSON body") } }
    return { req: { method: operation!.method, url: url.href, ...(body ? { body } : {}) },
      shown: { url: `${url.origin}${shownPath}${shownQuery.length ? `?${shownQuery.join("&")}` : ""}`, path: shownPath, credential } }
  }
  const send = async (input: DebugApiInput) => {
    guard()
    if (snapshot.busy) return
    const effective = input.intent === "confirm" && pending && pending.confirmation === input.confirmation
      ? { ...input, values: { ...pending.input.values, ...input.values } } : input
    const { req, shown } = request(effective), signature = JSON.stringify(req)
    const operation = operations.find(operation => operation.id === input.operationId)!
    if (mutation(req.method) && input.intent !== "confirm") {
      const confirmation = uuid()
      pending = { signature, confirmation, input: { ...input, values: { ...input.values } } }
      publish({ ...snapshot, fields: shown.credential || secretBody(req.body) || /\/secrets(?:\/|$)/.test(new URL(req.url).pathname) ? [] : snapshot.fields.map(field => ({ ...field, value: input.values?.[field.name] })), confirmation, model: { ...snapshot.model, pending: { method: req.method, path: shown.path } } })
      return
    }
    if (mutation(req.method)) {
      const confirmed = pending
      // One confirmation authorizes one execution: it is consumed here, before
      // fetch, whether it matches or not. A retry needs a fresh confirmation;
      // the idempotency key (by signature) is the separate retry identity.
      pending = undefined
      if (!confirmed || confirmed.signature !== signature || confirmed.confirmation !== input.confirmation) {
        publish({ ...snapshot, fields: fieldsFor(operation), confirmation: undefined, model: { ...snapshot.model, pending: undefined } })
        refuse("API confirmation is stale")
      }
    }
    const headers = new Headers()
    if (req.body) headers.set("Content-Type", "application/json")
    if (mutation(req.method)) { if (!keys.has(signature)) keys.set(signature, uuid()); headers.set("Idempotency-Key", keys.get(signature)!) }
    const seq = ++generation, account = epoch, started = now()
    const current = () => seq === generation && account === epoch
    const path = new URL(req.url).pathname, credential = shown.credential
    const exchange: NonNullable<DebugApiCard["exchange"]> = { request: { method: req.method, url: shown.url, headers: safeHeaders(headers), ...(req.body ? { body: displayedBody(req.body, path, credential || secretBody(req.body)) } : {}) } }
    // The cancellation exists before any subscriber hears of the Send, so a
    // reentrant endAccount aborts it; the epoch is rechecked right before fetch.
    const controller = abort = new AbortController()
    publish({ ...snapshot, busy: true, confirmation: undefined, model: { ...snapshot.model, pending: undefined, exchange } })
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
      // An error body is withheld whole: its envelope message and class are
      // server words. Only the enumerated class and the status are kept.
      exchange.response = { status: response.status, headers: safeHeaders(response.headers),
        body: response.ok ? displayedBody(body, path, credential, contentType) : body === "" ? "" : withheld(body, contentType), duration_ms: Math.max(0, now() - started) }
      if (!response.ok) {
        let error: { class?: unknown } = {}
        try { const decoded: unknown = JSON.parse(body); if (decoded && typeof decoded === "object") error = decoded } catch {}
        exchange.failure = { class: error.class === undefined ? "infra" : failureClass(error.class), message: `HTTP ${response.status}`, status: response.status }
      }
    } catch (cause) { exchange.failure = { class: "infra", message: cause instanceof Error && cause.message === "API redirect refused" ? cause.message : "API request failed" } }
    if (current()) publish({ ...snapshot, fields: fieldsFor(operation), busy: false, confirmation: undefined, model: { ...snapshot.model, pending: undefined, exchange } })
  }
  /** The account that owned every exchange, confirmation and retry key is gone: drop them and fence late answers. */
  const endAccount = () => {
    epoch++; generation++; abort?.abort(); abort = undefined; pending = undefined; keys.clear()
    publish({ model: { operations: snapshot.model.operations }, fields: [] })
  }
  return { available, open, select, send, endAccount, get: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { disposed = true; abort?.abort(); generation++; epoch++; pending = undefined; keys.clear(); listeners.clear(); document = undefined; operations = []; snapshot = { model: { operations: [] }, fields: [] } } }
}
export type DebugApiSeam = ReturnType<typeof createDebugApiSeam>
/** Durable copy for a failed exchange: status and class only, never the response's words. */
export const debugApiFailureCopy = (failure: { class: string; status?: number }) => {
  const kind = failureClass(failure.class)
  return failure.status === undefined ? `The API request failed (${kind}).` : `The API answered HTTP ${failure.status} (${kind}).`
}
