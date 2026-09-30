import * as AgentAction from "@smthrs/agent/AgentAction"
import { Flow as FlowDeclaration } from "@smthrs/flow"
/**
 * The helper end to end, on a flow that exists only here.
 *
 * The two halves have to be tested together: a recording that replay cannot
 * read is worse than no recording, and the mismatch only shows up when the same
 * request is digested twice. So the first case records a fixture against a
 * scripted model, and the second replays that exact file with the recorder
 * switched off, the way CI runs it.
 *
 * `routes` is overridden where the suite owns its flow; the default loader —
 * the router plus four dynamic imports — is exercised against a throwaway app
 * tree, because that path is what every real app takes.
 */
import { afterAll, beforeEach, describe, expect, it } from "@effect/vitest"
import * as Model from "@smthrs/model/Model"
import * as ModelEvent from "@smthrs/model/ModelEvent"
import { CapabilityContractError } from "@smthrs/testing/TestingError"
import * as Schema from "effect/Schema"
import * as Stream from "effect/Stream"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { inspect } from "node:util"
import { defineAgent, defineSandbox, defineTools } from "../src/index.ts"
import {
  cachedModelTest,
  preparedRequest,
  recording,
  replayModelError,
  type RoutedFlow,
  runCachedModelTest
} from "../src/testing.ts"
import { appTrees } from "./support/appTree.ts"

const Output = Schema.Struct({ answer: Schema.String })
// The spelling `docs/api.md` tells a caller to write for `cachedModelTest`'s
// output type argument, which nothing infers from a string flow id. `tsc`
// holds it to the schema the flow declares.
type Output = typeof Flow.successSchema.Type

const answerText = "Durable runs resume instead of repeating."

const Flow = FlowDeclaration.make("echo", {
  description: "Answers a topic in one line.",
  payload: { topic: Schema.String },
  success: Output,
  error: AgentAction.AgentFailure,
  prompt: ({ topic }) => `Answer in one line: ${topic}`
})

const Agent = defineAgent({
  seat: "test:scripted",
  system: ["You are a test agent. Answer with the declared JSON shape."],
  limits: { calls: 4 },
  maxFrames: 3
})

const Sandbox = defineSandbox({ limits: { heapBytes: 32 * 1024 * 1024, wallClockMs: 10_000 } })

const Tools = defineTools({ sources: [] })

/**
 * The layer files a throwaway tree gets, worded so a recorded request names
 * which of the two `AGENT.ts` files the loader resolved.
 */
const rootSystem = "You are the agent at the app root."
const nearSystem = "You are the agent beside the flow."

/**
 * A real `flows/echo/flow.ts`: `Flow.make` with usable schemas, imported by
 * absolute URL because the tree is written outside this package.
 */
const flowSource = `import { Flow as FlowDeclaration } from ${
  JSON.stringify(new URL("../../flows/flow/src/index.ts", import.meta.url).href)
}
import * as AgentAction from ${JSON.stringify(new URL("../../agent/src/AgentAction.ts", import.meta.url).href)}
import * as Schema from "effect/Schema"

export default FlowDeclaration.make("echo", {
  description: "Answers a topic in one line.",
  payload: { topic: Schema.String },
  success: Schema.Struct({ answer: Schema.String }),
  error: AgentAction.AgentFailure,
  prompt: ({ topic }) => \`Answer in one line: \${topic}\`
})
`

const routed: ReadonlyArray<RoutedFlow> = [{
  id: "echo",
  file: "flows/echo/flow.ts",
  spec: Flow,
  agent: Agent,
  sandbox: Sandbox,
  tools: Tools
}]

