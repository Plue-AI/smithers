// Holds one agent microVM until killed: node vm-hold.ts <session>
import { Effect } from "effect"
import { make, sh } from "../vm.ts"

await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const session = yield* make({ refresh: false }).acquire(process.argv[2] ?? `hold-${process.pid}`)
  process.stdout.write(`ready ${session.remoteId}\n`)
  yield* sh(session, "sleep 100000")
})))
