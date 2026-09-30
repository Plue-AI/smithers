import { Action, FlowRuntime, Interpreter, Sleep } from "@smthrs/flow"
import { Effect, Layer, Schema } from "effect"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import * as filesystem from "node:fs/promises"
import { hostname } from "node:os"
import { mock, test } from "node:test"
import { fileURLToPath } from "node:url"

if (!process.execArgv.includes("--experimental-test-module-mocks")) {
  test("burndown action behavior in an isolated host", () => {
    const child = spawnSync(process.execPath, [
      "--experimental-strip-types",
      "--experimental-test-module-mocks",
      "--test",
      fileURLToPath(import.meta.url)
    ], { encoding: "utf8" })
    assert.equal(child.status, 0, child.stdout + child.stderr)
  })
} else {
  const writes: Array<{ path: string; value: string }> = []
  const claims: Array<Array<string>> = []
  let ownership = { mine: true, holder: { host: hostname() } }
  const starts: Array<{ assignment: unknown; options: unknown }> = []
  let pollFailure = false
  let accountReadings: Array<unknown> = []
  const queue: Array<{ results: unknown; workers: unknown }> = []
  // GitHub claims and detached workers are external boundaries: fixtures avoid
  // spending subscriptions or changing live claims while exercising host policy.
  const executeClaim = (_command: string, args: Array<string>) => {
    claims.push(args)
    return Promise.resolve({ stdout: args[1] === "check" ? JSON.stringify(ownership) : "{}", stderr: "" })
  }
  Object.defineProperty(executeClaim, Symbol.for("nodejs.util.promisify.custom"), {
    value: executeClaim,
    configurable: true
  })
  mock.module("node:child_process", { namedExports: { execFile: executeClaim } })
  mock.module("../burndown/worker/flow.ts", {
    defaultExport: {
      ensure: (assignment: unknown, options: unknown) =>
        Effect.sync(() => {
          starts.push({ assignment, options })
          return `execution-${starts.length}`
        }),
      poll: () => pollFailure ? Effect.fail({ _tag: "FlowExecutionNotFound", executionId: "missing-worker" }) : Effect.succeed({ _tag: "None" })
    }
  })
  mock.module("../burndown/land.ts", {
    namedExports: {
      landAll: (results: Array<{ key: string }>, workers: unknown) =>
        Effect.sync(() => {
          queue.push({ results, workers })
          return { landed: results.map((r) => r.key), quarantined: [] }
        })
    }
  })
  mock.module("../burndown/accounts.ts", {
    namedExports: {
      discoverAccounts: async () => ({ accounts: [] }),
      readAccounts: async () => accountReadings
    }
  })
  mock.module("../burndown/issues.ts", {
    namedExports: {
      issueKey: (repo: string, n: number) => `${repo}#${n}`,
      selectCandidates: () => Effect.succeed({ candidates: [], openIssues: 0, pending: false })
    }
  })
  // External filesystem receipts are isolated: these unit tests exercise the real
  // action registrations without modifying the live burndown's operational files.
  mock.module("node:fs/promises", {
    namedExports: {
      ...filesystem,
      mkdir: async () => undefined,
      writeFile: async (path: string, value: string) => {
        writes.push({ path, value })
      },
      readFile: async () => "[]",
      readdir: async () => []
    }
  })
  const { layer } = await import("../burndown/host.ts")
  const { Settle, Launch, Land, Observe } = await import("../burndown/round.ts")
  const { RoundState, Settlement } = await import("../burndown/schema.ts")

  const assignment = {
    key: "smithers-2950-worker",
    repo: "smithersai/smithers",
    lead: { repo: "smithersai/smithers", n: 2950, title: "Fix queue" },
    extras: [{ repo: "smithersai/smithers", n: 2951, title: "Bundled fix" }],
    account: "codex-1",
    tool: "codex" as const,
    model: "gpt-6.1-sol",
    attempt: 0,
    placement: "local" as const
  }
  const result = {
    key: assignment.key,
    status: "ready" as const,
    commits: [{ issue: 2950, commit: "a".repeat(40) }, { issue: 2951, commit: "b".repeat(40) }],
    notes: "READY",
    agentHours: 1
  }
  const ready = { assignment, result }
  const initial = () =>
    Schema.decodeUnknownSync(RoundState)({
      options: { repos: [assignment.repo], placement: "local", maxAgents: 4, tickMinutes: 1 },
      round: 0,
      target: 4,
      inFlight: [],
      ready: [],
      quarantined: [],
      readings: {},
      rates: {},
      history: {},
      landed: 0
    })
  const observation = () => ({
    now: Date.now(),
    target: 4,
    candidates: [],
    openIssues: 0,
    inFlight: [],
    finished: [],
    capacity: [],
    exhausted: false,
    earliestReset: null,
    pending: false,
    readings: {},
    rates: {}
  })

  const settle = async (
    state: typeof RoundState.Type,
    finished = observation(),
    landed = { landed: [] as Array<string>, quarantined: [] as Array<{ key: string; error: string }> },
    launched: typeof RoundState.Type["inFlight"] = []
  ) => {
    return Schema.decodeUnknownSync(Settlement)(
      await invoke(
        Settle.name,
        Schema.decodeUnknownSync(Settle.payloadSchema)({
          state,
          observation: finished,
          plan: { launches: [], nextTarget: -1, note: "idle" },
          launched,
          landed
        })
      )
    )
  }

  const invoke = async (name: string, input: unknown) => {
    const handlers = new Map<string, (input: unknown) => { execute: Effect.Effect<unknown, unknown> }>()
    const runtime = {
      register: (declared: { _tag: string }, handler: never) => Effect.sync(() => handlers.set(declared._tag, handler))
    }
    return Effect.runPromise(
      Effect.gen(function*() {
        yield* Layer.build(
          (layer as Layer.Layer<never, never, Action.Implementations | FlowRuntime.FlowRuntime>).pipe(Layer.provide([
            Action.layerImplementations,
            Layer.succeed(FlowRuntime.FlowRuntime, runtime as never)
          ]))
        )
        const handler = handlers.get(name)
        assert.ok(handler)
        return yield* handler(input).execute.pipe(
          Effect.provideService(FlowRuntime.FlowInstance, { executionId: "recovery-round" } as never)
        )
      }).pipe(Effect.scoped)
    )
  }


  test("partial READY is quarantined intact rather than killing the persisted round", async () => {
    const partial = { ...result, commits: result.commits.slice(0, 1), notes: "extra BLOCKED" }
    const state = { ...initial(), inFlight: [{ assignment, executionId: "partial-worker", startedAt: 0 }] }
    const settled = await settle(state, { ...observation(), finished: [partial] } as never)
    assert.equal(settled.done, false)
    assert.deepEqual(settled.next.ready, [])
    assert.deepEqual(settled.next.inFlight, [])
    assert.deepEqual(settled.next.quarantined[0]!.assignment, assignment)
    assert.deepEqual(settled.next.quarantined[0]!.result, partial)
    assert.match(settled.next.quarantined[0]!.error, /incomplete|READY|bundle/i)
    assert.doesNotThrow(() => Schema.decodeUnknownSync(RoundState)(JSON.parse(JSON.stringify(settled.next))))
  })

  test("unknown worker poll frees its slot and retains failure diagnostics for retry", async () => {
    const state = { ...initial(), inFlight: [{ assignment, executionId: "missing-worker", startedAt: Date.now() - 1000 }] }
    pollFailure = true
    try {
      const observed = await invoke(Observe.name, { state }) as typeof Observe.successSchema.Type
      assert.deepEqual(observed.inFlight, [])
      assert.equal(observed.finished[0]!.status, "failed")
      assert.match(observed.finished[0]!.notes, /FlowExecutionNotFound|missing-worker/)
      const settled = await settle(state, observed as never)
      const history = settled.next.history as Record<string, { attempts: number; notes: string }>
      assert.equal(history[`${assignment.repo}#2950`]!.attempts, 1)
      assert.match(history[`${assignment.repo}#2950`]!.notes, /FlowExecutionNotFound|missing-worker/)
    } finally { pollFailure = false }
  })

  test("READY landing refuses another owner's claims and keeps the queue receipt", async () => {
    queue.length = 0
    claims.length = 0
    ownership = { mine: false, holder: { host: hostname() } }
    try {
      const state = { ...initial(), ready: [ready] }
      const landed = await invoke(Land.name, { state, observation: observation() }) as typeof Land.successSchema.Type
      assert.equal(queue.length, 0)
      assert.deepEqual((await settle(state, observation(), landed)).next.ready, [ready])
      assert.equal(claims.some((args) => args[1] === "claim"), false)
    } finally { ownership = { mine: true, holder: { host: hostname() } } }
  })

  test("quarantine persists while cooldown prevents repeated immediate repair admission", async () => {
    const settled = await settle({ ...initial(), ready: [ready] }, observation(), { landed: [], quarantined: [{ key: assignment.key, error: "conflict" }] })
    const history = settled.next.history as Record<string, { attempts: number; last: number }>
    assert.equal(history[`${assignment.repo}#2950`]!.attempts, 1)
    assert.equal(history[`${assignment.repo}#2951`]!.attempts, 1)
    const waiting = await invoke(Observe.name, { state: settled.next }) as typeof Observe.successSchema.Type
    assert.deepEqual(waiting.candidates, [])
    assert.equal((await settle(settled.next, waiting as never)).done, false)
    const cooled = { ...settled.next, history: Object.fromEntries(Object.entries(history).map(([key, value]) => [key, { ...value, last: Date.now() / 1000 - 3 * 3600 - 1 }])) }
    const eligible = await invoke(Observe.name, { state: cooled }) as typeof Observe.successSchema.Type
    assert.equal(eligible.candidates.length, 1)
    assert.equal(eligible.candidates[0]!.fix, "conflict")
    assert.deepEqual(eligible.candidates[0]!.extras, assignment.extras)
  })

  test("an idle round retains READY work and cannot finish while the queue is disabled", async () => {
    const state = { ...initial(), ready: [ready] }
    const settled = await settle(state)
    assert.deepEqual(settled.next.ready, [ready])
    assert.equal(settled.done, false)
  })

  test("quarantine retains the complete assignment and worker receipt after in-flight work ends", async () => {
    const state = { ...initial(), inFlight: [{ assignment, executionId: "worker-execution", startedAt: 0 }] }
    const settled = await settle(state, { ...observation(), finished: [result] } as never, {
      landed: [],
      quarantined: [{ key: assignment.key, error: "conflict" }]
    })
    assert.deepEqual(settled.next.inFlight, [])
    assert.deepEqual(settled.next.ready, [])
    assert.deepEqual(settled.next.quarantined, [{ ...ready, key: assignment.key, error: "conflict" }])
    assert.equal(settled.done, false)
  })

  test("an empty idle round finishes after its final queue receipt", async () => {
    const state = { ...initial(), ready: [ready] }
    const settled = await settle(state, observation(), { landed: [assignment.key], quarantined: [] })
    assert.equal(settled.done, true)
    assert.deepEqual(settled.next.ready, [])
    assert.equal(settled.next.landed, 1)
  })

  test("quarantine survives persisted idle rounds until a repair actually starts", async () => {
    const quarantine = { ...ready, key: assignment.key, error: "conflict" }
    const state = Schema.decodeUnknownSync(RoundState)(
      JSON.parse(JSON.stringify({ ...initial(), quarantined: [quarantine] }))
    )
    const first = await settle(state)
    assert.equal(first.done, false)
    assert.deepEqual(first.next.quarantined, [quarantine])
    const recovered = Schema.decodeUnknownSync(RoundState)(JSON.parse(JSON.stringify(first.next)))
    const second = await settle(recovered)
    assert.equal(second.done, false)
    assert.deepEqual(second.next.quarantined, [quarantine])
  })

  test("a started repair removes only its matching quarantine", async () => {
    const other = {
      assignment: { ...assignment, key: "other-worker" },
      result: { ...result, key: "other-worker" },
      key: "other-worker",
      error: "other conflict"
    }
    const state = { ...initial(), quarantined: [{ ...ready, key: assignment.key, error: "conflict" }, other] }
    const repair = {
      assignment: { ...assignment, attempt: 1, fix: "conflict" },
      executionId: "repair",
      startedAt: Date.now()
    }
    const settled = await settle(state, observation(), { landed: [], quarantined: [] }, [repair])
    assert.deepEqual(settled.next.quarantined, [other])
    assert.deepEqual(settled.next.inFlight, [repair])
    assert.equal(settled.done, false)
  })

  for (const waiting of ["pending", "candidate"] as const) {
    test(`an idle queue cannot complete while ${waiting} work remains`, async () => {
      const seen = {
        ...observation(),
        pending: waiting === "pending",
        candidates: waiting === "candidate"
          ? [{ repo: assignment.repo, lead: assignment.lead, extras: [], severity: "high", effort: "easy" }] :
          []
      }
      const settled = await settle(initial(), seen as never)
      assert.equal(settled.done, false)
    })
  }

  const candidate = (n = 2950) => ({
    repo: assignment.repo,
    lead: { ...assignment.lead, n },
    extras: [],
    severity: "high",
    effort: "easy"
  })
  const capacity = (slots = 1) => ({
    account: assignment.account,
    tool: assignment.tool,
    email: "fixture@example.test",
    slots,
    inFlight: 0,
    hardStop: false,
    windows: [],
    problem: null
  })

  test("landing disabled retains work that the same queue lands when enabled", async () => {
    queue.length = 0
    const state = { ...initial(), ready: [ready] }
    const prior = process.env.BURNDOWN_LAND
    try {
      process.env.BURNDOWN_LAND = "off"
      const skipped = await invoke(Land.name, { state, observation: observation() })
      assert.deepEqual(skipped, { landed: [], quarantined: [] })
      assert.equal(queue.length, 0)
      const retained = await settle(state, observation(), skipped)
      process.env.BURNDOWN_LAND = "on"
      const landed = await invoke(Land.name, { state: retained.next, observation: observation() })
      assert.deepEqual(queue[0], {
        results: [result],
        workers: [{ assignment, executionId: assignment.key, startedAt: 0 }]
      })
      assert.equal((await settle(retained.next, observation(), landed as never)).done, true)
    } finally {
      if (prior === undefined) delete process.env.BURNDOWN_LAND
      else process.env.BURNDOWN_LAND = prior
    }
  })

  test("repair checks every original claim and starts a new execution with retained identity", async () => {
    starts.length = 0
    claims.length = 0
    const quarantine = { ...ready, key: assignment.key, error: "conflict" }
    const state = { ...initial(), quarantined: [quarantine] }
    const input = {
      state,
      observation: {
        ...observation(),
        capacity: [capacity()],
        candidates: [
          { ...candidate(), extras: assignment.extras, fix: "conflict" }
        ]
      },
      plan: {
        launches: [{ repo: assignment.repo, n: 2950, account: assignment.account }],
        nextTarget: 4,
        note: "repair"
      }
    }
    const launched = await invoke(Launch.name, input) as typeof RoundState.Type["inFlight"]
    assert.equal(launched.length, 1)
    assert.equal(launched[0]!.assignment.key, assignment.key)
    assert.equal(launched[0]!.assignment.attempt, 1)
    assert.deepEqual(launched[0]!.assignment.extras, assignment.extras)
    assert.deepEqual(starts[0]!.options, { key: `${assignment.key}@repair-1` })
    assert.deepEqual(claims.map((args) => [args[1], args[2], args[4]]), [
      ["check", `${assignment.repo}#2950`, `burndown-${assignment.key}`],
      ["claim", `${assignment.repo}#2950`, `burndown-${assignment.key}`],
      ["check", `${assignment.repo}#2951`, `burndown-${assignment.key}`],
      ["claim", `${assignment.repo}#2951`, `burndown-${assignment.key}`]
    ])
    ownership = { mine: false, holder: { host: hostname() } }
    try {
      const refused = await invoke(Launch.name, input)
      assert.deepEqual(refused, [])
      assert.equal(starts.length, 1)
      assert.deepEqual((await settle(state)).next.quarantined, [quarantine])
    } finally {
      ownership = { mine: true, holder: { host: hostname() } }
    }
  })

  test("launch obeys computed account slots even when the pacing plan oversubscribes", async () => {
    starts.length = 0
    const candidates = [candidate(3001), candidate(3002), candidate(3003)]
    const launched = await invoke(Launch.name, {
      state: initial(),
      observation: {
        ...observation(),
        candidates,
        capacity: [capacity(1)]
      },
      plan: {
        launches: candidates.map((c) => ({ repo: c.repo, n: c.lead.n, account: assignment.account })),
        nextTarget: 4,
        note: "oversubscribed"
      }
    })
    assert.equal((launched as Array<unknown>).length, 1)
    assert.equal(starts.length, 1)
    assert.equal((starts[0]!.assignment as typeof assignment).lead.n, 3001)
  })

  for (const placement of ["local", "cloud"] as const) {
    test(`${placement} launch ${placement === "local" ? "waits without claiming" : "continues"} below the free-disk floor`, async () => {
      starts.length = 0
      claims.length = 0
      const saved = process.env.BURNDOWN_MIN_FREE_GIB
      process.env.BURNDOWN_MIN_FREE_GIB = String(Number.MAX_SAFE_INTEGER)
      try {
        const launched = await invoke(Launch.name, {
          state: { ...initial(), options: { ...initial().options, placement } },
          observation: { ...observation(), candidates: [candidate(3101)], capacity: [capacity(1)] },
          plan: {
            launches: [{ repo: assignment.repo, n: 3101, account: assignment.account }],
            nextTarget: 4,
            note: "disk"
          }
        })
        const expected = placement === "local" ? 0 : 1
        assert.equal((launched as Array<unknown>).length, expected)
        assert.equal(starts.length, expected)
        assert.equal(claims.filter((args) => args[1] === "claim").length, expected)
      } finally {
        if (saved === undefined) delete process.env.BURNDOWN_MIN_FREE_GIB
        else process.env.BURNDOWN_MIN_FREE_GIB = saved
      }
    })
  }

  test("observation refreshes running, READY and quarantined claims without taking over foreign hosts", async () => {
    const held = {
      ...initial(),
      inFlight: [{ assignment, executionId: "still-running", startedAt: 0 }],
      ready: [{ assignment: { ...assignment, key: "ready-worker" }, result: { ...result, key: "ready-worker" } }],
      quarantined: [{ assignment: { ...assignment, key: "quarantined-worker" }, result: { ...result, key: "quarantined-worker" }, key: "quarantined-worker", error: "conflict" }]
    }
    claims.length = 0
    await invoke(Observe.name, { state: held })
    assert.equal(claims.filter((args) => args[1] === "claim").length, 6)
    ownership = { mine: true, holder: { host: "another-host" } }
    claims.length = 0
    try {
      await invoke(Observe.name, { state: held })
      assert.equal(claims.filter((args) => args[1] === "claim").length, 0)
    } finally {
      ownership = { mine: true, holder: { host: hostname() } }
    }
  })

  for (const unknown of [[], [{ ...capacity(0), hardStop: true, problem: "login unavailable" }]]) {
    test(`unproven quota exhaustion stays retryable without claiming every account is capped (${unknown.length})`, async () => {
      writes.length = 0
      const seen = { ...observation(), now: 1000, candidates: [candidate()], capacity: unknown, exhausted: false }
      const settled = await settle(initial(), seen as never)
      assert.equal(settled.done, false)
      assert.ok(settled.wakeAt >= Date.now() + 59_000 && settled.wakeAt <= Date.now() + 61_000)
      assert.equal(writes.some((w) => w.path.endsWith("NEEDS-YOU.md")), false)
    })
  }

  test("public flow drains complete READY seeds through the registered round and real interpreter", async () => {
    const { FlowEngine } = await import("@smthrs/engine")
    const NodeCrypto = await import("@effect/platform-node/NodeCrypto")
    const { default: Burndown } = await import("../burndown/flow.ts")
    const { Round } = await import("../burndown/round.ts")
    queue.length = 0
    const previous = process.env.BURNDOWN_LAND
    process.env.BURNDOWN_LAND = "on"
    try {
      const { Pace } = await import("../burndown/pace.ts")
      const implementations = Layer.mergeAll(
        layer,
        Pace.toLayer(() => Effect.succeed({ launches: [], nextTarget: 4, note: "fixture" })),
        Sleep.layer
      ).pipe(Layer.provideMerge(Action.layerImplementations))
      const services = Interpreter.layerWithImplementations(Burndown, implementations).pipe(
        Layer.provideMerge(Interpreter.layer(Round).pipe(Layer.provide(implementations))),
        Layer.provideMerge(FlowEngine.layerMemory),
        Layer.provideMerge(NodeCrypto.layer)
      )
      const completed = await Effect.runPromise(
        Burndown.execute({ repos: [assignment.repo], ready: [ready] }, { executionId: "public-ready-recovery" }).pipe(
          Effect.provide(services as never)
        )
      )
      assert.equal(completed, "burndown finished after 1 rounds; landed 1")
      assert.equal(queue.length, 1)
      assert.deepEqual(queue[0]!.results, [result])
    } finally {
      if (previous === undefined) delete process.env.BURNDOWN_LAND
      else process.env.BURNDOWN_LAND = previous
    }
  })

  test("public READY seed rejects inconsistent worker identities and incomplete issue bundles", async () => {
    const { default: Burndown } = await import("../burndown/flow.ts")
    const invalid = [
      { ...ready, assignment: { ...assignment, repo: "other/repository" } },
      { ...ready, assignment: { ...assignment, lead: { ...assignment.lead, repo: "other/repository" } } },
      { ...ready, assignment: { ...assignment, extras: [{ ...assignment.extras[0], repo: "other/repository" }] } },
      { ...ready, result: { ...result, key: "unrelated-worker" } },
      { ...ready, result: { ...result, status: "failed" } },
      { ...ready, result: { ...result, commits: result.commits.slice(0, 1) } },
      { ...ready, result: { ...result, commits: [...result.commits].reverse() } },
      { ...ready, result: { ...result, commits: [{ issue: 2950, commit: "invalid" }, result.commits[1]] } }
    ]
    for (const seed of invalid) {
      assert.throws(() => Schema.decodeUnknownSync(Burndown.payloadSchema)({ repos: [assignment.repo], ready: [seed] }))
    }
    assert.doesNotThrow(() =>
      Schema.decodeUnknownSync(Burndown.payloadSchema)({ repos: [assignment.repo], ready: [ready] })
    )
  })

  for (const priorUsed of [10, 99]) {
    test(`unavailable current usage preserves a prior ${priorUsed}% receipt without authorizing launch or declaring exhaustion`, async () => {
      const account = {
        id: assignment.account,
        tool: assignment.tool,
        email: "fixture@example.test",
        directory: "fixture",
        aliases: []
      }
      const now = Date.now()
      const prior = {
        account,
        error: null,
        observedAt: now - 1000,
        usage: {
          limitReached: priorUsed >= 97,
          windows: [{ name: "primary", used: priorUsed, resetsAt: now + 3_600_000, durationHours: 5 }]
        }
      }
      const unavailable = {
        account,
        error: { _tag: "UsageUnavailable", accountId: account.id, message: "retry later" },
        usage: null,
        observedAt: now
      }
      accountReadings = [unavailable]
      try {
        const observed = await invoke(Observe.name, {
          state: { ...initial(), readings: { at: now - 1000, readings: [prior] } }
        }) as { capacity: Array<{ slots: number; problem: string | null }>; exhausted: boolean }
        assert.equal(observed.capacity[0]!.slots, 0)
        assert.match(observed.capacity[0]!.problem!, /UsageUnavailable/)
        assert.equal(observed.exhausted, false)
      } finally {
        accountReadings = []
      }
    })
  }

  test("failed worker receipts never release claims held on another host", async () => {
    ownership = { mine: true, holder: { host: "another-host" } }
    claims.length = 0
    const state = { ...initial(), inFlight: [{ assignment, executionId: "ended", startedAt: 0 }] }
    try {
      await settle(state, { ...observation(), finished: [{ ...result, status: "failed", commits: [] }] } as never)
      assert.equal(claims.filter((args) => args[1] === "release").length, 0)
    } finally {
      ownership = { mine: true, holder: { host: hostname() } }
    }
  })
}
