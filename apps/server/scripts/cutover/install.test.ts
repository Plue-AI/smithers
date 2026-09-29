import { afterAll, afterEach, beforeAll, expect, setDefaultTimeout, test } from "bun:test"
import { createHash, randomUUID } from "node:crypto"
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { stable } from "./deployment"
import { CLOUDFLARE_PRODUCERS, collectCloudflareFence, privateArtifact } from "./fence"
import { FakeCloudflare } from "./install-fake"
import { applyPhase, installStatus, loadPlan, MAINTENANCE_SECRETS, prepareInstall, readJournal, restoreAll } from "./install"

setDefaultTimeout(60_000) // each step spawns the real authorization hook process
const keys = await crypto.subtle.generateKey({ name: "RSA-OAEP", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" }, true, ["wrapKey", "unwrapKey"]) as CryptoKeyPair
const privateJwk = await crypto.subtle.exportKey("jwk", keys.privateKey)
const roots: string[] = [], saved = { token: process.env.CLOUDFLARE_API_TOKEN, hook: process.env.SMITHERS_CUTOVER_AUTHORIZE }
let fake: FakeCloudflare | undefined
beforeAll(() => { process.env.CLOUDFLARE_API_TOKEN = "fake-control-plane-token" }) // never the real credential
afterEach(() => { fake?.restore(); fake = undefined; process.env.SMITHERS_CUTOVER_AUTHORIZE = saved.hook })
afterAll(() => { process.env.CLOUDFLARE_API_TOKEN = saved.token; for (const r of roots) rmSync(r, { recursive: true, force: true }) })
const TOKEN = "export-token-" + randomUUID() + randomUUID()

/** A gate hook that echoes the exact request as an authorization, or misbehaves on demand. */
const hook = (root: string, mode: "authorize" | "refuse" | "wrong-plan" | "stale" = "authorize") => {
  const path = join(root, `hook-${mode}.sh`), log = join(root, "hook-calls.log")
  const body = mode === "refuse" ? "exit 1" : `exec bun -e '
const r=JSON.parse(await Bun.stdin.text());require("node:fs").appendFileSync(${JSON.stringify(log)},r.worker+" "+r.action+"\\n")
console.log(JSON.stringify({...r,schema:"smithers-cutover-phase-authorization/v1",decision:"authorized",${mode === "wrong-plan" ? 'planSHA256:"0".repeat(64),' : ""}issuedAt:new Date(Date.now()${mode === "stale" ? "-3600000" : ""}).toISOString(),deploymentLock:{tag:"prod-cutover",token:"lock-owner-1"}}))'`
  writeFileSync(path, `#!/bin/sh\n${body}\n`, { mode: 0o700 })
  process.env.SMITHERS_CUTOVER_AUTHORIZE = path
  return log
}
const setup = async () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-install-")); roots.push(root); chmodSync(root, 0o700)
  const expected = { executionID: randomUUID(), smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }
  writeFileSync(join(root, "expected.json"), JSON.stringify(expected), { mode: 0o600 })
  writeFileSync(join(root, "recipient.json"), JSON.stringify({ migrationId: expected.executionID, privateJwk, token: TOKEN, expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString() }), { mode: 0o600 })
  fake = new FakeCloudflare().install()
  const originals = Object.fromEntries(CLOUDFLARE_PRODUCERS.map(w => [w, fake!.live(w).id]))
  const { planSHA256, plan } = await prepareInstall(root)
  return { root, expected, planSHA256, plan, originals, fake: fake! }
}
const everyFile = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? everyFile(join(dir, e.name)) : [join(dir, e.name)])

