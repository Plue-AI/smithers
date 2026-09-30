import { REVIEW_MIGRATIONS } from "../../apps/review/src/server/migrations.ts"
import type { Release, RolloutHost } from "./runtime.ts"

export type WorkerApp = "review" | "bug-worker"
export interface WorkerArtifact {
  readonly revision: string
  readonly sha256: string
}
/** Evidence read by the trusted host from its gate, build, adoption and migration receipts. */
export interface WorkerQualification {
  readonly app: WorkerApp
  readonly mainRevision: string
  readonly gate: { readonly revision: string; readonly status: "passed" | "failed" }
  readonly artifact: WorkerArtifact
  readonly adoption: {
    readonly artifact: WorkerArtifact
    readonly status: "retained" | "replacement-required"
    readonly receipt: string
  }
  readonly migrations?: { readonly revision: string; readonly applied: ReadonlyArray<string>; readonly receipt: string }
}

const sameArtifact = (a: WorkerArtifact, b: WorkerArtifact) => a.revision === b.revision && a.sha256 === b.sha256

/** This validates identity relationships, not authenticity: never accept caller-supplied evidence. */
export function assertWorkerQualified(app: WorkerApp, artifact: WorkerArtifact, evidence: WorkerQualification): void {
  if (
    !/^[a-f0-9]{40}$/.test(artifact.revision) || !/^[a-f0-9]{64}$/.test(artifact.sha256) ||
    evidence.app !== app || evidence.mainRevision !== artifact.revision ||
    evidence.gate.status !== "passed" || evidence.gate.revision !== artifact.revision ||
    !sameArtifact(evidence.artifact, artifact) || !sameArtifact(evidence.adoption.artifact, artifact) ||
    evidence.adoption.status !== "retained" || !evidence.adoption.receipt.trim()
  ) throw new Error("Worker qualification refused")
  if (
    app === "review" && (
      evidence.migrations?.revision !== artifact.revision || !evidence.migrations.receipt.trim() ||
      REVIEW_MIGRATIONS.some(({ name }) => !evidence.migrations!.applied.includes(name))
    )
  ) throw new Error("Worker migration readback required")
}

/** The private host holds the exclusive lease, immutable artifact and durable receipts. */
export interface WorkerRolloutPorts extends Omit<RolloutHost, "publish" | "beforePublish"> {
  /** Reconcile interrupted publication and assert the lease and captured live version still match. */
  beforePublish(): Promise<void>
  qualification(): Promise<WorkerQualification>
  /** Upload these exact bytes; never rebuild from the current checkout. */
  publish(artifact: WorkerArtifact): Promise<Release>
  /** Read the deployed version's identity and digest, never the newest uploaded version. */
  verifyArtifact(release: Release, artifact: WorkerArtifact): Promise<boolean>
}

/** Adapt Worker publication to the existing rollout policy and its durable receipt format. */
export function qualifiedWorkerHost(app: WorkerApp, input: WorkerArtifact, ports: WorkerRolloutPorts): RolloutHost {
  const artifact = Object.freeze({ ...input })
  if (!ports.checks.includes("service-response") || ports.checks.includes("qualified-artifact")) {
    throw new Error("Worker service-response check required; qualified-artifact is reserved")
  }
  return {
    ...ports,
    checks: ["qualified-artifact", ...ports.checks],
    rollbackChecks: [
      "qualified-artifact",
      "service-response",
      ...ports.rollbackChecks.filter((name) => name !== "service-response")
    ],
    // The previous artifact has its own retained identity, verified by the host's existing checks.
    previousChecks: ports.previousChecks ?? ports.checks,
    beforePublish: async () => {
      await ports.beforePublish()
      assertWorkerQualified(app, artifact, await ports.qualification())
    },
    publish: () => ports.publish(artifact),
    check: async (name, release, phase) =>
      name === "qualified-artifact"
        ? {
          status: release.revision === artifact.revision && await ports.verifyArtifact(release, artifact)
            ? "passed"
            : "failed"
        }
        : ports.check(name, release, phase)
  }
}
