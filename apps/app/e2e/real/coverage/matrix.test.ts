import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { RuntimeCapabilitySchema } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import {
  canonicalSHA256,
  FEATURE_MATRIX,
  FEATURE_MATRIX_VERSION,
  featureMatrixSHA256,
  featureReceipts,
  coreFeatures,
  MANDATORY_DETERMINISTIC_BUN_TESTS,
  MANDATORY_DETERMINISTIC_BROWSER_SPECS,
  MATRIX_OBLIGATIONS,
  MATRIX_SCENARIO_IDS,
  applicableScenarioIds,
  MODE_DESCRIPTORS,
  missingModeReadiness,
  matrixPasses,
  matrixVerdict,
  owedScenarioIds,
  parseMatrixConfig,
  probeMode,
  readExecutionReceipt,
  scenarioReceipts,
  selectMatrixModes,
  validateExecutionReceipt
} from "./matrix"
import { checkRealE2E } from "./gate"
import { DEPLOYMENT_MODES } from "./types"
import type { ProcessRole } from "./matrix"

const roots: string[] = []
const revision = "a".repeat(40)
const deployed = "b".repeat(40)
const receipt = (mode: (typeof DEPLOYMENT_MODES)[number], startedRoles: readonly ProcessRole[], receiptRevision = revision) => ({
  mode,
  revision: receiptRevision,
  origin: "https://example.test", endpoint: "https://example.test",
  ready: true,
  startedRoles,
  freshLaunch: true,
  restarted: MODE_DESCRIPTORS[mode].requiresPersistentRestart,
  dataPreserved: MODE_DESCRIPTORS[mode].requiresPersistentRestart,
  ...(MODE_DESCRIPTORS[mode].requiresPersistentRestart ? {
    persistenceProof: {
      database: { before: "database-marker", after: "database-marker" },
      dataVolume: { before: "volume-marker", after: "volume-marker" }
    }
  } : {}),
  observedAt: "2026-09-21T00:00:00.000Z"
})

afterEach(() => { while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true }) })

/** A bootstrap exactly as the Worker builds it: from the one capability table, never a hand-written list. */
const cloudBootstrap = (buildSha: string, overrides: { readonly terminal?: boolean; readonly authFlow?: string } = {}) => ({
  apiVersion: 1, host: "cloud", version: "test", buildSha,
  capabilities: cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: overrides.terminal ?? true }),
  authFlow: overrides.authFlow ?? "native-handoff", sandbox: null
})

/** Serves a bootstrap and records every path readiness asked for. The health route answers only when told to. */
const recordingOrigin = (bootstrap: unknown, health?: number) => {
  const paths: string[] = []
  const fetcher = async (input: string | URL | Request) => {
    const { pathname } = new URL(String(input))
    paths.push(pathname)
    if (pathname === "/api/bootstrap") return Response.json(bootstrap)
    if (pathname === "/api/health" && health !== undefined) return new Response("health", { status: health })
    return Response.json({ code: "route_not_found" }, { status: 404 })
  }
  return { paths, fetcher }
}

const writeReceipt = (value: unknown): string => {
  const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
  roots.push(root)
  const path = join(root, "receipt.json")
  writeFileSync(path, JSON.stringify(value))
  return path
}

