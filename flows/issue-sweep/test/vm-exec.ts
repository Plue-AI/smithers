/**
 * Runs one shell line in a fresh agent microVM, booted and refreshed exactly
 * as a work flow's is, and prints its exit code and output:
 *   node flows/issue-sweep/test/vm-exec.ts 'go version && cargo --version'
 */
import { Effect } from "effect"
import { make, sh } from "../vm.ts"

const line = process.argv[2] ?? "true"
const ran = await Effect.runPromise(Effect.scoped(Effect.gen(function*() {
  const session = yield* make({ maxVms: 1 }).acquire(`vm-exec-${process.pid}`)
  return yield* sh(session, line)
})))
process.stdout.write(ran.stdout)
process.stderr.write(ran.stderr)
process.exitCode = ran.code
