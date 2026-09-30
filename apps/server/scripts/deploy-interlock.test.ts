import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ACTIVATION_RECORD_PATH, artifactDigest, classifyLive, classifyLocal, decideDeploy, parseActivationRecord, preflightDeploy, readActivationRecord, readLiveFacts, verifyActivated, type LiveFacts } from "./deployGuard"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { FakeCloudflare } from "./fakeCloudflare"

setDefaultTimeout(60_000)
const roots: string[] = [], saved = { token: process.env.CLOUDFLARE_API_TOKEN }
let fake: FakeCloudflare | undefined
beforeAll(() => { process.env.CLOUDFLARE_API_TOKEN = "fake-control-plane-token" }) // never the real credential
afterEach(() => { fake?.restore(); fake = undefined })
afterAll(() => { process.env.CLOUDFLARE_API_TOKEN = saved.token; for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), "deploy-interlock-")); chmodSync(d, 0o700); roots.push(d); return d }

// Annotation shapes read from the live account on 2026-09-24 (GET-only).
const LIVE_LEGACY = { "workers/message": "c05d8861b11fa9559dec239845eaf68031ba9fbd feat(native): contain Windows owners in identity-checked jo", "workers/tag": "c05d8861b11f", "workers/triggered_by": "version_upload" }
const LIVE_SECRET_ROTATION = { "workers/triggered_by": "secret" }
const LIVE_EXPORT = { "workers/message": "temporary sealed inventory over ace5abee0acd668a3545c72906fde7356f33b29c", "workers/tag": "sealed-state-inventory", "workers/triggered_by": "upload" }
const sha256Hex = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex")
const facts = (entry: string, annotations: Record<string, string>, modules = [entry]): LiveFacts => ({ versionId: randomUUID(), entry, modules, annotations })

test("the checkout names the edge unambiguously or refuses", () => {
  expect(classifyLocal("src/edge.ts", "src/edge.ts")).toBe("edge")
  expect(() => classifyLocal("src/edge.ts", "src/index.ts")).toThrow("DEPLOY_GUARD_LOCAL_AMBIGUOUS")
  // The legacy router is deleted; a checkout that names it is no longer a deployable Worker.
  expect(() => classifyLocal("src/index.ts", "src/index.ts")).toThrow("DEPLOY_GUARD_LOCAL_UNKNOWN")
  expect(() => classifyLocal("src/other.ts", "src/other.ts")).toThrow("DEPLOY_GUARD_LOCAL_UNKNOWN")
})

test("live identity comes from the entry module and must agree with the version's own annotations", () => {
  expect(classifyLive(facts("index.js", LIVE_LEGACY))).toBe("legacy")
  expect(classifyLive(facts("index.js", LIVE_SECRET_ROTATION))).toBe("legacy") // a secret rotation carries no message
  expect(classifyLive(facts("sealed-export-entry.js", LIVE_EXPORT, ["sealed-export-entry.js", "sealed-export-helper.js", "index.js"]))).toBe("maintenance-export")
  expect(classifyLive(facts("edge.js", LIVE_LEGACY, ["edge.js", "edge.js.map"]))).toBe("edge")
  for (const ambiguous of [facts("index.js", { "workers/tag": "sealed-state-inventory" }), facts("edge.js", { "workers/tag": "sealed-state-inventory" }),
    facts("index.js", LIVE_LEGACY, ["index.js", "sealed-export-helper.js"]), facts("edge.js", LIVE_LEGACY, ["edge.js", "index.js"])])
    expect(() => classifyLive(ambiguous)).toThrow("DEPLOY_GUARD_LIVE_AMBIGUOUS")
  // The retired cutover installer's admission and fence entries are no longer recognized versions.
  for (const unknown of [facts("worker.js", LIVE_LEGACY), facts("cutover-fence-entry.js", {}), facts("cutover-admission-entry.js", {})])
    expect(() => classifyLive(unknown)).toThrow("DEPLOY_GUARD_LIVE_UNKNOWN")
})

