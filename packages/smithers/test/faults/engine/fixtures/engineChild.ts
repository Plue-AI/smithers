/**
 * The engine incarnation the crash family kills.
 *
 * A test cannot `SIGKILL` itself, so the engine under the fault has to be a
 * separate operating-system process with its own pid. This is that process. It
 * opens the real SQLite file, builds the production Node host, and executes the
 * flow — or, in `probe` mode, proves it can do all of that and exits without
 * executing anything.
 *
 * The protocol on stdout is two lines and nothing else:
 *
 * - `SMITHERS_ENGINE_HANDSHAKE=<phase>:<nonce>` — printed before any work. The
 *   phase is `probe` or `execute`, and they are distinct on purpose: an
 *   admission probe must never be replayable as evidence that a flow ran.
 * - `PROBE_STATUS=ok` (probe) or `RESULT_STATUS=<status>` (execute).
 *
 * Usage:
 *   node engineChild.ts <filename> <executionId> <probe|execute> <markerDir> \
 *     <counterFile> <secondSleepMs> <nonce> <hostId>
 */
import * as NodeRuntime from "@smthrs/flows/NodeRuntime"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import * as Layer from "effect/Layer"
import { type FlowOptions, host, KillResume } from "../harness/killResumeFlow.ts"

const fail = (message: string): never => {
  process.stderr.write(`engineChild: ${message}\n`)
  process.exit(2)
}

const [filename, executionId, mode, markerDir, counterFile, sleepArg, nonce, hostId, crossing] = process.argv.slice(2)

if (
  filename === undefined || executionId === undefined || markerDir === undefined ||
  counterFile === undefined || sleepArg === undefined || nonce === undefined || hostId === undefined
) {
  fail(
    "usage: engineChild.ts <filename> <executionId> <probe|execute> <markerDir> <counterFile> <sleepMs> <nonce> <hostId>"
  )
}
if (mode !== "probe" && mode !== "execute") fail(`invalid mode ${String(mode)}`)
if (
  crossing !== undefined && crossing !== "default" && crossing !== "keyed-write" && crossing !== "sealed-check" &&
  crossing !== "keyless-shell"
) fail(`invalid crossing ${crossing}`)

const options: FlowOptions = {
  filename: filename as string,
  markerDir: markerDir as string,
  counterFile: counterFile as string,
  secondSleepMs: Number(sleepArg),
  hostId: hostId as string,
  ...(crossing === "keyed-write" || crossing === "sealed-check" || crossing === "keyless-shell" ? { crossing } : {})
}

const probe = Effect.void.pipe(
  Effect.provide(NodeRuntime.layerHost({
    filename: options.filename,
    workspaceRoot: options.markerDir,
    owner: { hostId: options.hostId },
    signals: []
  }, Layer.empty)),
  Effect.scoped
)

const execute = KillResume.execute({ label: "kill-resume" }, { executionId: executionId as string }).pipe(
  Effect.provide(host(options)),
  Effect.scoped,
  Effect.exit
)

if (mode === "probe") {
  process.stdout.write(`SMITHERS_ENGINE_HANDSHAKE=probe:${nonce}\n`)
  // Building the host migrates the database and stands up every store, which
  // is the whole admission claim: this runner can execute the product. No
  // marker is written, no counter line is appended, and no flow runs.
  await Effect.runPromise(probe)
  process.stdout.write("PROBE_STATUS=ok\n")
  process.exit(0)
}

process.stdout.write(`SMITHERS_ENGINE_HANDSHAKE=execute:${nonce}\n`)
const exit = await Effect.runPromise(execute)
if (Exit.isSuccess(exit)) {
  process.stdout.write(`RESULT_STATUS=succeeded ${exit.value}\n`)
  process.exit(0)
}
process.stdout.write(`RESULT_STATUS=failed\n`)
process.stderr.write(`${String(exit.cause)}\n`)
process.exit(1)
