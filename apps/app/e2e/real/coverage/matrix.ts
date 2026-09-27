import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import type { RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { cloudCapabilities, localCapabilities } from "@smthrs/rpc/HostCapabilities"
import { DEPLOYMENT_MODES } from "./types"
import type { DeploymentMode, RealHost, RealScenarioRunEvidence } from "./types"

/** Digest the actual public bootstrap response, independent of JSON object key order. */
export const canonicalBootstrapSHA256 = (body: unknown): string => {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    throw new Error("Bootstrap digest requires a JSON response")
  }
  return createHash("sha256").update(canonical(body)).digest("hex")
}

export type MatrixTier = "deterministic" | "local-infrastructure" | "live-provider" | "plue-production"
export type MatrixStatus = "passed" | "failed" | "unavailable" | "not-configured"
export type ProductProvider = "selfhost" | "plue"
export type ProductSurface = "web" | "local" | "native"
export type ProcessRole = "web" | "local-ui" | "native-ui" | "supervisor" | "app" | "docker-app" | "postgres"
const PROCESS_ROLES: readonly ProcessRole[] = ["web", "local-ui", "native-ui", "supervisor", "app", "docker-app", "postgres"]

export interface ModeDescriptor {
  readonly id: DeploymentMode
  readonly surface: ProductSurface
  readonly provider: ProductProvider
  /** Existing scenario tag for the selected backend; surface proof stays in the execution receipt. */
  readonly legacyHost: RealHost
  readonly requiredProcessRoles: readonly ProcessRole[]
  readonly forbiddenProcessRoles: readonly ProcessRole[]
  readonly requiresPersistentRestart: boolean
}

interface MatrixScenario {
  readonly id: string
  readonly capabilities: readonly RuntimeCapability[]
}

interface MatrixObligation {
  readonly id: string
  readonly scenarios: readonly MatrixScenario[]
  readonly tier: MatrixTier
}

