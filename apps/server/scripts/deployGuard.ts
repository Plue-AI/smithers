/**
 * Deploy interlock for `smithers-mvp-web` across the one-time shared-backend cutover.
 *
 * The one deploy path (scripts/deploy.ts, run by CI on every push to main) asks
 * this module first, before it reads the revision, builds, or spawns wrangler.
 * It compares what the checkout would deploy with what is live, both named by
 * facts the provider and the checkout state directly:
 *
 *   local  legacy  wrangler `main` = src/index.ts (bundles to index.js)
 *          edge    wrangler `main` = src/edge.ts  (bundles to edge.js)
 *   live   the entry module of the single 100% version (content/v2 CF-Entrypoint),
 *          cross-checked against that version's own annotations.
 *
 * | local \ live | legacy | edge   | cutover admission / maintenance export | cutover fence |
 * |--------------|--------|--------|----------------------------------------|---------------|
 * | legacy       | normal | refuse | refuse                                 | refuse        |
 * | edge         | refuse | normal | refuse                                 | activation    |
 *
 * Normal CI can therefore never undo a live installer version, never resurrect
 * the legacy writer over migrated state, and never activate the edge early.
 * Activation replaces the final fence only, and only with a fresh authorization
 * from the release gate's hook (SMITHERS_EDGE_ACTIVATION_AUTHORIZE). The hook
 * holds the production lease and names the verified cutover and import receipts.
 * The authorization is bound to this sha, this live fence execution and this
 * exact built artifact. There is no override flag. Anything unrecognized refuses.
 */
import { createHash } from "node:crypto"
import * as Data from "effect/Data"
import { z } from "zod"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { lstatSync } from "node:fs"
import { isAbsolute } from "node:path"
import { spawnSync } from "node:child_process"
import { accountURL, api } from "./cutover/cloudflare"

export type LocalIdentity = "legacy" | "edge"
export type LiveIdentity = "legacy" | "edge" | "cutover-admission" | "cutover-fence" | "maintenance-export"
/** The deploy interlock refused; `code` is the stable DEPLOY_GUARD_* id the operator log prints. */
export class DeployGuardRefusal extends Data.TaggedError("DeployGuardRefusal")<{ readonly code: string; readonly detail: string }> {
  override get message(): string {
    return `${this.code}: ${this.detail}`
  }
}
const refuse = (code: string, detail: string): never => { throw new DeployGuardRefusal({ code, detail }) }

/** The checkout's own claim, which must agree with itself. */
export const classifyLocal = (wranglerMain: string, identityEntry: string): LocalIdentity => {
  if (wranglerMain !== identityEntry) refuse("DEPLOY_GUARD_LOCAL_AMBIGUOUS", `wrangler main ${wranglerMain} differs from WORKER_IDENTITY.entry ${identityEntry}`)
  if (wranglerMain === "src/index.ts") return "legacy"
  if (wranglerMain === "src/edge.ts") return "edge"
  return refuse("DEPLOY_GUARD_LOCAL_UNKNOWN", `entry ${wranglerMain} is neither the legacy Worker nor the shared edge`)
}