const live = () => ({
  legacy: facts("index.js", LIVE_LEGACY), edge: facts("edge.js", LIVE_LEGACY),
  export: facts("sealed-export-entry.js", LIVE_EXPORT)
})
/** The committed owner record, read through the same loader the deploy uses. */
const committed = () => JSON.parse(readFileSync(ACTIVATION_RECORD_PATH, "utf8")) as Record<string, unknown>
const recordReader = (value: unknown) => () => parseActivationRecord(JSON.stringify(value))
const neverRead = () => { throw new Error("the activation record must only be read for the legacy-to-edge switch") }

test("decision table: normal over the edge; over legacy only as the owner-recorded activation; the export refuses", () => {
  const states = live()
  expect(decideDeploy(states.edge, neverRead).mode).toBe("normal")
  const activation = decideDeploy(states.legacy)
  expect(activation).toMatchObject({ mode: "activation", local: "edge", live: "legacy", liveVersion: states.legacy.versionId,
    record: { decision: "direct-switch", owner: "Will (roninjin10)", sha256: sha256Hex(readFileSync(ACTIVATION_RECORD_PATH)) } })
  expect(() => decideDeploy(states.export, neverRead)).toThrow("DEPLOY_GUARD_LIVE_CUTOVER")
})

test("the committed owner record validates and names the no-user disposition, not an import receipt", () => {
  const record = readActivationRecord()
  expect(record).toMatchObject({
    owner: "Will (roninjin10)", decidedAt: "2026-09-29", decision: "direct-switch", source: "https://github.com/smithersai/plue/issues/531",
    importDisposition: { users: "none", legacyDurableObjectState: "retained-unmigrated", identities: "unchanged" },
    backendBootstrap: { date: "2026-09-27", plueRevision: "0453975821e593aa5718ad7658629d7ed6a034c2", recorded: "retroactive" }
  })
  expect(record.importDisposition.retainedDurableObjects).toEqual([...WORKER_IDENTITY.durableObjects])
})

test("a missing or invalid owner record refuses the legacy-to-edge switch", () => {
  const legacy = live().legacy
  expect(() => decideDeploy(legacy, () => parseActivationRecord(undefined))).toThrow("DEPLOY_GUARD_EDGE_BEFORE_CUTOVER")
  expect(() => decideDeploy(legacy, () => parseActivationRecord("{not json"))).toThrow("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED")
  const base = committed()
  const disposition = base.importDisposition as Record<string, unknown>
  const invalid: unknown[] = [
    {}, [], null, "direct-switch",
    { ...base, decision: "staged-cutover" },
    { ...base, owner: "someone else" },
    { ...base, source: "https://github.com/smithersai/plue/issues/532" },
    { ...base, decidedAt: "yesterday" },
    { ...base, worker: "another-worker" },
    { ...base, transition: { from: "edge", to: "legacy" } },
    { ...base, schema: "smithers-edge-activation/v2" },
    // A disposition is never a receipt, and a receipt never stands in for the disposition.
    { ...base, importDisposition: "d".repeat(64) },
    { ...base, importReceiptSHA256: "d".repeat(64) },
    { ...base, importDisposition: { ...disposition, importReceiptSHA256: "d".repeat(64) } },
    { ...base, importDisposition: { ...disposition, legacyDurableObjectState: "migrated" } },
    { ...base, importDisposition: { ...disposition, users: "some" } },
    { ...base, importDisposition: { ...disposition, retainedDurableObjects: WORKER_IDENTITY.durableObjects.slice(1) } },
    { ...base, importDisposition: { ...disposition, retainedDurableObjects: WORKER_IDENTITY.durableObjects.map(o => ({ ...o, className: `${o.className}V2` })) } },
    { ...base, backendBootstrap: undefined },
    { ...base, backendBootstrap: { ...(base.backendBootstrap as object), plueRevision: "0453975" } },
    { ...base, override: true }
  ]
  for (const record of invalid) expect(() => decideDeploy(legacy, recordReader(record))).toThrow("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED")
  expect(decideDeploy(legacy, recordReader(base)).mode).toBe("activation")
})

