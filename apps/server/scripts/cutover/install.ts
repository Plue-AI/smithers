/**
 * One-time Cloudflare admission/fence installer and exact restore for all 14
 * product authorities.
 *
 *   bun scripts/cutover/install.ts prepare PRIVATE_DIR [--rehearsal smithers-cutover-rehearsal-<id>]
 *   bun scripts/cutover/install.ts apply   PRIVATE_DIR PLAN_SHA256 admission|fence
 *   bun scripts/cutover/install.ts restore PRIVATE_DIR PLAN_SHA256
 *   bun scripts/cutover/install.ts status  PRIVATE_DIR PLAN_SHA256
 *
 * prepare is GET-only and writes an immutable plan: exact original versions,
 * module bytes, settings, namespace/class identities, secret binding NAMES (never
 * values), public surfaces, the generated admission/fence modules and the whole
 * mutation sequence. apply/restore mutate only through the plan, and only after
 * the gate hook (SMITHERS_CUTOVER_AUTHORIZE) authorizes that exact step and an
 * fsynced journal intent exists. Restore redeploys the exact original version id
 * and touches only versions this execution owns. Exit 2 prints {"refused":CODE}.
 */
import { createHash, randomUUID } from "node:crypto"
import { closeSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync, writeSync } from "node:fs"
import { hostname } from "node:os"
import { isAbsolute, resolve } from "node:path"
import { spawnSync } from "node:child_process"
import { accountURL, api, type Binding, type Settings } from "./cloudflare"
import { stable, uploadModuleType, uploadedVersion } from "./deployment"
import { CLOUDFLARE_PRODUCERS, privateArtifact, type ArtifactReference, type FenceExpected } from "./fence"
import { admissionModule, fenceModule } from "./fence-module"
import { authoritySurface, type AuthoritySurface } from "./fence-routes"
import { readRecipient } from "./drain"
import { EXPORT_BINDINGS } from "../../src/MaintenanceExport"
import type { FenceIdentity } from "../../src/MaintenanceFence"

export const ADMISSION_WORKERS = ["smithers-cloud-chat-canary", "smithers-cloud-chat", "smithers-cloud-billing"] as const
// Producers first, the billing sink last: late charges from already admitted work keep draining until billing itself closes.
export const FENCE_ORDER = [...CLOUDFLARE_PRODUCERS.filter(w => w !== "smithers-cloud-billing"), "smithers-cloud-billing"] as const
export const MAINTENANCE_SECRETS = ["SMITHERS_EXPORT_TOKEN", "SMITHERS_EXPORT_RECIPIENT", "SMITHERS_EXPORT_EXPIRES_AT", "SMITHERS_EXPORT_SOURCE_REVISION", "SMITHERS_EXPORT_SOURCE_VERSION"] as const
const MIN_CREDENTIAL_MS = 30 * 60_000
type Phase = "admission" | "fence"
type Action = "previews-off" | "admission" | "fence"
export interface ModuleRef extends ArtifactReference { name: string; type: string }
export interface Generated { entry: ModuleRef; helper: ModuleRef; metadata: ArtifactReference }
export interface WorkerPlan {
  worker: string; originalVersion: string; originalDeployment: string; settingsSHA256: string; originalSettings: ArtifactReference
  entry: string; originalModules: ModuleRef[]; sourceArtifactSHA256: string
  /** Provider etag of the exact original version; version ids and their content are immutable. */
  originalEtag: string
  objects: Array<{ binding: string; className: string }>; namespaces: Array<{ binding: string; className: string; namespaceId: string }>
  secretNames: string[]; surface: AuthoritySurface; schedules: string[]
  admission: Generated | null; fence: Generated
}
export interface Step { index: number; phase: Phase; action: Action; worker: string }
export interface InstallPlan extends FenceExpected {
  schema: "smithers-cloudflare-install-plan/v1"; createdAt: string
  /** production = the 14 authorities; rehearsal = one isolated scratch Worker, never a product authority. */
  scope: "production" | "rehearsal"
  credential: { expiresAt: string; recipientSHA256: string }
  workers: WorkerPlan[]; sequence: Step[]
}
export interface JournalEntry {
  seq: number; prev: string; at: string; planSHA256: string; step: number | null; worker: string; action: Action | "restore" | "restore-previews"
  event: "authorized" | "intent" | "uploaded" | "adopted" | "verified" | "failed" | "restored" | "refused"
  version?: string; code?: string; authorizationSHA256?: string; lockTag?: string
}
const hash = (v: string | Uint8Array) => createHash("sha256").update(v).digest("hex")
const fail = (code: string): never => { throw new Error(code) }
const isCode = (e: unknown) => e instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(e.message)
const privateRoot = (directory: string) => {
  const root = resolve(directory), st = lstatSync(root)
  if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) fail("CF_INSTALL_DIRECTORY_NOT_PRIVATE")
  return root
}
const write = (root: string, file: string, bytes: string | Uint8Array): ArtifactReference => {
  writeFileSync(resolve(root, file), bytes, { mode: 0o600, flag: "wx" })
  return { path: file, sha256: hash(bytes) }
}
const readJSON = <T>(root: string, file: string): T => {
  const path = resolve(root, file), st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) fail("CF_INSTALL_INPUT_INVALID")
  return JSON.parse(readFileSync(path, "utf8")) as T
}
/** The export recipient is public; only its private half and the token stay in recipient.json. */
export const publicRecipient = (privateJwk: JsonWebKey): JsonWebKey => ({ kty: "RSA", n: privateJwk.n, e: privateJwk.e, alg: "RSA-OAEP-256", ext: true })
const message = (executionID: string, action: string) => `smithers-cutover ${executionID} ${action}`
const sortBindings = (bindings: Binding[]) => [...bindings].sort((a, b) => a.name.localeCompare(b.name))
const nonSecret = (settings: Settings) => sortBindings(settings.bindings.filter(b => b.type !== "secret_text"))
const secretNames = (settings: Settings) => settings.bindings.filter(b => b.type === "secret_text").map(b => b.name).sort()
const namespacesOf = (settings: Settings) => settings.bindings.filter(b => b.type === "durable_object_namespace")
  .map(b => ({ binding: b.name, className: b.class_name ?? "", namespaceId: b.namespace_id ?? "" })).sort((a, b) => a.binding.localeCompare(b.binding))