/** Answers every request with one cell that settles the run through `ctx.done`. */
const scripted = (): Model.Model =>
  Model.make({
    stream: () =>
      Stream.suspend(() => {
        const cell = `await ctx.done(${JSON.stringify({ answer: answerText })})`
        return Stream.fromIterable([
          ModelEvent.ModelEvent.TextStart({ type: "text-start", id: "cell" }),
          ModelEvent.ModelEvent.TextDelta({ type: "text-delta", id: "cell", text: "```cell\n" + cell + "\n```" }),
          ModelEvent.ModelEvent.TextEnd({ type: "text-end", id: "cell" }),
          ModelEvent.ModelEvent.Settle({ type: "settle", stopReason: "stop" })
        ])
      })
  })

const { write: tree, remove: removeTrees } = appTrees("smthrs-cached-")

const dir = tree({})
const fixturePath = join(dir, "echo.json")
const fixture = pathToFileURL(fixturePath)

afterAll(() => {
  removeTrees()
})

// `recording()` reads the environment inside the test body, so the mode is set
// per test rather than for the whole file.
beforeEach((context) => {
  if (context.task.name.startsWith("records")) process.env["SMTHRS_RECORD"] = "1"
  else delete process.env["SMTHRS_RECORD"]
})

const expectAnswer = (output: Output): void => {
  expect(output.answer).toBe(answerText)
}

describe("cachedModelTest", () => {
  cachedModelTest<{ topic: string }, Output>("records a fixture against the live seat", {
    fixture,
    flow: "echo",
    payload: { topic: "durable workflows" },
    live: scripted,
    routes: async () => routed,
    expect: expectAnswer
  })

  it("wrote the recorded fixture to disk in a form the decoder accepts", () => {
    expect(existsSync(fixturePath)).toBe(true)
    const parsed = JSON.parse(readFileSync(fixturePath, "utf8")) as { calls: ReadonlyArray<unknown> }
    expect(parsed.calls.length).toBeGreaterThan(0)
  })

  cachedModelTest<{ topic: string }, Output>("replays that fixture with no live model", {
    fixture,
    flow: "echo",
    payload: { topic: "durable workflows" },
    routes: async () => routed,
    expect: expectAnswer
  })
})

describe("recording a credential", () => {
  it("records nothing when the recording contains a credential's value, plain or JSON-escaped", async () => {
    const path = join(dir, "leaked.json")
    const plain = "sk-live-0123456789"
    const quoted = "pass\"word\\1234"
    process.env["SMTHRS_RECORD"] = "1"
    process.env["TEST_PLAIN_API_KEY"] = plain
    process.env["TEST_QUOTED_PASSWORD"] = quoted
    process.env["TEST_SHORT_TOKEN"] = "abc"
    process.env["TEST_UNUSED_SECRET"] = "never-in-the-fixture"
    try {
      await expect(
        runCachedModelTest<{ topic: string }, Output>("leak", {
          fixture: pathToFileURL(path),
          flow: "echo",
          payload: { topic: `${plain} ${quoted} abc` },
          live: scripted,
          routes: async () => routed,
          expect: expectAnswer
        })
      ).rejects.toThrow(`contains the value of TEST_PLAIN_API_KEY, TEST_QUOTED_PASSWORD; it was not written`)
    } finally {
      for (
        const name of [
          "SMTHRS_RECORD",
          "TEST_PLAIN_API_KEY",
          "TEST_QUOTED_PASSWORD",
          "TEST_SHORT_TOKEN",
          "TEST_UNUSED_SECRET"
        ]
      ) {
        delete process.env[name]
      }
    }
    expect(existsSync(path)).toBe(false)
    expect(existsSync(`${path}.recording`)).toBe(false)
  })
})

