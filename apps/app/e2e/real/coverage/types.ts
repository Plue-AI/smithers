import type { TestDetails } from "@playwright/test"

export const REAL_HOSTS = ["local", "production"] as const
export const DEPLOYMENT_MODES = ["web-selfhost", "web-plue", "local-own", "local-plue"] as const
export const CRITICAL_PATHS = ["success", "permission", "error", "persistence", "keyboard"] as const
export const DOORS = ["slash", "button", "agent", "user-only"] as const

export type RealHost = typeof REAL_HOSTS[number]
export type DeploymentMode = typeof DEPLOYMENT_MODES[number]
export type CriticalPath = typeof CRITICAL_PATHS[number]
export type Door = typeof DOORS[number]

/**
 * Machine-readable coverage tokens emitted by the realScenario fixture.
 *
 * `action:repository-flow:*` represents the runtime repository-flow family.
 * Every other action token must name a literal FLOW_NAMES declaration.
 */
export type RealCoverageToken =
  | `action:${string}`
  | `path:${CriticalPath}`
  | `door:${Door}`
  | `dimension:${string}`
  | `surface:${string}`
  | `host:${RealHost}`
  | `evidence:${string}`

export interface RealScenarioMetadata {
  readonly id: string
  readonly capabilities: readonly string[]
  readonly coverage: readonly RealCoverageToken[]
  readonly description?: string
}

export interface RealScenarioDetailsMetadata {
  readonly capabilities: readonly string[]
  readonly coverage: readonly RealCoverageToken[]
  readonly description?: string
}

/** Canonical per-test details. The fixture and reporter consume these annotations. */
export const scenario = (id: string, metadata: RealScenarioDetailsMetadata): TestDetails => ({
  tag: [
    `@real-scenario:${id}`,
    ...metadata.coverage.filter((token) => token.startsWith("host:")).map((token) => `@real-${token}`)
  ],
  annotation: [
    { type: "real-scenario", description: id },
    ...(metadata.description === undefined ? [] : [{ type: "real-description", description: metadata.description }]),
    ...metadata.capabilities.map((description) => ({ type: "real-capability", description })),
    ...metadata.coverage.map((description) => ({ type: "real-coverage", description }))
  ]
})

export interface RealScenarioRunEvidence {
  readonly scenarioId: string
  readonly host: RealHost
  readonly mode?: DeploymentMode
  readonly status: "passed" | "failed" | "timedOut" | "skipped" | "interrupted"
  readonly revision: string
  readonly buildSha?: string
  readonly startedAt: string
  readonly finishedAt: string
  readonly artifact?: string
}

export interface RealE2EEvidenceFile {
  readonly execution?: MatrixExecutionEvidence
  readonly suiteStatus: "passed" | "failed" | "timedout" | "interrupted"
  readonly reporterErrors: readonly string[]
  readonly runs: readonly RealScenarioRunEvidence[]
}

export interface MatrixExecutionEvidence {
  readonly executionID: string
  readonly mode: DeploymentMode
  readonly origin: string
  readonly endpoint: string
  readonly surfaceOrigin: string
  readonly startedAt: string
  readonly finishedAt: string
}

export interface CoverageGap {
  readonly kind: "action" | "critical-path" | "host" | "door" | "dimension" | "execution"
  readonly value: string
  readonly scenarioId?: string
}