test("prepare is GET-only and plans previews-off, admission for the three metering workers, then fences with billing last", async () => {
  const { plan, fake } = await setup()
  expect(fake.mutations).toEqual([])
  expect(plan.sequence.map(s => `${s.phase}:${s.action}:${s.worker}`).slice(0, 8)).toEqual([
    "admission:previews-off:smithers-cloud-identity", "admission:previews-off:smithers-cloud-chat-canary", "admission:previews-off:smithers-cloud-cron", "admission:previews-off:smithers-cloud-reco", "admission:previews-off:plue-ts",
    "admission:admission:smithers-cloud-chat-canary", "admission:admission:smithers-cloud-chat", "admission:admission:smithers-cloud-billing"])
  expect(plan.sequence.filter(s => s.action === "fence").map(s => s.worker).at(-1)).toBe("smithers-cloud-billing")
  expect(plan.sequence.filter(s => s.action === "fence")).toHaveLength(14)
  expect(plan.workers.find(w => w.worker === "smithers-cloud-sync")!.surface.origins).toEqual(["https://sync.smithers.sh"])
  expect(plan.workers.find(w => w.worker === "smithers-flows-flows")!.originalModules.map(m => m.type).sort()).toEqual(["application/javascript+module", "application/source-map"])
})

test("admission then final fence preserve secrets and object identity, hand off to collect, and restore every exact original version", async () => {
  const { root, planSHA256, plan, originals, fake } = await setup()
  const calls = hook(root)
  await applyPhase(root, planSHA256, "admission")
  for (const w of ["smithers-cloud-chat-canary", "smithers-cloud-chat", "smithers-cloud-billing"]) expect(fake.live(w).entry).toBe("cutover-admission-entry.js")
  expect(fake.workers.get("plue-ts")!.subdomain.previews_enabled).toBe(false)
  expect((await applyPhase(root, planSHA256, "admission")).every(x => x.skipped)).toBe(true) // idempotent re-run
  await applyPhase(root, planSHA256, "fence")
  const fencedMutations = fake.mutations.length, fencedAuthorizations = readFileSync(calls, "utf8")
  expect((await applyPhase(root, planSHA256, "fence")).every(x => x.skipped)).toBe(true)
  expect(fake.mutations).toHaveLength(fencedMutations)
  expect(readFileSync(calls, "utf8")).toBe(fencedAuthorizations)
  for (const w of CLOUDFLARE_PRODUCERS) {
    const live = fake.live(w)
    expect(live.entry).toBe("cutover-fence-entry.js")
    // The fence entry never imports the legacy runtime; originals ride along inert for exact provenance.
    expect(new TextDecoder().decode(live.modules.find(m => m.name === "cutover-fence-entry.js")!.bytes)).not.toMatch(/index\.js|worker\.js/)
    expect(live.secrets.API_SECRET).toBe(`secret-value-${w}`)
    expect(Object.keys(live.secrets).sort()).toEqual(["API_SECRET", ...MAINTENANCE_SECRETS].sort())
    const objects = (bindings: Array<Record<string, unknown>>) => bindings.filter(b => b.type === "durable_object_namespace").sort((x, y) => String(x.name).localeCompare(String(y.name)))
    expect(objects(live.bindings)).toEqual(objects(fake.workers.get(w)!.versions.get(originals[w]!)!.bindings))
  }
  expect((await installStatus(root, planSHA256)).every(r => r.state === "fenced")).toBe(true)
  // Handoff: collect's plan files verify against the exact original bytes and the reproducible fence helper.
  for (const w of plan.workers) {
    const collect = JSON.parse(readFileSync(join(root, `${w.worker}.plan.json`), "utf8"))
    const modules = collect.originalModules.map((m: { name: string; path: string; sha256: string }) => ({ name: m.name, sha256: createHash("sha256").update(privateArtifact(root, m)).digest("hex") })).sort((a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name))
    expect(createHash("sha256").update(stable({ entry: collect.originalEntry, modules })).digest("hex")).toBe(collect.identity.sourceArtifactSHA256)
    expect(collect.version).toBe(fake.live(w.worker).id)
  }
  expect(Object.keys(JSON.parse(readFileSync(join(root, "admission.json"), "utf8"))).sort()).toEqual(["smithers-cloud-billing", "smithers-cloud-chat", "smithers-cloud-chat-canary"])
  // No export token or provider secret value in any artifact except the owner-only recipient file.
  for (const file of everyFile(root).filter(f => !f.endsWith("recipient.json"))) {
    const text = readFileSync(file, "utf8")
    expect(text).not.toContain(TOKEN); expect(text).not.toContain("secret-value-")
    if (!file.endsWith(".sh") && !file.endsWith(".log")) expect(statSync(file).mode & 0o077).toBe(0)
  }
  const restored = await restoreAll(root, planSHA256)
  expect(restored.every(r => r.outcome === "restored")).toBe(true)
  for (const w of CLOUDFLARE_PRODUCERS) {
    expect(fake.live(w).id).toBe(originals[w]!)
    expect(Object.keys(fake.live(w).secrets)).toEqual(["API_SECRET"])
  }
  expect(fake.workers.get("smithers-cloud-cron")!.subdomain.previews_enabled).toBe(true)
  const journal = readJournal(root, planSHA256)
  // Every mutation has an authorization and an fsynced intent recorded before it.
  for (const [i, e] of journal.entries()) if (e.event === "intent") expect(journal[i - 1]!.event).toBe("authorized")
  expect(readFileSync(calls, "utf8").trim().split("\n")).toHaveLength(plan.sequence.length + 14 + plan.sequence.filter(s => s.action === "previews-off").length)
})

