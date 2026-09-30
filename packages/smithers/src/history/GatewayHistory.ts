/**
 * The gateway's `Run.Fork` and `Run.Verify`, served by the host that owns the
 * project's stores over the same history library `smthrs runs fork` and
 * `smthrs runs verify` use, so every surface forks one way and reads one
 * report.
 *
 * @since 1.0.0
 */

import * as RunHistory from "@smthrs/gateway/RunHistory"
import * as Redaction from "@smthrs/journal/Redaction"
import { Effect, Layer } from "effect"
import { homedir, tmpdir } from "node:os"
import { resolve } from "node:path"
import * as CliError from "../CliError.ts"
import * as Failure from "../internal/Failure.ts"
import * as History from "./History.ts"
import * as Verify from "./Verify.ts"

/**
 * How long a served verification may take to stop replaying. A person is
 * waiting on the answer through a relay, so it is shorter than the CLI's.
 *
 * @since 1.0.0
 * @category constants
 */
export const verifyWithin = "2 minutes"

/**
 * A sentence that names no path of the host: the project reads as `.`, and
 * the scratch and home directories as `<tmp>` and `~`. The caller of a served
 * gateway may be on another machine, and the layout of this one is not its
 * business.
 */
const hostless = (root: string, sentence: string): string =>
  ([[resolve(root), "."], [tmpdir(), "<tmp>"], [homedir(), "~"]] as const)
    // The filesystem root names nothing about this host and is in every path.
    .filter(([path]) => path.length > 1)
    .reduce((text, [path, name]) => text.split(path).join(name), sentence)

/** The refusal's own stable code (a `CliError.Refused`, a control or store error), else `history_failed`. */
const codeOf = (cause: Error): string => {
  const code = (cause as { readonly code?: unknown }).code
  return cause instanceof CliError.Refused || (typeof code === "string" && code !== "")
    ? String(code)
    : "history_failed"
}

/**
 * A designed refusal as the wire refusal, with the code and sentence the CLI
 * prints for it; anything else is a defect the gateway reports generically.
 */
const served = <A>(
  root: string,
  body: (signal: AbortSignal) => Promise<A>
): Effect.Effect<A, RunHistory.HistoryRefused> =>
  Effect.tryPromise({ try: body, catch: (cause) => cause }).pipe(
    Effect.catch((cause) =>
      Failure.isDesigned(cause)
        ? Effect.fail(
          new RunHistory.HistoryRefused({
            code: codeOf(cause),
            message: hostless(root, String(Redaction.redactDiagnostic(Failure.operatorSentence(cause))))
          })
        )
        : Effect.die(cause)
    )
  )

/** A report step on the wire: only the fields it names. */
const step = (value: Verify.Step): RunHistory.Step => ({
  stepKeyDigest: value.stepKeyDigest,
  ...(value.action === undefined ? {} : { action: value.action }),
  ...(value.node === undefined ? {} : { node: value.node })
})

/**
 * The history library the service calls: `smthrs runs fork` and
 * `smthrs runs verify`'s own entry points unless a test supplies others.
 *
 * @since 1.0.0
 * @category models
 */
export interface Ports {
  readonly mutate: typeof History.mutate
  readonly verify: typeof Verify.verify
}

const library: Ports = { mutate: History.mutate, verify: Verify.verify }

/**
 * The history service over the project at `root`.
 *
 * @since 1.0.0
 * @category constructors
 */
export const make = (root: string, options: Verify.Options = {}, ports: Ports = library): RunHistory.Service => ({
  fork: (input) =>
    served(root, async (signal) => {
      const forked = await ports.mutate(
        root,
        input.runId,
        {
          sequence: input.at,
          ...(input.lineage === undefined ? {} : { lineage: input.lineage }),
          ...(input.step === undefined ? {} : { override: input.step })
        },
        "fork",
        signal
      )
      return { runId: forked.runId, parentRunId: input.runId, status: "parked" as const }
    }),
  verify: (input) =>
    served(root, async (signal) => {
      const report = await ports.verify(root, input.runId, { settleWithin: verifyWithin, ...options }, signal)
      return {
        runId: report.runId,
        verdict: report.verdict,
        replayed: report.replayed.map(step),
        ...(report.resumes === undefined ? {} : { resumes: step(report.resumes) }),
        ...(report.executes === undefined ? {} : { executes: step(report.executes) }),
        notReplayed: report.notReplayed.map(step)
      }
    })
})

/**
 * The history service over the project at `root`, as the layer `smthrs serve`
 * provides to its gateway.
 *
 * @since 1.0.0
 * @category layers
 */
export const layer = (root: string, options: Verify.Options = {}): Layer.Layer<RunHistory.RunHistory> =>
  Layer.succeed(RunHistory.RunHistory)(make(root, options))
