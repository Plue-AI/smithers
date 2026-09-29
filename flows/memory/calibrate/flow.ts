/**
 * `memory/calibrate` as a file flow: the weekly refit of the repository's
 * memory thresholds, one action a host implements with {@link layer}.
 */
import * as Memory from "@smthrs/agent/Memory"
import { Action, Flow } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { isAbsolute, relative, resolve, sep } from "node:path"
import * as Calibrate from "../calibrate.ts"
import { LandedFailed } from "../landed.ts"
import { ThresholdsInvalid } from "../thresholds.ts"

const Payload = {
  journals: Schema.optionalKey(Schema.String).annotate({ description: "Directory of *.jsonl run journals" }),
  journalPrefix: Schema.optionalKey(Schema.String).annotate({ description: "Only journals whose name starts so" }),
  landed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0), Schema.isLessThanOrEqualTo(Calibrate.maxLanded)).annotate({
    description: "Landed commits on main to evaluate"
  }),
  write: Schema.Boolean.annotate({ description: "Write .smithers/memory-thresholds.json" })
}

const Success = Schema.Struct({
  receipt: Calibrate.Receipt,
  evidence: Calibrate.Evidence,
  written: Schema.Boolean
})

const Failure = Schema.Union([ThresholdsInvalid, Calibrate.JournalInvalid, LandedFailed, Memory.MemoryFailed])

export const Run = Action.make("memory/calibrate/run", {
  payload: Payload,
  success: Success,
  error: Failure,
  nondeterministic: true
})

// Evaluating landed commits spawns jj and git and adds, moves and forgets a
// temporary jj workspace: it snapshots the root working copy and writes jj
// operations, and checks each commit's parent out under the OS temporary
// directory ($TMPDIR/memory-calibrate-*), outside the repository, deleted when
// the run ends. The comment sits outside the literal so static discovery
// projects the declared capabilities.
export default Flow.make("memory/calibrate", {
  description:
    "Refit the repository's memory thresholds from run journals and landed fixes; report recall at 32 KiB and each decision's outcome.",
  capabilities: [
    "fs:read:**",
    "fs:write:.smithers/**",
    "fs:write:.jj/**",
    "proc:spawn:jj *",
    "proc:spawn:git *",
    "model:call:typesafe-ai/jev"
  ],
  effects: {
    reads: ["**"],
    writes: [".smithers/memory-thresholds.json", ".smithers/memory-thresholds.receipt.json", ".jj/**"],
    mode: "expected",
    onConflict: "serialize",
    tier: "irreversible"
  },
  payload: Payload,
  success: Success,
  error: Failure,
  body: (input) => Run.call(input)
})

/**
 * `journals` resolved against `root`; a path outside the repository is
 * {@link Calibrate.JournalInvalid}. The flow declares repository-relative
 * reads only, so it never reads the user's home; the CLI (`main.ts
 * --journals`) calls `Calibrate.run` directly and reads a session directory
 * outside the repository with the caller's own authority.
 */
export const journalsUnder = (root: string, journals: string) => {
  const path = resolve(root, journals)
  const inside = relative(resolve(root), path)
  return inside.split(sep)[0] === ".." || isAbsolute(inside)
    ? Effect.fail(new Calibrate.JournalInvalid({ path, message: "outside the repository" }))
    : Effect.succeed(path)
}

/** The implementation of {@link Run} over `root`. */
export const layer = (root: string) =>
  Run.toLayer((input) =>
    Effect.map(
      Effect.flatMap(
        input.journals === undefined ? Effect.succeed(undefined) : journalsUnder(root, input.journals),
        (journals) =>
          Calibrate.run({
            root,
            journals,
            journalPrefix: input.journalPrefix,
            landed: input.landed,
            write: input.write
          })
      ),
      ({ evidence, receipt, written }) => ({ receipt, evidence, written })
    )
  )