interface Deployment { id: string; versions: Array<{ version_id: string; percentage: number }> }
const liveVersion = async (worker: string): Promise<{ deployment: string; version: string }> => {
  const d = (await api<{ deployments: Deployment[] }>(`/workers/scripts/${worker}/deployments`)).result.deployments[0]
  if (!d || d.versions.length !== 1 || d.versions[0]!.percentage !== 100) fail("CF_INSTALL_SPLIT_DEPLOYMENT")
  return { deployment: d!.id, version: d!.versions[0]!.version_id }
}
// Live shape (observed 2026-09-24): script-level /settings and /content/v2 describe the NEWEST UPLOAD,
// not the deployed version (`?version=` is ignored). After a rollback they still show the fence.
// Read them only while the newest upload is the deployed version; judge any other version by /versions/{id}.
const liveSettings = async (worker: string) => (await api<Settings>(`/workers/scripts/${worker}/settings`)).result
interface VersionDetail { id: string; resources: { script: { etag: string }; script_runtime: { compatibility_date?: string; compatibility_flags?: string[]; usage_model?: string }; bindings: Binding[] } }
const versionDetail = async (worker: string, version: string) => (await api<VersionDetail>(`/workers/scripts/${worker}/versions/${version}`)).result
const newestUpload = async (worker: string) => (await api<{ items: Array<{ id: string; number: number }> }>(`/workers/scripts/${worker}/versions?per_page=1`)).result.items[0]?.id ?? fail("CF_INSTALL_VERSIONS_UNREADABLE")
const liveModules = async (worker: string) => {
  const response = await fetch(`${accountURL}/workers/scripts/${worker}/content/v2`, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })
  if (!response.ok) fail("CF_INSTALL_CONTENT_UNREADABLE")
  const entry = response.headers.get("cf-entrypoint") ?? fail("CF_INSTALL_CONTENT_UNREADABLE")
  const modules: Array<{ name: string; type: string; bytes: Uint8Array }> = []
  for (const [name, part] of await response.formData()) {
    if (typeof part === "string" || !/^[A-Za-z0-9_.-]+$/.test(name)) fail("CF_INSTALL_MODULE_SHAPE")
    modules.push({ name, type: (part as File).type, bytes: new Uint8Array(await (part as File).arrayBuffer()) })
  }
  return { entry: entry as string, modules }
}
const moduleSet = (modules: Array<{ name: string; sha256: string }>) => stable([...modules].map(m => ({ name: m.name, sha256: m.sha256 })).sort((a, b) => a.name.localeCompare(b.name)))

const bundleHelper = async (source: string) => {
  const built = await Bun.build({ entrypoints: [resolve(import.meta.dir, "../../src", source)], target: "browser", format: "esm", minify: true })
  if (!built.success || built.outputs.length !== 1) fail("CF_INSTALL_HELPER_BUILD_FAILED")
  return built.outputs[0]!.text()
}
/** Non-secret upload metadata. Secret additions are injected only in memory at apply time. */
const uploadMetadata = (settings: Settings, main: string, annotation: string) => ({
  ...Object.fromEntries(Object.entries(settings).filter(([k]) => ["placement", "compatibility_date", "compatibility_flags", "usage_model", "tags", "tail_consumers", "logpush", "observability"].includes(k))),
  main_module: main, keep_bindings: ["secret_text"], bindings: nonSecret(settings), annotations: { "workers/message": annotation },
  ...settings.bindings.some(b => b.type === "assets") ? { keep_assets: true } : {}
})