test("a completed admission and restore closes both apply phases for that plan", async () => {
  const { root, planSHA256, fake } = await setup()
  const calls = hook(root)
  await applyPhase(root, planSHA256, "admission")
  expect((await restoreAll(root, planSHA256)).every(r => r.outcome === "restored" || r.outcome === "already-original")).toBe(true)
  const worker = "smithers-cloud-identity"
  fake.workers.get(worker)!.subdomain.previews_enabled = false // independent change after restoration
  const mutations = [...fake.mutations], authorizations = readFileSync(calls, "utf8")
  const journal = readJournal(root, planSHA256)
  for (const phase of ["admission", "fence"] as const) {
    await expect(applyPhase(root, planSHA256, phase)).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
    expect(fake.mutations).toEqual(mutations)
    expect(readFileSync(calls, "utf8")).toBe(authorizations)
    expect(readJournal(root, planSHA256)).toEqual(journal)
  }
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
})

test("a restored partial admission cannot reuse a preview receipt after an independent disable", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  const firstAdmission = "smithers-cloud-chat-canary"
  const calls = hook(root)
  fake.failPut.add(firstAdmission)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_UPLOAD_FAILED")
  expect(readJournal(root, planSHA256).filter(e => e.action === "previews-off" && e.event === "verified")).toHaveLength(5)
  fake.failPut.delete(firstAdmission)
  await restoreAll(root, planSHA256)
  fake.workers.get(worker)!.subdomain.previews_enabled = false // a new actor disabled previews after recovery
  const mutations = [...fake.mutations], authorizations = readFileSync(calls, "utf8"), journal = readJournal(root, planSHA256)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
  expect(fake.mutations).toEqual(mutations)
  expect(readFileSync(calls, "utf8")).toBe(authorizations)
  expect(readJournal(root, planSHA256)).toEqual(journal)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
})

test("failed admission retries within its active cycle without disabling previews twice", async () => {
  const { root, planSHA256, fake } = await setup()
  const calls = hook(root)
  const firstAdmission = "smithers-cloud-chat-canary"
  fake.failPut.add(firstAdmission)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_UPLOAD_FAILED")
  const previewMutations = fake.mutations.filter(m => m.startsWith("subdomain "))
  expect(previewMutations).toHaveLength(5)
  fake.failPut.delete(firstAdmission)
  const retried = await applyPhase(root, planSHA256, "admission")
  expect(retried.filter(r => r.action === "previews-off").every(r => r.skipped)).toBe(true)
  expect(retried.filter(r => r.action === "admission").every(r => !r.skipped)).toBe(true)
  expect(fake.mutations.filter(m => m.startsWith("subdomain "))).toEqual(previewMutations)
  expect(readFileSync(calls, "utf8").trim().split("\n").filter(line => line.endsWith(" previews-off"))).toHaveLength(5)
})

