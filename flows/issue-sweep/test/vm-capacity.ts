/**
 * Capacity benchmark: N agent microVMs at once, each running an agent-shaped
 * workload (offline pnpm install, a vitest suite plus a tsc typecheck, a 256 MiB
 * write, a jj change).
 *   node flows/issue-sweep/test/vm-capacity.ts <N> [memoryMib] [cpus] [bootConcurrency]
 * HOLD=<seconds> keeps every microVM alive, idle, until all N have finished the
 * workload and then for that long, so the host holds all N at once.
 * Prints one JSON line: wall time, per-VM acquire/work percentiles, failures.
 * Host load, memory and swap are sampled separately (see vm-capacity.sh).
 */
import { Deferred, Effect } from "effect"
import { make, sh } from "../vm.ts"

const n = Number(process.argv[2] ?? 8)
const memoryMib = Number(process.argv[3] ?? 3072)
const cpus = Number(process.argv[4] ?? 2)
const bootConcurrency = Number(process.argv[5] ?? 8)
export const workload = [
  "set -e",
  "cd /home/developer/workspace",
  "t0=$(date +%s.%N)",
  "CI=1 pnpm install --offline --frozen-lockfile --reporter=silent",
  "t1=$(date +%s.%N)",
  "(cd packages/smithers/flows/sandbox && pnpm exec vitest run test/RootedPath.test.ts test/GuestPath.test.ts test/Sandbox.test.ts test/FanOut.test.ts test/ResourceLimits.test.ts --reporter=dot --coverage.enabled=false >/tmp/vitest.log 2>&1) || { tail -20 /tmp/vitest.log >&2; exit 3; }",
  "(cd packages/smithers/flows/sandbox && pnpm exec tsc -p tsconfig.test.json --noEmit >/tmp/tsc.log 2>&1) || { tail -5 /tmp/tsc.log >&2; exit 4; }",
  "t2=$(date +%s.%N)",
  "dd if=/dev/urandom of=/home/developer/blob bs=1M count=256 status=none && sync",
  "echo '// capacity probe' >> README.md && jj diff --stat >/dev/null && jj describe -m probe --quiet",
  "t3=$(date +%s.%N)",
  "echo \"$t0 $t1 $t2 $t3\""
].join("\n")

const hold = Number(process.env.HOLD ?? 0)
const allDone = Effect.runSync(Deferred.make<void>())
let done = 0
const provider = make({ maxVms: n, memoryMib, cpus, bootConcurrency, refresh: false })
const started = Date.now()
const results = await Effect.runPromise(Effect.forEach(
  Array.from({ length: n }, (_, index) => index),
  (index) =>
    Effect.scoped(Effect.gen(function*() {
      const t = Date.now()
      const session = yield* provider.acquire(`capacity-${n}-${index}-${started}`)
      const acquired = (Date.now() - t) / 1000
      const ran = yield* sh(session, workload)
      const [t0, t1, t2, t3] = ran.stdout.trim().split(" ").map(Number)
      if (hold > 0) {
        if (++done === n) yield* Deferred.succeed(allDone, undefined)
        yield* Deferred.await(allDone)
        yield* sh(session, `sleep ${hold}`)
      }
      return ran.code === 0
        ? { ok: true, acquired, install: t1! - t0!, test: t2! - t1!, disk: t3! - t2!, total: (Date.now() - t) / 1000 }
        : { ok: false, acquired, error: `exit ${ran.code}: ${ran.stderr.trim().split("\n").slice(-3).join(" | ")}` }
    })).pipe(Effect.catchCause((cause) => Effect.succeed({ ok: false, error: String(cause).slice(0, 1500) }))),
  { concurrency: "unbounded" }
))
const wall = (Date.now() - started) / 1000
const okRuns = results.filter((r): r is Extract<typeof r, { ok: true }> => r.ok && "test" in r)
const pct = (values: Array<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted.length === 0
    ? null
    : Number(sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))]!.toFixed(1))
}
const stat = (key: "acquired" | "install" | "test" | "disk" | "total") => ({
  p50: pct(okRuns.map((r) => r[key]), 0.5),
  p95: pct(okRuns.map((r) => r[key]), 0.95),
  max: pct(okRuns.map((r) => r[key]), 1)
})
process.stdout.write(`${
  JSON.stringify({
    n,
    memoryMib,
    cpus,
    bootConcurrency,
    wall,
    ok: okRuns.length,
    failed: n - okRuns.length,
    acquired: stat("acquired"),
    install: stat("install"),
    test: stat("test"),
    disk: stat("disk"),
    total: stat("total"),
    errors: results.filter((r) => !r.ok).map((r) => "error" in r ? r.error : "").slice(0, 5)
  })
}\n`)