/** GET-only. Writes install-plan.json plus owner-only artifacts; prints the plan digest. */
/** Scratch Workers the isolated binding round-trip rehearsal may touch. Nothing else. */
export const REHEARSAL_WORKER = /^smithers-cutover-rehearsal-[a-z0-9]{1,24}$/
export const prepareInstall = async (directory: string, options: { rehearsalWorker?: string } = {}): Promise<{ planSHA256: string; plan: InstallPlan }> => {
  const rehearsal = options.rehearsalWorker
  if (rehearsal !== undefined && (!REHEARSAL_WORKER.test(rehearsal) || (CLOUDFLARE_PRODUCERS as readonly string[]).includes(rehearsal))) fail("CF_INSTALL_REHEARSAL_TARGET_INVALID")
  const targets: readonly string[] = rehearsal ? [rehearsal] : CLOUDFLARE_PRODUCERS
  const admitted: readonly string[] = rehearsal ? [rehearsal] : ADMISSION_WORKERS
  const root = privateRoot(directory)
  const expected = readJSON<FenceExpected>(root, "expected.json")
  if (!/^[a-f0-9-]{36}$/.test(expected.executionID) || !/^[a-f0-9]{40}$/.test(expected.smithersRevision) || !/^[a-f0-9]{40}$/.test(expected.plueRevision) || expected.endpoint !== "https://api.jjhub.tech") fail("CF_INSTALL_IDENTITY_INVALID")
  const recipient = readRecipient(root, expected.executionID)
  const remaining = Date.parse(recipient.expiresAt) - Date.now()
  // MaintenanceExport honours at most a 24 h window; the drain needs time after the fence.
  if (!(remaining > 2 * MIN_CREDENTIAL_MS && remaining <= 86_400_000)) fail("CF_INSTALL_CREDENTIAL_WINDOW_INVALID")
  const dir = rehearsal ? `rehearsal-${rehearsal}-${expected.executionID}` : `install-${expected.executionID}`
  // One immutable plan per execution and scope; preparing twice is refused, never overwritten.
  if (existsSync(resolve(root, dir))) fail("CF_INSTALL_PLAN_EXISTS")
  mkdirSync(resolve(root, dir), { mode: 0o700 })
  const helpers = { admission: await bundleHelper("MaintenanceAdmission.ts"), fence: await bundleHelper("MaintenanceFence.ts") }
  const allNamespaces: Array<{ id: string; script: string; class: string; use_sqlite?: boolean }> = []
  for (let page = 1; ; page++) {
    const rows = (await api<Array<{ id: string; script: string; class: string; use_sqlite?: boolean }>>(`/workers/durable_objects/namespaces?per_page=1000&page=${page}`)).result
    allNamespaces.push(...rows)
    if (rows.length < 1000) break
  }
  const workers: WorkerPlan[] = []
  for (const worker of targets) {
    const folder = `${dir}/${worker}`
    mkdirSync(resolve(root, folder), { mode: 0o700 })
    const before = await liveVersion(worker)
    // Settings and module bytes below come from the newest upload; it must be the deployed original.
    if (await newestUpload(worker) !== before.version) fail("CF_INSTALL_LATEST_NOT_DEPLOYED")
    const settings = await liveSettings(worker)
    if (settings.bindings.some(b => (MAINTENANCE_SECRETS as readonly string[]).includes(b.name))) fail("CF_INSTALL_MAINTENANCE_ALREADY_PRESENT")
    const namespaces = namespacesOf(settings)
    if (namespaces.some(n => !(EXPORT_BINDINGS as readonly string[]).includes(n.binding) || !/^[a-f0-9]{32}$/.test(n.namespaceId) || !/^[A-Za-z][A-Za-z0-9_]*$/.test(n.className)) ||
      settings.bindings.some(b => b.type === "durable_object_namespace" && b.script_name && b.script_name !== worker)) fail("CF_INSTALL_UNKNOWN_DURABLE_BINDING")
    // A namespace owned by this script but unbound would keep an unfenced class identity.
    if (allNamespaces.some(n => n.script === worker && !namespaces.some(b => b.namespaceId === n.id))) fail("CF_INSTALL_UNBOUND_NAMESPACE")
    // The interrupted-alarm marker lives in a reserved SQLite table; a KV-backed object could not keep it.
    if (namespaces.some(b => allNamespaces.find(n => n.id === b.namespaceId)?.use_sqlite !== true)) fail("CF_INSTALL_KV_BACKED_OBJECT")
    const content = await liveModules(worker)
    if (!content.modules.some(m => m.name === content.entry) || content.modules.some(m => m.name.startsWith("cutover-"))) fail("CF_INSTALL_MODULE_SHAPE")
    const originalModules: ModuleRef[] = content.modules.map((m, i) => ({ name: m.name, type: m.name.endsWith(".map") ? "application/source-map" : uploadModuleType(m.name, m.type, content.entry), ...write(root, `${folder}/original-${i}.bin`, m.bytes) }))
    const sourceArtifactSHA256 = hash(stable({ entry: content.entry, modules: originalModules.map(m => ({ name: m.name, sha256: m.sha256 })).sort((a, b) => a.name.localeCompare(b.name)) }))
    const surface = await authoritySurface(worker)
    let schedules: string[] = []
    try { schedules = (await api<{ schedules: Array<{ cron: string }> }>(`/workers/scripts/${worker}/schedules`)).result.schedules.map(s => s.cron).sort() } catch { fail("CF_INSTALL_SCHEDULES_UNREADABLE") }
    const originalEtag = (await versionDetail(worker, before.version)).resources.script.etag
    const after = await liveVersion(worker)
    if (after.version !== before.version || await newestUpload(worker) !== before.version || hash(stable(await liveSettings(worker))) !== hash(stable(settings))) fail("CF_INSTALL_ORIGINAL_CHANGED_DURING_PREPARE")
    const objects = namespaces.map(n => ({ binding: n.binding, className: n.className }))
    const identity: FenceIdentity = { ...expected, worker, sourceVersion: before.version, sourceArtifactSHA256 }
    const generate = (kind: "admission" | "fence"): Generated => {
      const entryName = `cutover-${kind}-entry.js`, helperName = `cutover-${kind}-helper.js`
      const source = kind === "fence" ? fenceModule(identity, objects) : admissionModule(identity, content.entry, objects)
      return { entry: { name: entryName, type: "application/javascript+module", ...write(root, `${folder}/${entryName}`, source) },
        helper: { name: helperName, type: "application/javascript+module", ...write(root, `${folder}/${helperName}`, helpers[kind]) },
        metadata: write(root, `${folder}/${kind}-metadata.json`, JSON.stringify(uploadMetadata(settings, entryName, message(expected.executionID, kind)))) }
    }
    workers.push({ worker, originalVersion: before.version, originalDeployment: before.deployment, settingsSHA256: hash(stable(settings)),
      originalSettings: write(root, `${folder}/original-settings.json`, JSON.stringify(settings)), entry: content.entry, originalModules, sourceArtifactSHA256, originalEtag,
      objects, namespaces, secretNames: secretNames(settings), surface, schedules,
      admission: admitted.includes(worker) ? generate("admission") : null, fence: generate("fence") })
  }
  const sequence: Step[] = []
  const push = (phase: Phase, action: Action, worker: string) => sequence.push({ index: sequence.length, phase, action, worker })
  // Preview URLs keep every old version reachable with its full writer bindings.
  for (const w of workers) if (w.surface.previews) push("admission", "previews-off", w.worker)
  for (const worker of admitted) push("admission", "admission", worker)
  for (const worker of rehearsal ? targets : FENCE_ORDER) push("fence", "fence", worker)
  const plan: InstallPlan = { schema: "smithers-cloudflare-install-plan/v1", ...expected, createdAt: new Date().toISOString(), scope: rehearsal ? "rehearsal" : "production",
    credential: { expiresAt: recipient.expiresAt, recipientSHA256: hash(stable(publicRecipient(recipient.privateJwk))) }, workers, sequence }
  const bytes = JSON.stringify(plan)
  write(root, `install-plan-${hash(bytes)}.json`, bytes)
  return { planSHA256: hash(bytes), plan }
}