export interface LiveFacts {
  readonly versionId: string
  readonly entry: string
  readonly modules: ReadonlyArray<string>
  readonly annotations: Readonly<Record<string, string>>
}
const CUTOVER_MESSAGE = /^smithers-cutover ([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}) (admission|fence)$/
/** The live version's identity. Entry module decides; annotations must not contradict it. */
export const classifyLive = (facts: LiveFacts): { identity: LiveIdentity; executionID: string | null } => {
  const message = facts.annotations["workers/message"] ?? ""
  const cutover = CUTOVER_MESSAGE.exec(message)
  const only = (...names: string[]) => facts.modules.every(m => names.includes(m) || names.some(n => m === `${n}.map`))
  const contradict = () => refuse("DEPLOY_GUARD_LIVE_AMBIGUOUS", `live version ${facts.versionId} entry ${facts.entry} contradicts its annotation`)
  switch (facts.entry) {
    case "cutover-admission-entry.js":
    case "cutover-fence-entry.js": {
      const action = facts.entry === "cutover-fence-entry.js" ? "fence" : "admission"
      if (!cutover || cutover[2] !== action) return contradict()
      return { identity: action === "fence" ? "cutover-fence" : "cutover-admission", executionID: cutover[1]! }
    }
    case "sealed-export-entry.js":
      if (cutover) return contradict()
      return { identity: "maintenance-export", executionID: null }
    case "index.js":
      if (cutover || facts.annotations["workers/tag"] === "sealed-state-inventory" || !only("index.js")) return contradict()
      return { identity: "legacy", executionID: null }
    case "edge.js":
      if (cutover || !only("edge.js")) return contradict()
      return { identity: "edge", executionID: null }
    default:
      return refuse("DEPLOY_GUARD_LIVE_UNKNOWN", `live version ${facts.versionId} runs unrecognized entry ${facts.entry}`)
  }
}

export type GuardDecision =
  | { readonly mode: "normal"; readonly local: LocalIdentity; readonly live: LiveIdentity; readonly liveVersion: string }
  | { readonly mode: "activation"; readonly local: "edge"; readonly live: "cutover-fence"; readonly liveVersion: string; readonly executionID: string }
export const decideDeploy = (local: LocalIdentity, live: LiveFacts): GuardDecision => {
  const { identity, executionID } = classifyLive(live)
  if (local === identity) return { mode: "normal", local, live: identity, liveVersion: live.versionId }
  if (local === "edge" && identity === "cutover-fence") return { mode: "activation", local, live: identity, liveVersion: live.versionId, executionID: executionID! }
  if (identity === "cutover-admission" || identity === "cutover-fence" || identity === "maintenance-export")
    return refuse("DEPLOY_GUARD_LIVE_CUTOVER", `live ${identity} version ${live.versionId} belongs to the cutover installer; only its restore or the authorized edge activation may replace it`)
  if (local === "legacy") return refuse("DEPLOY_GUARD_LEGACY_OVER_EDGE", "the shared edge is live; the legacy writer must never return over migrated state through CI")
  return refuse("DEPLOY_GUARD_EDGE_BEFORE_CUTOVER", "the legacy Worker is live; the edge activates only over the verified cutover fence")
}

/** Evidence comes only from the exclusively owned deployment receipt store. */
const RecoveryReceipt = z.object({
  status: z.enum(["rolled-back", "rollback-failed"]),
  rollback: z.enum(["succeeded", "failed"]),
  previous: z.object({ version: z.string().min(1), revision: z.string().min(1) }),
  reverification: z.array(z.object({ name: z.string(), status: z.enum(["passed", "failed"]) })),
  recovery: z.object({
    accountId: z.string(), worker: z.string(), newestVersion: z.string().min(1),
    target: z.object({
      versionId: z.string().min(1), entry: z.string().min(1), modules: z.array(z.string()).min(1),
      annotations: z.record(z.string(), z.string()), digests: z.record(z.string(), z.string().regex(/^[a-f0-9]{64}$/))
    })
  })
}).refine(r => r.rollback === "succeeded" || r.status === "rollback-failed")
export type RecoveryEvidence = Omit<z.infer<typeof RecoveryReceipt>["recovery"], "target"> & {
  target: LiveFacts & { digests: Record<string, string> }
}

