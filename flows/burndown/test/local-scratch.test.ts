/**
 * Local workers get disposable scratch the launcher removes, and one shared Go
 * build cache. A fake agent CLI on PATH stands in for codex so the test spends
 * no subscription while the real RunAgent action, local placement and shell run.
 */
import { NodeServices } from "@effect/platform-node"
import { Action, FlowRuntime } from "@smthrs/flow"
import { Duration, Effect, Layer } from "effect"
import assert from "node:assert/strict"
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import type { Assignment, WorkerResult } from "../schema.ts"

const root = await mkdtemp(join(tmpdir(), "burndown-local-scratch-"))
const home = join(root, "home")
const accounts = join(root, "accounts")
const bin = join(root, "bin")
const probe = join(root, "probe")
const saved = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  BURNDOWN_ACCOUNTS_DIR: process.env.BURNDOWN_ACCOUNTS_DIR
}
await mkdir(join(home, "smithers"), { recursive: true })
await mkdir(join(accounts, "codex-fixture"), { recursive: true })
await mkdir(bin, { recursive: true })
await mkdir(probe, { recursive: true })
const jwt = `h.${Buffer.from(JSON.stringify({ email: "fixture@example.test" })).toString("base64url")}.s`
await writeFile(join(accounts, "codex-fixture", "auth.json"), JSON.stringify({ tokens: { id_token: jwt } }))
const commit = "a".repeat(40)
await writeFile(
  join(bin, "codex"),
  `#!/bin/sh
cat >/dev/null
[ -d "$TMPDIR" ] || { echo "TMPDIR missing" >&2; exit 9; }
printf '%s\\n%s\\n' "$TMPDIR" "$GOCACHE" > "$BURNDOWN_PROBE/$BURNDOWN_PROBE_NAME"
mkdir -p "$TMPDIR/go-build-tmp" && head -c 1048576 /dev/zero > "$TMPDIR/go-build-tmp/blob"
[ "$BURNDOWN_PROBE_FAIL" = 1 ] && exit 3
[ "$BURNDOWN_PROBE_SLEEP" = 1 ] && sleep 30
echo '{"type":"item.completed","item":{"type":"agent_message","text":"READY ${commit}"}}'
echo '{"type":"turn.completed","usage":{}}'
`
)
await chmod(join(bin, "codex"), 0o755)
// layerLocal resolves the checkout and run directories from the home directory.
process.env.HOME = home
process.env.PATH = `${bin}:${saved.PATH}`
process.env.BURNDOWN_ACCOUNTS_DIR = accounts
process.env.BURNDOWN_PROBE = probe
const { layerLocal, layerRunAgent, RunAgent } = await import("../run-agent.ts")

const assignment = (n: number): Assignment => ({
  key: `smithers-${n}-r0`,
  repo: "smithersai/smithers",
  lead: { repo: "smithersai/smithers", n, title: "fixture" },
  extras: [],
  account: "codex-fixture",
  tool: "codex",
  model: "gpt-6.1-sol",
  attempt: 0,
  placement: "local"
})

const run = (input: Assignment, within?: Duration.Input) => {
  const handlers = new Map<string, (input: unknown) => { execute: Effect.Effect<unknown, unknown> }>()
  const runtime = {
    register: (declared: { _tag: string }, handler: never) => Effect.sync(() => handlers.set(declared._tag, handler))
  }
  const layer = layerRunAgent(() => "brief")
  return Effect.runPromise(
    Effect.gen(function*() {
      yield* Layer.build(
        (layer as Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>).pipe(Layer.provide([
          Action.layerImplementations,
          Layer.succeed(FlowRuntime.FlowRuntime, runtime as never)
        ]))
      )
      const handler = handlers.get(RunAgent.name)
      assert.ok(handler)
      return (yield* handler(input).execute.pipe(
        Effect.provideService(FlowRuntime.FlowInstance, { executionId: "local-scratch" } as never),
        Effect.provide(layerLocal)
      )) as WorkerResult
    }).pipe(
      (effect) => within === undefined ? effect : Effect.timeoutOption(effect, within),
      Effect.scoped,
      Effect.provide(NodeServices.layer)
    )
  )
}

const exists = (path: string) => stat(path).then(() => true, () => false)
const probed = async (name: string) => (await readFile(join(probe, name), "utf8")).trim().split("\n")

test.after(async () => {
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  await rm(root, { recursive: true, force: true })
})

for (const outcome of ["ready", "failed"] as const) {
  test(`a ${outcome} local run removes its scratch and keeps its brief and log`, async () => {
    const input = assignment(outcome === "ready" ? 1 : 2)
    process.env.BURNDOWN_PROBE_NAME = input.key
    process.env.BURNDOWN_PROBE_FAIL = outcome === "ready" ? "0" : "1"
    process.env.BURNDOWN_PROBE_SLEEP = "0"
    const result = await run(input)
    assert.equal(result.status, outcome)
    const stateDir = join(home, "Smithers-Ops/burndown/runs", input.key)
    const [scratch] = await probed(input.key)
    assert.ok(scratch!.startsWith(`${stateDir}/`), `scratch ${scratch} is not inside ${stateDir}`)
    assert.equal(await exists(scratch!), false)
    assert.equal(await readFile(join(stateDir, "brief.md"), "utf8"), "brief")
    assert.equal(await exists(join(stateDir, "agent.log")), true)
  })
}

test("separate local runs share one Go build cache outside their scratch", async () => {
  const inputs = [assignment(3), assignment(4)]
  process.env.BURNDOWN_PROBE_FAIL = "0"
  for (const input of inputs) {
    process.env.BURNDOWN_PROBE_NAME = input.key
    assert.equal((await run(input)).status, "ready")
  }
  const [[scratchA, cacheA], [scratchB, cacheB]] = await Promise.all(inputs.map((input) => probed(input.key)))
  assert.notEqual(scratchA, scratchB)
  assert.ok(cacheA)
  assert.equal(cacheA, cacheB)
  assert.ok(!cacheA.startsWith(join(home, "Smithers-Ops")), `Go cache ${cacheA} is per run`)
})

test("an interrupted local run removes its scratch", async () => {
  const input = assignment(5)
  process.env.BURNDOWN_PROBE_NAME = input.key
  process.env.BURNDOWN_PROBE_FAIL = "0"
  process.env.BURNDOWN_PROBE_SLEEP = "1"
  try {
    await run(input, "3 seconds")
  } finally {
    process.env.BURNDOWN_PROBE_SLEEP = "0"
  }
  const [scratch] = await probed(input.key)
  assert.ok(scratch!.startsWith(join(home, "Smithers-Ops/burndown/runs", input.key)))
  const deadline = Date.now() + 10_000
  while (await exists(scratch!) && Date.now() < deadline) await new Promise((done) => setTimeout(done, 100))
  assert.equal(await exists(scratch!), false)
})