test("a crash after preview restore intent closes apply even without an overall restore receipt", async () => {
  const { root, fake } = await setup()
  const worker = "smithers-cutover-rehearsal-recovery"
  fake.addRehearsal(worker)
  const { planSHA256 } = await prepareInstall(root, { rehearsalWorker: worker })
  const calls = hook(root)
  fake.failPut.add(worker)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_UPLOAD_FAILED")
  fake.failPut.delete(worker)
  const providerFetch = globalThis.fetch
  let crashPrefix: string | undefined
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      crashPrefix = readFileSync(join(root, "install-journal.jsonl"), "utf8")
    }
    return providerFetch(input, init)
  }) as typeof fetch
  expect((await restoreAll(root, planSHA256)).map(r => r.outcome)).toEqual(["restored"])
  expect(crashPrefix).toBeDefined()
  writeFileSync(join(root, "install-journal.jsonl"), crashPrefix!) // model a process lost after fsynced intent and before its final receipt
  const journal = readJournal(root, planSHA256)
  expect(journal.filter(e => e.action === "restore-previews").map(e => e.event)).toEqual(["authorized", "intent"])
  expect(journal.some(e => e.action === "restore")).toBe(false)
  const mutations = [...fake.mutations], authorizations = readFileSync(calls, "utf8")
  for (const phase of ["admission", "fence"] as const) {
    await expect(applyPhase(root, planSHA256, phase)).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
    expect(fake.mutations).toEqual(mutations)
    expect(readFileSync(calls, "utf8")).toBe(authorizations)
    expect(readJournal(root, planSHA256)).toEqual(journal)
  }
})

test("a refused recovery closes apply without any successful restore receipt", async () => {
  const { root, fake } = await setup()
  const worker = "smithers-cutover-rehearsal-refused"
  fake.addRehearsal(worker)
  const { planSHA256 } = await prepareInstall(root, { rehearsalWorker: worker })
  hook(root)
  fake.failPut.add(worker)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_UPLOAD_FAILED")
  fake.failPut.delete(worker)
  hook(root, "refuse")
  expect(await restoreAll(root, planSHA256)).toEqual([{ worker, outcome: "refused", code: "CF_INSTALL_PHASE_UNAUTHORIZED" }])
  const journal = readJournal(root, planSHA256)
  expect(journal.filter(e => e.action === "restore").map(e => e.event)).toEqual(["refused"])
  expect(journal.some(e => e.action === "restore-previews" || e.event === "restored")).toBe(false)
  const calls = hook(root)
  const mutations = [...fake.mutations], authorizations = readFileSync(calls, "utf8")
  for (const phase of ["admission", "fence"] as const) {
    await expect(applyPhase(root, planSHA256, phase)).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
    expect(fake.mutations).toEqual(mutations)
    expect(readFileSync(calls, "utf8")).toBe(authorizations)
    expect(readJournal(root, planSHA256)).toEqual(journal)
  }
})

test("original drift before apply refuses before any mutation of that worker", async () => {
  const { root, planSHA256, fake } = await setup()
  hook(root)
  fake.foreignDeploy("smithers-cloud-chat-canary")
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_ORIGINAL_DRIFT")
  expect(fake.mutations).toEqual([]) // not even the preview toggles of other workers
  expect(readJournal(root, planSHA256).filter(e => e.worker === "smithers-cloud-chat-canary" && e.action === "admission")).toEqual([])
})

