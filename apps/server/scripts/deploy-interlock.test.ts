import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { artifactDigest, authorizeActivation, classifyLive, classifyLocal, decideDeploy, preflightDeploy, readLiveFacts, verifyActivated, type ActivationRequest, type LiveFacts } from "./deployGuard"
import { WORKER_IDENTITY } from "../src/workerIdentity"
import { FakeCloudflare } from "./cutover/install-fake"
import { applyPhase, prepareInstall, restoreAll } from "./cutover/install"

setDefaultTimeout(60_000)
const roots: string[] = [], saved = { token: process.env.CLOUDFLARE_API_TOKEN, hook: process.env.SMITHERS_CUTOVER_AUTHORIZE }
let fake: FakeCloudflare | undefined
beforeAll(() => { process.env.CLOUDFLARE_API_TOKEN = "fake-control-plane-token" }) // never the real credential
afterEach(() => { fake?.restore(); fake = undefined })
afterAll(() => { process.env.CLOUDFLARE_API_TOKEN = saved.token; process.env.SMITHERS_CUTOVER_AUTHORIZE = saved.hook; for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const dir = () => { const d = mkdtempSync(join(tmpdir(), "deploy-interlock-")); chmodSync(d, 0o700); roots.push(d); return d }

// Annotation shapes read from the live account on 2026-09-24 (GET-only).
const LIVE_LEGACY = { "workers/message": "c05d8861b11fa9559dec239845eaf68031ba9fbd feat(native): contain Windows owners in identity-checked jo", "workers/tag": "c05d8861b11f", "workers/triggered_by": "version_upload" }
const LIVE_SECRET_ROTATION = { "workers/triggered_by": "secret" }
const LIVE_EXPORT = { "workers/message": "temporary sealed inventory over ace5abee0acd668a3545c72906fde7356f33b29c", "workers/tag": "sealed-state-inventory", "workers/triggered_by": "upload" }
const EXECUTION = "2b1f6a1e-7d3c-4e4a-9b9e-0c1d2e3f4a5b"
const facts = (entry: string, annotations: Record<string, string>, modules = [entry]): LiveFacts => ({ versionId: randomUUID(), entry, modules, annotations })

test("the checkout names itself unambiguously or refuses", () => {
  expect(classifyLocal("src/index.ts", "src/index.ts")).toBe("legacy")
  expect(classifyLocal("src/edge.ts", "src/edge.ts")).toBe("edge")
  expect(() => classifyLocal("src/edge.ts", "src/index.ts")).toThrow("DEPLOY_GUARD_LOCAL_AMBIGUOUS")
  expect(() => classifyLocal("src/other.ts", "src/other.ts")).toThrow("DEPLOY_GUARD_LOCAL_UNKNOWN")
})

test("live identity comes from the entry module and must agree with the version's own annotations", () => {
  expect(classifyLive(facts("index.js", LIVE_LEGACY)).identity).toBe("legacy")
  expect(classifyLive(facts("index.js", LIVE_SECRET_ROTATION)).identity).toBe("legacy") // a secret rotation carries no message
  expect(classifyLive(facts("sealed-export-entry.js", LIVE_EXPORT, ["sealed-export-entry.js", "sealed-export-helper.js", "index.js"])).identity).toBe("maintenance-export")
  expect(classifyLive(facts("cutover-fence-entry.js", { "workers/message": `smithers-cutover ${EXECUTION} fence` }, ["cutover-fence-entry.js", "cutover-fence-helper.js", "index.js"]))).toEqual({ identity: "cutover-fence", executionID: EXECUTION })
  expect(classifyLive(facts("edge.js", LIVE_LEGACY, ["edge.js", "edge.js.map"])).identity).toBe("edge")
  for (const ambiguous of [facts("index.js", { "workers/message": `smithers-cutover ${EXECUTION} fence` }), facts("cutover-fence-entry.js", { "workers/message": `smithers-cutover ${EXECUTION} admission` }),
    facts("cutover-fence-entry.js", {}), facts("index.js", { "workers/tag": "sealed-state-inventory" }), facts("index.js", LIVE_LEGACY, ["index.js", "cutover-fence-helper.js"])])
    expect(() => classifyLive(ambiguous)).toThrow("DEPLOY_GUARD_LIVE_AMBIGUOUS")
  expect(() => classifyLive(facts("worker.js", LIVE_LEGACY))).toThrow("DEPLOY_GUARD_LIVE_UNKNOWN")
})

test("decision table: normal only like-for-like; edge only over the final fence as an activation; everything else refuses", () => {
  const live = {
    legacy: facts("index.js", LIVE_LEGACY), edge: facts("edge.js", LIVE_LEGACY),
    admission: facts("cutover-admission-entry.js", { "workers/message": `smithers-cutover ${EXECUTION} admission` }),
    fence: facts("cutover-fence-entry.js", { "workers/message": `smithers-cutover ${EXECUTION} fence` }),
    export: facts("sealed-export-entry.js", LIVE_EXPORT)
  }
  expect(decideDeploy("legacy", live.legacy).mode).toBe("normal")
  expect(decideDeploy("edge", live.edge).mode).toBe("normal")
  expect(decideDeploy("edge", live.fence)).toMatchObject({ mode: "activation", executionID: EXECUTION, liveVersion: live.fence.versionId })
  for (const state of ["admission", "fence", "export"] as const) expect(() => decideDeploy("legacy", live[state])).toThrow("DEPLOY_GUARD_LIVE_CUTOVER")
  for (const state of ["admission", "export"] as const) expect(() => decideDeploy("edge", live[state])).toThrow("DEPLOY_GUARD_LIVE_CUTOVER")
  expect(() => decideDeploy("legacy", live.edge)).toThrow("DEPLOY_GUARD_LEGACY_OVER_EDGE")
  expect(() => decideDeploy("edge", live.legacy)).toThrow("DEPLOY_GUARD_EDGE_BEFORE_CUTOVER")
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
  await expect(preflightDeploy("smithers-mvp-web", "src/index.ts", "src/index.ts", async () => { throw new Error("network down") })).rejects.toThrow("DEPLOY_GUARD_LIVE_UNREADABLE")
})

/** A release-gate hook that answers the request, optionally wrongly. */
const gateHook = (root: string, answer: string, mode = 0o700) => {
  const path = join(root, `activate-${randomUUID()}.sh`)
  writeFileSync(path, `#!/bin/sh\nexec bun -e 'const r=JSON.parse(await Bun.stdin.text());console.log(JSON.stringify(${answer}))'\n`, { mode })
  chmodSync(path, mode)
  return path
}
const RECEIPTS = `cutoverReceiptSHA256:"c".repeat(64),importReceiptSHA256:"d".repeat(64)`
test("activation needs the gate's fresh authorization bound to this sha, live fence execution and exact artifact", () => {
  const root = dir()
  const request: ActivationRequest = { schema: "smithers-edge-activation-request/v1", worker: "smithers-mvp-web", smithersRevision: "a".repeat(40), artifactSHA256: "b".repeat(64), liveVersion: randomUUID(), cutoverExecutionID: EXECUTION }
  const ok = `{...r,schema:"smithers-edge-activation-authorization/v1",decision:"authorized",issuedAt:new Date().toISOString(),deploymentLock:{tag:"prod-cutover",token:"t"},${RECEIPTS}}`
  expect(authorizeActivation(request, gateHook(root, ok))).toMatchObject({ lockTag: "prod-cutover", cutoverReceiptSHA256: "c".repeat(64), importReceiptSHA256: "d".repeat(64) })
  for (const wrong of [ok.replace("...r,", `...r,artifactSHA256:"e".repeat(64),`), ok.replace(`,importReceiptSHA256:"d".repeat(64)`, ""), ok.replace("new Date().toISOString()", "new Date(Date.now()-3600000).toISOString()"), ok.replace('"authorized"', '"refused"')])
    expect(() => authorizeActivation(request, gateHook(root, wrong))).toThrow("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED")
  expect(() => authorizeActivation(request, undefined)).toThrow("DEPLOY_GUARD_ACTIVATION_UNAUTHORIZED")
  expect(() => authorizeActivation(request, gateHook(root, ok, 0o777))).toThrow("DEPLOY_GUARD_AUTHORIZER_UNSAFE")
})

test("after activation the live edge must be exactly the authorized artifact", () => {
  const digests = { "edge.js": "1".repeat(64) }
  const live = { ...facts("edge.js", LIVE_LEGACY, ["edge.js", "edge.js.map"]), digests: { ...digests, "edge.js.map": "2".repeat(64) } }
  expect(() => verifyActivated(live, artifactDigest(digests))).not.toThrow()
  expect(() => verifyActivated(live, artifactDigest({ "edge.js": "3".repeat(64) }))).toThrow("DEPLOY_GUARD_ARTIFACT_DRIFT")
  expect(() => verifyActivated({ ...live, entry: "index.js", modules: ["index.js"] }, artifactDigest(digests))).toThrow("DEPLOY_GUARD_ARTIFACT_DRIFT")
})

test("the guard reads the installer's real admission/fence versions and blocks CI until restore", async () => {
  const root = dir()
  const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
  const executionID = randomUUID()
  writeFileSync(join(root, "expected.json"), JSON.stringify({ executionID, smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }), { mode: 0o600 })
  writeFileSync(join(root, "recipient.json"), JSON.stringify({ migrationId: executionID, privateJwk: await crypto.subtle.exportKey("jwk", keys.privateKey), token: "t".repeat(48), expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString() }), { mode: 0o600 })
  process.env.SMITHERS_CUTOVER_AUTHORIZE = gateHook(root, `{...r,schema:"smithers-cutover-phase-authorization/v1",decision:"authorized",issuedAt:new Date().toISOString(),deploymentLock:{tag:"t",token:"k"}}`)
  fake = new FakeCloudflare().install()
  const guard = (main: string) => preflightDeploy("smithers-mvp-web", main, main)
  expect((await guard("src/index.ts")).mode).toBe("normal")
  await expect(guard("src/edge.ts")).rejects.toThrow("DEPLOY_GUARD_EDGE_BEFORE_CUTOVER")
  const { planSHA256 } = await prepareInstall(root)
  await applyPhase(root, planSHA256, "admission")
  await applyPhase(root, planSHA256, "fence")
  await expect(guard("src/index.ts")).rejects.toThrow("DEPLOY_GUARD_LIVE_CUTOVER")
  expect(await guard("src/edge.ts")).toMatchObject({ mode: "activation", executionID })
  await restoreAll(root, planSHA256)
  // After the exact rollback the fence is still the newest upload, so content/v2 cannot describe
  // the live version: the guard refuses rather than guess (live-verified 2026-09-24).
  await expect(guard("src/index.ts")).rejects.toThrow("DEPLOY_GUARD_LIVE_NOT_NEWEST")
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
  const entry: string = WORKER_IDENTITY.entry
  const local = entry === "src/edge.ts" ? "edge" : "legacy"
  const refused = local === "edge"
    ? [["legacy", "DEPLOY_GUARD_EDGE_BEFORE_CUTOVER"], ["admission", "DEPLOY_GUARD_LIVE_CUTOVER"], ["export", "DEPLOY_GUARD_LIVE_CUTOVER"]]
    : [["fence", "DEPLOY_GUARD_LIVE_CUTOVER"], ["admission", "DEPLOY_GUARD_LIVE_CUTOVER"], ["export", "DEPLOY_GUARD_LIVE_CUTOVER"], ["edge", "DEPLOY_GUARD_LEGACY_OVER_EDGE"]]
  for (const [live, code] of refused) {
    const result = deploy(live!)
    expect(result.code).toBe(1)
    expect(result.out).toContain(code!)
    expect(result.spawned).toEqual([])
  }
  const permitted = local === "edge" ? ["edge", "fence"] : ["legacy", "secret-rotated"]
  for (const live of permitted) {
    const result = deploy(live)
    expect(result.out).toContain(`cutover interlock: ${live === "fence" ? "activation" : "normal"} (local ${local}, live ${live === "fence" ? "cutover-fence" : local}`)
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
  expect(decideDeploy("edge", live).mode).toBe("normal")
  expect(() => decideDeploy("legacy", live)).toThrow("DEPLOY_GUARD_LEGACY_OVER_EDGE")
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
