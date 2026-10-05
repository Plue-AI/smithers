/**
 * Test double for the Cloudflare control-plane endpoints the deploy interlock
 * and the sealed-inventory CLI (cutover/deploy.ts) read and write, serving the
 * one web Worker. Versions are immutable; secret VALUES live only inside the
 * fake and are never returned by any GET, matching the provider. Like the
 * provider (observed live 2026-09-24), script-level /settings and /content/v2
 * describe the NEWEST UPLOAD, not the deployed version; only /versions/{id}
 * describes one exact version.
 */
import { createHash, randomUUID } from "node:crypto"
import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { cloudflareApiBase } from "./cloudflareApi"
const accountURL = `${cloudflareApiBase}/accounts/${WORKER_IDENTITY.accountId}`

export interface FakeModule { name: string; type: string; bytes: Uint8Array }
export interface FakeVersion { id: string; entry: string; modules: FakeModule[]; bindings: Array<Record<string, unknown>>; secrets: Record<string, string>; settings: Record<string, unknown>; message: string }
export interface FakeWorker { versions: Map<string, FakeVersion>; live: string; latest: string; deployments: Array<{ id: string; created_on: string; versions: Array<{ version_id: string; percentage: number }> }>; subdomain: { enabled: boolean; previews_enabled: boolean }; routes: string[]; domains: string[]; schedules: string[] }
const utf8 = (s: string) => new TextEncoder().encode(s)