describe("deployment mode matrix", () => {
  test("bootstrap identity includes complete configuration and ignores only object key order", () => {
    const body = { buildSha: deployed, capabilities: ["identity", "cloud"], sandbox: { mode: "remote", ready: true } }
    expect(canonicalSHA256(body)).toBe(canonicalSHA256({ sandbox: { ready: true, mode: "remote" }, capabilities: body.capabilities, buildSha: deployed }))
    expect(canonicalSHA256(body)).not.toBe(canonicalSHA256({ ...body, sandbox: { mode: "remote", ready: false } }))
    expect(canonicalSHA256(body)).not.toBe(canonicalSHA256({ ...body, capabilities: [...body.capabilities].reverse() }))
    expect(() => canonicalSHA256({ value: undefined })).toThrow("JSON value")
  })

  test("enumerates four modes over one obligation catalog", () => {
    expect(Object.keys(MODE_DESCRIPTORS)).toEqual([...DEPLOYMENT_MODES])
    expect(MATRIX_OBLIGATIONS.length).toBeGreaterThan(10)
    expect(new Set(MATRIX_OBLIGATIONS.map(({ id }) => id)).size).toBe(MATRIX_OBLIGATIONS.length)
    expect(DEPLOYMENT_MODES.map((mode) => [mode, MODE_DESCRIPTORS[mode].legacyHost])).toEqual([
      ["web-selfhost", "local"], ["web-plue", "production"],
      ["local-own", "local"], ["local-plue", "production"],
    ])
  })

  test("every implemented matrix scenario resolves to the canonical real suite", () => {
    const report = checkRealE2E({
      realDir: resolve(import.meta.dir, ".."),
      flowNameFile: resolve(import.meta.dir, "../../../src/mainview/flows/FlowName.ts")
    })
    const declared = new Set(report.scenarios.map(({ id }) => id))
    expect(MATRIX_SCENARIO_IDS.filter((id) => !declared.has(id))).toEqual([])
    expect(MATRIX_OBLIGATIONS.filter(({ scenarios }) => scenarios.length === 0).map(({ id }) => id)).toEqual([])
  }, 30_000)

  test("GitHub import runs only when the host advertises its configured integration", () => {
    const owned = applicableScenarioIds(["identity", "agent", "model.turn", "cloud", "cloud.terminal"])
    expect(owned).toContain("repositories.local-git-push-file-readback")
    expect(owned).not.toContain("repositories.github-import-direct-readback")
    expect(applicableScenarioIds(["identity", "github"])).toContain("repositories.github-import-direct-readback")
  })

  test("a Plue mode owes GitHub import and fails it while its host does not advertise github", () => {
    const readiness = { mode: "web-plue" as const, status: "passed" as const, tier: "plue-production" as const, origin: "https://example.test", endpoint: "https://example.test",
      capabilities: cloudBootstrap(deployed).capabilities, buildSha: deployed, reasons: [] }
    expect(featureReceipts(readiness).filter(({ status }) => status !== "passed")).toEqual([
      { mode: "web-plue", capability: "github", status: "failed", reason: "core feature github is disabled" }
    ])
    expect(scenarioReceipts(readiness, revision, []).find(({ obligation }) => obligation === "github-import")).toMatchObject({
      status: "unavailable", reason: "no executed receipt"
    })
    const ready = MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios)
      .map(({ id }) => ({ scenarioId: id, host: "production" as const, mode: "web-plue" as const, revision, buildSha: deployed,
        status: "passed" as const, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }))
    const rows = scenarioReceipts(readiness, revision, ready)
    expect(rows.filter(({ status }) => status !== "passed")).toEqual([])
    expect(matrixPasses([readiness], rows, true, ["web-plue"])).toBe(false)
  })

  test("every obligation is owed by some mode, and a mode reports exactly the scenarios it owes", () => {
    const owed = new Set(DEPLOYMENT_MODES.flatMap((mode) => owedScenarioIds(mode)))
    expect(MATRIX_SCENARIO_IDS.filter((id) => !owed.has(id))).toEqual([])
    expect(owedScenarioIds("web-plue")).toContain("repositories.github-import-direct-readback")
    expect(owedScenarioIds("web-plue")).not.toContain("chat.owner-model")
    expect(owedScenarioIds("local-own")).toContain("chat.owner-model")
    expect(owedScenarioIds("local-own")).not.toContain("repositories.github-import-direct-readback")
    for (const mode of DEPLOYMENT_MODES) {
      const rows = scenarioReceipts({ ...missingModeReadiness(mode, "ready"), status: "passed" }, revision, [])
      expect(rows.map(({ scenarioId }) => scenarioId)).toEqual([...owedScenarioIds(mode)])
    }
  })

  test("the self-hosting release journey is a matrix obligation (#1668)", () => {
    const ids = MATRIX_OBLIGATIONS.map(({ id }) => id)
    for (const id of ["approval", "duplicate-input", "error-surfaced"]) expect(ids).toContain(id)
    expect(MATRIX_OBLIGATIONS.find(({ id }) => id === "approval")?.scenarios.map(({ id }) => id))
      .toEqual(["approvals.product-approve", "approvals.product-deny"])
    for (const mode of DEPLOYMENT_MODES) {
      expect(owedScenarioIds(mode)).toEqual(expect.arrayContaining([
        "approvals.product-approve", "approvals.product-deny",
        "issues.owner-resolution-durable-replay", "flows.product-no-box"
      ]))
    }
  })

  test("the published feature matrix classifies every runtime capability for both providers (#1668)", () => {
    expect(Object.keys(FEATURE_MATRIX).sort()).toEqual([...RuntimeCapabilitySchema.options].sort())
    for (const [capability, providers] of Object.entries(FEATURE_MATRIX)) {
      expect(Object.keys(providers).sort(), capability).toEqual(["plue", "selfhost"])
      for (const row of Object.values(providers)) {
        expect(["core", "optional", "absent"], capability).toContain(row.support)
        if (row.support !== "core") expect(row.reason.trim(), capability).not.toBe("")
      }
    }
    // Every published version keeps its digest. A row change bumps FEATURE_MATRIX_VERSION and appends a digest.
    const published = [
      "73c9cf348cc84c9dbd7ef927e3c1f3040e3636d1b6b8be9531aeaf580129a2e4",
      "42a406f582e43f1022b4c8d790961d6d978bf603f89c1c62ce7479a7668b9d68",
      "609193c0daf3143e80a21a1fa4c28f51e6a7b4a5c8f9cee2e5faf780dbdbd356"
    ]
    expect(published).toHaveLength(FEATURE_MATRIX_VERSION)
    expect(new Set(published).size).toBe(published.length)
    expect(published.at(-1)).toBe(featureMatrixSHA256())
  })

  test("the README publishes the same feature matrix", () => {
    const readme = readFileSync(resolve(import.meta.dir, "README.md"), "utf8")
    const published = [...readme.matchAll(/^\| `([a-z.]+)` \| (core|optional|absent) \| (core|optional|absent) \|/gm)]
      .map(([, capability, selfhost, plue]) => [capability, selfhost, plue])
    expect(published).toEqual(Object.entries(FEATURE_MATRIX).map(([capability, { selfhost, plue }]) => [capability, selfhost.support, plue.support]))
    expect(readme).toContain(`Feature matrix version ${FEATURE_MATRIX_VERSION}`)
  })

  test("command selection remains optional when either host's recommendation provider is configured or absent (#3326)", async () => {
    const modes: readonly ("local-own" | "web-plue")[] = ["local-own", "web-plue"]
    const recommendationSettings: readonly (boolean | undefined)[] = [undefined, false, true]
    for (const mode of modes) {
      const descriptor = MODE_DESCRIPTORS[mode]
      expect(FEATURE_MATRIX["commands.select"][descriptor.provider]).toEqual({
        support: "optional", reason: "needs a recommendation provider"
      })
      expect(coreFeatures(mode)).not.toContain("commands.select")
      const buildSha = mode === "web-plue" ? deployed : revision
      const config = parseMatrixConfig({ revision, modes: [{
        mode, origin: "https://example.test", endpoint: "https://example.test",
        auth: { kind: mode === "web-plue" ? "browser-profile" : "owner-session", environment: "AUTH" },
        executionReceipt: writeReceipt(receipt(mode, descriptor.requiredProcessRoles, buildSha))
      }] }).modes[0]!
      const digests: string[] = []
      for (const recommend of recommendationSettings) {
        const bootstrap = {
          apiVersion: 1, host: mode === "web-plue" ? "cloud" : "local", version: "test", buildSha,
          capabilities: mode === "web-plue"
            ? cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: false, terminal: true, ...(recommend === undefined ? {} : { recommend }) })
            : localCapabilities({ identity: true, cloud: true, agent: true, ...(recommend === undefined ? {} : { recommend }) }),
          authFlow: mode === "web-plue" ? "native-handoff" : "credentials", sandbox: null
        }
        // Controlled HTTP responses qualify the local contract, not a deployed provider.
        const origin = recordingOrigin(bootstrap, 200)
        const readiness = await probeMode(config, revision, { AUTH: "configured" }, origin.fetcher)
        expect(readiness.status).toBe("passed")
        expect(readiness.capabilities.includes("commands.select")).toBe(recommend === true)
        expect(readiness.capabilities.includes("recommend")).toBe(recommend === true)
        expect(readiness.bootstrapSHA256).toBe(canonicalSHA256(bootstrap))
        expect(featureReceipts(readiness).some(({ capability }) => capability === "commands.select")).toBe(false)
        expect(origin.paths).toEqual(mode === "web-plue" ? ["/api/bootstrap"] : ["/api/bootstrap", "/api/health"])
        digests.push(canonicalSHA256(bootstrap))
      }
      expect(digests[0]).toBe(digests[1])
      expect(digests[2]).not.toBe(digests[0])
    }
  })

  test("every core feature is exercised by a scenario each of its modes owes, so a stub cannot stand in for it", () => {
    for (const mode of DEPLOYMENT_MODES) {
      const owed = MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios).filter(({ id }) => owedScenarioIds(mode).includes(id))
      const exercised = new Set(owed.flatMap(({ capabilities }) => capabilities))
      expect(coreFeatures(mode).filter((capability) => !exercised.has(capability)), mode).toEqual([])
    }
  })

  test("the shared Go backend can advertise every core feature of both providers", () => {
    const source = readFileSync(resolve(import.meta.dir, "../../../../../packages/backend/internal/compose/bootstrap.go"), "utf8")
    const advertised = new Set([...source.matchAll(/append\(result\.Capabilities, "([a-z.]+)"\)/g)].map(([, capability]) => capability))
    expect(advertised.size).toBeGreaterThan(5)
    for (const mode of DEPLOYMENT_MODES) expect(coreFeatures(mode).filter((capability) => !advertised.has(capability)), mode).toEqual([])
  })

  test("a disabled core feature fails the release gate even when every other row passed", () => {
    const passing = (capabilities: readonly string[]) => ({ mode: "web-plue" as const, status: "passed" as const, tier: "plue-production" as const,
      origin: "https://example.test", endpoint: "https://example.test", capabilities, buildSha: deployed, reasons: [] })
    const runs = owedScenarioIds("web-plue").map((scenarioId) => ({ scenarioId, host: "production" as const, mode: "web-plue" as const, revision,
      buildSha: deployed, status: "passed" as const, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }))
    const complete = passing(coreFeatures("web-plue"))
    expect(featureReceipts(complete).map(({ status }) => status)).toEqual(coreFeatures("web-plue").map(() => "passed"))
    expect(matrixPasses([complete], scenarioReceipts(complete, revision, runs), true, ["web-plue"])).toBe(true)

    const disabled = passing(coreFeatures("web-plue").filter((capability) => capability !== "cloud.terminal"))
    expect(featureReceipts(disabled).filter(({ status }) => status !== "passed")).toEqual([{
      mode: "web-plue", capability: "cloud.terminal", status: "failed", reason: "core feature cloud.terminal is disabled"
    }])
    expect(matrixPasses([disabled], scenarioReceipts(disabled, revision, runs), true, ["web-plue"])).toBe(false)

    const unconfigured = missingModeReadiness("web-plue", "not configured")
    expect(featureReceipts(unconfigured).map(({ status, reason }) => [status, reason]))
      .toEqual(coreFeatures("web-plue").map(() => ["not-configured", "readiness not-configured"]))
  })

  test("a scenario both providers owe declares both hosts, and the catalog repeats each spec's capabilities", () => {
    const report = checkRealE2E({
      realDir: resolve(import.meta.dir, ".."),
      flowNameFile: resolve(import.meta.dir, "../../../src/mainview/flows/FlowName.ts")
    })
    const hosts = new Map(report.scenarios.map(({ id, coverage }) => [id, coverage.filter((token) => token.startsWith("host:"))]))
    const selfhost = new Set(owedScenarioIds("web-selfhost"))
    const shared = owedScenarioIds("web-plue").filter((id) => selfhost.has(id))
    expect(shared.length).toBeGreaterThan(10)
    expect(shared.filter((id) => !hosts.get(id)?.includes("host:local") || !hosts.get(id)?.includes("host:production"))).toEqual([])
    const declared = new Map(report.scenarios.map(({ id, capabilities }) => [id, [...capabilities].sort()]))
    expect(MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios)
      .filter(({ id, capabilities }) => JSON.stringify([...capabilities].sort()) !== JSON.stringify(declared.get(id)))
      .map(({ id }) => id)).toEqual([])
  }, 30_000)

  test("every owed scenario runs in the signed-in fixture a mode's credential reaches", () => {
    const report = checkRealE2E({
      realDir: resolve(import.meta.dir, ".."),
      flowNameFile: resolve(import.meta.dir, "../../../src/mainview/flows/FlowName.ts")
    })
    const files = new Map(report.scenarios.map(({ id, file }) => [id, file]))
    const fixture = (id: string): string | undefined => {
      const source = readFileSync(files.get(id)!, "utf8")
      const declaration = source.slice(0, source.indexOf(`scenario("${id}"`))
      return [...declaration.matchAll(/^\s*(\w+)(?:\.\w+)?\(/gm)].at(-1)?.[1]
    }
    expect(MATRIX_SCENARIO_IDS.map((id) => [id, fixture(id)]).filter(([, name]) => name !== "authenticatedTest")).toEqual([])
  }, 30_000)

  test("parses credential-free origins and secret references without requiring every mode", () => {
    expect(parseMatrixConfig({
      revision,
      modes: [{
        mode: "local-own",
        origin: "https://example.test", endpoint: "https://example.test",
        auth: { kind: "owner-session", environment: "SMITHERS_OWNER_SESSION" },
        executionReceipt: "/tmp/native-own.json"
      }]
    }).modes[0]).toEqual({
      mode: "local-own",
      origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "owner-session", environment: "SMITHERS_OWNER_SESSION" },
      executionReceipt: "/tmp/native-own.json"
    })
    expect(() => parseMatrixConfig({ revision, modes: [{
      mode: "web-plue", origin: "https://secret@example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: "x"
    }] })).toThrow("credential-free")
  })

  test("requires the selected endpoint and binds the launcher to it", () => {
    const config = { mode: "local-plue", origin: "http://127.0.0.1:5173", endpoint: "https://example.test", auth: { kind: "application-token", environment: "TOKEN" }, executionReceipt: "x" }
    expect(() => parseMatrixConfig({ revision, modes: [{ ...config, endpoint: undefined }] })).toThrow()
    expect(() => parseMatrixConfig({ revision, modes: [{ ...config, endpoint: "https://secret@example.test" }] })).toThrow("credential-free")
    const parsed = parseMatrixConfig({ revision, modes: [config] }).modes[0]!
    expect(validateExecutionReceipt(parsed, revision, { ...receipt("local-plue", ["local-ui"]), origin: config.origin })).toEqual([])
    expect(validateExecutionReceipt(parsed, revision, { ...receipt("local-plue", ["local-ui"]), origin: config.origin, endpoint: "https://foreign.test" })).toContain("launcher endpoint differs from selected backend")
  })

  test("reports unlaunched own modes as failed, never passed", () => {
    const readiness = { ...missingModeReadiness("web-selfhost", "not launched"), origin: "https://example.test" }
    const rows = scenarioReceipts(readiness, revision, [])
    expect(rows.every(({ status }) => status === "failed")).toBe(true)
    expect(rows.find(({ obligation }) => obligation === "flow")?.reason).toBe("not launched")
    expect(rows.find(({ obligation }) => obligation === "chat")?.reason).toBe("not launched")
  })

  test("a failed attempt prevents a later pass from satisfying an obligation", () => {
    const readiness = { mode: "local-own" as const, status: "passed" as const, tier: "local-infrastructure" as const, origin: "https://example.test", endpoint: "https://example.test", capabilities: ["identity", "model.turn"], reasons: [] }
    const base = { scenarioId: "chat.owner-model", host: "local" as const, mode: "local-own" as const, revision, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }
    const rows = scenarioReceipts(readiness, revision, [{ ...base, status: "failed" as const }, { ...base, status: "passed" as const }])
    expect(rows.find(({ scenarioId }) => scenarioId === "chat.owner-model")?.status).toBe("failed")
  })

  test("readiness joins a real execution receipt with health and advertised capabilities", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const { fetcher } = recordingOrigin(cloudBootstrap(deployed))
    expect(await probeMode(config, revision, { PROFILE: "configured" }, fetcher)).toMatchObject({ status: "passed", bootstrapSHA256: canonicalSHA256(cloudBootstrap(deployed)) })
  })

  test.each(["web-plue", "local-plue"] as const)("%s rejects a local Bun API surface", async (mode) => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt(mode, MODE_DESCRIPTORS[mode].requiredProcessRoles, mode === "web-plue" ? deployed : revision)))
    const config = parseMatrixConfig({ revision, modes: [{
      mode, origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path,
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured", NATIVE_DRIVER: "configured" }, async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: "b".repeat(40),
      capabilities: [], authFlow: "redirect", sandbox: null
    }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toEqual([`bootstrap host local does not match ${mode} provider plue`])
  })

  test("an owner session cannot enter readiness without an owner-credentials bootstrap contract", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-own", ["local-ui", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-own", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const fetcher = (async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: revision,
      capabilities: [], authFlow: "none", sandbox: null
    }))
    const result = await probeMode(config, revision, { OWNER: "configured" }, fetcher)
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("bootstrap authFlow none does not advertise owner credentials")
  })

  test("rejects invented launcher roles", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify({ ...receipt("local-own", ["local-ui", "app", "postgres"]), startedRoles: ["local-ui", "magic"] }))
    expect(() => readExecutionReceipt(path)).toThrow("malformed execution receipt")
  })

  test("a core feature the bootstrap omits fails its feature row and filters its scenario", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, recordingOrigin(cloudBootstrap(deployed, { terminal: false })).fetcher)
    expect(applicableScenarioIds(result.capabilities)).not.toContain("workspaces.product-terminal-keyboard-output")
    const runs = applicableScenarioIds(result.capabilities).map((scenarioId) => ({ scenarioId, host: "production" as const, mode: "local-plue" as const,
      revision, buildSha: deployed, status: "passed" as const, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }))
    const rows = scenarioReceipts(result, revision, runs)
    expect(rows.find(({ obligation }) => obligation === "terminal")).toMatchObject({ status: "unavailable", reason: "no executed receipt" })
    expect(featureReceipts(result).find(({ capability }) => capability === "cloud.terminal")).toMatchObject({ status: "failed", reason: "core feature cloud.terminal is disabled" })
    expect(matrixPasses([result], rows, true, ["local-plue"])).toBe(false)
  })

  test("two passing own modes cannot accept a all-modes run with two unconfigured Plue modes", () => {
    const readiness = DEPLOYMENT_MODES.map((mode) => mode.endsWith("-plue")
      ? missingModeReadiness(mode, "not configured")
      : { ...missingModeReadiness(mode, "ready"), status: "passed" as const,
          capabilities: ["identity", "agent", "model.turn", "cloud", "cloud.terminal"] })
    expect(readiness.filter(({ status }) => status === "not-configured")).toHaveLength(2)
    const runs = readiness.filter(({ status }) => status === "passed").flatMap((state) =>
      applicableScenarioIds(state.capabilities).map((scenarioId) => ({
        mode: state.mode, scenarioId, host: MODE_DESCRIPTORS[state.mode].legacyHost,
        status: "passed" as const, revision,
        startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z"
      })))
    const rows = readiness.flatMap((state) => scenarioReceipts(state, revision, runs))
    expect(rows.filter(({ status }) => status === "not-configured")).toHaveLength(
      DEPLOYMENT_MODES.filter((mode) => mode.endsWith("-plue")).reduce((count, mode) => count + owedScenarioIds(mode).length, 0))
    expect(matrixPasses(readiness, rows, true)).toBe(false)
    expect(matrixPasses(readiness, rows, true, DEPLOYMENT_MODES, [
      { tier: "deterministic", status: "passed", exitCode: 0 },
      { tier: "local-infrastructure", status: "failed", exitCode: 1 }
    ])).toBe(false)
    expect(matrixPasses(readiness, rows.slice(1), true)).toBe(false)

    const own = selectMatrixModes("own-only")
    expect(own).toEqual({ modes: ["web-selfhost", "local-own"], scope: "partial" })
    const ownReadiness = readiness.filter(({ mode }) => own.modes.includes(mode))
    const ownRows = rows.filter(({ mode }) => own.modes.includes(mode))
    expect(matrixVerdict(own, ownReadiness, ownRows, true)).toEqual({
      ok: true, scope: "partial", modes: own.modes, allModesAccepted: false
    })
    expect(matrixVerdict(selectMatrixModes(), readiness, rows, true).allModesAccepted).toBe(false)
  })

  test("all-modes acceptance needs an executed receipt for every owed scenario", () => {
    const selection = selectMatrixModes()
    const readiness = selection.modes.map((mode) => ({
      mode, status: "passed" as const,
      tier: MODE_DESCRIPTORS[mode].provider === "plue" ? "plue-production" as const : "local-infrastructure" as const,
      capabilities: ["identity", "agent", "model.turn", "cloud", "cloud.terminal", "github"], reasons: []
    }))
    const runs = readiness.flatMap((state) => applicableScenarioIds(state.capabilities).map((scenarioId) => ({
      mode: state.mode, scenarioId, host: MODE_DESCRIPTORS[state.mode].legacyHost,
      status: "passed" as const, revision,
      startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z"
    })))
    const receipts = readiness.flatMap((state) => scenarioReceipts(state, revision, runs))
    expect(matrixVerdict(selection, readiness, receipts, true)).toEqual({
      ok: true, scope: "all-modes", modes: DEPLOYMENT_MODES, allModesAccepted: true
    })
    const missing = readiness.flatMap((state) => scenarioReceipts(state, revision,
      runs.filter((run) => run.mode !== "local-plue" || run.scenarioId !== "flows.product-run")))
    expect(matrixVerdict(selection, readiness, missing, true).allModesAccepted).toBe(false)
  })

  test("owed scenarios come from the feature matrix, so a Plue host never owes model.turn", () => {
    const owedCapabilities = (mode: (typeof DEPLOYMENT_MODES)[number]) => [...new Set(MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios)
      .filter(({ id }) => owedScenarioIds(mode).includes(id)).flatMap(({ capabilities }) => capabilities))].sort()
    expect(owedCapabilities("web-plue")).toEqual(["cloud", "cloud.terminal", "github", "identity"])
        expect(owedCapabilities("web-selfhost")).toEqual(["cloud", "cloud.terminal", "identity", "model.turn"])
  })

  test("web-plue readiness certifies the deployed Worker build without a health route or the checkout revision", async () => {
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "web-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" },
      executionReceipt: writeReceipt(receipt("web-plue", ["web"], deployed))
    }] }).modes[0]!
    const origin = recordingOrigin(cloudBootstrap(deployed))
    const result = await probeMode(config, revision, { PROFILE: "configured" }, origin.fetcher)
    expect(result.reasons).toEqual([])
    expect(result.status).toBe("passed")
    expect(result.buildSha).toBe(deployed)
    expect(origin.paths).toEqual(["/api/bootstrap"])
  })

  test("a web-plue receipt must name the deployed build it observed", async () => {
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "web-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" },
      executionReceipt: writeReceipt(receipt("web-plue", ["web"], revision))
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, recordingOrigin(cloudBootstrap(deployed)).fetcher)
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain(`receipt revision ${revision} does not match ${deployed}`)
  })

  test("Plue readiness refuses a deployment with no sign-in door or no exact build", async () => {
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "web-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" },
      executionReceipt: writeReceipt(receipt("web-plue", ["web"], deployed))
    }] }).modes[0]!
    const closed = await probeMode(config, revision, { PROFILE: "configured" }, recordingOrigin(cloudBootstrap(deployed, { authFlow: "none" })).fetcher)
    expect(closed.reasons).toContain("bootstrap authFlow none offers no sign-in")
    const unstamped = await probeMode(config, revision, { PROFILE: "configured" }, recordingOrigin(cloudBootstrap("dev")).fetcher)
    expect(unstamped.reasons).toContain("bootstrap buildSha dev is not an exact revision")
  })

  test("selfhost readiness still requires health and the checkout build", async () => {
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-own", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" },
      executionReceipt: writeReceipt(receipt("local-own", ["local-ui", "app", "postgres"]))
    }] }).modes[0]!
    const bootstrap = (buildSha: string) => ({
      apiVersion: 1, host: "local", version: "test", buildSha,
      capabilities: localCapabilities({ identity: true, cloud: true, agent: true }), authFlow: "credentials", sandbox: null
    })
    const healthy = recordingOrigin(bootstrap(revision), 200)
    expect(await probeMode(config, revision, { OWNER: "configured" }, healthy.fetcher)).toMatchObject({ status: "passed", buildSha: revision, reasons: [] })
    expect(healthy.paths).toContain("/api/health")
    const stale = await probeMode(config, revision, { OWNER: "configured" }, recordingOrigin(bootstrap(deployed), 503).fetcher)
    expect(stale.reasons).toContain("health returned HTTP 503")
    expect(stale.reasons).toContain(`bootstrap revision ${deployed} does not match ${revision}`)
  })

  test.each(["web-selfhost", "local-own"] as const)("%s accepts the deployment-neutral Go bootstrap", async (mode) => {
    const descriptor = MODE_DESCRIPTORS[mode]
    const config = parseMatrixConfig({ revision, modes: [{
      mode, origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "owner-session", environment: "OWNER" },
      executionReceipt: writeReceipt(receipt(mode, descriptor.requiredProcessRoles)),
    }] }).modes[0]!
    // The shared Go backend's self-hosted response: cloud is the API surface, not its deployment provider.
    const bootstrap = {
      apiVersion: 1, host: "cloud", version: "test", buildSha: revision,
      capabilities: ["identity", "cloud", "cloud.terminal"], authFlow: "credentials",
      sandbox: { platform: "linux", mode: "trusted-only" }
    }
    const origin = recordingOrigin(bootstrap, 200)
    const result = await probeMode(config, revision, { OWNER: "configured", NATIVE_DRIVER: "configured" }, origin.fetcher)
    expect(result).toMatchObject({ status: "passed", tier: "local-infrastructure", buildSha: revision, reasons: [] })
    expect(result.capabilities).toEqual(bootstrap.capabilities)
    expect(result.bootstrapSHA256).toBe(canonicalSHA256(bootstrap))
    expect(origin.paths).toEqual(["/api/bootstrap", "/api/health"])

    const stale = await probeMode(config, revision, { OWNER: "configured", NATIVE_DRIVER: "configured" },
      recordingOrigin({ ...bootstrap, buildSha: deployed }, 503).fetcher)
    expect(stale.status).toBe("failed")
    expect(stale.reasons).toContain(`bootstrap revision ${deployed} does not match ${revision}`)
    expect(stale.reasons).toContain("health returned HTTP 503")

    writeFileSync(config.executionReceipt, JSON.stringify({ ...receipt(mode, []), endpoint: "https://another.test" }))
    const wrongLaunch = await probeMode(config, revision, { OWNER: "configured", NATIVE_DRIVER: "configured" }, origin.fetcher)
    expect(wrongLaunch.status).toBe("failed")
    expect(wrongLaunch.reasons).toContain("launcher endpoint differs from selected backend")
    for (const role of descriptor.requiredProcessRoles) expect(wrongLaunch.reasons).toContain(`launcher did not prove ${role} started`)
  })

  test("a Plue attempt against a different deployment fails its obligation", () => {
    const readiness = { mode: "web-plue" as const, status: "passed" as const, tier: "plue-production" as const, origin: "https://example.test", endpoint: "https://example.test",
      capabilities: ["identity", "cloud", "cloud.terminal"], buildSha: deployed, reasons: [] }
    const base = { scenarioId: "issues.product-create-readback", host: "production" as const, mode: "web-plue" as const, revision,
      startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z", status: "passed" as const }
    const find = (rows: ReturnType<typeof scenarioReceipts>) => rows.find(({ scenarioId }) => scenarioId === base.scenarioId)
    expect(find(scenarioReceipts(readiness, revision, [{ ...base, buildSha: deployed }]))?.status).toBe("passed")
    const moved = find(scenarioReceipts(readiness, revision, [{ ...base, buildSha: "c".repeat(40) }]))
    expect(moved?.status).toBe("failed")
    expect(moved?.reason).toBe(`deployment changed during the run: ${"c".repeat(40)} is not ${deployed}`)
  })

  test("runner partitions cover only their declared modes while the default still requires all four", () => {
    const ubuntu = ["web-selfhost", "web-plue", "local-own", "local-plue"] as const
    expect(new Set(ubuntu)).toEqual(new Set(DEPLOYMENT_MODES))
    const readiness = ubuntu.map((mode) => missingModeReadiness(mode, "not configured"))
    const rows = readiness.flatMap((state) => scenarioReceipts(state, revision, []))
    expect(matrixPasses(readiness, rows, true, ubuntu)).toBe(false)
    expect(matrixPasses(readiness, rows, true)).toBe(false)
    expect(matrixPasses(readiness, rows, true, ["web-selfhost", "web-selfhost"])).toBe(false)
  })
})


test("every mandatory deterministic suite names an executable file", () => {
  for (const file of [...MANDATORY_DETERMINISTIC_BUN_TESTS, ...MANDATORY_DETERMINISTIC_BROWSER_SPECS]) {
    expect(existsSync(resolve(import.meta.dirname, "../../..", file)), file).toBe(true)
  }
})
