/**
 * Deploy interlock for `smithers-mvp-web`: the checkout deploys the shared edge
 * (wrangler `main` = src/edge.ts, bundling to edge.js), never anything else.
 *
 * The one deploy path (scripts/deploy.ts, run on every push to main) asks
 * this module first, before it reads the revision, builds, or spawns wrangler.
 * It compares what the checkout would deploy with what is live, named by
 * facts the provider and the checkout state directly: the entry module of
 * the single 100% version (content/v2 CF-Entrypoint), cross-checked against
 * that version's own annotations.
 *
 * | live   | legacy     | edge   | maintenance export |
 * |--------|------------|--------|--------------------|
 * | answer | activation | normal | refuse             |
 *
 * Normal CI can therefore never undo a live sealed-inventory export version.
 * A live legacy version (the pre-edge Worker, or a `wrangler rollback` to
 * one) is replaced only as the direct switch the committed owner record
 * (cutover/activation.json, ACTIVATION_RECORD_PATH) admits: the owner's
 * decision, the no-user import disposition with the legacy Durable Object
 * state retained unmigrated under unchanged identities, and the retroactive
 * record of the backend bootstrap. The record is data in the deployed
 * commit, not an input: there is no override flag or environment switch.
 * Anything unrecognized refuses.
 */
import { createHash } from "node:crypto"
import * as Data from "effect/Data"
import { z } from "zod"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { accountURL, api } from "./cutover/cloudflare"

export type LiveIdentity = "legacy" | "edge" | "maintenance-export"
/** The deploy interlock refused; `code` is the stable DEPLOY_GUARD_* id the operator log prints. */
export class DeployGuardRefusal extends Data.TaggedError("DeployGuardRefusal")<{ readonly code: string; readonly detail: string }> {
  override get message(): string {
    return `${this.code}: ${this.detail}`
  }
}
const refuse = (code: string, detail: string): never => { throw new DeployGuardRefusal({ code, detail }) }

/** The checkout's own claim, which must agree with itself and name the edge. */
export const classifyLocal = (wranglerMain: string, identityEntry: string): "edge" => {
  if (wranglerMain !== identityEntry) refuse("DEPLOY_GUARD_LOCAL_AMBIGUOUS", `wrangler main ${wranglerMain} differs from WORKER_IDENTITY.entry ${identityEntry}`)
  if (wranglerMain === "src/edge.ts") return "edge"
  return refuse("DEPLOY_GUARD_LOCAL_UNKNOWN", `entry ${wranglerMain} is not the shared edge`)
}

export interface LiveFacts {
  readonly versionId: string
  readonly entry: string
  readonly modules: ReadonlyArray<string>
  readonly annotations: Readonly<Record<string, string>>
}
/** The live version's identity. Entry module decides; annotations must not contradict it. */
export const classifyLive = (facts: LiveFacts): LiveIdentity => {
  const exporting = facts.annotations["workers/tag"] === "sealed-state-inventory"
  const only = (...names: string[]) => facts.modules.every(m => names.includes(m) || names.some(n => m === `${n}.map`))
  const contradict = () => refuse("DEPLOY_GUARD_LIVE_AMBIGUOUS", `live version ${facts.versionId} entry ${facts.entry} contradicts its annotation`)
  switch (facts.entry) {
    case "sealed-export-entry.js":
      return "maintenance-export"
    case "index.js":
      if (exporting || !only("index.js")) return contradict()
      return "legacy"
    case "edge.js":
      if (exporting || !only("edge.js")) return contradict()
      return "edge"
    default:
      return refuse("DEPLOY_GUARD_LIVE_UNKNOWN", `live version ${facts.versionId} runs unrecognized entry ${facts.entry}`)
  }
}

// ---- The owner record that admits the legacy-to-edge switch ----
/** The committed owner disposition record. Its path is fixed; nothing relocates it. */
export const ACTIVATION_RECORD_PATH = fileURLToPath(new URL("../cutover/activation.json", import.meta.url))
const DurableObjectRow = z.strictObject({ binding: z.string(), className: z.string() })
const sameIdentities = (rows: ReadonlyArray<z.infer<typeof DurableObjectRow>>) =>
  rows.length === WORKER_IDENTITY.durableObjects.length &&
  WORKER_IDENTITY.durableObjects.every((o, i) => rows[i]!.binding === o.binding && rows[i]!.className === o.className)
/**
 * Strict at every level: an unknown key (an import receipt digest, an override)
 * invalidates the record. The import disposition is its own field and states
 * that nothing was imported; no receipt check exists for it to satisfy.
 */