test("no mutation without an exact, fresh gate authorization for that step", async () => {
  const { root, planSHA256, fake } = await setup()
  delete process.env.SMITHERS_CUTOVER_AUTHORIZE
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_PHASE_UNAUTHORIZED")
  for (const mode of ["refuse", "wrong-plan", "stale"] as const) { hook(root, mode); await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_PHASE_UNAUTHORIZED") }
  hook(root); await expect(applyPhase(root, planSHA256, "fence")).rejects.toThrow("CF_INSTALL_ADMISSION_NOT_VERIFIED")
  expect(fake.mutations).toEqual([])
  expect(readJournal(root, planSHA256).some(e => e.event === "intent")).toBe(false)
})

test("prepare-only restore preserves a foreign preview disable with absent or refusing authorization", async () => {
  const { root, planSHA256, originals, fake } = await setup()
  const worker = "smithers-cloud-identity"
  expect(readJournal(root, planSHA256)).toEqual([])
  fake.workers.get(worker)!.subdomain.previews_enabled = false // independent operator change after prepare
  for (const mode of ["absent", "refuse"] as const) {
    if (mode === "absent") delete process.env.SMITHERS_CUTOVER_AUTHORIZE
    else hook(root, "refuse")
    const results = await restoreAll(root, planSHA256)
    expect(fake.live(worker).id).toBe(originals[worker])
    expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
    expect(fake.mutations).toEqual([])
    expect(results.find(r => r.worker === worker)?.outcome).toBe("already-original")
  }
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews")).toEqual([])
  hook(root)
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
  expect(fake.mutations).toEqual([])
})

test("owned previews need a separate restore authorization and durable intent even when the original version is live", async () => {
  const { root, planSHA256, plan, originals, fake } = await setup()
  const worker = "smithers-cloud-identity"
  const previewStep = plan.sequence.find(s => s.worker === worker && s.action === "previews-off")!
  const calls = hook(root)
  await applyPhase(root, planSHA256, "admission")
  expect(fake.live(worker).id).toBe(originals[worker])
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  const providerFetch = globalThis.fetch
  let checkedBeforeWrite = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      const entries = readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews")
      expect(entries.map(e => e.event)).toEqual(["authorized", "intent"])
      expect(entries.every(e => e.step === previewStep.index)).toBe(true)
      checkedBeforeWrite = true
    }
    return providerFetch(input, init)
  }) as typeof fetch
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(checkedBeforeWrite).toBe(true)
  expect(results.find(r => r.worker === worker)?.outcome).toBe("restored")
  expect(fake.mutations.slice(priorMutations).filter(m => m === `subdomain ${worker}`)).toEqual([`subdomain ${worker}`])
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(true)
  expect(readFileSync(calls, "utf8")).toContain(`${worker} restore-previews\n`)
  const entries = readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews")
  expect(entries.map(e => e.event)).toEqual(["authorized", "intent", "restored"])
  expect(entries.every(e => e.step === previewStep.index)).toBe(true)
})

test("absent, refusing, wrong-plan, and stale restore gates leave owned disabled previews untouched", async () => {
  const { root, planSHA256, originals, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  expect(fake.live(worker).id).toBe(originals[worker])
  const priorMutations = fake.mutations.length
  for (const mode of ["absent", "refuse", "wrong-plan", "stale"] as const) {
    if (mode === "absent") delete process.env.SMITHERS_CUTOVER_AUTHORIZE
    else hook(root, mode)
    const results = await restoreAll(root, planSHA256)
    expect(results.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_INSTALL_PHASE_UNAUTHORIZED" })
  }
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews" && e.event === "intent")).toEqual([])
})

test("restore refuses foreign workersDev drift before touching owned previews", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  fake.workers.get(worker)!.subdomain.enabled = false // changed independently after our previews-off write
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_RESTORE_PREVIEWS_DRIFT" })
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(fake.workers.get(worker)!.subdomain).toEqual({ enabled: false, previews_enabled: false })
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews" && e.event === "intent")).toEqual([])
})

test("a second restore preserves previews disabled independently after the first restore", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  await restoreAll(root, planSHA256)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(true)
  fake.workers.get(worker)!.subdomain.previews_enabled = false // independent change after ownership was consumed
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === worker)?.outcome).toBe("already-original")
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews" && e.event === "intent")).toHaveLength(1)
})