export const loadPlan = (root: string, planSHA256: string): InstallPlan => {
  if (!/^[a-f0-9]{64}$/.test(planSHA256)) fail("CF_INSTALL_PLAN_DIGEST_INVALID")
  const plan = JSON.parse(privateArtifact(root, { path: `install-plan-${planSHA256}.json`, sha256: planSHA256 }).toString()) as InstallPlan
  if (plan.schema !== "smithers-cloudflare-install-plan/v1" || !(plan.scope === "production"
    ? plan.workers.length === CLOUDFLARE_PRODUCERS.length && CLOUDFLARE_PRODUCERS.every(w => plan.workers.filter(p => p.worker === w).length === 1)
    : plan.scope === "rehearsal" && plan.workers.length === 1 && REHEARSAL_WORKER.test(plan.workers[0]!.worker) && !(CLOUDFLARE_PRODUCERS as readonly string[]).includes(plan.workers[0]!.worker))) fail("CF_INSTALL_PLAN_INVALID")
  // Every artifact the plan names must still be the exact reviewed bytes.
  for (const w of plan.workers) for (const ref of [w.originalSettings, ...w.originalModules, ...[w.admission, w.fence].flatMap(g => g ? [g.entry, g.helper, g.metadata] : [])]) privateArtifact(root, ref)
  return plan
}

// ---- Journal: append-only, fsynced, hash-chained, written BEFORE each mutation. ----
const JOURNAL = "install-journal.jsonl"
export const readJournal = (root: string, planSHA256: string): JournalEntry[] => {
  const path = resolve(root, JOURNAL)
  if (!existsSync(path)) return []
  const st = lstatSync(path)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o077) !== 0) fail("CF_INSTALL_JOURNAL_INVALID")
  let prev = "0".repeat(64)
  return readFileSync(path, "utf8").split("\n").filter(Boolean).map((line, i) => {
    const entry = JSON.parse(line) as JournalEntry
    if (entry.seq !== i || entry.prev !== prev || entry.planSHA256 !== planSHA256) fail("CF_INSTALL_JOURNAL_INVALID")
    prev = hash(line)
    return entry
  })
}
const appendJournal = (root: string, planSHA256: string, entry: Omit<JournalEntry, "seq" | "prev" | "at" | "planSHA256">) => {
  const existing = readJournal(root, planSHA256), path = resolve(root, JOURNAL)
  const prev = existing.length ? hash(readFileSync(path, "utf8").split("\n").filter(Boolean).at(-1)!) : "0".repeat(64)
  const line = JSON.stringify({ seq: existing.length, prev, at: new Date().toISOString(), planSHA256, ...entry })
  const fd = openSync(path, "a", 0o600)
  try { writeSync(fd, line + "\n"); fsyncSync(fd) } finally { closeSync(fd) }
}
// ---- Lock: one installer process per private directory; a provably dead owner's lock is recovered. ----
interface LockOwner { pid: number; executionID: string; startedAt: string; host: string; processStart: string | null; nonce: string }
const LOCK = "install.lock"
/** The OS start time of `pid`, which a reused PID cannot share; null when it cannot be read. */
const processStart = (pid: number): string | null => {
  const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } })
  const start = run.status === 0 && typeof run.stdout === "string" ? run.stdout.trim() : ""
  return start === "" ? null : start
}
const pidExists = (pid: number) => {
  try { process.kill(pid, 0); return true } catch (e) { return (e as { code?: string }).code !== "ESRCH" }
}
/**
 * dead only when the recorded owner provably no longer runs: same host and
 * execution, and its PID is gone or now names a process with another start
 * time. Anything unreadable or unrecorded is unknown and keeps the lock.
 */
export const lockOwnerState = (owner: unknown, executionID: string): "live" | "dead" | "unknown" => {
  const o = owner as Partial<LockOwner> | null
  if (!o || typeof o !== "object" || !Number.isSafeInteger(o.pid) || o.pid! <= 0 || o.executionID !== executionID || o.host !== hostname() ||
    typeof o.processStart !== "string" || !o.processStart || typeof o.nonce !== "string" || !o.nonce) return "unknown"
  if (!pidExists(o.pid!)) return "dead"
  const start = processStart(o.pid!)
  return start === null ? "unknown" : start === o.processStart ? "live" : "dead"
}
const acquireLock = (root: string, executionID: string): LockOwner => {
  const path = resolve(root, LOCK)
  const owner: LockOwner = { pid: process.pid, executionID, startedAt: new Date().toISOString(), host: hostname(), processStart: processStart(process.pid), nonce: randomUUID() }
  for (let attempt = 0; attempt < 3; attempt++) {
    try { writeFileSync(path, JSON.stringify(owner), { mode: 0o600, flag: "wx" }); return owner } catch (e) { if ((e as { code?: string }).code !== "EEXIST") throw e }
    let held: string
    try { held = readFileSync(path, "utf8") } catch (e) { if ((e as { code?: string }).code === "ENOENT") continue; throw e }
    let parsed: unknown = null
    try { parsed = JSON.parse(held) } catch { /* unreadable owner: unknown */ }
    if (lockOwnerState(parsed, executionID) !== "dead") fail("CF_INSTALL_LOCKED")
    // Move the dead owner's lock aside atomically, then prove it was that exact lock before taking over.
    const tomb = resolve(root, `${LOCK}.dead-${(parsed as LockOwner).pid}-${randomUUID()}`)
    try { renameSync(path, tomb) } catch (e) { if ((e as { code?: string }).code === "ENOENT") continue; throw e }
    if (readFileSync(tomb, "utf8") !== held) {
      // A newer owner took the lock in between: put it back untouched and refuse.
      try { linkSync(tomb, path); rmSync(tomb) } catch { fail("CF_INSTALL_LOCK_CONTENDED") }
      fail("CF_INSTALL_LOCKED")
    }
    // The tomb stays beside the journal as the receipt of this recovery.
  }
  return fail("CF_INSTALL_LOCKED")
}
const withLock = async <T>(root: string, executionID: string, body: () => Promise<T>): Promise<T> => {
  const owner = acquireLock(root, executionID), path = resolve(root, LOCK)
  try { return await body() } finally {
    // Release only this process's own lock, never one another operator holds.
    try { if ((JSON.parse(readFileSync(path, "utf8")) as Partial<LockOwner>).nonce === owner.nonce) rmSync(path) } catch { /* already gone */ }
  }
}

