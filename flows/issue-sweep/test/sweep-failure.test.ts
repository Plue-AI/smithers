import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import { FlowEngine } from "@smthrs/engine"
import { Action, Fault, Flow, Interpreter, Sleep, WaitFor } from "@smthrs/flow"
import { Burndown, PatternError } from "@smthrs/patterns"
import { Clock, Duration, Effect, Layer, ManagedRuntime, Schema } from "effect"
import assert from "node:assert/strict"
import test from "node:test"
import Sweep, { Accounts, Dispatch, GhFailed, ghFailed, ListIssues, SweepFailure } from "../flow.ts"
import { HostFailed, hostFailed, output } from "../host.ts"

import Work, { AgentFailed, FetchIssue, fetchIssueWith } from "../work/flow.ts"

// run-13: one proxy 502 at discovery failed the whole sweep.
const proxy502 = "Smithers GitHub proxy could not reach GitHub (HTTP 502)"

test("GitHub not answering is infra; GitHub answering no is not", () => {
  for (
    const message of [
      proxy502,
      ...Array.from({ length: 100 }, (_, n) => `HTTP ${500 + n}: server error`),
      "HTTP 429: rate limited; Retry-After: 60",
      "Could not resolve host: api.github.com",
      "Failed to connect to api.github.com",
      "Connection timed out",
      "Connection reset",
      "Network is unreachable",
      "EAI_AGAIN",
      "ENOTFOUND"
    ]
  ) {
    const failure = ghFailed(message)
    assert.equal(failure.code, "unreachable", message)
    assert.equal(Fault.of(failure).class, "infra", message)
  }
  for (const message of ["gh: HTTP 404: Not Found", "HTTP 401: Bad credentials", "HTTP 403: Resource not accessible"]) {
    const failure = ghFailed(message)
    assert.equal(failure.code, "refused", message)
    assert.notEqual(Fault.of(failure).class, "infra", message)
  }
  // Failures journaled before the field existed still decode, as refused.
  assert.notEqual(Fault.of(new GhFailed({ message: proxy502 })).class, "infra")
})

// Advance the real retry scheduler without waiting two hours in a unit test.
// All attempts, decoding and settlement still go through the memory engine.
const retryClock = () => {
  let now = 0
  const delays: Array<number> = []
  const nanos = () => BigInt(now) * 1_000_000n
  const clock: Clock.Clock = {
    currentTimeMillisUnsafe: () => now,
    currentTimeMillis: Effect.sync(() => now),
    currentTimeNanosUnsafe: nanos,
    currentTimeNanos: Effect.sync(nanos),
    monotonicTimeNanosUnsafe: nanos,
    monotonicTimeNanos: Effect.sync(nanos),
    sleep: (duration) =>
      Effect.sync(() => {
        const delay = Duration.toMillis(duration)
        delays.push(delay)
        now += delay
      })
  }
  return { clock, delays }
}

const engine = (
  discover: () => Effect.Effect<ReadonlyArray<never>, GhFailed>,
  capacity: () => Effect.Effect<Burndown.Capacity, HostFailed> = () => Effect.succeed(Burndown.available(1))
) => {
  const { clock, delays } = retryClock()
  let dispatches = 0
  // Same declarations, parent and child codecs as the discovered sweep;
  // fixture handlers isolate this regression from real GitHub/account writes.
  const rounds = Burndown.make({
    name: "issue-sweep/rounds",
    error: SweepFailure,
    discover: ListIssues,
    capacity: Accounts,
    dispatch: Dispatch,
    maxRounds: 500,
    signal: "issue-sweep/accounts-reset"
  })
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(Sweep),
      Interpreter.layer(rounds),
      Sleep.layer,
      WaitFor.layer,
      ListIssues.toLayer(discover),
      Accounts.toLayer(capacity),
      Dispatch.toLayer(() =>
        Effect.sync(() => {
          dispatches++
          return { rows: [], launched: 0, deferred: 0 }
        })
      )
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(Layer.succeed(Clock.Clock, clock))
    )
  )
  return { runtime, delays, dispatches: () => dispatches }
}

test("engine discovery retries two proxy 502s and proceeds to dispatch", async () => {
  let calls = 0
  const fixture = engine(() =>
    Effect.suspend(() =>
      ++calls <= 2
        ? Effect.fail(ghFailed(proxy502)) :
        Effect.succeed([])
    )
  )
  try {
    const result = await fixture.runtime.runPromise(
      Sweep.execute({ repo: "acme/app" }, { executionId: "proxy-recovery" })
    )
    assert.deepEqual(result, { rows: [], rounds: 1, stopped: "drained" })
    assert.equal(calls, 3)
    assert.deepEqual(fixture.delays, [5000, 10000])
    assert.equal(fixture.dispatches(), 1)
  } finally {
    await fixture.runtime.dispose()
  }
})