test("the live read refuses a split deployment and a version that changes while it is read", async () => {
  const content = async () => ({ entry: "index.js", modules: ["index.js"], digests: { "index.js": "0".repeat(64) } })
  let reads = 0
  const moving = (async (path: string) => path.endsWith("/deployments")
    ? { result: { deployments: [{ versions: [{ version_id: reads++ === 0 ? "v1" : "v2", percentage: 100 }] }] } }
    : path.endsWith("/versions?per_page=1") ? { result: { items: [{ id: "v1" }] } }
    : { result: { annotations: LIVE_LEGACY } }) as never
  await expect(readLiveFacts("smithers-mvp-web", moving, content)).rejects.toThrow("DEPLOY_GUARD_LIVE_CHANGED")
  const split = (async () => ({ result: { deployments: [{ versions: [{ version_id: "a", percentage: 50 }, { version_id: "b", percentage: 50 }] }] } })) as never
  await expect(readLiveFacts("smithers-mvp-web", split, content)).rejects.toThrow("DEPLOY_GUARD_LIVE_SPLIT")
  await expect(preflightDeploy("smithers-mvp-web", "src/edge.ts", "src/edge.ts", async () => { throw new Error("network down") })).rejects.toThrow("DEPLOY_GUARD_LIVE_UNREADABLE")
  await expect(preflightDeploy("smithers-mvp-web", "src/index.ts", "src/index.ts", async () => { throw new Error("never read") })).rejects.toThrow("DEPLOY_GUARD_LOCAL_UNKNOWN")
})

test("after activation the live edge must be exactly the authorized artifact", () => {
  const digests = { "edge.js": "1".repeat(64) }
  const live = { ...facts("edge.js", LIVE_LEGACY, ["edge.js", "edge.js.map"]), digests: { ...digests, "edge.js.map": "2".repeat(64) } }
  expect(() => verifyActivated(live, artifactDigest(digests))).not.toThrow()
  expect(() => verifyActivated(live, artifactDigest({ "edge.js": "3".repeat(64) }))).toThrow("DEPLOY_GUARD_ARTIFACT_DRIFT")
  expect(() => verifyActivated({ ...live, entry: "index.js", modules: ["index.js"] }, artifactDigest(digests))).toThrow("DEPLOY_GUARD_ARTIFACT_DRIFT")
  expect(() => verifyActivated({ ...live, digests: { ...live.digests, "extra.js": "4".repeat(64) } }, artifactDigest(digests))).toThrow("DEPLOY_GUARD_ARTIFACT_DRIFT")
})

test("an upload-only edge build over the live legacy writer never reads as a live edge", async () => {
  fake = new FakeCloudflare().install()
  fake.uploadOnly("smithers-mvp-web")
  fake.latest("smithers-mvp-web").entry = "edge.js"; fake.latest("smithers-mvp-web").modules = [{ name: "edge.js", type: "application/javascript+module", bytes: new TextEncoder().encode("// edge") }]
  await expect(preflightDeploy("smithers-mvp-web", "src/edge.ts", "src/edge.ts")).rejects.toThrow("DEPLOY_GUARD_LIVE_NOT_NEWEST")
})