// ---- Live facts: GET-only ----
type Get = <T>(path: string) => Promise<{ result: T }>
type Content = (worker: string) => Promise<{ entry: string; modules: string[]; digests: Record<string, string> }>
export const readLiveFacts = async (worker: string, get: Get, content: Content, rollbackReceipt?: unknown): Promise<LiveFacts & { digests: Record<string, string> }> => {
  const current = async () => {
    const d = (await get<{ deployments: Array<{ versions: Array<{ version_id: string; percentage: number }> }> }>(`/workers/scripts/${worker}/deployments`)).result.deployments[0]
    if (!d || d.versions.length !== 1 || d.versions[0]!.percentage !== 100) return refuse("DEPLOY_GUARD_LIVE_SPLIT", "the live deployment is not one version at 100%")
    return d.versions[0]!.version_id
  }
  const versionId = await current()
  // Live shape (observed 2026-09-24): content/v2 serves the NEWEST UPLOAD, not the deployed version.
  // An upload-only edge build over a live legacy writer would otherwise read as "edge is live".
  const newest = (await get<{ items: Array<{ id: string }> }>(`/workers/scripts/${worker}/versions?per_page=1`)).result.items[0]?.id
  let saved: LiveFacts & { digests: Record<string, string> } | undefined
  if (newest !== versionId) {
    const parsed = RecoveryReceipt.safeParse(rollbackReceipt)
    if (!parsed.success) return refuse("DEPLOY_GUARD_LIVE_NOT_NEWEST", "no verified rollback receipt for the older live version")
    const r = parsed.data
    const target = r.recovery.target
    if (r.recovery.worker !== worker || r.recovery.accountId !== (process.env.CLOUDFLARE_ACCOUNT_ID || WORKER_IDENTITY.accountId) ||
      r.previous.version !== versionId || target.versionId !== versionId || r.recovery.newestVersion !== newest ||
      !r.reverification.some(c => c.name === "CN-24" && c.status === "passed") ||
      !target.modules.includes(target.entry) || target.modules.length !== Object.keys(target.digests).length ||
      target.modules.some(name => !target.digests[name]))
      return refuse("DEPLOY_GUARD_LIVE_NOT_NEWEST", "rollback receipt does not verify this live version")
    saved = target
  }
  // Live shape: version annotations are top-level `result.annotations`.
  const annotations = (await get<{ annotations?: Record<string, string> }>(`/workers/scripts/${worker}/versions/${versionId}`)).result.annotations ?? {}
  if (saved && JSON.stringify(Object.entries(annotations).sort()) !== JSON.stringify(Object.entries(saved.annotations).sort()))
    return refuse("DEPLOY_GUARD_LIVE_NOT_NEWEST", "rollback target annotations differ from the receipt")
  const body = saved ?? await content(worker)
  if (await current() !== versionId || (await get<{ items: Array<{ id: string }> }>(`/workers/scripts/${worker}/versions?per_page=1`)).result.items[0]?.id !== newest) refuse("DEPLOY_GUARD_LIVE_CHANGED", "the live version changed while it was being read")
  return { versionId, entry: body.entry, modules: body.modules, annotations, digests: body.digests }
}
export const sha256 = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex")
/** Digest of a module set: the exact built artifact the gate rehearsed. */
export const artifactDigest = (modules: Record<string, string>): string =>
  sha256(JSON.stringify(Object.keys(modules).sort().map(name => [name, modules[name]])))

