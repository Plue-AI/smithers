/**
 * What each standard helper actually binds.
 *
 * A host composes `StandardFlows.filesystem(services)`, not the seven bindings
 * inside it, so the catalog a helper produces is this package's contract with
 * the model and with `docs/guides/capabilities.md`. Losing one line from a
 * binding array is invisible until a run reaches for the capability and finds
 * nothing there, which is the failure the filesystem list was written to end:
 * with only `read` and `write` bound, the built-in harness emitted
 * `apply_patch` heredocs into `bash`, watched the shell report
 * `apply_patch: command not found`, and finished runs claiming fixes it never
 * applied. These tests read the catalog each source produces and compare it
 * with the documented set, and run the two search bindings to prove they are
 * handed the `Search` the host supplied rather than the bare filesystem
 * context.
 */
import * as NodePath from "@effect/platform-node/NodePath"
import * as Digest from "@smthrs/core/Digest"
import type { FlowRuntime } from "@smthrs/flow"
import * as AgentEvent from "@smthrs/harness/AgentEvent"
import type * as Cell from "@smthrs/harness/Cell"
import * as FlowBinding from "@smthrs/harness/FlowBinding"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import * as MemoryStore from "@smthrs/memory/MemoryStore"
import * as Recall from "@smthrs/memory/Recall"
import * as Evaluator from "@smthrs/model/Evaluator"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Descriptor from "@smthrs/registry/Descriptor"
import * as Search from "@smthrs/std/Search"
import * as TestRunner from "@smthrs/std/TestRunner"
import { Context, Effect, FileSystem, Layer, Option, Path } from "effect"
import type * as Crypto from "effect/Crypto"
import { existsSync } from "node:fs"
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ChildFlows from "../src/ChildFlows.ts"
import * as StandardFlows from "../src/StandardFlows.ts"

/** The native path service, materialized once so bindings can be given a context. */
const pathServices: Context.Context<Path.Path> = Effect.runSync(
  Effect.provide(Effect.context<Path.Path>(), NodePath.layer)
)

const nativeHelperAvailable = [
  process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY,
  join(import.meta.dirname, "../../../../target/release/smithers-jj-export"),
  join(import.meta.dirname, "../../../../target/debug/smithers-jj-export"),
  "/usr/local/bin/smithers-jj-export"
].some((path) => path !== undefined && existsSync(path))
const guardedDisk = process.env.SMITHERS_WORKSPACE_JJ_EXPORT_BINARY || nativeHelperAvailable ? it : it.skip
const guardedDiskReason = process.platform === "win32" && guardedDisk === it.skip
  ? "skipped on Windows: native smithers-jj-export was not built"
  : "requires native smithers-jj-export"

/**
 * The host slices each helper takes. A catalog is the binding list a source
 * declares, so the services behind it never run here and a refusing stub is
 * the honest stand-in for every one of them.
 */
const filesystemServices = Context.merge(
  Context.make(FileSystem.FileSystem, FileSystem.makeNoop({})),
  pathServices
)

const shellServices = Context.merge(
  Context.make(ChildProcessSpawner.ChildProcessSpawner, ChildProcessSpawner.makeNoop()),
  pathServices
)

const evaluatorServices = (layer: Layer.Layer<Evaluator.Evaluator>): Context.Context<Evaluator.Evaluator> =>
  Effect.runSync(Effect.provide(Effect.context<Evaluator.Evaluator>(), layer))

const testServices = Context.make(
  ChildProcessSpawner.ChildProcessSpawner,
  ChildProcessSpawner.makeNoop()
).pipe(
  Context.add(TestRunner.TestRunner, TestRunner.makeNoop()),
  // The `test` flow attributes a non-zero exit with Jev. A host without a key
  // binds this, and the flow fails rather than reporting an unjudged run.
  Context.merge(evaluatorServices(Evaluator.layerUnavailable()))
)

const memoryServices = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
  Context.add(Recall.Recall, Recall.makeNoop())
)

const clockServices = Context.empty() as Context.Context<
  Crypto.Crypto | FlowRuntime.FlowRuntime | FlowRuntime.FlowInstance
>

