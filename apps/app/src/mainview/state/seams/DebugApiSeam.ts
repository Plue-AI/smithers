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
export type DebugApiSnapshot = { model: DebugApiCard; fields: FormField[]; confirmation?: string; busy?: boolean }
const METHODS: HttpMethod[] = ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]
const mutation = (method: string) => method !== "GET" && method !== "HEAD"
const safeHeaders = (headers: Headers): [string, string][] => [...headers.entries()].filter(([key]) =>
  !/(authorization|cookie|token|secret|api[-_]key)/i.test(key))
const secretBody = (body?: string) => !!body && /"(?:value|password|token|secret|api[_-]?key)"\s*:/i.test(body)
const displayedBody = (body: string, path: string) => /(?:^|\/)secrets(?:\/|$)/.test(path) || secretBody(body) ? "[redacted]" : body
const validPath = (path: string) => /^\/api(?:\/|$)/.test(path) && !/[\\?#\u0000-\u0020]/.test(path) && !/%(?:2f|5c|2e)/i.test(path) && !path.split("/").some(part => part === "." || part === "..")

export const installOperations = (document: OpenApiDocument) => {
  const operations: (DebugApiCard["operations"][number] & { spec: ApiOperation; parameters: ApiParameter[] })[] = []
  for (const [path, row] of Object.entries(document.paths)) {
    if (!validPath(path) || row["x-composition"] === "plue") continue
    for (const key of Object.keys(row)) {
      const method = key.toUpperCase() as HttpMethod
      if (!METHODS.includes(method)) continue
      const spec = row[key as Lowercase<HttpMethod>]
      if (!spec?.operationId || spec["x-composition"] === "plue") continue
      if (operations.some(operation => operation.id === spec.operationId)) throw Error("Duplicate OpenAPI operation")
      operations.push({ id: spec.operationId, method, path, summary: spec.summary ?? "", group: spec.tags?.[0] ?? "API", spec,
        parameters: [...(row.parameters ?? []), ...(spec.parameters ?? [])] })
    }
  }
  return operations
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
  let generation = 0, disposed = false
  let abort: AbortController | undefined
  let loading: Promise<void> | undefined
  const uuid = options.uuid ?? (() => crypto.randomUUID()), now = options.now ?? (() => performance.now())
  const publish = (value: DebugApiSnapshot) => { if (disposed) return; snapshot = value; for (const listener of listeners) listener() }
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
    let path = operation!.path
    const query = new URLSearchParams()
    for (const parameter of operation!.parameters.map(resolveParameter)) {
      const value = values[`${parameter.in}:${parameter.name}`]
      if (value === undefined || value === "") continue
      if (parameter.in === "path") {
        if (value === "." || value === ".." || /[\\/]/.test(value)) refuse("Invalid path parameter")
        path = path.replace(`{${parameter.name}}`, encodeURIComponent(value))
      } else if (parameter.in === "query") query.append(parameter.name, value)
    }
    if (/[{}]/.test(path) || !validPath(path)) refuse("Invalid API path")
    const url = new URL(path, options.origin)
    if (url.origin !== new URL(options.origin).origin || url.username || url.password) refuse("Cross-origin API request")
    url.search = query.toString()
    const body = values.body
    if (body !== undefined && body !== "") { try { JSON.parse(body) } catch { refuse("Invalid JSON body") } }
    return { method: operation!.method, url: url.href, ...(body ? { body } : {}) }
  }
  const send = async (input: DebugApiInput) => {
    guard()
    if (snapshot.busy) return
    const effective = input.intent === "confirm" && pending && pending.confirmation === input.confirmation
      ? { ...input, values: { ...pending.input.values, ...input.values } } : input
    const req = request(effective), signature = JSON.stringify(req)
    if (mutation(req.method) && input.intent !== "confirm") {
      const confirmation = uuid()
      pending = { signature, confirmation, input: { ...input, values: { ...input.values } } }
      publish({ ...snapshot, fields: secretBody(req.body) || /\/secrets(?:\/|$)/.test(new URL(req.url).pathname) ? [] : snapshot.fields.map(field => ({ ...field, value: input.values?.[field.name] })), confirmation, model: { ...snapshot.model, pending: { method: req.method, path: new URL(req.url).pathname } } })
      return
    }
    if (mutation(req.method)) {
      if (!pending || pending.signature !== signature || pending.confirmation !== input.confirmation) {
        pending = undefined
        publish({ ...snapshot, fields: fieldsFor(operations.find(operation => operation.id === input.operationId)!), confirmation: undefined, model: { ...snapshot.model, pending: undefined } })
        refuse("API confirmation is stale")
      }
    }
    const headers = new Headers()
    if (req.body) headers.set("Content-Type", "application/json")
    if (mutation(req.method)) { if (!keys.has(signature)) keys.set(signature, uuid()); headers.set("Idempotency-Key", keys.get(signature)!) }
    const seq = ++generation, started = now()
    const exchange: NonNullable<DebugApiCard["exchange"]> = { request: { method: req.method, url: req.url, headers: safeHeaders(headers), ...(req.body ? { body: displayedBody(req.body, new URL(req.url).pathname) } : {}) } }
    publish({ ...snapshot, busy: true, model: { ...snapshot.model, pending: undefined, exchange } })
    try {
      guard()
      abort = new AbortController()
      const response = await options.fetch(req.url, { signal: abort.signal, method: req.method, headers, body: req.body, credentials: "same-origin", redirect: "error" })
      if (response.redirected || (response.url && new URL(response.url).origin !== new URL(options.origin).origin)) refuse("API redirect refused")
      const body = await response.text()
      if (response.ok && mutation(req.method)) keys.delete(signature)
      exchange.response = { status: response.status, headers: safeHeaders(response.headers), body: displayedBody(body, new URL(req.url).pathname), duration_ms: Math.max(0, now() - started) }
      if (!response.ok) {
        let error: { class?: string; message?: string } = {}
        try { const decoded: unknown = JSON.parse(body); if (decoded && typeof decoded === "object") error = decoded } catch {}
        exchange.failure = { class: typeof error.class === "string" ? error.class : "infra", message: typeof error.message === "string" ? error.message : `HTTP ${response.status}`, status: response.status }
      }
    } catch (cause) { exchange.failure = { class: "infra", message: cause instanceof Error ? cause.message : "API request failed" } }
    if (seq === generation) publish({ ...snapshot, fields: fieldsFor(operations.find(operation => operation.id === input.operationId)!), busy: false, confirmation: undefined, model: { ...snapshot.model, pending: undefined, exchange } })
  }
  return { available, open, select, send, get: () => snapshot, subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { disposed = true; abort?.abort(); generation++; pending = undefined; keys.clear(); listeners.clear(); document = undefined; operations = []; snapshot = { model: { operations: [] }, fields: [] } } }
}
export type DebugApiSeam = ReturnType<typeof createDebugApiSeam>