test("engine retries transient HTTP and network discovery failures", async () => {
  for (
    const message of [
      "HTTP 500: Internal Server Error",
      "HTTP 501: Not Implemented",
      "HTTP 503: Service Unavailable",
      "HTTP 504: Gateway Timeout",
      "HTTP 599: proxy timeout",
      "HTTP 429: rate limited; Retry-After: 60",
      "Could not resolve host: api.github.com",
      "Failed to connect to api.github.com",
      "Connection reset",
      "Operation timed out",
      "Network is unreachable",
      "EAI_AGAIN",
      "ENOTFOUND"
    ]
  ) {
    let calls = 0
    const fixture = engine(() =>
      Effect.suspend(() =>
        ++calls === 1
          ? Effect.fail(ghFailed(message)) :
          Effect.succeed([])
      )
    )
    try {
      const result = await fixture.runtime.runPromise(Sweep.execute({ repo: "acme/app" }, { executionId: "transient" }))
      assert.equal(result.stopped, "drained", message)
      assert.equal(calls, 2, message)
      assert.deepEqual(fixture.delays, [5000], message)
      assert.equal(fixture.dispatches(), 1, message)
    } finally {
      await fixture.runtime.dispose()
    }
  }
})

test("engine exhausted discovery settles and replays the typed failure", async () => {
  let calls = 0
  const fixture = engine(() =>
    Effect.suspend(() => {
      calls++
      return Effect.fail(ghFailed(proxy502))
    })
  )
  try {
    const run = Sweep.execute({ repo: "acme/app" }, { executionId: "proxy-exhausted" })
    const failure = await fixture.runtime.runPromise(Effect.flip(run))
    assert.ok(failure instanceof GhFailed)
    assert.equal(failure.message, proxy502)
    assert.equal(failure.code, "unreachable")
    assert.ok(calls > 3)
    assert.ok(fixture.delays.reduce((a, b) => a + b, 0) <= 7200000)
    const settledCalls = calls
    const replay = await fixture.runtime.runPromise(Effect.flip(run))
    assert.deepEqual(replay, failure)
    assert.equal(calls, settledCalls, "settled execution does not rediscover")
    assert.equal(fixture.dispatches(), 0)
  } finally {
    await fixture.runtime.dispose()
  }
})

for (
  const message of [
    "HTTP 401: Bad credentials",
    "HTTP 403: Resource not accessible",
    "HTTP 404: Not Found",
    "HTTP 422: Validation Failed"
  ]
) {
  test(`engine refuses without retry: ${message}`, async () => {
    let calls = 0
    const fixture = engine(() =>
      Effect.suspend(() => {
        calls++
        return Effect.fail(ghFailed(message))
      })
    )
    try {
      const failure = await fixture.runtime.runPromise(Effect.flip(Sweep.execute(
        { repo: "acme/app" },
        { executionId: "refused" }
      )))
      assert.ok(failure instanceof GhFailed)
      assert.equal(failure.code, "refused")
      assert.equal(calls, 1)
      assert.deepEqual(fixture.delays, [])
      assert.equal(fixture.dispatches(), 0)
    } finally {
      await fixture.runtime.dispose()
    }
  })
}

test("a sweep that fails settles with a typed, encodable failure", () => {
  const encode = Schema.encodeUnknownSync(SweepFailure)
  for (
    const failure of [
      ghFailed(proxy502),
      new Burndown.Stop({ message: "round 0 launched nothing: 3 selection errors" }),
      new HostFailed({ message: "host unavailable" }),
      new PatternError.PatternError({ code: "invalid_decorator", message: "invalid round input" })
    ]
  ) {
    const encoded = encode(failure)
    assert.deepEqual(JSON.parse(JSON.stringify(encoded)), encoded, "the journal stores it as plain data")
    assert.equal((Schema.decodeUnknownSync(SweepFailure)(encoded) as { _tag: string })._tag, failure._tag)
  }
})


test("host diagnostics classify connectivity without reclassifying ordinary agent failures", () => {
  for (const message of [proxy502, "HTTP 503: Service Unavailable", "HTTP 429: Retry-After: 60", "ENOTFOUND"]) {
    assert.equal(Fault.of(hostFailed(message)).class, "infra")
  }
  for (const message of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden", "HTTP 404: Not Found"]) {
    assert.equal(Fault.of(hostFailed(message)).class, "dependency")
  }
  assert.equal(Fault.of(new AgentFailed({ message: proxy502 })).class, "bug")
})