/** The catalog `docs/guides/capabilities.md` promises, helper by helper. */
const promised: ReadonlyArray<{
  readonly source: FlowBinding.Source
  readonly flows: ReadonlyArray<string>
}> = [
  {
    source: StandardFlows.filesystem(filesystemServices),
    flows: ["read", "write", "edit", "apply_patch", "ls", "glob", "grep"]
  },
  { source: StandardFlows.shell(shellServices), flows: ["bash"] },
  { source: StandardFlows.tests(testServices), flows: ["test"] },
  {
    source: StandardFlows.memory(
      memoryServices,
      evaluatorServices(Evaluator.layerUnavailable()),
      StandardFlows.hostWide
    ),
    flows: ["remember", "recall"]
  },
  { source: StandardFlows.jev(evaluatorServices(Evaluator.layerUnavailable())), flows: ["jev"] },
  { source: StandardFlows.clock(clockServices), flows: ["wait"] },
  { source: StandardFlows.approval(StandardFlows.askerNoop()), flows: ["ask"] }
]

/** One synthetic call, so a binding runs without the controller around it. */
const callOf = (flowName: string, input: unknown): Cell.Call =>
  ({
    flowName,
    input,
    capabilities: [],
    effects: {
      reads: [],
      writes: [],
      mode: "expected",
      onConflict: "serialize",
      tier: "sealed"
    },
    placement: Option.none(),
    identity: {
      session: "session-1",
      frame: 0,
      cell: "cell-digest",
      ordinal: 0,
      declaration: `${flowName}-declaration`,
      layers: []
    }
  }) as unknown as Cell.Call

describe("the dark coding terminal binding", () => {
  it.each([
    { command: "printf terminal-fixture", mode: "unhermetic" },
    { command: "printf terminal-fixture", mode: "hermetic", reads: ["**"], writes: ["**"] },
    { script: "print('terminal-fixture')", interpreter: "python3", mode: "unhermetic" },
    { command: "printf terminal-fixture", container: "branch", mode: "unhermetic" }
  ])("refuses before any host or container effect: %j", async (input) => {
    let spawns = 0
    let routes = 0
    const services = Context.merge(pathServices, Context.make(
      ChildProcessSpawner.ChildProcessSpawner,
      ChildProcessSpawner.makeNoop({ spawn: () => { spawns++; return Effect.die("host execution") } })
    ))
    const source = StandardFlows.shell(services, {
      exec: () => { routes++; return Effect.die("container execution") }
    }, { terminal: "agent", sealedTo: "branch" })
    const [binding] = await Effect.runPromise(source.bindings())
    expect(binding!.descriptor.name).toBe("bash")
    const result = await Effect.runPromise(binding!.run(callOf("bash", input)))
    expect(result).toMatchObject({ outcome: "failure", code: "flow_failed", value: null })
    expect(result.message).toContain("Agent terminal unavailable")
    expect(result.message).toContain("C-J3-10 and C-COL-04")
    expect(spawns).toBe(0)
    expect(routes).toBe(0)
  })
})