// ---- Activation: a fresh, exact, delegated decision from the release gate ----
export interface ActivationRequest {
  readonly schema: "smithers-edge-activation-request/v1"
  readonly worker: string
  readonly smithersRevision: string
  readonly artifactSHA256: string
  readonly liveVersion: string
  readonly cutoverExecutionID: string
}
export interface ActivationAuthorization { readonly authorizationSHA256: string; readonly lockTag: string; readonly cutoverReceiptSHA256: string; readonly importReceiptSHA256: string }
export const authorizeActivation = (request: ActivationRequest, hook = process.env.SMITHERS_EDGE_ACTIVATION_AUTHORIZE, now = Date.now()): ActivationAuthorization => {
  if (!hook || !isAbsolute(hook)) return refuse("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED", "no release-gate activation authorizer is configured")
  const st = lstatSync(hook)
  if (!st.isFile() || st.isSymbolicLink() || (st.mode & 0o022) !== 0 || (st.mode & 0o100) === 0) refuse("DEPLOY_GUARD_AUTHORIZER_UNSAFE", "the activation authorizer is not an owner-controlled executable")
  const run = spawnSync(hook, ["authorize-edge"], { input: JSON.stringify(request), timeout: 120_000, encoding: "utf8", maxBuffer: 65_536 })
  let answer: Record<string, unknown> = {}
  try { answer = run.status === 0 ? JSON.parse(String(run.stdout).trim()) : {} } catch { answer = {} }
  const issued = Date.parse(String(answer.issuedAt)), lock = answer.deploymentLock as { tag?: unknown; token?: unknown } | undefined
  const hex = (v: unknown) => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)
  if (run.status !== 0 || answer.schema !== "smithers-edge-activation-authorization/v1" || answer.decision !== "authorized" ||
    (Object.keys(request) as Array<keyof ActivationRequest>).some(k => k !== "schema" && answer[k] !== request[k]) ||
    !Number.isFinite(issued) || issued < now - 60_000 || issued > now + 5_000 ||
    typeof lock?.tag !== "string" || !lock.tag || typeof lock.token !== "string" || !lock.token ||
    !hex(answer.cutoverReceiptSHA256) || !hex(answer.importReceiptSHA256)) refuse("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED", "the release gate did not authorize this exact activation")
  return { authorizationSHA256: sha256(String(run.stdout)), lockTag: lock!.tag as string, cutoverReceiptSHA256: answer.cutoverReceiptSHA256 as string, importReceiptSHA256: answer.importReceiptSHA256 as string }
}
/** After an activation, the live version must serve exactly the authorized modules. */
export const verifyActivated = (live: LiveFacts & { digests: Record<string, string> }, authorizedArtifact: string): void => {
  if (classifyLive(live).identity !== "edge" || artifactDigest(codeModules(live.digests)) !== authorizedArtifact) refuse("DEPLOY_GUARD_ARTIFACT_DRIFT", "the live edge is not the authorized artifact; restore through the release gate")
}

// ---- Wiring used by scripts/deploy.ts ----
/** Entry name and per-module digests of the live script (content/v2), GET-only. */
export const cloudflareContent: Content = async worker => {
  const response = await fetch(`${accountURL}/workers/scripts/${worker}/content/v2`, { redirect: "error", signal: AbortSignal.timeout(60_000), headers: { authorization: `Bearer ${process.env.CLOUDFLARE_API_TOKEN}` } })
  const entry = response.headers.get("cf-entrypoint")
  if (!response.ok || !entry) return refuse("DEPLOY_GUARD_LIVE_UNREADABLE", `live content unreadable (${response.status})`)
  const digests: Record<string, string> = {}
  for (const [name, part] of await response.formData()) {
    if (typeof part === "string") return refuse("DEPLOY_GUARD_LIVE_UNREADABLE", "live module shape unrecognized")
    digests[name] = sha256(new Uint8Array(await (part as Blob).arrayBuffer()))
  }
  return { entry, modules: Object.keys(digests).sort(), digests }
}
export const liveFactsFromCloudflare = (worker: string, rollbackReceipt?: unknown) => readLiveFacts(worker, api, cloudflareContent, rollbackReceipt)
/** First step of every real deploy: nothing is read, built or spawned before this answers. */
export const preflightDeploy = async (worker: string, wranglerMain: string, identityEntry: string, read = liveFactsFromCloudflare): Promise<GuardDecision> => {
  const local = classifyLocal(wranglerMain, identityEntry)
  let live: LiveFacts
  try { live = await read(worker) } catch (error) {
    if (error instanceof DeployGuardRefusal) throw error
    return refuse("DEPLOY_GUARD_LIVE_UNREADABLE", "the live version could not be read; a guard that cannot see refuses")
  }
  return decideDeploy(local, live)
}
/** Only JavaScript modules name the artifact; source maps and wrangler's README are not uploaded code. */
export const codeModules = (digests: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(digests).filter(([name]) => name.endsWith(".js")))