test("already-enabled previews retire an owned disable without another provider write", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  fake.workers.get(worker)!.subdomain.previews_enabled = true // an independent operator already enabled them
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === worker)?.outcome).toBe("already-original")
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews").map(e => e.event)).toEqual(["restored"])
  fake.workers.get(worker)!.subdomain.previews_enabled = false
  await restoreAll(root, planSHA256)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
})

test("workersDev drift arising during authorization is refused before preview intent or write", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  const calls = hook(root)
  await applyPhase(root, planSHA256, "admission")
  const providerFetch = globalThis.fetch
  let driftedDuringGate = false
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (!driftedDuringGate && request.method === "GET" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`) &&
      readFileSync(calls, "utf8").includes(`${worker} restore-previews\n`)) {
      fake.workers.get(worker)!.subdomain.enabled = false
      driftedDuringGate = true
    }
    return providerFetch(input, init)
  }) as typeof fetch
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(driftedDuringGate).toBe(true)
  expect(results.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_RESTORE_PREVIEWS_DRIFT" })
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews").map(e => e.event)).toEqual(["authorized"])
})

test("an ambiguous failed preview-disable response cannot establish ownership for restore", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  const providerFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      const response = await providerFetch(input, init) // provider committed the write, but its response was lost
      globalThis.fetch = providerFetch
      expect(response.ok).toBe(true)
      return Response.json({ success: false }, { status: 502 })
    }
    return providerFetch(input, init)
  }) as typeof fetch
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow()
  const off = readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "previews-off")
  expect(off.map(e => e.event)).toEqual(["authorized", "intent", "failed"])
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_RESTORE_PREVIEWS_UNCERTAIN" })
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews" && e.event === "intent")).toEqual([])
})

test("a lost preview-enable response is recovered only while the verified setting remains enabled", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  const providerFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      const response = await providerFetch(input, init)
      globalThis.fetch = providerFetch
      expect(response.ok).toBe(true)
      return Response.json({ success: false }, { status: 502 })
    }
    return providerFetch(input, init)
  }) as typeof fetch
  const first = await restoreAll(root, planSHA256)
  expect(first.find(r => r.worker === worker)?.outcome).toBe("refused")
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(true)
  const pending = readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews")
  expect(pending.some(e => e.event === "intent")).toBe(true)
  expect(pending.some(e => e.event === "restored")).toBe(false)
  const afterLostResponse = fake.mutations.length
  const recovered = await restoreAll(root, planSHA256)
  expect(recovered.find(r => r.worker === worker)?.outcome).toBe("already-original")
  expect(fake.mutations.slice(afterLostResponse)).not.toContain(`subdomain ${worker}`)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews" && e.event === "restored")).toHaveLength(1)
  fake.workers.get(worker)!.subdomain.previews_enabled = false
  const afterRecovery = fake.mutations.length
  await restoreAll(root, planSHA256)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(fake.mutations.slice(afterRecovery)).not.toContain(`subdomain ${worker}`)
})

test("a lost preview-enable response followed by an independent disable is uncertain", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  const providerFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      const response = await providerFetch(input, init)
      globalThis.fetch = providerFetch
      expect(response.ok).toBe(true)
      return Response.json({ success: false }, { status: 502 })
    }
    return providerFetch(input, init)
  }) as typeof fetch
  await restoreAll(root, planSHA256)
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(true)
  fake.workers.get(worker)!.subdomain.previews_enabled = false
  const priorMutations = fake.mutations.length
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_RESTORE_PREVIEWS_UNCERTAIN" })
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
})

test("a failed preview-enable write with previews still disabled cannot be retried automatically", async () => {
  const { root, planSHA256, fake } = await setup()
  const worker = "smithers-cloud-identity"
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  const providerFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init)
    if (request.method === "POST" && new URL(request.url).pathname.endsWith(`/workers/scripts/${worker}/subdomain`)) {
      globalThis.fetch = providerFetch
      return Response.json({ success: false }, { status: 502 }) // response does not establish whether provider wrote
    }
    return providerFetch(input, init)
  }) as typeof fetch
  const first = await restoreAll(root, planSHA256)
  expect(first.find(r => r.worker === worker)?.outcome).toBe("refused")
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(readJournal(root, planSHA256).filter(e => e.worker === worker && e.action === "restore-previews").map(e => e.event)).toEqual(["authorized", "intent"])
  const priorMutations = fake.mutations.length
  const retry = await restoreAll(root, planSHA256)
  expect(retry.find(r => r.worker === worker)).toEqual({ worker, outcome: "refused", code: "CF_RESTORE_PREVIEWS_UNCERTAIN" })
  expect(fake.workers.get(worker)!.subdomain.previews_enabled).toBe(false)
  expect(fake.mutations.slice(priorMutations)).not.toContain(`subdomain ${worker}`)
})

test("partial fence is journaled and restore rolls back only owned versions, never a foreign one", async () => {
  const { root, planSHA256, plan, originals, fake } = await setup()
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  const fences = plan.sequence.filter(s => s.action === "fence").map(s => s.worker)
  fake.failPut.add(fences[4]!)
  await expect(applyPhase(root, planSHA256, "fence")).rejects.toThrow("CF_INSTALL_UPLOAD_FAILED")
  expect(readJournal(root, planSHA256).filter(e => e.action === "fence" && e.event === "verified").map(e => e.worker)).toEqual(fences.slice(0, 4))
  const foreign = fake.foreignDeploy(fences[1]!)
  const results = await restoreAll(root, planSHA256)
  expect(results.find(r => r.worker === fences[1])).toEqual({ worker: fences[1]!, outcome: "refused", code: "CF_RESTORE_FOREIGN_VERSION" })
  expect(fake.live(fences[1]!).id).toBe(foreign)
  expect(results.find(r => r.worker === fences[4])!.outcome).toBe("restored") // preview-only rollback
  for (const w of [fences[0]!, fences[2]!, fences[3]!, "smithers-cloud-billing", "smithers-cloud-chat-canary"]) expect(fake.live(w).id).toBe(originals[w]!)
  expect(fake.mutations.filter(m => m === `rollback ${fences[1]}`)).toEqual([])
  const mutations = [...fake.mutations], journal = readJournal(root, planSHA256)
  await expect(applyPhase(root, planSHA256, "fence")).rejects.toThrow("CF_INSTALL_RECOVERY_STARTED")
  expect(fake.mutations).toEqual(mutations)
  expect(readJournal(root, planSHA256)).toEqual(journal)
})

test("a lost upload response adopts only the version carrying this execution's annotation", async () => {
  const { root, planSHA256, fake } = await setup()
  hook(root)
  fake.losePutResponse.add("smithers-cloud-chat-canary")
  await applyPhase(root, planSHA256, "admission")
  const events = readJournal(root, planSHA256).filter(e => e.worker === "smithers-cloud-chat-canary" && e.action === "admission").map(e => e.event)
  expect(events).toEqual(["authorized", "intent", "adopted", "verified"])
})

test("a tampered plan artifact or a concurrent operator is refused", async () => {
  const { root, planSHA256, plan } = await setup()
  hook(root)
  writeFileSync(join(root, "install.lock"), "{}", { mode: 0o600 })
  await expect(applyPhase(root, planSHA256, "admission")).rejects.toThrow("CF_INSTALL_LOCKED")
  rmSync(join(root, "install.lock"))
  const entry = join(root, plan.workers[0]!.fence.entry.path)
  writeFileSync(entry, readFileSync(entry, "utf8") + "\n// edited")
  expect(() => loadPlan(root, planSHA256)).toThrow("CF_FENCE_ARTIFACT_DIGEST_MISMATCH")
})

test("isolated rehearsal: every production binding type round-trips through admission and fence, then restores exactly; production names are refused", async () => {
  const { root, fake } = await setup()
  const scratch = "smithers-cutover-rehearsal-t1"
  fake.addRehearsal(scratch)
  const original = fake.live(scratch)
  await expect(prepareInstall(root, { rehearsalWorker: "smithers-cloud-billing" })).rejects.toThrow("CF_INSTALL_REHEARSAL_TARGET_INVALID")
  const { planSHA256, plan } = await prepareInstall(root, { rehearsalWorker: scratch })
  expect(plan.scope).toBe("rehearsal")
  expect(plan.sequence.map(s => `${s.action}:${s.worker}`)).toEqual([`previews-off:${scratch}`, `admission:${scratch}`, `fence:${scratch}`])
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  const byName = (bindings: Array<Record<string, unknown>>) => [...bindings].sort((a, b) => String(a.name).localeCompare(String(b.name)))
  expect(byName(fake.live(scratch).bindings)).toEqual(byName(original.bindings))
  expect(fake.live(scratch).secrets.REHEARSAL_SECRET).toBe("rehearsal-secret-value")
  await applyPhase(root, planSHA256, "fence")
  expect(byName(fake.live(scratch).bindings)).toEqual(byName(original.bindings))
  expect(existsSync(join(root, `${scratch}.plan.json`))).toBe(false) // rehearsal never feeds production collection
  expect(fake.mutations.every(m => m.endsWith(scratch))).toBe(true) // no production authority touched
  expect((await restoreAll(root, planSHA256)).map(r => r.outcome)).toEqual(["restored"])
  expect(fake.live(scratch).id).toBe(original.id)
  // As on the live provider: the rollback leaves the fence as the newest upload, and restore still proves the original.
  expect(fake.latest(scratch).entry).toBe("cutover-fence-entry.js")
  expect(fake.workers.get(scratch)!.subdomain.previews_enabled).toBe(true)
  expect(await installStatus(root, planSHA256)).toEqual([{ worker: scratch, state: "original", liveVersion: original.id }])
})

test("prepare refuses when the newest upload is not the deployed version: script-level settings and content would describe the wrong version", async () => {
  const { root, fake } = await setup()
  const scratch = "smithers-cutover-rehearsal-t2"
  fake.addRehearsal(scratch).uploadOnly(scratch)
  await expect(prepareInstall(root, { rehearsalWorker: scratch })).rejects.toThrow("CF_INSTALL_LATEST_NOT_DEPLOYED")
})

test("fence collection refuses an undeployed upload before treating script content as serving evidence", async () => {
  const { root, expected, planSHA256, fake } = await setup()
  hook(root)
  await applyPhase(root, planSHA256, "admission")
  await applyPhase(root, planSHA256, "fence")
  const worker = CLOUDFLARE_PRODUCERS[0]!
  const deployed = fake.live(worker).id
  fake.uploadOnly(worker)
  expect(fake.live(worker).id).toBe(deployed)
  expect(fake.latest(worker).id).not.toBe(deployed)
  await expect(collectCloudflareFence({ ...expected, privateDirectory: root })).rejects.toThrow("CF_FENCE_CONTENT_NOT_DEPLOYED")
})

test("a KV-backed Durable Object class is refused: the alarm marker needs SQLite", async () => {
  const root = mkdtempSync(join(tmpdir(), "cutover-install-kv-")); roots.push(root); chmodSync(root, 0o700)
  const executionID = randomUUID()
  writeFileSync(join(root, "expected.json"), JSON.stringify({ executionID, smithersRevision: "a".repeat(40), plueRevision: "b".repeat(40), endpoint: "https://api.jjhub.tech" }), { mode: 0o600 })
  writeFileSync(join(root, "recipient.json"), JSON.stringify({ migrationId: executionID, privateJwk, token: TOKEN, expiresAt: new Date(Date.now() + 6 * 3_600_000).toISOString() }), { mode: 0o600 })
  fake = new FakeCloudflare({}, ["RecoDurableObject"]).install()
  await expect(prepareInstall(root)).rejects.toThrow("CF_INSTALL_KV_BACKED_OBJECT")
})