// ---- Gate authorization hook: a fresh, exact, per-step decision; never a standing yes. ----
export interface PhaseRequest extends FenceExpected { schema: "smithers-cutover-phase-request/v1"; planSHA256: string; phase: Phase | "restore"; step: number | null; worker: string; action: string }
export const authorizeStep = (request: PhaseRequest): { authorizationSHA256: string; lockTag: string } => {
  const hook = process.env.SMITHERS_CUTOVER_AUTHORIZE
  if (!hook || !isAbsolute(hook)) fail("CF_INSTALL_PHASE_UNAUTHORIZED")
  const st = lstatSync(hook!)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o022) !== 0 || (st.mode & 0o100) === 0) fail("CF_INSTALL_AUTHORIZER_UNSAFE")
  const run = spawnSync(hook!, ["authorize"], { input: JSON.stringify(request), timeout: 60_000, encoding: "utf8", maxBuffer: 65_536 })
  if (run.status !== 0 || typeof run.stdout !== "string") fail("CF_INSTALL_PHASE_UNAUTHORIZED")
  let answer: Record<string, unknown>
  try { answer = JSON.parse(run.stdout.trim()) } catch { return fail("CF_INSTALL_PHASE_UNAUTHORIZED") }
  const issued = Date.parse(String(answer.issuedAt)), lock = answer.deploymentLock as { tag?: unknown; token?: unknown } | undefined
  if (answer.schema !== "smithers-cutover-phase-authorization/v1" || answer.decision !== "authorized" ||
    (["executionID", "smithersRevision", "plueRevision", "endpoint", "planSHA256", "phase", "step", "worker", "action"] as const).some(k => answer[k] !== request[k]) ||
    !Number.isFinite(issued) || issued < Date.now() - 60_000 || issued > Date.now() + 5_000 ||
    typeof lock?.tag !== "string" || !lock.tag || typeof lock.token !== "string" || !lock.token) fail("CF_INSTALL_PHASE_UNAUTHORIZED")
  return { authorizationSHA256: hash(run.stdout), lockTag: lock!.tag as string }
}

// ---- Mutations ----
const additions = (plan: InstallPlan, w: WorkerPlan, root: string) => {
  const recipient = readRecipient(root, plan.executionID)
  if (recipient.expiresAt !== plan.credential.expiresAt || hash(stable(publicRecipient(recipient.privateJwk))) !== plan.credential.recipientSHA256) fail("CF_INSTALL_CREDENTIAL_EPOCH_MISMATCH")
  if (Date.parse(recipient.expiresAt) - Date.now() < MIN_CREDENTIAL_MS) fail("CF_INSTALL_CREDENTIAL_EXPIRING")
  const values: Record<(typeof MAINTENANCE_SECRETS)[number], string> = { SMITHERS_EXPORT_TOKEN: recipient.token, SMITHERS_EXPORT_RECIPIENT: JSON.stringify(publicRecipient(recipient.privateJwk)),
    SMITHERS_EXPORT_EXPIRES_AT: recipient.expiresAt, SMITHERS_EXPORT_SOURCE_REVISION: `sha256:${w.sourceArtifactSHA256}`, SMITHERS_EXPORT_SOURCE_VERSION: w.originalVersion }
  return MAINTENANCE_SECRETS.map(name => ({ name, type: "secret_text", text: values[name] }))
}
const upload = async (root: string, plan: InstallPlan, w: WorkerPlan, generated: Generated): Promise<string> => {
  const metadata = JSON.parse(privateArtifact(root, generated.metadata).toString()) as { bindings: unknown[] }
  metadata.bindings = [...metadata.bindings, ...additions(plan, w, root)]
  const form = new FormData()
  form.set("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }))
  for (const m of [...w.originalModules, generated.entry, generated.helper]) form.set(m.name, new Blob([new Uint8Array(privateArtifact(root, m))], { type: m.type }), m.name)
  return uploadedVersion((await api<{ deployment_id?: string }>(`/workers/scripts/${w.worker}?excludeScript=true&bindings_inherit=strict`, { method: "PUT", body: form })).result)
}
/** Proves the installed version: exact modules, original non-secret bindings, secret names and object identities. */
const verifyInstalled = async (root: string, w: WorkerPlan, generated: Generated, version: string) => {
  if ((await liveVersion(w.worker)).version !== version) fail("CF_INSTALL_VERSION_NOT_LIVE")
  const content = await liveModules(w.worker)
  if (content.entry !== generated.entry.name || moduleSet(content.modules.map(m => ({ name: m.name, sha256: hash(m.bytes) }))) !== moduleSet([...w.originalModules, generated.entry, generated.helper])) fail("CF_INSTALL_MODULES_DIFFER")
  const original = JSON.parse(privateArtifact(root, w.originalSettings).toString()) as Settings, observed = await liveSettings(w.worker)
  if (stable(nonSecret(observed)) !== stable(nonSecret(original))) fail("CF_INSTALL_BINDINGS_DIFFER")
  if (stable(secretNames(observed)) !== stable([...w.secretNames, ...MAINTENANCE_SECRETS].sort())) fail("CF_INSTALL_SECRET_BINDINGS_DIFFER")
  if (stable(namespacesOf(observed)) !== stable(w.namespaces)) fail("CF_INSTALL_DURABLE_IDENTITY_CHANGED")
  if ((await liveVersion(w.worker)).version !== version) fail("CF_INSTALL_VERSION_NOT_LIVE")
  return observed
}
const setPreviews = async (worker: string, surface: AuthoritySurface, previews: boolean) => {
  await api(`/workers/scripts/${worker}/subdomain`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ enabled: surface.workersDev, previews_enabled: previews }) })
  const now = (await api<{ enabled: boolean; previews_enabled: boolean }>(`/workers/scripts/${worker}/subdomain`)).result
  if (now.enabled !== surface.workersDev || now.previews_enabled !== previews) fail("CF_INSTALL_PREVIEWS_NOT_APPLIED")
}
/** Live shape (observed 2026-09-24): version annotations are top-level `result.annotations`, not under `metadata`. */
const versionMessage = async (worker: string, version: string) =>
  (await api<{ annotations?: Record<string, string> }>(`/workers/scripts/${worker}/versions/${version}`)).result.annotations?.["workers/message"] ?? null
