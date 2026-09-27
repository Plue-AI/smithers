import { afterEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import {
  canonicalBootstrapSHA256,
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
const receipt = (mode: "local-own" | "local-plue" | "native-own" | "native-plue" | "web-plue", startedRoles: readonly ProcessRole[], receiptRevision = revision) => ({
  mode,
  revision: receiptRevision,
  origin: "https://example.test", endpoint: "https://example.test",
  ready: true,
  startedRoles,
  freshLaunch: true,
  restarted: mode.endsWith("-own"),
  dataPreserved: mode.endsWith("-own"),
  ...(mode.endsWith("-own") ? {
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
    expect(canonicalBootstrapSHA256(body)).toBe(canonicalBootstrapSHA256({ sandbox: { ready: true, mode: "remote" }, capabilities: body.capabilities, buildSha: deployed }))
    expect(canonicalBootstrapSHA256(body)).not.toBe(canonicalBootstrapSHA256({ ...body, sandbox: { mode: "remote", ready: false } }))
    expect(canonicalBootstrapSHA256(body)).not.toBe(canonicalBootstrapSHA256({ ...body, capabilities: [...body.capabilities].reverse() }))
    expect(() => canonicalBootstrapSHA256({ value: undefined })).toThrow("JSON response")
  })

  test("enumerates six modes over one obligation catalog", () => {
    expect(Object.keys(MODE_DESCRIPTORS)).toEqual([...DEPLOYMENT_MODES])
    expect(MATRIX_OBLIGATIONS.length).toBeGreaterThan(10)
    expect(new Set(MATRIX_OBLIGATIONS.map(({ id }) => id)).size).toBe(MATRIX_OBLIGATIONS.length)
    expect(DEPLOYMENT_MODES.map((mode) => [mode, MODE_DESCRIPTORS[mode].legacyHost])).toEqual([
      ["web-selfhost", "local"], ["web-plue", "production"],
      ["local-own", "local"], ["local-plue", "production"],
      ["native-own", "local"], ["native-plue", "production"]
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
    const rows = scenarioReceipts(readiness, revision, [])
    expect(rows.find(({ obligation }) => obligation === "github-import")).toMatchObject({
      status: "failed", reason: "bootstrap does not advertise github"
    })
    const ready = MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios)
      .filter(({ id }) => id !== "repositories.github-import-direct-readback")
      .map(({ id }) => ({ scenarioId: id, host: "production" as const, mode: "web-plue" as const, revision, buildSha: deployed,
        status: "passed" as const, startedAt: "2026-09-21T00:00:00Z", finishedAt: "2026-09-21T00:00:01Z" }))
    expect(matrixPasses([readiness], scenarioReceipts(readiness, revision, ready), true, ["web-plue"])).toBe(false)
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

  test("parses credential-free origins and secret references without requiring every mode", () => {
    expect(parseMatrixConfig({
      revision,
      modes: [{
        mode: "native-own",
        origin: "https://example.test", endpoint: "https://example.test",
        auth: { kind: "owner-session", environment: "SMITHERS_OWNER_SESSION" },
        executionReceipt: "/tmp/native-own.json"
      }]
    }).modes[0]).toEqual({
      mode: "native-own",
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

  test("requires native own supervision and proves remote native starts neither backend nor postgres", () => {
    const ownConfig = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: "x"
    }] }).modes[0]!
    expect(validateExecutionReceipt(ownConfig, revision, receipt("native-own", ["native-ui", "app", "postgres"]))).toContain("launcher did not prove supervisor started")
    expect(validateExecutionReceipt(ownConfig, revision, receipt("native-own", ["native-ui", "supervisor", "app", "postgres"]))).toEqual([])

    const remoteConfig = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: "x"
    }] }).modes[0]!
    expect(validateExecutionReceipt(remoteConfig, revision, receipt("native-plue", ["native-ui", "app"]))).toContain("remote mode unexpectedly started app")
    expect(validateExecutionReceipt(remoteConfig, revision, receipt("native-plue", ["native-ui"]))).toEqual([])
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
    expect(await probeMode(config, revision, { PROFILE: "configured" }, fetcher)).toMatchObject({ status: "passed", bootstrapSHA256: canonicalBootstrapSHA256(cloudBootstrap(deployed)) })
  })

  test("readiness rejects a bootstrap from the wrong provider or revision", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("local-plue", ["local-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "local-plue", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "browser-profile", environment: "PROFILE" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "configured" }, async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: "b".repeat(40),
      capabilities: [], authFlow: "redirect", sandbox: null
    }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("bootstrap host local does not match local-plue provider plue")
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

  test("native readiness remains unavailable without a packaged native driver envelope", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-own", ["native-ui", "supervisor", "app", "postgres"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-own", origin: "https://example.test", endpoint: "https://example.test", auth: { kind: "owner-session", environment: "OWNER" }, executionReceipt: path
    }] }).modes[0]!
    const result = await probeMode(config, revision, { OWNER: "configured" }, async () => Response.json({
      apiVersion: 1, host: "local", version: "test", buildSha: revision,
      capabilities: [], authFlow: "none", sandbox: null
    }))
    expect(result.status).toBe("failed")
    expect(result.reasons).toContain("native mode has no packaged Electrobun CDP driver configuration")
  })

  test("native readiness accepts only an explicit available driver reference", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-plue", ["native-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue",
      origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "application-token", environment: "PLUE_TOKEN" },
      executionReceipt: path,
      surfaceDriver: { kind: "electrobun-cdp", environment: "NATIVE_PLUE_DRIVER" }
    }] }).modes[0]!
    const { fetcher } = recordingOrigin(cloudBootstrap(deployed))
    expect((await probeMode(config, revision, { PLUE_TOKEN: "configured" }, fetcher)).reasons)
      .toContain("native driver environment NATIVE_PLUE_DRIVER is unavailable")
    expect((await probeMode(config, revision, {
      PLUE_TOKEN: "configured", NATIVE_PLUE_DRIVER: "configured"
    }, fetcher)).status).toBe("passed")
  })

  test("native auth follows the package handshake instead of a browser-profile substitute", async () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify(receipt("native-plue", ["native-ui"])))
    const config = parseMatrixConfig({ revision, modes: [{
      mode: "native-plue",
      origin: "https://example.test", endpoint: "https://example.test",
      auth: { kind: "browser-profile", environment: "PROFILE" },
      executionReceipt: path,
      surfaceDriver: { kind: "electrobun-cdp", environment: "NATIVE_DRIVER" }
    }] }).modes[0]!
    const result = await probeMode(config, revision, { PROFILE: "x", NATIVE_DRIVER: "x" }, async (input) =>
      new URL(String(input)).pathname === "/api/health" ? new Response("ok") : Response.json({
        apiVersion: 1, host: "cloud", version: "test", buildSha: revision,
        capabilities: [], authFlow: "both", sandbox: null
      }))
    expect(result.reasons).toContain("native-plue requires the packaged application-token flow")
  })

  test("rejects invented launcher roles", () => {
    const root = mkdtempSync(join(tmpdir(), "smithers-mode-matrix-"))
    roots.push(root)
    const path = join(root, "receipt.json")
    writeFileSync(path, JSON.stringify({ ...receipt("native-own", ["native-ui", "supervisor", "app", "postgres"]), startedRoles: ["native-ui", "magic"] }))
    expect(() => readExecutionReceipt(path)).toThrow("malformed execution receipt")
  })

  test("an owed capability the bootstrap omits fails its obligation and filters its scenario", async () => {
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
    expect(rows.find(({ obligation }) => obligation === "terminal")).toMatchObject({ status: "failed", reason: "bootstrap does not advertise cloud.terminal" })
    expect(matrixPasses([result], rows, true, ["local-plue"])).toBe(false)
  })

  test("three passing own modes cannot accept a six-mode run with three unconfigured Plue modes", () => {
    const readiness = DEPLOYMENT_MODES.map((mode) => mode.endsWith("-plue")
      ? missingModeReadiness(mode, "not configured")
      : { ...missingModeReadiness(mode, "ready"), status: "passed" as const,
          capabilities: ["identity", "agent", "model.turn", "cloud", "cloud.terminal"] })
    expect(readiness.filter(({ status }) => status === "not-configured")).toHaveLength(3)
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
    expect(own).toEqual({ modes: ["web-selfhost", "local-own", "native-own"], scope: "partial" })
    const ownReadiness = readiness.filter(({ mode }) => own.modes.includes(mode))
    const ownRows = rows.filter(({ mode }) => own.modes.includes(mode))
    expect(matrixVerdict(own, ownReadiness, ownRows, true)).toEqual({
      ok: true, scope: "partial", modes: own.modes, sixModeAccepted: false
    })
    expect(matrixVerdict(selectMatrixModes(), readiness, rows, true).sixModeAccepted).toBe(false)
  })

  test("six-mode acceptance needs an executed receipt for every owed scenario", () => {
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
      ok: true, scope: "six-mode", modes: DEPLOYMENT_MODES, sixModeAccepted: true
    })
    const missing = readiness.flatMap((state) => scenarioReceipts(state, revision,
      runs.filter((run) => run.mode !== "native-plue" || run.scenarioId !== "flows.product-run")))
    expect(matrixVerdict(selection, readiness, missing, true).sixModeAccepted).toBe(false)
  })

  test("owed scenarios come from the host tables, so a Plue host never owes model.turn", () => {
    const owedCapabilities = (mode: (typeof DEPLOYMENT_MODES)[number]) => [...new Set(MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios)
      .filter(({ id }) => owedScenarioIds(mode).includes(id)).flatMap(({ capabilities }) => capabilities))].sort()
    expect(owedCapabilities("web-plue")).toEqual(["cloud", "cloud.terminal", "github", "identity"])
    expect(owedCapabilities("native-plue")).toEqual(["cloud", "cloud.terminal", "github", "identity"])
    expect(owedCapabilities("web-selfhost")).toEqual(["cloud", "cloud.terminal", "identity", "model.turn"])
    const worker = cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true, browser: true })
    expect(owedCapabilities("web-plue").filter((capability) => !worker.includes(capability))).toEqual(["github"])
    const bun = localCapabilities({ identity: true, cloud: true, agent: true, browser: true })
    expect(owedCapabilities("local-own").every((capability) => bun.includes(capability))).toBe(true)
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

  test("runner partitions cover only their declared modes while the default still requires all six", () => {
    const ubuntu = ["web-selfhost", "web-plue", "local-own", "local-plue"] as const
    const mac = ["native-own", "native-plue"] as const
    expect(new Set([...ubuntu, ...mac])).toEqual(new Set(DEPLOYMENT_MODES))
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