describe("the standard capability catalog", () => {
  for (
    const fixture of [
      {
        flow: "glob",
        input: { pattern: "**/add.mjs", limit: 10 },
        value: { paths: ["add.mjs", "nested/add.mjs"], total: 2, truncated: false }
      },
      {
        flow: "grep",
        input: { pattern: "a + b", fixedStrings: true, limit: 10 },
        value: {
          matches: [
            expect.objectContaining({ file: "add.mjs", line: 1 }),
            expect.objectContaining({ file: "nested/add.mjs", line: 1 })
          ],
          filesSearched: 2,
          truncated: false
        }
      },
      {
        flow: "ls",
        input: { path: "." },
        value: {
          entries: [{ name: "nested/", kind: "directory" }, { name: "add.mjs", kind: "file" }],
          total: 2,
          truncated: false
        }
      }
    ]
  ) {
    guardedDisk(
      `searches the guarded disk workspace through ${fixture.flow} without an absolute root (${guardedDiskReason})`,
      async () => {
        const root = await realpath(await mkdtemp(join(tmpdir(), "smithers-standard-search-")))
        try {
          await mkdir(join(root, "nested"))
          await writeFile(join(root, "add.mjs"), "export const add = (a, b) => a + b\n")
          await writeFile(join(root, "nested/add.mjs"), "export const sum = (a, b) => a + b\n")
          const guarded = KernelFileSystem.layer.pipe(
            Layer.provide(AtomicFileSystem.layer),
            Layer.provideMerge(NodePath.layer),
            Layer.provide(Workspace.layer(root)),
            Layer.provide(GrantStore.layerNoop)
          )
          const result = await Effect.runPromise(
            Effect.gen(function*() {
              const services = yield* Effect.context<FileSystem.FileSystem | Path.Path>()
              const bindings = yield* StandardFlows.filesystem(services).bindings()
              return yield* bindings.find((binding) => binding.descriptor.name === fixture.flow)!
                .run(callOf(fixture.flow, fixture.input))
            }).pipe(Effect.provide(guarded), Effect.scoped)
          )

          expect(result, JSON.stringify(result)).toMatchObject({ outcome: "success", value: fixture.value })
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      }
    )
  }

  for (const entry of promised) {
    it(`binds exactly the flows ${entry.source.name} promises`, async () => {
      const bindings = await Effect.runPromise(entry.source.bindings())
      expect(bindings.map((binding) => binding.descriptor.name)).toEqual(entry.flows)
    })
  }

  /**
   * What each standard flow says a call to it does, on the descriptor a run
   * journals and a card reads.
   *
   * These are the words the compatibility table in `apps/app` `RunTrace.ts`
   * guesses for a journal recorded before a declaration could say anything, so
   * a record with metadata and one without must read identically. `bash`
   * declares no activity on purpose and is the one row that says so.
   */
  it("declares what a call to each standard flow does and how it reads", async () => {
    const bound = await Effect.runPromise(
      Effect.forEach(
        [
          StandardFlows.filesystem(filesystemServices),
          StandardFlows.shell(shellServices),
          StandardFlows.tests(
            testServices
          ),
          StandardFlows.jev(evaluatorServices(Evaluator.layerUnavailable()))
        ],
        (source) => source.bindings()
      )
    )
    const declared = new Map(
      bound.flat().map((binding) => [
        binding.descriptor.name,
        [binding.descriptor.activity, binding.descriptor.presentation] as const
      ])
    )
    expect(
      [...declared].map((
        [name, [activity, presentation]]
      ) => [name, activity, presentation?.verb.success, presentation?.subject, presentation?.result])
    ).toEqual([
      ["read", "reads", "read", "path", "read"],
      ["write", "writes", "wrote", "path", "write"],
      ["edit", "writes", "edited", "path", "edit"],
      ["apply_patch", "writes", "patched", "patch", "patch"],
      ["ls", "reads", "listed", "path", "entries"],
      ["glob", "reads", "listed", "pattern", "paths"],
      ["grep", "reads", "searched", "pattern", "matches"],
      ["bash", undefined, "ran", "command", "command"],
      ["test", "tests", "ran", "selection", "tests"],
      ["jev", "checks", "asked Jev", "none", "none"]
    ])
    // Display fields grant nothing: the identity a plan approves and a call
    // replays against is the same number with and without them.
    const read = bound.flat().find((binding) => binding.descriptor.name === "read")!.descriptor
    const { activity: _activity, presentation: _presentation, ...bare } = read
    expect(Descriptor.declarationDigest(new Descriptor.FlowDescriptor(bare))).toBe(
      Descriptor.declarationDigest(read)
    )
  })

  it("names its sources so a composed catalog says where each flow came from", () => {
    expect(promised.map((entry) => entry.source.name)).toEqual([
      "std/filesystem",
      "std/shell",
      "std/tests",
      "memory",
      "model/jev",
      "engine/clock",
      "host/approval"
    ])
  })

  it("pins every standard and child source", () => {
    const children = ChildFlows.source(ChildFlows.makeNoop())
    expect([...promised.map((entry) => entry.source.name), children.name]).toEqual(StandardFlows.coreSources)
  })

  it("hands glob and grep the search the host supplied, not the bare filesystem context", async () => {
    const asked: Array<string> = []
    const search = Search.make({
      glob: (input) =>
        Effect.sync(() => {
          asked.push(`glob ${input.pattern} in ${input.root}`)
          return { paths: ["/repo/alpha.md"], total: 1, truncated: false }
        }),
      grep: (input) =>
        Effect.sync(() => {
          asked.push(`grep ${input.pattern} in ${input.root}`)
          return { matches: [], files: [], filesSearched: 1, skippedBinary: 0, truncated: false }
        })
    })
    const bindings = await Effect.runPromise(
      StandardFlows.filesystem(filesystemServices, search).bindings()
    )
    const byName = new Map(bindings.map((binding) => [binding.descriptor.name, binding]))

    const globbed = await Effect.runPromise(
      byName.get("glob")!.run(callOf("glob", { pattern: "*.md", root: "/repo" }))
    )
    const grepped = await Effect.runPromise(
      byName.get("grep")!.run(callOf("grep", { pattern: "second", root: "/repo" }))
    )

    // The filesystem context alone cannot answer either call: both handlers
    // require `Search`, and only the search context carries it.
    expect(globbed).toMatchObject({
      outcome: "success",
      value: { paths: ["/repo/alpha.md"], total: 1, truncated: false }
    })
    expect(grepped).toMatchObject({ outcome: "success", value: { filesSearched: 1 } })
    expect(asked).toEqual(["glob *.md in /repo", "grep second in /repo"])
  })
})

describe("the jev flow", () => {
  /** A scripted judge that records every request it is asked. */
  const recording = (
    answer: Evaluator.Script
  ): { readonly services: Context.Context<Evaluator.Evaluator>; readonly asked: Array<Evaluator.Request> } => {
    const asked: Array<Evaluator.Request> = []
    const services = evaluatorServices(
      Evaluator.layerScripted((request) => {
        asked.push(request)
        return answer(request)
      })
    )
    return { services, asked }
  }

  const bindingOf = async (source: FlowBinding.Source): Promise<FlowBinding.Binding> => {
    const bindings = await Effect.runPromise(source.bindings())
    return bindings.find((binding) => binding.descriptor.name === "jev")!
  }

  const questions = {
    auth: { type: "boolean", instructions: "Does this file implement authentication?" },
    area: { type: "choice", instructions: "Which area owns it?", criteria: { auth: "login", billing: "invoices" } },
    risk: { type: "score", instructions: "How risky is changing it?", criteria: ["low", "high"] }
  }

  it("asks the bound evaluator the questions the cell wrote and answers with decoded, typed answers", async () => {
    const judge = recording(() => ({
      auth: { probability: 0.9 },
      area: { choice: "auth", probabilities: { auth: 0.8, billing: 0.2 } },
      risk: { score: 1 }
    }))
    const binding = await bindingOf(StandardFlows.jev(judge.services))
    const result = await Effect.runPromise(binding.run(callOf("jev", { state: { path: "auth.py" }, questions })))

    // The judge was CONTACTED, once, with the state and the questions as the
    // cell wrote them: the wire form of the decoded questions is the literal.
    expect(judge.asked).toHaveLength(1)
    expect(judge.asked[0]!.state).toEqual({ path: "auth.py" })
    expect(Evaluator.encodeQuestions(judge.asked[0]!.questions)).toEqual(questions)
    expect(result).toMatchObject({
      outcome: "success",
      value: {
        answers: {
          auth: { value: true, probability: 0.9 },
          area: { value: "auth", probabilities: { auth: 0.8, billing: 0.2 }, confidence: 0.8 },
          risk: { value: 1, label: "high", probabilities: { low: 0, high: 1 }, confidence: 1 }
        },
        latencyMs: 0
      }
    })
  })

  it("passes the transport's usage and confidence through, so the call's cost is in its recorded result", async () => {
    const services = Context.make(
      Evaluator.Evaluator,
      Evaluator.Evaluator.of({
        evaluate: () =>
          Effect.succeed({
            answers: { auth: { type: "boolean" as const, probability: 0.2 } },
            confidence: { auth: 0.6 },
            usage: { inputTokens: 120, outputTokens: 4 },
            latencyMs: 287
          })
      })
    )
    const binding = await bindingOf(StandardFlows.jev(services))
    const result = await Effect.runPromise(
      binding.run(callOf("jev", { state: "def login(): pass", questions: { auth: questions.auth } }))
    )
    expect(result).toMatchObject({
      outcome: "success",
      value: {
        answers: { auth: { value: false, probability: 0.2 } },
        confidence: { auth: 0.6 },
        usage: { inputTokens: 120, outputTokens: 4 },
        latencyMs: 287
      }
    })
  })

  it("refuses a malformed question before any transport is asked, with a message the cell can correct from", async () => {
    const judge = recording(() => ({}))
    const binding = await bindingOf(StandardFlows.jev(judge.services))
    const result = await Effect.runPromise(
      binding.run(
        callOf("jev", {
          state: { path: "auth.py" },
          questions: { area: { type: "choice", instructions: "Which area?", criteria: { only: "one option" } } }
        })
      )
    )
    expect(result).toMatchObject({ outcome: "failure", code: "invalid_input" })
    expect(result.message).toContain("A choice question offers between 2 and 255 options, not 1")
    expect(judge.asked).toHaveLength(0)
  })

  it("refuses an empty question map and an oversized state without asking the judge", async () => {
    const judge = recording(() => ({}))
    const binding = await bindingOf(StandardFlows.jev(judge.services, { maxStateBytes: 32 }))
    const none = await Effect.runPromise(binding.run(callOf("jev", { state: {}, questions: {} })))
    const huge = await Effect.runPromise(
      binding.run(callOf("jev", { state: { excerpt: "x".repeat(64) }, questions: { auth: questions.auth } }))
    )
    expect(none).toMatchObject({ outcome: "failure", code: "flow_failed" })
    expect(none.message).toContain("at least one question")
    expect(huge).toMatchObject({ outcome: "failure", code: "flow_failed" })
    expect(huge.message).toContain("this host's ceiling is 32 bytes")
    expect(judge.asked).toHaveLength(0)
  })

  it("only lowers the state ceiling: a larger or non-finite value keeps the default", async () => {
    // The public contract is the description's 256 KiB; a host cannot raise it
    // by passing a bigger number, and cannot remove it by passing NaN. A state
    // one byte over the default is refused under every such request, and the
    // refusal names the default ceiling rather than the one the host asked for.
    const judge = recording(() => ({}))
    const state = "x".repeat(StandardFlows.defaultMaxJevStateBytes - 1)
    expect(new TextEncoder().encode(JSON.stringify(state)).byteLength).toBe(StandardFlows.defaultMaxJevStateBytes + 1)
    for (const requested of [Number.POSITIVE_INFINITY, Number.NaN, StandardFlows.defaultMaxJevStateBytes * 4]) {
      const binding = await bindingOf(StandardFlows.jev(judge.services, { maxStateBytes: requested }))
      const result = await Effect.runPromise(binding.run(callOf("jev", { state, questions: { auth: questions.auth } })))
      expect(result).toMatchObject({ outcome: "failure", code: "flow_failed" })
      expect(result.message).toContain(`this host's ceiling is ${StandardFlows.defaultMaxJevStateBytes} bytes`)
    }
    expect(judge.asked).toHaveLength(0)
  })

  it.each([
    {
      label: "a refusing gateway",
      layer: Evaluator.layerScripted(() =>
        Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "The gateway answered 503" }))
      ),
      expected: "refused: The gateway answered 503"
    },
    {
      label: "a timed-out gateway",
      layer: Evaluator.layerScripted(() =>
        Effect.fail(
          new Evaluator.EvaluatorError({ code: "timeout", message: "The gateway did not answer within 1500 ms" })
        )
      ),
      expected: "timeout: The gateway did not answer within 1500 ms"
    },
    {
      label: "no transport at all",
      layer: Evaluator.layerUnavailable(),
      expected: `unreachable: ${Evaluator.unreachableMessage}`
    },
    {
      label: "an answer of the wrong shape",
      layer: Evaluator.layerScripted(() => ({ auth: { choice: "yes" } })),
      expected: "invalid_answer:"
    }
  ])("fails the call with the evaluator's code and no default answer for $label", async ({ expected, layer }) => {
    const binding = await bindingOf(StandardFlows.jev(evaluatorServices(layer)))
    const result = await Effect.runPromise(
      binding.run(callOf("jev", { state: { path: "auth.py" }, questions: { auth: questions.auth } }))
    )
    expect(result).toMatchObject({ outcome: "failure", code: "flow_failed", value: null })
    expect(result.message).toContain(`Flow jev failed: ${expected}`)
    expect(JSON.stringify(result)).not.toContain("answers")
  })

  it("is absent from any catalog whose host bound no evaluator", async () => {
    // Absence is structural: `jev` takes `Context<Evaluator>` and nothing
    // else, so a composition without a judge has no way to construct it. The
    // catalog a judgeless host composes is exactly the other helpers' flows.
    const catalog = await Effect.runPromise(
      FlowBinding.catalog([
        StandardFlows.filesystem(filesystemServices),
        StandardFlows.shell(shellServices)
      ])
    )
    expect(catalog.descriptors.map((entry) => entry.name)).not.toContain("jev")
    const judge = evaluatorServices(Evaluator.layerUnavailable())
    const withJudge = await Effect.runPromise(
      FlowBinding.catalog([
        StandardFlows.memory(memoryServices, judge, StandardFlows.hostWide),
        StandardFlows.jev(judge)
      ])
    )
    expect(withJudge.descriptors.map((entry) => entry.name)).toEqual(["remember", "recall", "jev"])
    const jev = withJudge.descriptors.find((entry) => entry.name === "jev")!
    expect(jev.modelInvocable).toBe(true)
    expect(jev.capabilities).toEqual(["model:call:typesafe-ai/jev"])
    expect(jev.effects.tier).toBe("sealed")
    expect(jev.description).toContain("pack the items into one call")
  })
})