const verifiedVersion = (journal: JournalEntry[], worker: string, action: Action) =>
  journal.filter(e => e.worker === worker && e.action === action && e.event === "verified").at(-1)?.version ?? null
const ownedVersions = (journal: JournalEntry[], worker: string) =>
  new Set(journal.filter(e => e.worker === worker && ["uploaded", "adopted", "verified"].includes(e.event) && e.version).map(e => e.version!))

/** Applies one phase in plan order. Stops at the first refusal; the journal says exactly how far it got. */
export const applyPhase = async (directory: string, planSHA256: string, phase: Phase): Promise<Array<{ step: number; worker: string; action: Action; version: string | null; skipped: boolean }>> => {
  const root = privateRoot(directory), plan = loadPlan(root, planSHA256)
  return withLock(root, plan.executionID, async () => {
    const journal = () => readJournal(root, planSHA256)
    // Recovery closes this plan, including refused or partial restores; applying needs a fresh plan.
    if (journal().some(e => e.action === "restore" || e.action === "restore-previews")) fail("CF_INSTALL_RECOVERY_STARTED")
    if (phase === "fence") for (const s of plan.sequence.filter(s => s.phase === "admission"))
      if (s.action === "previews-off" ? !journal().some(e => e.step === s.index && e.event === "verified") : !verifiedVersion(journal(), s.worker, s.action)) fail("CF_INSTALL_ADMISSION_NOT_VERIFIED")
    // Whole-phase preflight: any drifted authority refuses the phase before its first mutation.
    for (const step of plan.sequence.filter(s => s.phase === phase && s.action !== "previews-off")) {
      const w = plan.workers.find(p => p.worker === step.worker)!, live = await liveVersion(w.worker)
      const predecessor = step.action === "fence" && w.admission ? verifiedVersion(journal(), w.worker, "admission") : w.originalVersion
      if (live.version === verifiedVersion(journal(), w.worker, step.action)) continue
      if (live.version !== predecessor) fail(predecessor === w.originalVersion ? "CF_INSTALL_ORIGINAL_DRIFT" : "CF_INSTALL_LIVE_DRIFT")
      if (predecessor === w.originalVersion && hash(stable(await liveSettings(w.worker))) !== w.settingsSHA256) fail("CF_INSTALL_ORIGINAL_DRIFT")
    }
    const done = []
    for (const step of plan.sequence.filter(s => s.phase === phase)) {
      const w = plan.workers.find(p => p.worker === step.worker)!
      const record = (entry: Omit<JournalEntry, "seq" | "prev" | "at" | "planSHA256" | "step" | "worker" | "action">) => appendJournal(root, planSHA256, { step: step.index, worker: w.worker, action: step.action, ...entry })
      if (step.action === "previews-off") {
        const current = (await api<{ enabled: boolean; previews_enabled: boolean }>(`/workers/scripts/${w.worker}/subdomain`)).result
        if (!current.previews_enabled && journal().some(e => e.step === step.index && e.event === "verified")) { done.push({ step: step.index, worker: w.worker, action: step.action, version: null, skipped: true }); continue }
        if (current.enabled !== w.surface.workersDev || current.previews_enabled !== true) fail("CF_INSTALL_ORIGINAL_DRIFT")
        const auth = authorizeStep({ schema: "smithers-cutover-phase-request/v1", executionID: plan.executionID, smithersRevision: plan.smithersRevision, plueRevision: plan.plueRevision, endpoint: plan.endpoint, planSHA256, phase, step: step.index, worker: w.worker, action: step.action })
        record({ event: "authorized", ...auth }); record({ event: "intent" })
        try { await setPreviews(w.worker, w.surface, false) } catch (e) { record({ event: "failed", code: isCode(e) ? (e as Error).message : "CF_INSTALL_PREVIEWS_FAILED" }); throw isCode(e) ? e : new Error("CF_INSTALL_PREVIEWS_FAILED") }
        record({ event: "verified" }); done.push({ step: step.index, worker: w.worker, action: step.action, version: null, skipped: false }); continue
      }
      const generated = step.action === "admission" ? w.admission! : w.fence
      const predecessor = step.action === "fence" && w.admission ? verifiedVersion(journal(), w.worker, "admission") : w.originalVersion
      const live = await liveVersion(w.worker)
      const mine = verifiedVersion(journal(), w.worker, step.action)
      if (mine && live.version === mine) { done.push({ step: step.index, worker: w.worker, action: step.action, version: mine, skipped: true }); continue }
      if (live.version !== predecessor) fail(predecessor === w.originalVersion ? "CF_INSTALL_ORIGINAL_DRIFT" : "CF_INSTALL_LIVE_DRIFT")
      const settings = await liveSettings(w.worker)
      if (predecessor === w.originalVersion ? hash(stable(settings)) !== w.settingsSHA256 : stable(nonSecret(settings)) !== stable(nonSecret(JSON.parse(privateArtifact(root, w.originalSettings).toString()) as Settings))) fail(predecessor === w.originalVersion ? "CF_INSTALL_ORIGINAL_DRIFT" : "CF_INSTALL_LIVE_DRIFT")
      if (stable(namespacesOf(settings)) !== stable(w.namespaces)) fail("CF_INSTALL_DURABLE_IDENTITY_CHANGED")
      if ((await api<{ previews_enabled: boolean }>(`/workers/scripts/${w.worker}/subdomain`)).result.previews_enabled) fail("CF_INSTALL_PREVIEWS_ENABLED")
      const auth = authorizeStep({ schema: "smithers-cutover-phase-request/v1", executionID: plan.executionID, smithersRevision: plan.smithersRevision, plueRevision: plan.plueRevision, endpoint: plan.endpoint, planSHA256, phase, step: step.index, worker: w.worker, action: step.action })
      additions(plan, w, root) // Credential epoch and remaining window are checked before the intent.
      record({ event: "authorized", ...auth }); record({ event: "intent" })
      let version: string
      try { version = await upload(root, plan, w, generated); record({ event: "uploaded", version }) } catch (error) {
        // The response may be lost after the provider created the version: adopt only our own annotated version.
        const now = await liveVersion(w.worker).catch(() => null)
        if (now && now.version !== predecessor && await versionMessage(w.worker, now.version).catch(() => null) === message(plan.executionID, step.action)) { version = now.version; record({ event: "adopted", version }) }
        else { record({ event: "failed", code: isCode(error) ? (error as Error).message : "CF_INSTALL_UPLOAD_FAILED" }); throw isCode(error) ? error : new Error("CF_INSTALL_UPLOAD_FAILED") }
      }
      try { await verifyInstalled(root, w, generated, version) } catch (error) { record({ event: "failed", version, code: isCode(error) ? (error as Error).message : "CF_INSTALL_VERIFY_FAILED" }); throw isCode(error) ? error : new Error("CF_INSTALL_VERIFY_FAILED") }
      record({ event: "verified", version }); done.push({ step: step.index, worker: w.worker, action: step.action, version, skipped: false })
    }
    if (phase === "fence" && plan.scope === "production") await writeCollectPlans(root, plan, readJournal(root, planSHA256))
    return done
  })
}

