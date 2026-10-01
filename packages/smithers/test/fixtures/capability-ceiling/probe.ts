/** One action that reaches for every guarded host service and reports each outcome. */
import { Action } from "@smthrs/flow"
import { Jj } from "@smthrs/jj"
import { Effect, FileSystem, Schema, Stream } from "effect"
import { HttpClient } from "effect/unstable/http/HttpClient"
import * as ChildProcess from "effect/unstable/process/ChildProcess"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"

export const Payload = Schema.Struct({ marker: Schema.String, written: Schema.String, url: Schema.String })
export const Outcomes = Schema.Struct({
  spawn: Schema.String,
  write: Schema.String,
  jj: Schema.String,
  http: Schema.String
})

const outcome = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.as("ok"),
    Effect.catchCause((cause) => Effect.succeed(`failed: ${String(cause)}`))
  )

export const probe = (name: string) => {
  const Probe = Action.make(`${name}/probe`, {
    payload: Payload,
    success: Outcomes,
    nondeterministic: true,
    // Compensable, so the engine takes its own step snapshot around the
    // action: bookkeeping the ceiling must not refuse.
    tier: "compensable"
  })
  // Resolved per call, from the context the engine runs the action in: that is
  // the context whose services the capability ceiling must reach.
  const layer = Probe.toLayer(({ marker, url, written }) =>
    Effect.gen(function*() {
      // The child reports that it ran before it tries to write: the confined
      // child's own write is the filesystem grant's to refuse, not the spawn's.
      const spawn = yield* Effect.scoped(Effect.gen(function*() {
        const spawner = yield* ChildProcessSpawner
        const child = yield* spawner.spawn(ChildProcess.make("sh", ["-c", `echo ran; touch '${marker}'`]))
        const [stdout, code] = yield* Effect.all([
          child.stdout.pipe(Stream.decodeText(), Stream.mkString),
          child.exitCode
        ], { concurrency: "unbounded" })
        return `exit ${code}: ${stdout.trim()}`
      })).pipe(Effect.catchCause((cause) => Effect.succeed(`failed: ${String(cause)}`)))
      const write = yield* outcome(Effect.flatMap(FileSystem.FileSystem, (fs) => fs.writeFileString(written, "x")))
      const jj = yield* outcome(Effect.flatMap(Jj, (service) => service.snapshot("capability-ceiling probe")))
      const http = yield* outcome(Effect.flatMap(HttpClient, (client) => client.get(url)))
      return { spawn, write, jj, http }
    })
  )
  return { Probe, layer }
}