describe("the default routes loader", () => {
  // The layer files export plain objects with the right shape rather than
  // calling the constructors, so the throwaway tree needs no resolvable
  // imports of its own.
  const app = (extra: Record<string, string> = {}) => ({
    "AGENT.ts": `export const Agent = ${JSON.stringify(Agent)}\n`,
    "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
    "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
    ...extra
  })

  it("routes a flow, imports its layer files, and runs it", async () => {
    const root = tree(app({
      "flows/echo/flow.ts": flowSource
    }))
    // The flow module is imported for its `Flow` export; the spec that
    // actually runs comes from this file, so the schemas stay real.
    const loaded = await import(pathToFileURL(join(root, "flows/echo/flow.ts")).href) as {
      readonly default: { readonly _tag: string }
    }
    expect(loaded.default._tag).toBe("echo")

    await runCachedModelTest<{ topic: string }, Output>("routed", {
      fixture,
      flow: "echo",
      payload: { topic: "durable workflows" },
      root,
      routes: async () => routed,
      expect: expectAnswer
    })
  })

  /**
   * The loader on its own path: no `routes` override, a tree the router has to
   * walk, real schemas, and an `AGENT.ts` beside the flow that has to beat the
   * one at the app root. Every other case here proves a refusal; this one is
   * the success, and the recorded request is what names the layer that ran.
   */
  it("routes a real tree, records through it, and replays what it recorded", async () => {
    const root = tree({
      "AGENT.ts": `export const Agent = ${JSON.stringify({ ...Agent, system: [rootSystem] })}\n`,
      "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
      "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
      // Nearer the flow than the root file, so this is the one that must run.
      "flows/echo/AGENT.ts": `export const Agent = ${JSON.stringify({ ...Agent, system: [nearSystem] })}\n`,
      "flows/echo/flow.ts": flowSource
    })
    const path = join(dir, "default-loader.json")
    const seen: Array<Output> = []
    const payload = { topic: "durable workflows" }

    process.env["SMTHRS_RECORD"] = "1"
    try {
      await runCachedModelTest<{ topic: string }, Output>("default loader", {
        fixture: pathToFileURL(path),
        flow: "echo",
        payload,
        root,
        live: scripted,
        expect: (output) => {
          seen.push(output)
        }
      })
    } finally {
      delete process.env["SMTHRS_RECORD"]
    }
    await runCachedModelTest<{ topic: string }, Output>("default loader", {
      fixture: pathToFileURL(path),
      flow: "echo",
      payload,
      root,
      expect: (output) => {
        seen.push(output)
      }
    })

    // Both halves ran the flow to a decoded output, and the replay matched the
    // request the recording digested: a loader that resolved a different
    // `AGENT.ts` the second time would fail as an unscripted request.
    expect(seen).toEqual([{ answer: answerText }, { answer: answerText }])
    const recorded = JSON.parse(readFileSync(path, "utf8")) as {
      calls: ReadonlyArray<{ request: { system: ReadonlyArray<{ text: string }> } }>
    }
    expect(recorded.calls.length).toBeGreaterThan(0)
    const system = recorded.calls[0]!.request.system.map((part) => part.text).join("\n")
    expect(system).toContain(nearSystem)
    expect(system).not.toContain(rootSystem)
  })

  it("names the known flows when the requested flow is not routed", async () => {
    const root = tree(app({ "flows/echo/flow.ts": "export const Flow = {}\n" }))
    await expect(
      runCachedModelTest("unrouted", {
        fixture,
        flow: "missing",
        payload: {},
        root,
        expect: () => {}
      })
    ).rejects.toThrow("flow \"missing\" is not routed. Known flows: echo")
  })

  it("ignores a standalone MDX prompt as a flow", async () => {
    const root = tree(app({ "flows/notes/flow.mdx": "# notes\n" }))
    await expect(
      runCachedModelTest("markdown flow", { fixture, flow: "notes", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("flow \"notes\" is not routed")
  })

  it("runs a default body flow with its optional named layer", async () => {
    const bodySource = `import { Flow } from ${
      JSON.stringify(new URL("../../flows/flow/src/index.ts", import.meta.url).href)
    }
import * as Node from ${JSON.stringify(new URL("../../flows/core/src/Node.ts", import.meta.url).href)}
import * as Schema from "effect/Schema"
import * as Layer from "effect/Layer"
export const layer = Layer.empty
export default Flow.make("echo", { payload: { topic: Schema.String }, success: Schema.String,
  body: ({ topic }) => Node.succeed(topic) })`
    const root = tree(app({ "flows/echo/flow.ts": bodySource }))
    await runCachedModelTest<{ topic: string }, string>("body", {
      fixture,
      flow: "echo",
      payload: { topic: "computed" },
      root,
      expect: (output) => expect(output).toBe("computed")
    })
  })

  it("refuses a default flow whose tag differs from its directory", async () => {
    const root = tree(app({ "flows/echo/flow.ts": flowSource.replace("make(\"echo\"", "make(\"other\"") }))
    await expect(
      runCachedModelTest("wrong-id", { fixture, flow: "echo", payload: { topic: "identity" }, root, expect: () => {} })
    )
      .rejects.toThrow("tag \"other\" must match its routed id \"echo\"")
  })

  it("refuses an invalid named flow layer", async () => {
    const root = tree(app({ "flows/echo/flow.ts": `${flowSource}\nexport const layer = {}` }))
    await expect(
      runCachedModelTest("bad-layer", { fixture, flow: "echo", payload: { topic: "layers" }, root, expect: () => {} })
    )
      .rejects.toThrow("named layer must be an Effect Layer")
  })

  it("refuses a flow with only a named legacy export", async () => {
    const root = tree(app({ "flows/echo/flow.ts": "export const Flow = {}\n" }))
    await expect(runCachedModelTest("legacy", { fixture, flow: "echo", payload: {}, root, expect: () => {} }))
      .rejects.toThrow("flows/echo/flow.ts must default-export a tagged Flow.make")
  })

  it("refuses a default export from another flow model", async () => {
    const root = tree(app({ "flows/echo/flow.ts": "export default { _tag: \"echo\" }\n" }))
    await expect(runCachedModelTest("lookalike", { fixture, flow: "echo", payload: {}, root, expect: () => {} }))
      .rejects.toThrow("flows/echo/flow.ts must default-export a tagged Flow.make")
  })

  it("refuses a layer file that exports nothing under the expected name", async () => {
    const root = tree({
      "AGENT.ts": "export const NotAgent = {}\n",
      "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
      "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
      "flows/echo/flow.ts": flowSource
    })
    await expect(
      runCachedModelTest("missing export", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("AGENT.ts must export `Agent`")
  })

  // The name alone was the whole check, so a layer file could export anything
  // at all under it and the mistake only surfaced deep inside the agent host,
  // in a message that named neither the file nor the field.
  it("refuses a layer export that is not a spec at all", async () => {
    const root = tree({
      "AGENT.ts": "export const Agent = 42\n",
      "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
      "TOOLS.ts": `export const Tools = ${JSON.stringify(Tools)}\n`,
      "flows/echo/flow.ts": flowSource
    })
    await expect(
      runCachedModelTest("not a spec", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("AGENT.ts must export `Agent` built by defineAgent")
  })

  it("refuses a layer export carrying another spec's tag", async () => {
    const root = tree({
      "AGENT.ts": `export const Agent = ${JSON.stringify(Agent)}\n`,
      "SANDBOX.ts": `export const Sandbox = ${JSON.stringify(Sandbox)}\n`,
      // The shape of a `TOOLS.ts` export, built by the wrong constructor.
      "TOOLS.ts": `export const Tools = ${JSON.stringify({ ...Tools, _tag: "SandboxSpec" })}\n`,
      "flows/echo/flow.ts": flowSource
    })
    await expect(
      runCachedModelTest("wrong tag", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow("TOOLS.ts must export `Tools` built by defineTools")
  })

  it("loads the flow, agent, sandbox, and tools a routed tree declares", async () => {
    const root = tree(app({
      "flows/echo/flow.ts": flowSource
    }))
    // A payload of `{}` and an output of `{}` are not usable schemas, so the
    // run is expected to fail — what matters is that it failed AFTER the four
    // modules resolved, not while resolving them.
    await expect(
      runCachedModelTest("resolved layers", { fixture, flow: "echo", payload: {}, root, expect: () => {} })
    ).rejects.toThrow()
  })
})

describe("refusals", () => {
  it("refuses to replay a fixture that does not exist", async () => {
    await expect(
      runCachedModelTest("absent fixture", {
        fixture: pathToFileURL(join(dir, "absent.json")),
        flow: "echo",
        payload: {},
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow("Record one with `pnpm test:record`")
  })

  it("refuses to record without a live model", async () => {
    process.env["SMTHRS_RECORD"] = "1"
    try {
      await expect(
        runCachedModelTest("no live seat", {
          fixture: pathToFileURL(join(dir, "absent.json")),
          flow: "echo",
          payload: {},
          routes: async () => routed,
          expect: () => {}
        })
      ).rejects.toThrow("SMTHRS_RECORD=1 needs a live model")
    } finally {
      delete process.env["SMTHRS_RECORD"]
    }
  })

  it("names the flows a supplied routes loader returned", async () => {
    await expect(
      runCachedModelTest("wrong id", {
        fixture,
        flow: "absent",
        payload: {},
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow("flow \"absent\" is not routed. Known flows: echo")
  })

  it("narrows a recorded provider failure onto the production model seam", async () => {
    // The recorded failure is the one thing a replay puts on the error channel:
    // an unscripted request and a harness mismatch are defects that
    // `@smthrs/testing` dies on. Editing a recorded fixture is how the failure
    // is produced without a provider, and the events are cleared so the stream
    // fails at the first call rather than after a settled turn.
    //
    // `content_policy` rather than `rate_limited` because the recorded code is
    // reconstructed rather than flattened, and `ModelError.retryable` is true
    // for a rate limit: the agent would then wait out a backoff no provider is
    // going to clear. That the surfaced failure names this exact code is the
    // assertion — a replay that mapped every recording onto
    // `invalid_provider_output` would hand the code under test a different
    // decision than the recording captured.
    const recorded = JSON.parse(readFileSync(fixturePath, "utf8")) as {
      calls: Array<{ events: ReadonlyArray<unknown>; failure?: unknown }>
    }
    const failingPath = join(dir, "failing.json")
    writeFileSync(
      failingPath,
      JSON.stringify({
        calls: recorded.calls.map((call) => ({
          ...call,
          events: [],
          failure: { code: "content_policy", message: "refused", httpStatus: 400 }
        }))
      })
    )

    const failure = await runCachedModelTest("recorded failure", {
      fixture: pathToFileURL(failingPath),
      flow: "echo",
      payload: { topic: "durable workflows" },
      routes: async () => routed,
      expect: () => {}
    }).then(() => undefined, (error: unknown) => error)

    // The engine re-encodes the failure for the journal and keeps only its
    // message, so what reaches the caller is the provider's own wording. That
    // is the assertion: the replay used to rewrite every recorded failure as
    // `recorded model replay failed: <code>`, which told the code under test
    // that the double had misbehaved rather than that the provider had
    // refused.
    const rendered = inspect(failure, { depth: 20 })
    expect(failure).toBeDefined()
    expect(rendered).toContain("refused")
    expect(rendered).not.toContain("recorded model replay failed")
  })

  // Both refusals name the file first. `JSON.parse` used to run eagerly
  // outside the returned effect, so a fixture with a trailing comma rejected
  // with a bare `SyntaxError` and a schema-drifted one surfaced its
  // `SchemaError` unwrapped; neither said which of an app's fixtures was
  // wrong.
  it("names the fixture path when its bytes are not JSON", async () => {
    const path = join(dir, "malformed.json")
    writeFileSync(path, "{\"calls\": [},\n")
    const failure = await runCachedModelTest("malformed fixture", {
      fixture: pathToFileURL(path),
      flow: "echo",
      payload: { topic: "durable workflows" },
      routes: async () => routed,
      expect: () => {}
    }).then(() => undefined, (error: unknown) => error)
    const rendered = inspect(failure, { depth: 20 })
    expect(rendered).toContain(path)
    expect(rendered).toContain("is not valid JSON")
  })

  it("names the fixture path when the JSON is not a fixture", async () => {
    const path = join(dir, "not-a-fixture.json")
    writeFileSync(path, JSON.stringify({ calls: "nope" }))
    const failure = await runCachedModelTest("drifted fixture", {
      fixture: pathToFileURL(path),
      flow: "echo",
      payload: { topic: "durable workflows" },
      routes: async () => routed,
      expect: () => {}
    }).then(() => undefined, (error: unknown) => error)
    const rendered = inspect(failure, { depth: 20 })
    expect(rendered).toContain(path)
    expect(rendered).toContain("is not a @smthrs/testing fixture")
  })

  it("surfaces a replay of a request the fixture never recorded", async () => {
    await expect(
      runCachedModelTest("unscripted request", {
        fixture,
        flow: "echo",
        // A payload the recording never saw digests to a request the replay
        // has no answer for.
        payload: { topic: "never recorded" },
        routes: async () => routed,
        expect: () => {}
      })
    ).rejects.toThrow()
  })
})

/**
 * Cancellation, which is what a vitest timeout amounts to.
 *
 * `runCachedModelTest` used to call `Effect.runPromise` with no signal, so a
 * test that exhausted `testTimeout` was reported failed while its fiber kept
 * evaluating cells in the sandbox and, under `SMTHRS_RECORD=1`, kept the live
 * provider stream open until the worker process exited.
 */
describe("a cancelled run", () => {
  /** A live seat whose stream never settles: only cancellation ends this run. */
  const stalled = (): Model.Model => Model.make({ stream: () => Stream.never })

  it("interrupts the flow when the caller's signal aborts", async () => {
    const controller = new AbortController()
    const path = join(dir, "aborted.json")
    process.env["SMTHRS_RECORD"] = "1"
    try {
      const run = runCachedModelTest<{ topic: string }, Output>("aborted", {
        fixture: pathToFileURL(path),
        flow: "echo",
        payload: { topic: "durable workflows" },
        live: stalled,
        routes: async () => routed,
        signal: controller.signal,
        expect: () => {
          throw new Error("an interrupted run must not reach its assertions")
        }
      }).then(() => "settled" as const, () => "interrupted" as const)

      setTimeout(() => controller.abort(), 100)
      let timer: ReturnType<typeof setTimeout> | undefined
      const stillRunning = new Promise<"still running">((resolve) => {
        timer = setTimeout(resolve, 5_000, "still running")
      })
      const outcome = await Promise.race([run, stillRunning])
      clearTimeout(timer)
      expect(outcome).toBe("interrupted")
    } finally {
      delete process.env["SMTHRS_RECORD"]
    }
    // The run never reached `options.expect`, so nothing was written.
    expect(existsSync(path)).toBe(false)
  })
})

/**
 * What a recording run that fails does to the fixture already on disk.
 *
 * The write used to sit in a `finally`, so a provider 429, a payload the flow
 * could not decode, or an assertion that no longer held replaced a good
 * committed fixture with a partial one, and a run that reached the model zero
 * times truncated it to `{"calls": []}`. Both cases below start from a fixture
 * with known bytes and assert those exact bytes afterwards: nothing here reads
 * what the run produced, because the contract is that it produced nothing.
 */
describe("a failed recording", () => {
  const sentinel = "{\n  \"calls\": [\n    \"the bytes already committed\"\n  ]\n}\n"

  /** A fresh fixture path carrying {@link sentinel}, plus the staging name a write would use. */
  const committed = (name: string): { readonly path: string; readonly staging: string } => {
    const path = join(dir, name)
    writeFileSync(path, sentinel)
    return { path, staging: `${path}.recording` }
  }

  const record = async (run: () => Promise<void>): Promise<unknown> => {
    process.env["SMTHRS_RECORD"] = "1"
    try {
      return await run().then(() => undefined, (error: unknown) => error)
    } finally {
      delete process.env["SMTHRS_RECORD"]
    }
  }

  it("leaves the committed bytes alone when the assertion no longer holds", async () => {
    const { path, staging } = committed("assertion-failed.json")
    const failure = await record(() =>
      runCachedModelTest<{ topic: string }, Output>("assertion failed", {
        fixture: pathToFileURL(path),
        flow: "echo",
        payload: { topic: "durable workflows" },
        live: scripted,
        routes: async () => routed,
        expect: () => {
          throw new Error("the answer changed")
        }
      })
    )
    expect(inspect(failure)).toContain("the answer changed")
    expect(readFileSync(path, "utf8")).toBe(sentinel)
    expect(existsSync(staging)).toBe(false)
  })

  it("leaves the committed bytes alone when the run itself fails", async () => {
    // `echo` declares `{ topic: string }`, so an empty payload fails to decode
    // and the run ends before the model is reached at all.
    const { path, staging } = committed("run-failed.json")
    const failure = await record(() =>
      runCachedModelTest("run failed", {
        fixture: pathToFileURL(path),
        flow: "echo",
        payload: {},
        live: scripted,
        routes: async () => routed,
        expect: () => {}
      })
    )
    expect(failure).toBeDefined()
    expect(readFileSync(path, "utf8")).toBe(sentinel)
    expect(existsSync(staging)).toBe(false)
  })
})

/**
 * The bridge from the replay error channel to the production `Model` seam.
 *
 * `ModelLikeError` has two members and a fixture can only express one of them:
 * `ModelErrorLike.code` is a closed union with no `capability_contract_violation`
 * member, so only a poisoned `ModelLike` reaches the second branch. It is
 * driven here directly rather than left unproven.
 */
describe("replayModelError", () => {
  it("rebuilds a recorded provider failure field for field", () => {
    const error = replayModelError({
      code: "rate_limited",
      message: "slow down",
      retryAfterMillis: 1_500,
      resetAtEpochMillis: 42,
      resetSource: "header",
      providerCode: "429",
      requestId: "req-1",
      httpStatus: 429
    })
    expect(error.code).toBe("rate_limited")
    expect(error.message).toBe("slow down")
    expect(error.retryAfterMillis).toBe(1_500)
    expect(error.resetAtEpochMillis).toBe(42)
    expect(error.resetSource).toBe("header")
    expect(error.providerCode).toBe("429")
    expect(error.requestId).toBe("req-1")
    expect(error.httpStatus).toBe(429)
  })

  it("omits the retry metadata a recording did not carry", () => {
    const error = replayModelError({ code: "content_policy", message: "refused" })
    expect(error.code).toBe("content_policy")
    expect(error.retryAfterMillis).toBeUndefined()
    expect(error.httpStatus).toBeUndefined()
  })

  it("reports a double's contract violation as a defective provider response, naming it", () => {
    // A contract violation is a defect in the double, not a decision the
    // provider made, so it must not arrive wearing a provider's code. The real
    // error class is constructed rather than a look-alike literal, because the
    // branch exists to handle the other member of `ModelLikeError` and a
    // structural stand-in would not prove it is reachable from that union.
    const error = replayModelError(
      new CapabilityContractError({
        code: "capability_contract_violation",
        capability: "model",
        operation: "model/stream"
      })
    )
    expect(error.code).toBe("invalid_provider_output")
    expect(error.message).toContain("capability_contract_violation")
  })
})

describe("the test seat", () => {
  it("reads SMTHRS_RECORD from the environment at call time", () => {
    delete process.env["SMTHRS_RECORD"]
    expect(recording()).toBe(false)
    process.env["SMTHRS_RECORD"] = "1"
    expect(recording()).toBe(true)
    delete process.env["SMTHRS_RECORD"]
  })

  it("carries a credential-free placeholder request", () => {
    expect(preparedRequest.url).toBe("https://example.invalid/v1/messages")
    expect(preparedRequest.bodyText).toBe("{}")
  })
})