/** Hands the fenced state to cutover-evidence.ts collect in its existing plan format. */
const writeCollectPlans = async (root: string, plan: InstallPlan, journal: JournalEntry[]) => {
  const same = (file: string, value: unknown) => {
    const path = resolve(root, file), bytes = JSON.stringify(value)
    if (existsSync(path)) { if (readFileSync(path, "utf8") !== bytes) fail("CF_INSTALL_COLLECT_PLAN_CONFLICT"); return }
    writeFileSync(path, bytes, { mode: 0o600, flag: "wx" })
  }
  for (const w of plan.workers) {
    const version = verifiedVersion(journal, w.worker, "fence") ?? fail("CF_INSTALL_FENCE_NOT_VERIFIED")
    same(`${w.worker}.plan.json`, { identity: { executionID: plan.executionID, smithersRevision: plan.smithersRevision, plueRevision: plan.plueRevision, endpoint: plan.endpoint, worker: w.worker, sourceVersion: w.originalVersion, sourceArtifactSHA256: w.sourceArtifactSHA256 },
      version, settingsSHA256: hash(stable(await liveSettings(w.worker))), originalEntry: w.entry, originalSettings: w.originalSettings,
      originalModules: w.originalModules.map(m => ({ name: m.name, path: m.path, sha256: m.sha256 })), objects: w.objects, helper: { path: w.fence.helper.path, sha256: w.fence.helper.sha256 }, origins: w.surface.origins })
  }
  same("admission.json", Object.fromEntries(ADMISSION_WORKERS.map(w => [w, verifiedVersion(journal, w, "admission") ?? fail("CF_INSTALL_ADMISSION_NOT_VERIFIED")])))
}

/** Restores only a verified, outstanding preview disable. Booleans cannot prove ownership after an ambiguous write. */
const restorePreviews = async (root: string, planSHA256: string, plan: InstallPlan, w: WorkerPlan): Promise<boolean> => {
  const step = plan.sequence.find(s => s.worker === w.worker && s.action === "previews-off")
  if (!step) return false
  const journal = readJournal(root, planSHA256).filter(e => e.worker === w.worker)
  // Include completed restores from older journals: their preview ownership is already spent.
  const restored = journal.filter(e => (e.action === "restore-previews" || e.action === "restore") && e.event === "restored").at(-1)?.seq ?? -1
  const pending = journal.filter(e => e.seq > restored && e.step === step.index)
  const disable = pending.filter(e => e.action === "previews-off").at(-1)
  if (!disable) return false
  const record = (entry: Omit<JournalEntry, "seq" | "prev" | "at" | "planSHA256" | "step" | "worker" | "action">) =>
    appendJournal(root, planSHA256, { step: step.index, worker: w.worker, action: "restore-previews", ...entry })
  const read = async () => (await api<{ enabled: boolean; previews_enabled: boolean }>(`/workers/scripts/${w.worker}/subdomain`)).result
  const current = await read()
  if (current.previews_enabled) { record({ event: "restored" }); return false }
  if (current.enabled !== w.surface.workersDev) fail("CF_RESTORE_PREVIEWS_DRIFT")
  if (disable.event !== "verified" || !pending.some(e => e.action === "previews-off" && e.event === "intent" && e.seq < disable.seq) ||
    pending.some(e => e.action === "restore-previews" && e.event === "intent" && e.seq > disable.seq)) fail("CF_RESTORE_PREVIEWS_UNCERTAIN")
  const auth = authorizeStep({ schema: "smithers-cutover-phase-request/v1", executionID: plan.executionID, smithersRevision: plan.smithersRevision, plueRevision: plan.plueRevision,
    endpoint: plan.endpoint, planSHA256, phase: "restore", step: step.index, worker: w.worker, action: "restore-previews" })
  record({ event: "authorized", ...auth })
  // The gate may take time. Check again before recording intent and changing either setting.
  const checked = await read()
  if (checked.previews_enabled) { record({ event: "restored" }); return false }
  if (checked.enabled !== w.surface.workersDev) fail("CF_RESTORE_PREVIEWS_DRIFT")
  if ((await liveVersion(w.worker)).version !== w.originalVersion) fail("CF_RESTORE_VERSION_NOT_LIVE")
  record({ event: "intent" })
  await setPreviews(w.worker, w.surface, true)
  record({ event: "restored" })
  return true
}