test("the real deploy.ts enforces the checkout identity before any subprocess", () => {
  const shims = dir(), log = join(shims, "spawned.log")
  for (const cmd of ["git", "jj", "node", "pnpm", "bun", "npx", "wrangler"]) writeFileSync(join(shims, cmd), `#!/bin/sh\necho "${cmd} $*" >> ${log}\nexit 1\n`, { mode: 0o700 })
  const deploy = (live: string) => {
    rmSync(log, { force: true })
    const run = Bun.spawnSync([process.execPath, "--preload", new URL("./deploy-interlock-preload.ts", import.meta.url).pathname, new URL("./deploy.ts", import.meta.url).pathname],
      { cwd: new URL("..", import.meta.url).pathname, env: { PATH: shims, HOME: process.env.HOME ?? "", CLOUDFLARE_API_TOKEN: "fake-control-plane-token", DEPLOY_INTERLOCK_LIVE: live } })
    return { code: run.exitCode, out: run.stdout.toString() + run.stderr.toString(), spawned: existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [] }
  }
  expect(WORKER_IDENTITY.entry).toBe("src/edge.ts")
  for (const [live, code] of [["fence", "DEPLOY_GUARD_LIVE_UNKNOWN"], ["export", "DEPLOY_GUARD_LIVE_CUTOVER"]] as const) {
    const result = deploy(live)
    expect(result.code).toBe(1)
    expect(result.out).toContain(code)
    expect(result.spawned).toEqual([])
  }
  for (const [live, expected] of [["edge", "normal (local edge, live edge"], ["legacy", "activation (local edge, live legacy"], ["secret-rotated", "activation (local edge, live legacy"]] as const) {
    const result = deploy(live)
    expect(result.out).toContain(`cutover interlock: ${expected}`)
    if (live !== "edge") expect(result.out).toContain("owner record")
    expect(result.spawned[0]).toMatch(/^(git|jj) /)
    expect(result.spawned.some(line => line.includes("wrangler"))).toBe(false)
  }
})

test("only a verified rollback receipt admits an older live version, preserving identity and race guards", async () => {
  const target = { ...facts("edge.js", LIVE_LEGACY), digests: { "edge.js": "1".repeat(64) } }
  const receipt = {
    status: "rolled-back", rollback: "succeeded", previous: { version: target.versionId, revision: "a".repeat(40) },
    reverification: [{ name: "CN-24", status: "passed" }],
    recovery: { accountId: WORKER_IDENTITY.accountId, worker: "smithers-mvp-web", target, newestVersion: "rejected" }
  }
  let reads = 0
  let moved = false
  let uploadMoved = false
  let uploads = 0
  const get = (async (path: string) => path.endsWith("/deployments")
    ? { result: { deployments: [{ versions: [{ version_id: moved && reads++ > 0 ? "other" : target.versionId, percentage: 100 }] }] } }
    : path.endsWith("/versions?per_page=1") ? { result: { items: [{ id: uploadMoved && uploads++ > 0 ? "another-upload" : "rejected" }] } }
    : { result: { id: target.versionId, annotations: LIVE_LEGACY } }) as never
  const content = async () => { throw Error("must not read newest upload content") }
  const read = (value: unknown) => readLiveFacts("smithers-mvp-web", get, content, value)
  const live = await read(receipt)
  expect(live).toEqual(target)
  expect(decideDeploy(live, neverRead).mode).toBe("normal")
  for (const bad of [undefined, {}, { ...receipt, rollback: "failed" }, { ...receipt, status: "restoring" },
    { ...receipt, previous: { version: "other", revision: "a".repeat(40) } },
    { ...receipt, reverification: [{ name: "CN-24", status: "failed" }] },
    ...[ { worker: "other" }, { accountId: "other" }, { newestVersion: "older" },
      { target: { ...target, annotations: {} } }, { target: { ...target, digests: {} } }
    ].map(change => ({ ...receipt, recovery: { ...receipt.recovery, ...change } }))]) {
    await expect(read(bad)).rejects.toThrow("DEPLOY_GUARD_LIVE_NOT_NEWEST")
  }
  // A red restored baseline can still be repaired if the exact version was restored.
  expect(await read({ ...receipt, status: "rollback-failed" })).toEqual(target)
  expect(await read({ ...receipt, status: "rollback-failed", rollback: "failed" })).toEqual(target)
  moved = true
  await expect(read(receipt)).rejects.toThrow("DEPLOY_GUARD_LIVE_CHANGED")
  moved = false
  uploadMoved = true
  await expect(read(receipt)).rejects.toThrow("DEPLOY_GUARD_LIVE_CHANGED")
})