const fetchEngine = (message: string, failures: number) => {
  let calls = 0
  const found = { title: "fix discovery", body: "issue", state: "open", comments: [] }
  const ReadFlow = Flow.make("issue-sweep/test-fetch", {
    payload: FetchIssue.payloadSchema,
    success: FetchIssue.successSchema,
    // Exercise the real work flow's settlement codec, including its unions.
    error: Work.errorSchema,
    body: (input) => FetchIssue.call(input)
  })
  const { clock, delays } = retryClock()
  const runtime = ManagedRuntime.make(Layer.mergeAll(
    Interpreter.layer(ReadFlow),
    fetchIssueWith(() => Effect.suspend(() => ++calls <= failures
      ? Effect.fail(hostFailed(message)) : Effect.succeed(found)))
  ).pipe(
    Layer.provideMerge(Action.layerImplementations),
    Layer.provideMerge(FlowEngine.layerMemory),
    Layer.provideMerge(NodeCrypto.layer),
    Layer.provideMerge(Layer.succeed(Clock.Clock, clock))
  ))
  return { runtime, flow: ReadFlow, calls: () => calls, delays }
}

test("FetchIssue retries two proxy 502s then succeeds through the engine", async () => {
  const fixture = fetchEngine(proxy502, 2)
  try {
    const result = await fixture.runtime.runPromise(fixture.flow.execute({ repo: "acme/app", issue: 1 }, {
      executionId: "fetch-recovery"
    }))
    assert.deepEqual(result, { title: "fix discovery", body: "issue", comments: [] })
    assert.equal(fixture.calls(), 3)
    assert.deepEqual(fixture.delays, [5000, 10000])
  } finally { await fixture.runtime.dispose() }
})

test("FetchIssue exhausted retries encode and replay AgentFailed through Work's declared codec", async () => {
  const fixture = fetchEngine(proxy502, Infinity)
  try {
    const run = fixture.flow.execute({ repo: "acme/app", issue: 1 }, { executionId: "fetch-exhausted" })
    const failure = await fixture.runtime.runPromise(Effect.flip(run))
    assert.ok(failure instanceof AgentFailed)
    assert.equal(failure.code, "unreachable")
    assert.equal(failure.message, proxy502)
    const calls = fixture.calls()
    assert.ok(calls > 3)
    assert.deepEqual(await fixture.runtime.runPromise(Effect.flip(run)), failure)
    assert.equal(fixture.calls(), calls)
  } finally { await fixture.runtime.dispose() }
})

for (const message of ["HTTP 401: Bad credentials", "HTTP 403: Forbidden", "HTTP 404: Not Found", "HTTP 422: Invalid"]) {
  test(`FetchIssue refuses without retry: ${message}`, async () => {
    const fixture = fetchEngine(message, Infinity)
    try {
      const failure = await fixture.runtime.runPromise(Effect.flip(fixture.flow.execute(
        { repo: "acme/app", issue: 1 }, { executionId: "fetch-refused" }
      )))
      assert.ok(failure instanceof AgentFailed)
      assert.equal(failure.code, "refused")
      assert.equal(fixture.calls(), 1)
      assert.deepEqual(fixture.delays, [])
    } finally { await fixture.runtime.dispose() }
  })
}


test("Accounts retries classified host connectivity before discovery", async () => {
  let calls = 0
  const fixture = engine(() => Effect.succeed([]), () => Effect.suspend(() => ++calls <= 2
    ? Effect.fail(hostFailed(proxy502)) : Effect.succeed(Burndown.available(1))))
  try {
    const result = await fixture.runtime.runPromise(Sweep.execute({ repo: "acme/app" }, { executionId: "accounts-recovery" }))
    assert.equal(result.stopped, "drained")
    assert.equal(calls, 3)
    assert.deepEqual(fixture.delays, [5000, 10000])
    assert.equal(fixture.dispatches(), 1)
  } finally { await fixture.runtime.dispose() }
})

test("Accounts exhaustion settles and replays classified HostFailed", async () => {
  let calls = 0
  const fixture = engine(() => Effect.succeed([]), () => Effect.suspend(() => {
    calls++
    return Effect.fail(hostFailed(proxy502))
  }))
  try {
    const run = Sweep.execute({ repo: "acme/app" }, { executionId: "accounts-exhausted" })
    const failure = await fixture.runtime.runPromise(Effect.flip(run))
    assert.ok(failure instanceof HostFailed)
    assert.equal(failure.code, "unreachable")
    const settled = calls
    assert.ok(settled > 3)
    assert.deepEqual(await fixture.runtime.runPromise(Effect.flip(run)), failure)
    assert.equal(calls, settled)
    assert.equal(fixture.dispatches(), 0)
  } finally { await fixture.runtime.dispose() }
})


test("host output classifies actual failed command diagnostics", async () => {
  for (const [message, expected] of [[proxy502, "infra"], ["HTTP 429: Retry-After: 60", "infra"], ["HTTP 401: Bad credentials", "dependency"], ["HTTP 404: Not Found", "dependency"]] as const) {
    const failure = await Effect.runPromise(Effect.flip(output(process.execPath, [
      "-e", "process.stderr.write(process.argv[1]); process.exit(1)", message
    ])))
    assert.ok(failure instanceof HostFailed)
    assert.equal(Fault.of(failure).class, expected)
    assert.ok(failure.message.includes(message))
  }
})