const ActivationRecordSchema = z.strictObject({
  schema: z.literal("smithers-edge-activation/v1"),
  worker: z.literal(WORKER_IDENTITY.name),
  transition: z.strictObject({ from: z.literal("legacy"), to: z.literal("edge"), entry: z.literal("src/edge.ts") }),
  owner: z.literal("Will (roninjin10)"),
  decidedAt: z.iso.date(),
  decision: z.literal("direct-switch"),
  source: z.literal("https://github.com/smithersai/plue/issues/531"),
  importDisposition: z.strictObject({
    users: z.literal("none"),
    legacyDurableObjectState: z.literal("retained-unmigrated"),
    identities: z.literal("unchanged"),
    retainedDurableObjects: z.array(DurableObjectRow).refine(sameIdentities, "must equal WORKER_IDENTITY.durableObjects"),
    note: z.string().min(1)
  }),
  backendBootstrap: z.strictObject({
    date: z.iso.date(),
    kind: z.literal("no-user-backend-bootstrap"),
    plueRevision: z.string().regex(/^[0-9a-f]{40}$/),
    recorded: z.literal("retroactive")
  })
})
export type ActivationRecord = z.infer<typeof ActivationRecordSchema> & { readonly sha256: string }
/** Validate the record's exact bytes; `undefined` means the file does not exist. */
export const parseActivationRecord = (text: string | undefined): ActivationRecord => {
  if (text === undefined) return refuse("DEPLOY_GUARD_EDGE_BEFORE_CUTOVER", "the legacy Worker is live and no owner activation record authorizes the switch to the edge")
  let json: unknown
  try { json = JSON.parse(text) } catch { return refuse("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED", "the owner activation record is not JSON") }
  const parsed = ActivationRecordSchema.safeParse(json)
  if (!parsed.success) return refuse("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED", `the owner activation record is invalid: ${parsed.error.issues.map(i => `${i.path.join(".") || "<root>"} ${i.message}`).join("; ")}`)
  return { ...parsed.data, sha256: sha256(text) }
}
export const readActivationRecord = (): ActivationRecord => {
  let text: string | undefined
  try { text = readFileSync(ACTIVATION_RECORD_PATH, "utf8") } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") return refuse("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED", "the owner activation record is unreadable")
  }
  return parseActivationRecord(text)
}

export type GuardDecision =
  | { readonly mode: "normal"; readonly local: "edge"; readonly live: "edge"; readonly liveVersion: string }
  | { readonly mode: "activation"; readonly local: "edge"; readonly live: "legacy"; readonly liveVersion: string; readonly record: ActivationRecord }
export const decideDeploy = (live: LiveFacts, activationRecord: () => ActivationRecord = readActivationRecord): GuardDecision => {
  const identity = classifyLive(live)
  if (identity === "edge") return { mode: "normal", local: "edge", live: identity, liveVersion: live.versionId }
  if (identity === "maintenance-export")
    return refuse("DEPLOY_GUARD_LIVE_CUTOVER", `live ${identity} version ${live.versionId} belongs to the sealed-inventory export; only its own restore may replace it`)
  return { mode: "activation", local: "edge", live: "legacy", liveVersion: live.versionId, record: activationRecord() }
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
/** Digest of a module set: the exact built artifact an activation publishes. */
export const artifactDigest = (modules: Record<string, string>): string =>
  sha256(JSON.stringify(Object.keys(modules).sort().map(name => [name, modules[name]])))

// ---- Activation: the published edge must be exactly the bundled artifact ----
/** After an activation, the live version must serve exactly the modules bundled before publication. */
export const verifyActivated = (live: LiveFacts & { digests: Record<string, string> }, authorizedArtifact: string): void => {
  if (classifyLive(live) !== "edge" || artifactDigest(codeModules(live.digests)) !== authorizedArtifact) refuse("DEPLOY_GUARD_ARTIFACT_DRIFT", "the live edge is not the bundled activation artifact; the rollout restores the captured legacy version")
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
  classifyLocal(wranglerMain, identityEntry)
  let live: LiveFacts
  try { live = await read(worker) } catch (error) {
    if (error instanceof DeployGuardRefusal) throw error
    return refuse("DEPLOY_GUARD_LIVE_UNREADABLE", "the live version could not be read; a guard that cannot see refuses")
  }
  return decideDeploy(live)
}
/** Only JavaScript modules name the artifact; source maps and wrangler's README are not uploaded code. */
export const codeModules = (digests: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(digests).filter(([name]) => name.endsWith(".js")))
