import { createHash } from "node:crypto"
import { existsSync, readFileSync } from "node:fs"
import { AppBootstrapSchema } from "@smthrs/rpc/AppBootstrap"
import type { RuntimeCapability } from "@smthrs/rpc/AppBootstrap"
import { DEPLOYMENT_MODES } from "./types"
import type { DeploymentMode, RealHost, RealScenarioRunEvidence } from "./types"

/** Digest a JSON value, such as the public bootstrap response, independent of object key order. */
export const canonicalSHA256 = (body: unknown): string => {
  const canonical = (value: unknown): string => {
    if (value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value))) return JSON.stringify(value)
    if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
    if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`
    throw new Error("Canonical digest requires a JSON value")
  }
  return createHash("sha256").update(canonical(body)).digest("hex")
}

export type MatrixTier = "deterministic" | "local-infrastructure" | "live-provider" | "plue-production"
export type MatrixStatus = "passed" | "failed" | "unavailable" | "not-configured"
export type ProductProvider = "selfhost" | "plue"
export type ProductSurface = "web" | "local"
export type ProcessRole = "web" | "local-ui" | "supervisor" | "app" | "docker-app" | "postgres"
const PROCESS_ROLES: readonly ProcessRole[] = ["web", "local-ui", "supervisor", "app", "docker-app", "postgres"]

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

}

export const MATRIX_SURFACE_DRIVERS: Readonly<Record<ProductSurface, "playwright">> = {
  web: "playwright",
  local: "playwright",

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
  { id: "setup-inspection", scenarios: [{ id: "setup.inspect-recovery", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "issue", scenarios: [{ id: "issues.product-create-readback", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "landing", scenarios: [{ id: "landings.local-change-land", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "reload", scenarios: [{ id: "issues.product-reload-readback", capabilities: ["identity"] }], tier: "local-infrastructure" },
  { id: "approval", scenarios: [
    { id: "approvals.product-approve", capabilities: ["identity", "cloud"] },
    { id: "approvals.product-deny", capabilities: ["identity", "cloud"] }
  ], tier: "local-infrastructure" },
  { id: "duplicate-input", scenarios: [{ id: "issues.owner-resolution-durable-replay", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" },
  { id: "error-surfaced", scenarios: [{ id: "flows.product-no-box", capabilities: ["identity", "cloud"] }], tier: "local-infrastructure" }
]

export const MATRIX_SCENARIO_IDS = [...new Set(MATRIX_OBLIGATIONS.flatMap((entry) => entry.scenarios.map(({ id }) => id)))]

export type FeatureSupport = "core" | "optional" | "absent"
export type FeatureRow = { readonly support: "core" } | { readonly support: "optional" | "absent"; readonly reason: string }

/** Bump with any row change; every matrix report publishes this version and the table's digest. */
export const FEATURE_MATRIX_VERSION = 3

const core = { support: "core" } as const
const optional = (reason: string): FeatureRow => ({ support: "optional", reason })
const absent = (reason: string): FeatureRow => ({ support: "absent", reason })
const billing = optional("needs the operator's payment provider")

/**
 * Every runtime capability, classified per provider. A core feature must be advertised by every mode of that
 * provider, or the release gate fails; an optional one needs operator configuration; an absent one is not served.
 * Plue owes `github`: its hosted backend serves GitHub sign-in and import.
 */
export const FEATURE_MATRIX: Readonly<Record<RuntimeCapability, Readonly<Record<ProductProvider, FeatureRow>>>> = {
  "agent": { selfhost: optional("needs a configured default agent"), plue: optional("needs a configured default agent") },
  "model.turn": { selfhost: core, plue: optional("needs a configured model provider") },
  "recommend": { selfhost: optional("needs a recommendation provider"), plue: optional("needs a recommendation provider") },
  "commands.select": { selfhost: optional("needs a recommendation provider"), plue: optional("needs a recommendation provider") },
  "browser.read": { selfhost: optional("needs a pinned HTTPS transport"), plue: optional("needs a pinned HTTPS transport") },
  "identity": { selfhost: core, plue: core },
  "github": { selfhost: optional("needs the operator's GitHub OAuth app"), plue: core },
  "cloud": { selfhost: core, plue: core },
  "billing.balance": { selfhost: billing, plue: billing },
  "billing.overview": { selfhost: billing, plue: billing },
  "billing.plans": { selfhost: billing, plue: billing },
  "billing.checkout": { selfhost: billing, plue: billing },
  "billing.portal": { selfhost: billing, plue: billing },
  "cloud.terminal": { selfhost: core, plue: core },
  "cloud.pat": { selfhost: optional("a local host's session with its configured backend"), plue: absent("the shared backend holds no Smithers Cloud PAT session") },
  "native.shell": { selfhost: absent("retired shell capability"), plue: absent("retired shell capability") },
}

export const featureMatrixSHA256 = (): string => canonicalSHA256(FEATURE_MATRIX)

/** The features a mode's bootstrap must advertise. */
export const coreFeatures = (mode: DeploymentMode): readonly RuntimeCapability[] => {
  const provider = MODE_DESCRIPTORS[mode].provider
  return (Object.keys(FEATURE_MATRIX) as RuntimeCapability[]).filter((capability) => FEATURE_MATRIX[capability][provider].support === "core")
}

/** A mode owes every scenario whose capabilities are all core for its provider; each one it owes must pass. */
export const owedScenarioIds = (mode: DeploymentMode): readonly string[] => {
  const owed = coreFeatures(mode)
  return MATRIX_OBLIGATIONS.flatMap(({ scenarios }) => scenarios
    .filter(({ capabilities }) => capabilities.every((capability) => owed.includes(capability)))
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

export interface MatrixFeatureReceipt {
  readonly mode: DeploymentMode
  readonly capability: RuntimeCapability
  readonly status: MatrixStatus
  readonly reason?: string
}

type MatrixFetcher = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

/** Total budget for one mode's readiness requests, from connection through body decoding. */
export const READINESS_DEADLINE_MS = 30_000

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
    return {
      mode: entry.mode,
      origin: httpOrigin(entry.origin),
      endpoint: httpOrigin(entry.endpoint),
      auth: { kind: entry.auth.kind, environment: entry.auth.environment },
      executionReceipt: entry.executionReceipt
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
 * backend was built from this checkout, so it must also answer /api/health and report the
 * checkout revision. A Plue mode targets an independently deployed origin: its build is recorded as
 * evidence, and the web receipt must name that same build. Its readiness requires only bootstrap.
 */
export const probeMode = async (
  config: ModeConfig,
  revision: string,
  environment: Readonly<Record<string, string | undefined>> = process.env,
  fetcher: MatrixFetcher = fetch,
  deadlineMs: number = READINESS_DEADLINE_MS
): Promise<ModeReadiness> => {
  const descriptor = MODE_DESCRIPTORS[config.mode]
  const reasons: string[] = []

  if (!environment[config.auth.environment]?.trim()) reasons.push(`auth environment ${config.auth.environment} is unavailable`)
  let capabilities: readonly string[] = []
  let buildSha: string | undefined
  let bootstrapSHA256: string | undefined
  const signal = AbortSignal.timeout(deadlineMs)
  const expired = new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }))
  expired.catch(() => undefined)
  const bounded = <T>(work: Promise<T>): Promise<T> => Promise.race([work, expired])
  try {
    const bootstrap = await bounded(fetcher(new URL("/api/bootstrap", config.origin), { signal }))
    if (!bootstrap.ok) reasons.push(`bootstrap returned HTTP ${bootstrap.status}`)
    else {
      const body: unknown = await bounded(bootstrap.json())
      if (config.auth.kind === "owner-session" && (!isObject(body) || body.authFlow !== "credentials")) {
        reasons.push(`bootstrap authFlow ${isObject(body) ? String(body.authFlow) : "unknown"} does not advertise owner credentials`)
      }
      const parsed = AppBootstrapSchema.safeParse(body)
      if (!parsed.success) reasons.push(`bootstrap contract is invalid: ${parsed.error.message}`)
      else {
        bootstrapSHA256 = canonicalSHA256(body)
        capabilities = parsed.data.capabilities
        // `cloud` names the shared web API, including self-hosted Go deployments.
        // Provider identity comes from config and its bound launch receipt; Plue still cannot be a Bun host.
        if (descriptor.provider === "plue" && parsed.data.host !== "cloud") {
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
      const health = await bounded(fetcher(new URL("/api/health", config.origin), { signal }))
      if (!health.ok) reasons.push(`health returned HTTP ${health.status}`)
    }
  } catch (error) {
    reasons.push(signal.aborted ? `readiness timed out after ${deadlineMs} ms`
      : `readiness request failed: ${error instanceof Error ? error.message : String(error)}`)
  }
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

/** One row per core feature of the mode. A core feature its bootstrap does not advertise fails its row. */
export const featureReceipts = (readiness: ModeReadiness): readonly MatrixFeatureReceipt[] =>
  coreFeatures(readiness.mode).map((capability): MatrixFeatureReceipt => {
    const reason = readiness.status !== "passed" ? `readiness ${readiness.status}`
      : readiness.capabilities.includes(capability) ? undefined : `core feature ${capability} is disabled`
    const status: MatrixStatus = readiness.status !== "passed" ? readiness.status : reason === undefined ? "passed" : "failed"
    return { mode: readiness.mode, capability, status, ...(reason === undefined ? {} : { reason }) }
  })

/** One row per scenario the mode owes. A scenario its host did not run has no executed receipt. */
export const scenarioReceipts = (
  readiness: ModeReadiness,
  revision: string,
  runs: readonly RealScenarioRunEvidence[]
): readonly MatrixScenarioReceipt[] => {
  const owed = owedScenarioIds(readiness.mode)
  return MATRIX_OBLIGATIONS.flatMap((obligation) => obligation.scenarios.filter(({ id }) => owed.includes(id)).map(({ id: scenarioId }): MatrixScenarioReceipt => {
    const tier = readiness.tier === "plue-production" ? readiness.tier : obligation.tier
    const attempts = runs.filter((run) => run.mode === readiness.mode && run.scenarioId === scenarioId && run.revision === revision)
    const moved = MODE_DESCRIPTORS[readiness.mode].provider === "plue" ? attempts.find((run) => run.buildSha !== readiness.buildSha) : undefined
    const failure = moved ?? attempts.find((run) => run.status !== "passed")
    const passed = attempts.find((run) => run.status === "passed")
    const reason = readiness.status !== "passed" ? readiness.reasons.join("; ")
      : moved ? `deployment changed during the run: ${moved.buildSha ?? "unrecorded"} is not ${readiness.buildSha ?? "unrecorded"}`
      : failure ? `unsuccessful attempt: ${failure.status}`
        : !passed ? "no executed receipt" : undefined
    const status: MatrixStatus = reason === undefined ? "passed"
      : readiness.status !== "passed" ? readiness.status
        : failure !== undefined ? "failed" : "unavailable"
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
  readonly scope: "all-modes" | "partial"
}

export const selectMatrixModes = (value?: string): MatrixSelection => {
  const modes = value === undefined ? DEPLOYMENT_MODES
    : value === "own-only" ? DEPLOYMENT_MODES.filter((mode) => MODE_DESCRIPTORS[mode].provider === "selfhost")
      : value.split(",").map((mode) => {
        if (!(DEPLOYMENT_MODES as readonly string[]).includes(mode)) throw new Error(`invalid matrix mode ${mode}`)
        return mode as DeploymentMode
      })
  if (modes.length === 0 || new Set(modes).size !== modes.length) throw new Error("matrix modes must be a nonempty set")
  return { modes, scope: modes.length === DEPLOYMENT_MODES.length ? "all-modes" : "partial" }
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
  readiness.flatMap(featureReceipts).every(({ status }) => status === "passed") &&
  scenarios.every(({ status }) => status === "passed")

export const matrixVerdict = (
  selection: MatrixSelection,
  readiness: readonly ModeReadiness[],
  scenarios: readonly MatrixScenarioReceipt[],
  deterministicPassed: boolean,
  commands: readonly { readonly tier: string; readonly status: "passed" | "failed" | "unavailable"; readonly exitCode?: number }[] = []
) => {
  const ok = matrixPasses(readiness, scenarios, deterministicPassed, selection.modes, commands)
  return { ok, scope: selection.scope, modes: selection.modes, allModesAccepted: ok && selection.scope === "all-modes" }
}