/** Redeploys each exact original version, newest step first. Never overwrites a version this execution does not own. */
export const restoreAll = async (directory: string, planSHA256: string): Promise<Array<{ worker: string; outcome: "restored" | "already-original" | "refused"; code?: string }>> => {
  const root = privateRoot(directory), plan = loadPlan(root, planSHA256)
  return withLock(root, plan.executionID, async () => {
    const results: Array<{ worker: string; outcome: "restored" | "already-original" | "refused"; code?: string }> = []
    const touched = [...new Set([...plan.sequence].reverse().map(s => s.worker))]
    for (const worker of touched) {
      const w = plan.workers.find(p => p.worker === worker)!
      const record = (entry: Omit<JournalEntry, "seq" | "prev" | "at" | "planSHA256" | "step" | "worker" | "action">) => appendJournal(root, planSHA256, { step: null, worker, action: "restore", ...entry })
      try {
        const journal = readJournal(root, planSHA256), live = await liveVersion(worker)
        let owned = ownedVersions(journal, worker)
        if (live.version !== w.originalVersion && !owned.has(live.version)) {
          // Crash between intent and result: adopt only a version carrying this execution's own annotation.
          const note = await versionMessage(worker, live.version).catch(() => null)
          if (journal.some(e => e.worker === worker && e.event === "intent") && ["admission", "fence"].some(a => note === message(plan.executionID, a))) { record({ event: "adopted", version: live.version }); owned = new Set([...owned, live.version]) }
          else fail("CF_RESTORE_FOREIGN_VERSION")
        }
        if (live.version !== w.originalVersion) {
          const auth = authorizeStep({ schema: "smithers-cutover-phase-request/v1", executionID: plan.executionID, smithersRevision: plan.smithersRevision, plueRevision: plan.plueRevision, endpoint: plan.endpoint, planSHA256, phase: "restore", step: null, worker, action: "restore" })
          record({ event: "authorized", ...auth }); record({ event: "intent", version: w.originalVersion })
          await api(`/workers/scripts/${worker}/deployments`, { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ strategy: "percentage", versions: [{ version_id: w.originalVersion, percentage: 100 }], annotations: { "workers/message": message(plan.executionID, "restore") } }) })
        }
        if ((await liveVersion(worker)).version !== w.originalVersion) fail("CF_RESTORE_VERSION_NOT_LIVE")
        // The deployed version itself, not the newest upload (which is still this execution's fence).
        const original = JSON.parse(privateArtifact(root, w.originalSettings).toString()) as Settings, deployed = await versionDetail(worker, w.originalVersion)
        if (deployed.id !== w.originalVersion || !w.originalEtag || deployed.resources.script.etag !== w.originalEtag) fail("CF_RESTORE_MODULES_DIFFER")
        const runtime = deployed.resources.script_runtime
        if (stable(nonSecret({ bindings: deployed.resources.bindings } as Settings)) !== stable(nonSecret(original)) || stable(secretNames({ bindings: deployed.resources.bindings } as Settings)) !== stable(w.secretNames) ||
          runtime.compatibility_date !== original.compatibility_date || stable(runtime.compatibility_flags ?? []) !== stable(original.compatibility_flags ?? []) || runtime.usage_model !== original.usage_model) fail("CF_RESTORE_SETTINGS_DIFFER")
        const previewsRestored = await restorePreviews(root, planSHA256, plan, w)
        const wasOriginal = live.version === w.originalVersion && !previewsRestored
        record({ event: "restored", version: w.originalVersion })
        results.push({ worker, outcome: wasOriginal ? "already-original" : "restored" })
      } catch (error) {
        const code = isCode(error) ? (error as Error).message : "CF_RESTORE_FAILED"
        record({ event: "refused", code }); results.push({ worker, outcome: "refused", code })
      }
    }
    return results
  })
}

/** Read-only: where every authority stands relative to the plan and journal. */
export const installStatus = async (directory: string, planSHA256: string) => {
  const root = privateRoot(directory), plan = loadPlan(root, planSHA256), journal = readJournal(root, planSHA256)
  const rows = []
  for (const w of plan.workers) {
    const live = await liveVersion(w.worker)
    const state = live.version === w.originalVersion ? "original" : live.version === verifiedVersion(journal, w.worker, "fence") ? "fenced"
      : live.version === verifiedVersion(journal, w.worker, "admission") ? "admission" : ownedVersions(journal, w.worker).has(live.version) ? "owned-unverified" : "foreign"
    rows.push({ worker: w.worker, state, liveVersion: live.version })
  }
  return rows
}

if (import.meta.main) {
  const [mode, directory, digest, phase] = process.argv.slice(2)
  try {
    let out: unknown
    if (mode === "prepare" && directory && (!digest || digest === "--rehearsal" && phase)) { const r = await prepareInstall(directory, digest ? { rehearsalWorker: phase } : {}); out = { planSHA256: r.planSHA256, steps: r.plan.sequence.map(s => `${s.index}:${s.phase}:${s.action}:${s.worker}`) } }
    else if (mode === "apply" && directory && digest && (phase === "admission" || phase === "fence")) out = await applyPhase(directory, digest, phase)
    else if (mode === "restore" && directory && digest && !phase) { const r = await restoreAll(directory, digest); out = r; if (r.some(x => x.outcome === "refused")) { console.log(JSON.stringify({ refused: "CF_RESTORE_INCOMPLETE", results: r })); process.exit(2) } }
    else if (mode === "status" && directory && digest && !phase) out = await installStatus(directory, digest)
    else fail("CF_INSTALL_USAGE")
    console.log(JSON.stringify(out))
  } catch (error) {
    const code = isCode(error) ? (error as Error).message : (error as { code?: string } | null)?.code === "ENOENT" ? "CF_INSTALL_INPUT_MISSING" : "CF_INSTALL_UNCLASSIFIED_FAILURE"
    console.log(JSON.stringify({ refused: code }))
    process.exit(2)
  }
}