export const MODE_DESCRIPTORS: Readonly<Record<DeploymentMode, ModeDescriptor>> = {
  "web-selfhost": {
    id: "web-selfhost", surface: "web", provider: "selfhost", legacyHost: "local",
    requiredProcessRoles: ["docker-app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "web-plue": {
    id: "web-plue", surface: "web", provider: "plue", legacyHost: "production",
    requiredProcessRoles: ["web"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  },
  "local-own": {
    id: "local-own", surface: "local", provider: "selfhost", legacyHost: "local",
    requiredProcessRoles: ["local-ui", "app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "local-plue": {
    id: "local-plue", surface: "local", provider: "plue", legacyHost: "production",
    requiredProcessRoles: ["local-ui"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  },
  "native-own": {
    id: "native-own", surface: "native", provider: "selfhost", legacyHost: "local",
    requiredProcessRoles: ["native-ui", "supervisor", "app", "postgres"], forbiddenProcessRoles: [], requiresPersistentRestart: true
  },
  "native-plue": {
    id: "native-plue", surface: "native", provider: "plue", legacyHost: "production",
    requiredProcessRoles: ["native-ui"], forbiddenProcessRoles: ["app", "docker-app", "postgres", "supervisor"], requiresPersistentRestart: false
  }
}

export const MATRIX_SURFACE_DRIVERS: Readonly<Record<ProductSurface, "playwright" | "electrobun-cdp">> = {
  web: "playwright",
  local: "playwright",
  native: "electrobun-cdp"
}

/** One obligation catalog. Modes inject topology; they do not copy scenario bodies. */
export const MATRIX_OBLIGATIONS: readonly MatrixObligation[] = [
  { id: "signed-in", scenarios: [{ id: "auth.mode-session-cookie-persistence", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "repository-create", scenarios: [{ id: "repositories.product-create-readback", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "local-git-push", scenarios: [{ id: "repositories.local-git-push-file-readback", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "github-import", scenarios: [{ id: "repositories.github-import-direct-readback", capabilities: ["identity", "github"] }], tier: "live-provider" },
  { id: "chat", scenarios: [
    { id: "chat.owner-model", capabilities: ["identity", "model.turn"] }
  ], tier: "local-infrastructure" },
  { id: "workspace", scenarios: [{ id: "workspaces.product-lifecycle", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "terminal", scenarios: [{ id: "workspaces.product-terminal-keyboard-output", capabilities: ["identity", "cloud", "cloud.terminal"] }], tier: "local-infrastructure" },
  { id: "flow", scenarios: [{ id: "flows.product-run", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "issue", scenarios: [{ id: "issues.product-create-readback", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "landing", scenarios: [{ id: "landings.local-change-land", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "reload", scenarios: [{ id: "issues.product-reload-readback", capabilities: ["identity"] }], tier: "local-infrastructure" }
]

export const MATRIX_SCENARIO_IDS = [...new Set(MATRIX_OBLIGATIONS.flatMap((entry) => entry.scenarios.map(({ id }) => id)))]

/**
 * Every door each host type must open, read from the one table the Worker and the Bun server emit from.
 * Plue also owes `github`: its backend serves GitHub import behind the Worker's `/api/github/import`
 * proxy, so a Plue mode fails that obligation until its bootstrap advertises the capability.
 */
const PROVIDER_CAPABILITY_UNIVERSE: Readonly<Record<ProductProvider, readonly RuntimeCapability[]>> = {
  selfhost: localCapabilities({ agent: true, identity: true, cloud: true, browser: true }),
  plue: [...cloudCapabilities({ identity: true, cloud: true, agent: true, checkout: true, terminal: true, browser: true }), "github"]
}

/** A mode owes every scenario whose capabilities its host type opens; each one it owes must pass. */
export const owedScenarioIds = (mode: DeploymentMode): readonly string[] => {
  const universe = PROVIDER_CAPABILITY_UNIVERSE[MODE_DESCRIPTORS[mode].provider]
  return MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios
    .filter(({ capabilities }) => capabilities.every((capability) => universe.includes(capability)))
    .map(({ id }) => id))
}

export const applicableScenarioIds = (capabilities: readonly string[]): readonly string[] =>
  MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios
    .filter((scenario) => scenario.capabilities.every((capability) => capabilities.includes(capability)))
    .map(({ id }) => id))

export const MANDATORY_DETERMINISTIC_BUN_TESTS = [
  "src/mainview/state/controller/workflows.test.ts",
  "src/mainview/state/controller/repositorySetup.test.ts",
  "src/mainview/state/controller/failures.test.ts"
] as const

export const MANDATORY_DETERMINISTIC_BROWSER_SPECS = [
  "e2e/playwright/flow-launch-background.spec.ts",
  "e2e/playwright/toast-stack.spec.ts"
] as const

export interface ModeConfig {
  readonly mode: DeploymentMode
  readonly origin: string
  readonly endpoint: string
  readonly auth: { readonly kind: "browser-profile" | "owner-session" | "application-token"; readonly environment: string }
  readonly executionReceipt: string
  /** Secret-free reference to a JSON launch envelope held only in the runner environment. */
  readonly surfaceDriver?: { readonly kind: "electrobun-cdp"; readonly environment: string }
}

export interface MatrixConfig {
  readonly revision: string
  readonly modes: readonly ModeConfig[]
}

export interface ExecutionReceipt {
  readonly mode: DeploymentMode
  readonly revision: string
  readonly origin: string
  readonly endpoint: string
  readonly ready: boolean
  readonly startedRoles: readonly ProcessRole[]
  readonly freshLaunch: boolean
  readonly restarted: boolean
  readonly dataPreserved: boolean
  readonly persistenceProof?: {
    readonly database: { readonly before: string; readonly after: string }
    readonly dataVolume: { readonly before: string; readonly after: string }
  }
  readonly observedAt: string
}

export interface ModeReadiness {
  readonly mode: DeploymentMode
  readonly status: MatrixStatus
  readonly tier: MatrixTier
  readonly origin?: string
  readonly endpoint?: string
  readonly capabilities: readonly string[]
  /** The build the mode's backend reported: the checkout for selfhost, the deployed Worker for Plue. */
  readonly buildSha?: string
  readonly bootstrapSHA256?: string
  readonly reasons: readonly string[]
}

export interface MatrixScenarioReceipt {
  readonly mode: DeploymentMode
  readonly obligation: string
  readonly scenarioId: string
  readonly tier: MatrixTier
  readonly status: MatrixStatus
  readonly revision: string
  readonly origin?: string
  readonly reason?: string
}

type MatrixFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value)
const exactRevision = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{40,64}$/.test(value)
const deploymentMode = (value: unknown): value is DeploymentMode => typeof value === "string" && (DEPLOYMENT_MODES as readonly string[]).includes(value)

const httpOrigin = (value: unknown): string => {
  if (typeof value !== "string") throw new Error("mode origin must be a string")
  const parsed = new URL(value)
  if (!/^https?:$/.test(parsed.protocol) || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
    throw new Error(`mode origin must be a credential-free HTTP(S) origin: ${value}`)
  }
  return parsed.origin
}

export const parseMatrixConfig = (value: unknown): MatrixConfig => {
  if (!isObject(value) || !exactRevision(value.revision) || !Array.isArray(value.modes)) throw new Error("matrix config requires an exact revision and modes array")
  const seen = new Set<DeploymentMode>()
  const modes = value.modes.map((entry): ModeConfig => {
    if (!isObject(entry) || !deploymentMode(entry.mode) || !isObject(entry.auth) || typeof entry.executionReceipt !== "string") {
      throw new Error("every matrix mode requires mode, origin, auth, and executionReceipt")
    }
    if (seen.has(entry.mode)) throw new Error(`duplicate matrix mode ${entry.mode}`)
    seen.add(entry.mode)
    if ((entry.auth.kind !== "browser-profile" && entry.auth.kind !== "owner-session" && entry.auth.kind !== "application-token") || typeof entry.auth.environment !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(entry.auth.environment)) {
      throw new Error(`${entry.mode} auth must name a browser-profile, owner-session, or application-token environment variable`)
    }
    if (!entry.executionReceipt.trim()) throw new Error(`${entry.mode} executionReceipt is required`)
    let surfaceDriver: ModeConfig["surfaceDriver"]
    if (entry.surfaceDriver !== undefined) {
      if (!isObject(entry.surfaceDriver) || entry.surfaceDriver.kind !== "electrobun-cdp" ||
          typeof entry.surfaceDriver.environment !== "string" || !/^[A-Z][A-Z0-9_]+$/.test(entry.surfaceDriver.environment)) {
        throw new Error(`${entry.mode} surfaceDriver must name an electrobun-cdp environment variable`)
      }
      if (MODE_DESCRIPTORS[entry.mode].surface !== "native") throw new Error(`${entry.mode} must not configure a native surface driver`)
      surfaceDriver = { kind: "electrobun-cdp", environment: entry.surfaceDriver.environment }
    }
    return {
      mode: entry.mode,
      origin: httpOrigin(entry.origin),
      endpoint: httpOrigin(entry.endpoint),
      auth: { kind: entry.auth.kind, environment: entry.auth.environment },
      executionReceipt: entry.executionReceipt,
      ...(surfaceDriver ? { surfaceDriver } : {})
    }
  })
  return { revision: value.revision, modes }
}

export const readExecutionReceipt = (path: string): ExecutionReceipt => {
  if (!existsSync(path)) throw new Error(`execution receipt does not exist: ${path}`)
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown
  if (!isObject(value) || !deploymentMode(value.mode) || !exactRevision(value.revision) || typeof value.origin !== "string" || typeof value.endpoint !== "string" || typeof value.ready !== "boolean" ||
      !Array.isArray(value.startedRoles) || value.startedRoles.some((role) => typeof role !== "string" || !(PROCESS_ROLES as readonly string[]).includes(role)) || typeof value.freshLaunch !== "boolean" ||
      typeof value.restarted !== "boolean" || typeof value.dataPreserved !== "boolean" ||
      (value.persistenceProof !== undefined && (!isObject(value.persistenceProof) || !isObject(value.persistenceProof.database) || !isObject(value.persistenceProof.dataVolume) ||
        typeof value.persistenceProof.database.before !== "string" || typeof value.persistenceProof.database.after !== "string" ||
        typeof value.persistenceProof.dataVolume.before !== "string" || typeof value.persistenceProof.dataVolume.after !== "string")) ||
      typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) {
    throw new Error(`malformed execution receipt: ${path}`)
  }
  return value as unknown as ExecutionReceipt
}

export const validateExecutionReceipt = (config: ModeConfig, revision: string, receipt: ExecutionReceipt): readonly string[] => {
  const descriptor = MODE_DESCRIPTORS[config.mode]
  const reasons: string[] = []
  if (receipt.mode !== config.mode) reasons.push(`receipt mode ${receipt.mode} does not match ${config.mode}`)
  if (receipt.revision !== revision) reasons.push(`receipt revision ${receipt.revision} does not match ${revision}`)
  if (httpOrigin(receipt.origin) !== config.origin) reasons.push(`receipt origin ${receipt.origin} does not match ${config.origin}`)
  if (httpOrigin(receipt.endpoint) !== config.endpoint) reasons.push("launcher endpoint differs from selected backend")
  if (!receipt.ready) reasons.push("launcher did not report actual readiness")
  for (const role of descriptor.requiredProcessRoles) if (!receipt.startedRoles.includes(role)) reasons.push(`launcher did not prove ${role} started`)
  for (const role of descriptor.forbiddenProcessRoles) if (receipt.startedRoles.includes(role)) reasons.push(`remote mode unexpectedly started ${role}`)
  if (descriptor.provider === "selfhost" && !receipt.freshLaunch) reasons.push("launcher did not prove a fresh launch")
  if (descriptor.requiresPersistentRestart) {
    if (!receipt.restarted || !receipt.dataPreserved) reasons.push("persistent restart with preserved data was not proven")
    const proof = receipt.persistenceProof
    if (proof === undefined || proof.database.before === "" || proof.dataVolume.before === "" ||
        proof.database.before !== proof.database.after || proof.dataVolume.before !== proof.dataVolume.after) {
      reasons.push("persistent restart markers for the database and data volume were not proven")
    }
  }
  return reasons
}

/**
 * One readiness contract per provider. Bootstrap is the public contract every host serves. A selfhost
 * backend was built from this checkout, so it must also answer the Bun host's /api/health and report the
 * checkout revision. A Plue mode targets the deployed Worker, which serves no /api/health and ships on its
 * own deploy train: its build is recorded as evidence, and the web receipt must name that same build.
 */
export const probeMode = async (
  config: ModeConfig,
  revision: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: MatrixFetcher = fetch
): Promise<ModeReadiness> => {
  const descriptor = MODE_DESCRIPTORS[config.mode]
  const reasons: string[] = []
  if (descriptor.surface === "native") {
    if (config.surfaceDriver === undefined) reasons.push("native mode has no packaged Electrobun CDP driver configuration")
    else if (!environment[config.surfaceDriver.environment]?.trim()) {
      reasons.push(`native driver environment ${config.surfaceDriver.environment} is unavailable`)
    }
    if (config.mode === "native-own" && config.auth.kind !== "owner-session") {
      reasons.push("native-own requires the packaged owner-session bootstrap flow")
    }
    if (config.mode === "native-plue" && config.auth.kind !== "application-token") {
      reasons.push("native-plue requires the packaged application-token flow")
    }
  }
  if (!environment[config.auth.environment]?.trim()) reasons.push(`auth environment ${config.auth.environment} is unavailable`)
  let capabilities: readonly string[] = []
  let buildSha: string | undefined
  let bootstrapSHA256: string | undefined
  try {
    const bootstrap = await fetcher(new URL("/api/bootstrap", config.origin))
    if (!bootstrap.ok) reasons.push(`bootstrap returned HTTP ${bootstrap.status}`)
    else {
      const body = await bootstrap.json()
      if (config.auth.kind === "owner-session" && (!isObject(body) || body.authFlow !== "credentials")) {
        reasons.push(`bootstrap authFlow ${isObject(body) ? String(body.authFlow) : "unknown"} does not advertise owner credentials`)
      }
      const parsed = AppBootstrapSchema.safeParse(body)
      if (!parsed.success) reasons.push(`bootstrap contract is invalid: ${parsed.error.message}`)
      else {
        bootstrapSHA256 = canonicalBootstrapSHA256(body)
        capabilities = parsed.data.capabilities
        const bootstrapHost: RealHost = parsed.data.host === "cloud" ? "production" : "local"
        if (bootstrapHost !== descriptor.legacyHost) {
          reasons.push(`bootstrap host ${parsed.data.host} does not match ${config.mode} provider ${descriptor.provider}`)
        }
        if (!exactRevision(parsed.data.buildSha)) reasons.push(`bootstrap buildSha ${parsed.data.buildSha} is not an exact revision`)
        else buildSha = parsed.data.buildSha
        if (descriptor.provider === "selfhost" && parsed.data.buildSha !== revision) {
          reasons.push(`bootstrap revision ${parsed.data.buildSha} does not match ${revision}`)
        }
        if (descriptor.provider === "plue" && parsed.data.authFlow === "none") reasons.push("bootstrap authFlow none offers no sign-in")
      }
    }
    if (descriptor.provider === "selfhost") {
      const health = await fetcher(new URL("/api/health", config.origin))
      if (!health.ok) reasons.push(`health returned HTTP ${health.status}`)
    }
  } catch (error) { reasons.push(`readiness request failed: ${error instanceof Error ? error.message : String(error)}`) }
  // The web-plue launcher observes the deployed page, so its receipt names the deployed build; every other surface runs this checkout.
  const surfaceRevision = descriptor.surface === "web" && descriptor.provider === "plue" ? buildSha : revision
  if (surfaceRevision === undefined) reasons.push("the deployed build is unknown, so the web-plue receipt cannot be checked")
  else {
    try { reasons.push(...validateExecutionReceipt(config, surfaceRevision, readExecutionReceipt(config.executionReceipt))) }
    catch (error) { reasons.push(error instanceof Error ? error.message : String(error)) }
  }
  return {
    mode: config.mode,
    status: reasons.length === 0 ? "passed" : "failed",
    tier: descriptor.provider === "plue" ? "plue-production" : "local-infrastructure",
    origin: config.origin,
    endpoint: config.endpoint,
    capabilities,
    ...(buildSha === undefined ? {} : { buildSha }),
    ...(bootstrapSHA256 === undefined ? {} : { bootstrapSHA256 }),
    reasons
  }
}

/** One row per scenario the mode owes. An owed capability the bootstrap does not advertise fails its row. */
export const scenarioReceipts = (
  readiness: ModeReadiness,
  revision: string,
  runs: readonly RealScenarioRunEvidence[]
): readonly MatrixScenarioReceipt[] => {
  const owed = owedScenarioIds(readiness.mode)
  return MATRIX_OBLIGATIONS.flatMap((obligation) => obligation.scenarios.filter(({ id }) => owed.includes(id)).map((scenario): MatrixScenarioReceipt => {
    const scenarioId = scenario.id
    const tier = readiness.tier === "plue-production" ? readiness.tier : obligation.tier
    const missingCapabilities = scenario.capabilities.filter((capability) => !readiness.capabilities.includes(capability))
    const attempts = runs.filter((run) => run.mode === readiness.mode && run.scenarioId === scenarioId && run.revision === revision)
    const moved = MODE_DESCRIPTORS[readiness.mode].provider === "plue" ? attempts.find((run) => run.buildSha !== readiness.buildSha) : undefined
    const failure = moved ?? attempts.find((run) => run.status !== "passed")
    const passed = attempts.find((run) => run.status === "passed")
    const reason = readiness.status !== "passed" ? readiness.reasons.join("; ")
      : missingCapabilities.length > 0 ? `bootstrap does not advertise ${missingCapabilities.join(", ")}`
      : moved ? `deployment changed during the run: ${moved.buildSha ?? "unrecorded"} is not ${readiness.buildSha ?? "unrecorded"}`
      : failure ? `unsuccessful attempt: ${failure.status}`
        : !passed ? "no executed receipt" : undefined
    const status: MatrixStatus = reason === undefined ? "passed"
      : readiness.status !== "passed" ? readiness.status
        : missingCapabilities.length > 0 || failure !== undefined ? "failed" : "unavailable"
    return {
      mode: readiness.mode, obligation: obligation.id, scenarioId, tier, status,
      revision, ...(readiness.origin ? { origin: readiness.origin } : {}), ...(reason ? { reason } : {})
    }
  }))
}

export const missingModeReadiness = (mode: DeploymentMode, reason: string): ModeReadiness => ({
  mode,
  status: MODE_DESCRIPTORS[mode].provider === "plue" ? "not-configured" : "failed",
  tier: MODE_DESCRIPTORS[mode].provider === "plue" ? "plue-production" : "local-infrastructure",
  capabilities: [],
  reasons: [reason]
})

export interface MatrixSelection {
  readonly modes: readonly DeploymentMode[]
  readonly scope: "six-mode" | "partial"
}

export const selectMatrixModes = (value?: string): MatrixSelection => {
  const modes = value === undefined ? DEPLOYMENT_MODES
    : value === "own-only" ? DEPLOYMENT_MODES.filter((mode) => MODE_DESCRIPTORS[mode].provider === "selfhost")
      : value.split(",").map((mode) => {
        if (!(DEPLOYMENT_MODES as readonly string[]).includes(mode)) throw new Error(`invalid matrix mode ${mode}`)
        return mode as DeploymentMode
      })
  if (modes.length === 0 || new Set(modes).size !== modes.length) throw new Error("matrix modes must be a nonempty set")
  return { modes, scope: modes.length === DEPLOYMENT_MODES.length ? "six-mode" : "partial" }
}

export const matrixPasses = (
  readiness: readonly ModeReadiness[],
  scenarios: readonly MatrixScenarioReceipt[],
  deterministicPassed: boolean,
  requiredModes: readonly DeploymentMode[] = DEPLOYMENT_MODES,
  commands: readonly { readonly tier: string; readonly status: "passed" | "failed" | "unavailable"; readonly exitCode?: number }[] = []
): boolean => deterministicPassed &&
  commands.every(({ status, exitCode }) => status === "passed" && exitCode === 0) &&
  requiredModes.length > 0 &&
  new Set(requiredModes).size === requiredModes.length &&
  requiredModes.every((mode) => DEPLOYMENT_MODES.includes(mode)) &&
  readiness.length === requiredModes.length &&
  new Set(readiness.map(({ mode }) => mode)).size === requiredModes.length &&
  readiness.every(({ mode }) => requiredModes.includes(mode)) &&
  scenarios.length === requiredModes.reduce((count, mode) => count + owedScenarioIds(mode).length, 0) &&
  scenarios.every(({ mode, scenarioId }) => requiredModes.includes(mode) && owedScenarioIds(mode).includes(scenarioId)) &&
  new Set(scenarios.map(({ mode, scenarioId }) => `${mode}:${scenarioId}`)).size === scenarios.length &&
  readiness.every(({ status }) => status === "passed") &&
  scenarios.every(({ status }) => status === "passed")

export const matrixVerdict = (
  selection: MatrixSelection,
  readiness: readonly ModeReadiness[],
  scenarios: readonly MatrixScenarioReceipt[],
  deterministicPassed: boolean,
  commands: readonly { readonly tier: string; readonly status: "passed" | "failed" | "unavailable"; readonly exitCode?: number }[] = []
) => {
  const ok = matrixPasses(readiness, scenarios, deterministicPassed, selection.modes, commands)
  return { ok, scope: selection.scope, modes: selection.modes, sixModeAccepted: ok && selection.scope === "six-mode" }
}
