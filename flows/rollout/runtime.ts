/** Deterministic rollout shared by Cloud hosts, self-hosters and the deploy command. */
export interface Release {
  readonly version: string
  readonly revision: string
}
export type Phase = "baseline" | "candidate" | "restored"
export interface CheckResult {
  readonly name: string
  readonly status: "passed" | "failed"
}
export interface RolloutReceipt {
  readonly startedAt: string
  updatedAt: string
  status:
    | "captured"
    | "prepared"
    | "publishing"
    | "checking"
    | "restoring"
    | "passed"
    | "failed"
    | "refused"
    | "rolled-back"
    | "rollback-failed"
  previous: Release | null
  candidate: Release | null
  baseline: Array<CheckResult>
  checks: Array<CheckResult>
  failedChecks: Array<string>
  skippedChecks: ReadonlyArray<string>
  rollback: "not-needed" | "succeeded" | "failed"
  reverification: Array<CheckResult>
}
/** The host owns serialization, bounded I/O, immutable versions and durable receipt storage. */
export interface RolloutHost {
  /** The newest receipt in the durable store, read under the host's exclusive lease. */
  lastReceipt(): Promise<RolloutReceipt | null>
  checks: ReadonlyArray<string>
  /** Only checks affected by this deployment can trigger restoration. */
  rollbackChecks: ReadonlyArray<string>
  previousChecks?: ReadonlyArray<string>
  skippedChecks?: ReadonlyArray<string>
  capture(): Promise<Release>
  beforePublish?(): Promise<void>
  publish(): Promise<Release>
  check(name: string, release: Release, phase: Phase): Promise<{ status: "passed" | "failed" }>
  restore(release: Release): Promise<void>
  record(receipt: RolloutReceipt): Promise<void>
}

const terminal: ReadonlyArray<RolloutReceipt["status"]> = ["passed", "failed", "refused", "rolled-back", "rollback-failed"]
/** A receipt left in a non-terminal status belongs to a run that stopped mid-rollout. */
export const isInterrupted = (receipt: RolloutReceipt): boolean => !terminal.includes(receipt.status)

const recorder = (host: RolloutHost, receipt: RolloutReceipt) => async (status: RolloutReceipt["status"]) => {
  receipt.status = status
  receipt.updatedAt = new Date().toISOString()
  await host.record(receipt)
}

const verify = async (host: RolloutHost, release: Release, phase: Phase): Promise<Array<CheckResult>> => {
  const results: Array<CheckResult> = []
  for (const name of phase === "candidate" ? host.checks : (host.previousChecks ?? host.checks)) {
    // Never copy exception messages: provider/process errors can contain credentials.
    try {
      results.push({
        name,
        status: (await host.check(name, release, phase)).status === "passed" ? "passed" : "failed"
      })
    } catch {
      results.push({ name, status: "failed" })
    }
  }
  return results
}

/** Restore the captured baseline, re-verify it, and record the terminal receipt. Never rolls forward. */
const restoreBaseline = async (host: RolloutHost, receipt: RolloutReceipt, previous: Release): Promise<RolloutReceipt> => {
  const record = recorder(host, receipt)
  // A full disk must not prevent rollback. Try to retain intent, then restore anyway.
  try {
    await record("restoring")
  } catch {
    receipt.failedChecks.push("receipt")
  }
  try {
    await host.restore(previous)
    receipt.rollback = "succeeded"
  } catch {
    receipt.rollback = "failed"
  }
  // Even an uncertain restore has observable results.
  receipt.reverification = await verify(host, previous, "restored")
  await record(
    receipt.rollback === "succeeded" &&
      receipt.reverification.every((c) =>
        !(host.previousChecks ?? host.rollbackChecks).includes(c.name) || c.status === "passed" ||
        receipt.baseline.some((b) => b.name === c.name && b.status === "failed")
      )
      ? "rolled-back"
      : "rollback-failed"
  )
  return receipt
}

/**
 * Close an interrupted run's receipt. Before publication nothing changed, so it is refused.
 * From "publishing" on the candidate may be live: restore the interrupted run's baseline.
 */
export async function reconcile(host: RolloutHost, interrupted: RolloutReceipt): Promise<RolloutReceipt> {
  const receipt: RolloutReceipt = { ...structuredClone(interrupted), failedChecks: [...interrupted.failedChecks, "interrupted"] }
  if (receipt.status === "captured" || receipt.status === "prepared") {
    await recorder(host, receipt)("refused")
    return receipt
  }
  if (!receipt.previous) {
    receipt.rollback = "failed"
    await recorder(host, receipt)("rollback-failed")
    return receipt
  }
  return restoreBaseline(host, receipt, receipt.previous)
}

/**
 * Failed deployment checks restore the baseline; upstream failures only fail the run.
 * An interrupted earlier run is reconciled first; a run that had to restore production publishes nothing.
 */
export async function rollout(host: RolloutHost): Promise<RolloutReceipt> {
  if (
    host.checks.length === 0 || host.previousChecks?.length === 0 || new Set(host.checks).size !== host.checks.length ||
    host.rollbackChecks.length === 0 || host.rollbackChecks.some((name) => !host.checks.includes(name))
  ) throw new Error("Required checks must be nonempty and unique")
  const startedAt = new Date().toISOString()
  const receipt: RolloutReceipt = {
    startedAt,
    updatedAt: startedAt,
    status: "captured",
    previous: null,
    candidate: null,
    baseline: [],
    checks: [],
    failedChecks: [],
    skippedChecks: host.skippedChecks ?? [],
    rollback: "not-needed",
    reverification: []
  }
  const record = recorder(host, receipt)
  let last: RolloutReceipt | null
  try {
    last = await host.lastReceipt()
  } catch {
    receipt.failedChecks = ["receipt"]
    await record("refused")
    return receipt
  }
  if (last && isInterrupted(last)) {
    const closed = await reconcile(host, last)
    if (closed.status !== "refused") return closed
  }
  let previous: Release
  try {
    previous = await host.capture()
    if (!previous.version || !previous.revision) throw new Error("A rollback target is required")
    receipt.previous = previous
  } catch {
    receipt.failedChecks = ["capture"]
    await record("refused")
    return receipt
  }
  await record("captured")
  receipt.baseline = await verify(host, previous, "baseline")
  await record("prepared")
  try {
    await host.beforePublish?.()
  } catch (error) {
    receipt.failedChecks = [error instanceof PublicationRefusal ? error.check : "deployment-changed"]
    await record("refused")
    return receipt
  }
  await record("publishing") // A storage failure here prevents publication.
  try {
    receipt.candidate = await host.publish()
    if (!receipt.candidate.version || !receipt.candidate.revision) throw new Error("Missing published identity")
    await record("checking")
    receipt.checks = await verify(host, receipt.candidate, "candidate")
    receipt.failedChecks = receipt.checks.filter((c) => c.status !== "passed").map((c) => c.name)
    if (!receipt.failedChecks.some((name) => host.rollbackChecks.includes(name))) {
      await record(receipt.failedChecks.length === 0 ? "passed" : "failed")
      return receipt
    }
  } catch {
    receipt.failedChecks.push(receipt.candidate?.version && receipt.candidate.revision ? "receipt" : "publish")
  }
  return restoreBaseline(host, receipt, previous)
}

/**
 * A prepublication gate can name its refusal in the durable receipt.
 *
 * @since 0.1.0
 * @category errors
 */
export class PublicationRefusal extends Error {
  constructor(readonly check: string) { super(check) }
}
