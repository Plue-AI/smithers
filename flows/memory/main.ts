/**
 * `node --experimental-strip-types flows/memory/main.ts calibrate --root <repo>
 *   [--journals <dir>] [--journal-prefix <prefix>] [--landed <N>] [--write]`
 *
 * Runs `memory/calibrate` once and prints its receipt as JSON. `--journals`
 * may name any directory, such as the TUI's `~/.smithers/tui/sessions`,
 * which is read recursively; the flow's payload is limited to the
 * repository. Without
 * `--write` it writes no thresholds. `--landed` above 0 evaluates each commit
 * in a temporary jj workspace outside the repository: adding it snapshots the
 * root working copy, each commit adds jj operations, and the workspace is
 * forgotten and deleted afterwards, on Ctrl-C too. Jev is the Vercel AI Gateway when
 * `AI_GATEWAY_API_KEY` is set, falling back to the host's subscription judge
 * when the gateway is unreachable or slow; the host judge alone otherwise.
 */
import * as NodeRuntime from "@effect/platform-node/NodeRuntime"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as EvaluatorBackup from "@smthrs/model/EvaluatorBackup"
import { Effect, Layer, Redacted } from "effect"
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient"
import { resolve } from "node:path"
import { parseArgs } from "node:util"
import * as GrantStore from "../../packages/smithers/flows/kernel/src/GrantStore.ts"
import * as KernelHttpClient from "../../packages/smithers/flows/kernel/src/HttpClient.ts"
import { evaluatorLayer } from "../repository/jev-checks.ts"
import * as Calibrate from "./calibrate.ts"

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    root: { type: "string" },
    journals: { type: "string" },
    "journal-prefix": { type: "string" },
    landed: { type: "string", default: "0" },
    write: { type: "boolean", default: false }
  }
})

if (positionals[0] !== "calibrate" || values.root === undefined) {
  process.stderr.write(
    "usage: main.ts calibrate --root <repo> [--journals <dir>] [--journal-prefix <p>] [--landed <N>] [--write]\n"
  )
  process.exit(2)
}
const landed = Number(values.landed)
if (!Number.isSafeInteger(landed) || landed < 0 || landed > Calibrate.maxLanded) {
  process.stderr.write(`--landed must be an integer from 0 to ${Calibrate.maxLanded}\n`)
  process.exit(2)
}

const host = evaluatorLayer(process.env)
const key = process.env.AI_GATEWAY_API_KEY
const judge: Layer.Layer<Evaluator.Evaluator> = key === undefined || key === ""
  ? host
  : Layer.effect(
    Evaluator.Evaluator,
    Effect.gen(function*() {
      const gateway = yield* Effect.provide(
        Effect.service(Evaluator.Evaluator),
        Evaluator.layerVercelGateway({ apiKey: Redacted.make(key) }).pipe(
          Layer.provide(KernelHttpClient.layer),
          // eslint-disable-next-line no-restricted-syntax -- Jev HTTP only, as apps/tui/src/host.ts binds it
          Layer.provide(GrantStore.layerNoop),
          Layer.provide(FetchHttpClient.layer)
        )
      )
      const backup = yield* Effect.provide(Effect.service(Evaluator.Evaluator), host)
      return EvaluatorBackup.withFallback(gateway, backup)
    })
  )

// runMain interrupts the fiber on SIGINT, so the workspace finalizer runs.
NodeRuntime.runMain(
  Calibrate.run({
    root: resolve(values.root),
    journals: values.journals === undefined ? undefined : resolve(values.journals),
    journalPrefix: values["journal-prefix"],
    landed,
    write: values.write
  }).pipe(
    Effect.tap((result) =>
      Effect.sync(() =>
        process.stdout.write(
          `${JSON.stringify({ ...result.receipt, evidence: result.evidence, written: result.written }, null, 2)}\n`
        )
      )
    ),
    Effect.provide(Layer.merge(NodeServices.layer, judge))
  )
)