describe("the recall flow", () => {
  const rows = [
    { bank: "notes", key: "deploy", text: "Deploys go through the release train.", score: 0.8 },
    { bank: "notes", key: "auth", text: "Login tokens rotate hourly.", score: 0.6 }
  ]
  const recalling = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
    Context.add(Recall.Recall, Recall.Recall.of({ recall: () => Effect.succeed(rows) }))
  )

  const recall = async (
    judge: Layer.Layer<Evaluator.Evaluator>,
    services: Context.Context<MemoryStore.MemoryStore | Recall.Recall> = recalling
  ) => {
    const journaled: Array<AgentEvent.AgentEvent> = []
    const bindings = await Effect.runPromise(
      StandardFlows.memory(services, evaluatorServices(judge), StandardFlows.hostWide).bindings()
    )
    const result = await Effect.runPromise(
      bindings.find((binding) => binding.descriptor.name === "recall")!
        .run(callOf("recall", { banks: ["notes"], query: "why does login fail?" }))
        .pipe(Effect.provideService(AgentEvent.Journal, (event) => Effect.sync(() => void journaled.push(event))))
    )
    return { ...result, journaled }
  }

  it("withholds only the rows Jev is confident the query does not need, lists them, and journals the reading", async () => {
    const asked: Array<Evaluator.Request> = []
    const result = await recall(Evaluator.layerScripted((request) => {
      asked.push(request)
      return { unnecessary_0: { probability: 0.95 }, unnecessary_1: { probability: 0.1 } }
    }))
    expect(asked).toHaveLength(1)
    expect(asked[0]!.state).toMatchObject({ context: { task: "why does login fail?" } })
    expect(result).toMatchObject({ outcome: "success" })
    expect(result.value).toEqual({
      rows: [rows[1]],
      withheld: [{ key: "deploy", digest: Digest.digest(rows[0]!.text), p: 0.95 }]
    })
    expect(result.journaled.map((event) => event._tag)).toEqual(["decision-settled", "relevance-settled"])
    expect(result.journaled[0]).toMatchObject({
      scope: "session-1",
      frame: 0,
      classifier: "relevance/unnecessary",
      acted: true
    })
    expect(result.journaled[1]).toMatchObject({
      source: "recall",
      withheld: [{ kind: "memory", id: "deploy", p: 0.95 }],
      kept: [{ kind: "memory", id: "auth", p: 0.1 }]
    })
  })

  it("asks nothing and journals nothing when nothing is recalled", async () => {
    const asked: Array<Evaluator.Request> = []
    const result = await recall(
      Evaluator.layerScripted((request) => {
        asked.push(request)
        return {}
      }),
      Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
        Context.add(Recall.Recall, Recall.Recall.of({ recall: () => Effect.succeed([]) }))
      )
    )
    expect(result.value).toEqual({ rows: [], withheld: [] })
    expect(asked).toEqual([])
    expect(result.journaled).toEqual([])
  })

  it.each([
    {
      label: "a refusing gateway",
      layer: Evaluator.layerScripted(() =>
        Effect.fail(new Evaluator.EvaluatorError({ code: "refused", status: 503, message: "The gateway answered 503" }))
      ),
      unjudged: { reason: "refused", detail: "The gateway answered 503" }
    },
    {
      label: "a timed-out gateway",
      layer: Evaluator.layerScripted(() =>
        Effect.fail(
          new Evaluator.EvaluatorError({ code: "timeout", message: "The gateway did not answer within 1500 ms" })
        )
      ),
      unjudged: { reason: "timeout", detail: "The gateway did not answer within 1500 ms" }
    },
    {
      label: "no transport at all",
      layer: Evaluator.layerUnavailable(),
      unjudged: { reason: "unreachable", detail: Evaluator.unreachableMessage }
    }
  ])("keeps every row, says why, and journals decision-unjudged for $label", async ({ layer, unjudged }) => {
    const result = await recall(layer)
    expect(result).toMatchObject({ outcome: "success" })
    expect(result.value).toEqual({ rows, withheld: [], unjudged })
    expect(result.journaled).toEqual([
      expect.objectContaining({
        _tag: "decision-unjudged",
        scope: "session-1",
        frame: 0,
        classifier: "relevance/unnecessary",
        reason: unjudged.reason,
        items: 2
      })
    ])
  })

  it("judges a scoped recall over the policy's own bank, and refuses a foreign one before any I/O", async () => {
    const reached: Array<ReadonlyArray<string>> = []
    const scoped = Context.make(MemoryStore.MemoryStore, MemoryStore.makeNoop()).pipe(
      Context.add(
        Recall.Recall,
        Recall.Recall.of({ recall: (input) => Effect.sync(() => (reached.push(input.banks), rows)) })
      )
    )
    const judge = evaluatorServices(
      Evaluator.layerScripted(() => ({ unnecessary_0: { probability: 0.95 }, unnecessary_1: { probability: 0.1 } }))
    )
    const bindings = await Effect.runPromise(
      StandardFlows.memory(scoped, judge, {
        policy: { banks: ["agent-builder"], maxTokens: 2048 }
      }).bindings()
    )
    const binding = bindings.find((entry) => entry.descriptor.name === "recall")!
    expect(binding.descriptor.description).toContain("withheld and listed")
    const journaled: Array<AgentEvent.AgentEvent> = []
    const run = (banks: ReadonlyArray<string>) =>
      Effect.runPromise(
        binding.run(callOf("recall", { banks, query: "why does login fail?" })).pipe(
          Effect.provideService(AgentEvent.Journal, (event) => Effect.sync(() => void journaled.push(event)))
        )
      )
    const kept = await run([])
    expect(reached).toEqual([["agent-builder"]])
    expect(kept.value).toEqual({
      rows: [rows[1]],
      withheld: [{ key: "deploy", digest: Digest.digest(rows[0]!.text), p: 0.95 }]
    })
    expect(journaled.map((event) => event._tag)).toEqual(["decision-settled", "relevance-settled"])
    const foreign = await run(["agent-checker"])
    expect(foreign).toMatchObject({ outcome: "failure" })
    expect(foreign.message).toContain("invalid_namespace")
    expect(reached).toHaveLength(1)
  })

  it("declares recall's input and effects with the judged output", async () => {
    const bindings = await Effect.runPromise(
      StandardFlows.memory(recalling, evaluatorServices(Evaluator.layerUnavailable()), StandardFlows.hostWide)
        .bindings()
    )
    const recall = bindings.find((binding) => binding.descriptor.name === "recall")!.descriptor
    expect(recall.description).toContain("withheld and listed")
    expect(recall.effects.tier).toBe("sealed")
  })
})
