/**
 * The operator's status at a glance: one count line, then one line for each
 * run that is not done — parked ones with the gate to answer, then failed,
 * then running.
 */
import type { RunView } from "../client.ts"

type Bucket = "running" | "parked" | "failed" | "done"

const bucketOf = (status: string): Bucket => {
  if (status === "completed") return "done"
  if (status === "failed" || status === "cancelled") return "failed"
  if (status.startsWith("waiting-") || status === "suspended") return "parked"
  return "running"
}

const order: ReadonlyArray<Bucket> = ["parked", "failed", "running"]

/** The lines `status` prints for `runs`. */
export const glance = (runs: ReadonlyArray<RunView>): Array<string> => {
  if (runs.length === 0) return ["no runs"]
  const counts: Record<Bucket, number> = { running: 0, parked: 0, failed: 0, done: 0 }
  for (const run of runs) counts[bucketOf(run.status)]++
  const lines = [`running ${counts.running}  parked ${counts.parked}  failed ${counts.failed}  done ${counts.done}`]
  for (const bucket of order) {
    for (const run of runs.filter((candidate) => bucketOf(candidate.status) === bucket)) {
      lines.push(`${run.status === "cancelled" ? "cancelled" : bucket.padEnd(7)} ${run.runId}  ${run.flowId}`)
      for (const gate of run.gates) {
        lines.push(`        answer ${gate.gateId} approve|decline  ${gate.prompt.split("\n")[0]}`)
      }
    }
  }
  return lines
}
