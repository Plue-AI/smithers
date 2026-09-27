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
    | "refused"
    | "rolled-back"
    | "rollback-failed"
  previous: Release
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
  checks: ReadonlyArray<string>
  previousChecks?: ReadonlyArray<string>
  skippedChecks?: ReadonlyArray<string>
  capture(): Promise<Release>
  beforePublish?(): Promise<void>
  publish(): Promise<Release>
  check(name: string, release: Release, phase: Phase): Promise<{ status: "passed" | "failed" }>
  restore(release: Release): Promise<void>
  record(receipt: RolloutReceipt): Promise<void>
}

/** No judgment: every required failure, including exceptions, restores the captured release. */
export async function rollout(host: RolloutHost): Promise<RolloutReceipt> {
  if (
    host.checks.length === 0 || host.previousChecks?.length === 0 || new Set(host.checks).size !== host.checks.length
  ) throw new Error("Required checks must be nonempty and unique")
  const previous = await host.capture()
  if (!previous.version || !previous.revision) throw new Error("A rollback target is required")
  const startedAt = new Date().toISOString()
  const receipt: RolloutReceipt = {
    startedAt,
    updatedAt: startedAt,
    status: "captured",
    previous,
    candidate: null,
    baseline: [],
    checks: [],
    failedChecks: [],
    skippedChecks: host.skippedChecks ?? [],
    rollback: "not-needed",
    reverification: []
  }
  const record = async (status: RolloutReceipt["status"]) => {
    receipt.status = status
    receipt.updatedAt = new Date().toISOString()
    await host.record(receipt)
  }
  const verify = async (release: Release, phase: Phase): Promise<Array<CheckResult>> => {
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
  await record("captured")
  receipt.baseline = await verify(previous, "baseline")
  if (receipt.baseline.some((c) => c.status !== "passed")) {
    receipt.failedChecks = receipt.baseline.filter((c) => c.status !== "passed").map((c) => c.name)
    await record("refused")
    return receipt
  }
  await record("prepared")
  try {
    await host.beforePublish?.()
  } catch {
    receipt.failedChecks = ["deployment-changed"]
    await record("refused")
    return receipt
  }
  await record("publishing") // A storage failure here prevents publication.
  try {
    receipt.candidate = await host.publish()
    if (!receipt.candidate.version || !receipt.candidate.revision) throw new Error("Missing published identity")
    await record("checking")
    receipt.checks = await verify(receipt.candidate, "candidate")
    receipt.failedChecks = receipt.checks.filter((c) => c.status !== "passed").map((c) => c.name)
    if (receipt.failedChecks.length === 0) {
      await record("passed")
      return receipt
    }
  } catch {
    receipt.failedChecks.push(receipt.candidate?.version && receipt.candidate.revision ? "receipt" : "publish")
  }
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
  // Even an uncertain restore has observable results. Never recursively roll forward.
  receipt.reverification = await verify(previous, "restored")
  await record(
    receipt.rollback === "succeeded" && receipt.reverification.every((c) => c.status === "passed")
      ? "rolled-back"
      : "rollback-failed"
  )
  return receipt
}