export class FakeCloudflare {
  readonly workers = new Map<string, FakeWorker>()
  readonly namespaces: Array<{ id: string; script: string; class: string; use_sqlite: boolean }> = []
  readonly mutations: string[] = []
  failPut = new Set<string>(); losePutResponse = new Set<string>()
  private realFetch = globalThis.fetch
  constructor() {
    const worker = WORKER_IDENTITY.name
    const bindings: Array<Record<string, unknown>> = [{ type: "plain_text", name: "SMITHERS_BACKEND_ORIGIN", text: "https://api.jjhub.tech" }]
    WORKER_IDENTITY.durableObjects.forEach(({ binding, className }, index) => {
      const id = (index + 1).toString(16).padStart(32, "0")
      bindings.push({ type: "durable_object_namespace", name: binding, class_name: className, namespace_id: id })
      this.namespaces.push({ id, script: worker, class: className, use_sqlite: true })
    })
    const source = `${WORKER_IDENTITY.durableObjects.map(({ className }) => `export class ${className} {}`).join("\n")}\nexport default { fetch() { return new Response("legacy") } }`
    // Live as the legacy Worker was before the edge activation; a test makes any other version live with setLive.
    const version: FakeVersion = { id: randomUUID(), entry: "index.js", modules: [{ name: "index.js", type: "text/javascript", bytes: utf8(source) }], bindings,
      secrets: { API_SECRET: `secret-value-${worker}` }, message: `original ${worker}`,
      settings: { compatibility_date: "2026-08-01", compatibility_flags: [], placement: {}, tags: [], tail_consumers: [], logpush: false, usage_model: "standard", observability: { enabled: true } } }
    this.workers.set(worker, { versions: new Map([[version.id, version]]), live: version.id, latest: version.id, deployments: [{ id: randomUUID(), created_on: new Date(Date.now() - 86_400_000).toISOString(), versions: [{ version_id: version.id, percentage: 100 }] }],
      subdomain: { enabled: false, previews_enabled: false }, routes: [], domains: [`${worker}.smithers.sh`], schedules: [] })
  }
  /** Makes a crafted version live, e.g. a maintenance export or a legacy bundle, for interlock tests. */
  setLive(worker: string, entry: string, message: string | null, extraModules: string[] = []) {
    const w = this.workers.get(worker)!, current = this.live(worker)
    const version: FakeVersion = { ...current, id: randomUUID(), entry, message: message ?? "",
      modules: [entry, ...extraModules].map(name => ({ name, type: name.endsWith(".map") ? "application/source-map" : "application/javascript+module", bytes: utf8(`// ${name}`) })) }
    w.versions.set(version.id, version); w.latest = version.id; this.deploy(w, version.id)
    return version.id
  }
  install() { globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => this.handle(new Request(input, init))) as typeof fetch; return this }
  restore() { globalThis.fetch = this.realFetch }
  live(worker: string) { const w = this.workers.get(worker)!; return w.versions.get(w.live)! }
  latest(worker: string) { const w = this.workers.get(worker)!; return w.versions.get(w.latest)! }
  /** A version uploaded but not deployed (wrangler versions upload / gradual deployments). */
  uploadOnly(worker: string) {
    const w = this.workers.get(worker)!, version = { ...this.live(worker), id: randomUUID(), message: "uploaded, not deployed" }
    w.versions.set(version.id, version); w.latest = version.id
    return version.id
  }
  /** Someone else deploys a new version (drift / foreign ownership). */
  foreignDeploy(worker: string) {
    const w = this.workers.get(worker)!, current = this.live(worker)
    const version = { ...current, id: randomUUID(), message: "someone else" }
    w.versions.set(version.id, version); w.latest = version.id; this.deploy(w, version.id)
    return version.id
  }
  private deploy(w: FakeWorker, id: string) { w.live = id; w.deployments.unshift({ id: randomUUID(), created_on: new Date().toISOString(), versions: [{ version_id: id, percentage: 100 }] }) }
  private ok(result: unknown, headers: Record<string, string> = {}) { return Response.json({ success: true, result }, { headers }) }
  private settings(v: FakeVersion) {
    return { ...v.settings, annotations: { "workers/message": v.message }, bindings: [...v.bindings, ...Object.keys(v.secrets).sort().map(name => ({ type: "secret_text", name }))] }
  }
  /**
   * Serves this fixture over loopback to operator CLIs run as real child
   * processes: `bun --preload <preload> ...` sends their Cloudflare API calls
   * here. `trap` may hold one request, before or after the fixture accepts it,
   * so a test can kill the child or drop the response at exactly that point;
   * `held` resolves when it does.
   */
  serve(directory: string, trap: (method: string, path: string) => "before" | "after" | "drop-after" | undefined = () => undefined) {
    let reached!: () => void
    const held = new Promise<void>(resolve => { reached = resolve })
    const server = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url), path = url.pathname.slice("/acct".length) + url.search, hold = trap(request.method, path)
        if (hold === "before") { reached(); return new Promise<Response>(() => {}) }
        const response = await this.handle(new Request(accountURL + path, { method: request.method, headers: request.headers, body: request.method === "GET" ? undefined : await request.arrayBuffer() }))
        if (hold === "after") { reached(); return new Promise<Response>(() => {}) }
        // The provider committed the request, then the connection closed before any response.
        if (hold === "drop-after") { reached(); server.stop(true); return new Promise<Response>(() => {}) }
        return response
      }
    })
    const preload = join(directory, `loopback-preload-${randomUUID()}.ts`)
    writeFileSync(preload, `const account = ${JSON.stringify(accountURL)}, proxy = ${JSON.stringify(`${server.url.origin}/acct`)}, real = globalThis.fetch
globalThis.fetch = (async (input, init) => {
  const request = new Request(input, init)
  if (!request.url.startsWith(account)) return real(request)
  const body = request.method === "GET" ? undefined : await request.arrayBuffer()
  return real(proxy + request.url.slice(account.length), { method: request.method, headers: request.headers, body, signal: init?.signal })
})\n`, { mode: 0o600 })
    return { preload, held, stop: () => server.stop(true) }
  }
  handle = async (request: Request): Promise<Response> => {
    const url = new URL(request.url)
    if (!url.href.startsWith(accountURL)) return new Response("unexpected network", { status: 599 })
    const path = url.pathname.slice(new URL(accountURL).pathname.length), method = request.method
    if (path === "/workers/domains") return this.ok([...this.workers].flatMap(([service, w]) => w.domains.map(hostname => ({ hostname, service, environment: "production", enabled: true }))))
    if (path === "/workers/subdomain") return this.ok({ subdomain: "acct" })
    if (path === "/workers/durable_objects/namespaces") return this.ok(url.searchParams.get("page") === "1" ? this.namespaces : [])
    const m = /^\/workers\/scripts\/([a-z0-9-]+)(\/.*)?$/.exec(path)
    const w = m && this.workers.get(m[1]!)
    if (!m || !w) return Response.json({ success: false }, { status: 404 })
    const worker = m[1]!, rest = m[2] ?? ""
    if (rest === "/deployments" && method === "GET") return this.ok({ deployments: w.deployments })
    if (rest === "/deployments" && method === "POST") {
      const body = await request.json() as { versions: Array<{ version_id: string; percentage: number }> }
      if (body.versions.length !== 1 || !w.versions.has(body.versions[0]!.version_id)) return Response.json({ success: false }, { status: 400 })
      this.mutations.push(`rollback ${worker}`); this.deploy(w, body.versions[0]!.version_id); return this.ok({ id: randomUUID() })
    }
    if (rest === "/settings") return this.ok(this.settings(this.latest(worker)))
    if (rest === "/versions" || rest.startsWith("/versions?")) return this.ok({ items: [...w.versions.values()].map((v, i) => ({ id: v.id, number: i + 1 })).reverse() })
    if (rest === "/routes") return this.ok(w.routes.map(pattern => ({ pattern, script: worker })))
    if (rest === "/schedules") return this.ok({ schedules: w.schedules.map(cron => ({ cron })) })
    if (rest === "/subdomain" && method === "GET") return this.ok(w.subdomain)
    if (rest === "/subdomain" && method === "POST") { this.mutations.push(`subdomain ${worker}`); w.subdomain = await request.json() as FakeWorker["subdomain"]; return this.ok(w.subdomain) }
    if (rest.startsWith("/versions/")) { const v = w.versions.get(rest.slice(10)); return v ? this.ok({ id: v.id, metadata: { source: "api" }, annotations: { ...v.message ? { "workers/message": v.message } : {}, "workers/triggered_by": "upload" },
      resources: { script: { etag: createHash("sha256").update(JSON.stringify([v.entry, ...v.modules.map(m => [m.name, createHash("sha256").update(m.bytes).digest("hex")])])).digest("hex") },
        script_runtime: { compatibility_date: v.settings.compatibility_date, ...(v.settings.compatibility_flags as string[] | undefined)?.length ? { compatibility_flags: v.settings.compatibility_flags } : {}, usage_model: v.settings.usage_model },
        bindings: this.settings(v).bindings } }) : Response.json({ success: false }, { status: 404 }) }
    if (rest === "/content/v2") {
      const v = this.latest(worker), form = new FormData()
      for (const mod of v.modules) form.set(mod.name, new Blob([mod.bytes as Uint8Array<ArrayBuffer>], { type: mod.type }), mod.name)
      return new Response(form, { headers: { "cf-entrypoint": v.entry } })
    }
    if (rest === "" && method === "PUT") {
      this.mutations.push(`put ${worker}`)
      if (this.failPut.has(worker)) return Response.json({ success: false }, { status: 500 })
      const form = await request.formData(), metadata = JSON.parse(await (form.get("metadata") as File).text()) as { main_module: string; bindings: Array<Record<string, unknown>>; keep_bindings?: string[]; annotations?: Record<string, string> } & Record<string, unknown>
      const modules: FakeModule[] = []
      for (const [name, part] of form) if (name !== "metadata") modules.push({ name, type: (part as File).type, bytes: new Uint8Array(await (part as File).arrayBuffer()) })
      const main = modules.find(x => x.name === metadata.main_module)
      if (!main) return Response.json({ success: false }, { status: 400 })
      const source = new TextDecoder().decode(main.bytes)
      // The provider rejects a version whose bound Durable Object classes are not exported.
      for (const b of metadata.bindings) if (b.type === "durable_object_namespace" && !new RegExp(`export class ${b.class_name}\\b`).test(source)) return Response.json({ success: false }, { status: 400 })
      const previous = this.latest(worker), secrets = metadata.keep_bindings?.includes("secret_text") ? { ...previous.secrets } : {}
      for (const b of metadata.bindings) if (b.type === "secret_text") secrets[b.name as string] = b.text as string
      const settings = Object.fromEntries(Object.entries(metadata).filter(([k]) => !["main_module", "bindings", "keep_bindings", "keep_assets", "annotations"].includes(k)))
      const version: FakeVersion = { id: randomUUID(), entry: metadata.main_module, modules, bindings: metadata.bindings.filter(b => b.type !== "secret_text"), secrets, settings, message: metadata.annotations?.["workers/message"] ?? "" }
      w.versions.set(version.id, version); w.latest = version.id; this.deploy(w, version.id)
      if (this.losePutResponse.has(worker)) { this.losePutResponse.delete(worker); return Response.json({ success: false }, { status: 502 }) }
      return this.ok({ id: worker, deployment_id: version.id })
    }
    return Response.json({ success: false }, { status: 404 })
  }
}
