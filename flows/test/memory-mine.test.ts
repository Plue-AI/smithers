import { NodeCrypto, NodeServices } from "@effect/platform-node"
import * as MemoryMine from "@smthrs/agent/MemoryMine"
import { FlowEngine } from "@smthrs/engine"
import { Action, Interpreter } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Effect, Exit, Layer, ManagedRuntime } from "effect"
import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "node:test"
import * as MemoryStore from "../../packages/smithers/agent/memory/src/MemoryStore.ts"
import * as TestMemory from "../../packages/smithers/agent/memory/src/test/TestMemory.ts"
import * as Mine from "../memory/mine.ts"
import * as MineFlowFile from "../memory/mine/flow.ts"
import MineFlow from "../memory/mine/flow.ts"

const bank = "project-0123456789abcdef"

const build = "The tests run with `pnpm vitest` from packages/foo."
const plan = "I will now edit the file."
const output = "Build output lands in dist/esm."
const tracked = "The coding flow drops the review receipt when a landing retries."

/** A control-journal row and a harness row, in JSONL, as a finished run leaves them. */
const journal = [
  {
    seq: 3,
    eventType: "control.agent.model-settled",
    payload: { text: `${build}\n\n${plan}\n\n\`\`\`ts\nctx.call("bash", { cmd: "ls" })\n\`\`\`` }
  },
  {
    seq: 5,
    event_type: "control.agent.steering-drained",
    payload_json: JSON.stringify({
      messages: [
        { role: "user", text: "Use SQLite, not Postgres,\nfor the local store." },
        { role: "assistant", text: "Continuing." }
      ]
    })
  },
  {
    seq: 8,
    eventType: "flows.harness.model-settled.v1",
    payload: {
      message: {
        role: "assistant",
        content: [{ type: "text", text: `${output}\n\nThe  tests run with \`pnpm vitest\`   from packages/foo.` }, {
          type: "tool-call"
        }]
      }
    }
  },
  {
    seq: 9,
    eventType: "flows.harness.model-settled.v1",
    payload: { message: { content: [{ type: "text", text: tracked }] } }
  },
  { seq: 10, eventType: "control.agent.cell-produced", payload: { text: "ignored" } }
].map((row) => JSON.stringify(row)).join("\n") + "\n"

type Asked = Array<ReadonlyArray<string>>

/** Answers each item's durable question from `durable` and its issue question from `issue`, recording what was asked. */
const judge = (durable: Readonly<Record<string, number>>, asked: Asked, issue: Readonly<Record<string, number>> = {}) =>
  Evaluator.layerScripted((request) => {
    const items = (request.state as { items: ReadonlyArray<{ text: string }> }).items
    asked.push(items.map((item) => item.text))
    return Object.fromEntries(items.flatMap((item, index) => [
      [`durable_${index}`, { probability: durable[item.text] ?? 0 }],
      [`issue_${index}`, { probability: issue[item.text] ?? 0 }]
    ]))
  })

const failing = (code: Evaluator.EvaluatorErrorCode) =>
  Evaluator.layerScripted(() => Effect.fail(new Evaluator.EvaluatorError({ code, message: `jev ${code}` })))

const workspace = async () => {
  const root = await mkdtemp(join(tmpdir(), "memory-mine-"))
  return { root, done: () => rm(root, { recursive: true, force: true }) }
}

/** Runs `effect`, which brings its own test store, over the Node filesystem and `evaluator`. */
const run = <A, E>(
  effect: Effect.Effect<A, E, Evaluator.Evaluator | NodeServices.NodeServices>,
  evaluator: Layer.Layer<Evaluator.Evaluator>
) => Effect.runPromiseExit(effect.pipe(Effect.provide(Layer.mergeAll(evaluator, NodeServices.layer))))

const notes = Effect.flatMap(MemoryStore.MemoryStore, (store) => store.listNotes({ namespace: bank }))

const input = (root: string, runId = "run-1") => ({ runId, item: "item-7", root, bank, journal })

test("rows reads JSONL in both journal spellings, which MemoryMine.extract reads with their sequence", async () => {
  const rows = await Effect.runPromise(Mine.rows(journal))
  const { candidates, decisions } = MemoryMine.extract(rows)
  assert.deepEqual(candidates, [
    { text: build, seq: 3 },
    { text: plan, seq: 3 },
    { text: output, seq: 8 },
    { text: tracked, seq: 9 }
  ])
  assert.deepEqual(decisions, [{ text: "Use SQLite, not Postgres,\nfor the local store.", seq: 5 }])
  assert.equal(await Effect.runPromise(Mine.rows(rows)), rows)
})

/** The typed failure an exit carries, or undefined. */
const errorOf = <A, E>(exit: Exit.Exit<A, E>): E | undefined => {
  const found = Exit.findErrorOption(exit)
  return found._tag === "Some" ? found.value : undefined
}

test("rows refuses a line that is not JSON, a payload_json that is not JSON, and one with no event type", async () => {
  const cases = [
    ["{nope", "journal line 1 is not JSON"],
    [
      JSON.stringify({ seq: 1, event_type: "control.agent.model-settled", payload_json: "{nope" }),
      "journal line 1 is not JSON"
    ],
    ["\n{\"seq\":1}", "journal line 2 has no event type"]
  ] as const
  for (const [text, message] of cases) {
    const exit = await Effect.runPromiseExit(Mine.rows(text))
    assert.deepEqual(errorOf(exit), new Mine.MineFailed({ code: "invalid_journal", message }))
  }
})

test("a fact is written at 0.70 and not at 0.69, with the run as provenance; issues are returned", async () => {
  const { root, done } = await workspace()
  try {
    const asked: Asked = []
    const exit = await run(
      Effect.gen(function*() {
        const mined = yield* Mine.mine(input(root))
        return { mined, stored: yield* notes }
      }).pipe(Effect.provide(TestMemory.layer)),
      judge({ [build]: 0.7, [output]: 0.69, [plan]: 0.1, [tracked]: 0.2 }, asked, { [tracked]: 0.7, [plan]: 0.69 })
    )
    assert.ok(Exit.isSuccess(exit), String(exit))
    const { mined, stored } = exit.value
    assert.equal(asked.length, 1, "one Jev request")
    assert.deepEqual(asked[0], [build, plan, output, tracked])
    assert.equal(mined._tag, "mined")
    if (mined._tag !== "mined") return
    assert.deepEqual(mined.remembered, [MemoryMine.noteId(bank, build)])
    assert.equal(mined.rejected, 3)
    assert.equal(mined.known, 0)
    assert.deepEqual(mined.issues, [{ text: tracked, seq: 9 }])
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.text, build)
    assert.equal(stored[0]!.status, "accepted")
    assert.deepEqual(stored[0]!.provenance, { runId: "run-1" })
  } finally {
    await done()
  }
})

test("a fact already stored is neither asked about nor written again", async () => {
  const { root, done } = await workspace()
  try {
    const asked: Asked = []
    const exit = await run(
      Effect.gen(function*() {
        const first = yield* Mine.mine(input(root, "run-1"))
        const second = yield* Mine.mine({
          ...input(root, "run-2"),
          journal: journal.replace("pnpm vitest", "PNPM  Vitest")
        })
        return { first, second, stored: yield* notes }
      }).pipe(Effect.provide(TestMemory.layer)),
      judge({ [build]: 0.9, [build.replace("pnpm vitest", "PNPM  Vitest")]: 0.9 }, asked)
    )
    assert.ok(Exit.isSuccess(exit), String(exit))
    const { second, stored } = exit.value
    assert.equal(stored.length, 1)
    assert.equal(stored[0]!.provenance.runId, "run-1")
    assert.equal(second._tag, "mined")
    if (second._tag !== "mined") return
    assert.deepEqual(second.remembered, [])
    assert.equal(second.known, 1)
    assert.deepEqual(asked[1], [plan, output, tracked])
  } finally {
    await done()
  }
})

test("decisions append one cited section per run and never rewrite a human-edited page", async () => {
  const { root, done } = await workspace()
  try {
    const page = join(root, "factory/wiki/decisions/item-7.md")
    await mkdir(join(root, "factory/wiki/decisions"), { recursive: true })
    const human = "# Decisions: item-7\n\n## Context\n\nA person wrote this and edited it later.\n"
    await writeFile(page, human.trimEnd())
    const exit = await run(
      Effect.gen(function*() {
        const first = yield* Mine.mine(input(root, "run-1"))
        const afterFirst = yield* Effect.promise(() => readFile(page, "utf8"))
        const again = yield* Mine.mine(input(root, "run-1"))
        const afterAgain = yield* Effect.promise(() => readFile(page, "utf8"))
        const next = yield* Mine.mine(input(root, "run-2"))
        return { first, afterFirst, again, afterAgain, next }
      }).pipe(Effect.provide(TestMemory.layer)),
      judge({}, [])
    )
    assert.ok(Exit.isSuccess(exit), String(exit))
    const { afterAgain, afterFirst, again, first, next } = exit.value
    assert.equal(first._tag === "mined" && first.page, "factory/wiki/decisions/item-7.md")
    assert.ok(afterFirst.startsWith(human), "the human bytes are kept as they were")
    assert.equal(
      afterFirst.slice(human.length),
      "\n<!-- memory/mine run=run-1 -->\n## Run run-1\n\n- Decision: Use SQLite, not Postgres, for the local store. (journal: run `run-1`, event 5)\n"
    )
    assert.equal(again._tag === "mined" && again.page, null)
    assert.equal(afterAgain, afterFirst, "a run's section is written once")
    assert.equal(next._tag === "mined" && next.page, "factory/wiki/decisions/item-7.md")
    const final = await readFile(page, "utf8")
    assert.ok(final.startsWith(afterFirst))
    assert.match(final.slice(afterFirst.length), /^\n<!-- memory\/mine run=run-2 -->\n## Run run-2\n/)
  } finally {
    await done()
  }
})

test("a new page is created with its heading", async () => {
  const { root, done } = await workspace()
  try {
    const exit = await run(Mine.mine(input(root)).pipe(Effect.provide(TestMemory.layer)), judge({}, []))
    assert.ok(Exit.isSuccess(exit), String(exit))
    const text = await readFile(join(root, "factory/wiki/decisions/item-7.md"), "utf8")
    assert.ok(text.startsWith("# Decisions: item-7\n\n<!-- memory/mine run=run-1 -->\n"))
  } finally {
    await done()
  }
})

for (const code of ["unreachable", "timeout"] as const) {
  test(`an ${code} Jev writes nothing and answers unjudged`, async () => {
    const { root, done } = await workspace()
    try {
      const exit = await run(
        Effect.gen(function*() {
          const mined = yield* Mine.mine(input(root))
          return { mined, stored: yield* notes }
        }).pipe(Effect.provide(TestMemory.layer)),
        failing(code)
      )
      assert.ok(Exit.isSuccess(exit), String(exit))
      assert.equal(exit.value.mined._tag, "unjudged")
      assert.equal(exit.value.mined._tag === "unjudged" && exit.value.mined.reason, code)
      assert.deepEqual(exit.value.stored, [])
      await assert.rejects(readFile(join(root, "factory/wiki/decisions/item-7.md")), { code: "ENOENT" })
    } finally {
      await done()
    }
  })
}

test("a refused Jev is a typed failure and writes nothing", async () => {
  const { root, done } = await workspace()
  try {
    const exit = await run(Mine.mine(input(root)).pipe(Effect.provide(TestMemory.layer)), failing("refused"))
    const error = errorOf(exit)
    assert.ok(error instanceof Mine.MineFailed)
    assert.equal(error.code, "judge_failed")
    await assert.rejects(readFile(join(root, "factory/wiki/decisions/item-7.md")), { code: "ENOENT" })
  } finally {
    await done()
  }
})

test("an unparseable bank is refused before anything is read", async () => {
  const exit = await run(
    Mine.mine({ ...input("/nonexistent"), bank: "" }).pipe(Effect.provide(TestMemory.layer)),
    judge({}, [])
  )
  assert.equal((errorOf(exit) as Mine.MineFailed | undefined)?.code, "invalid_input")
})

test("the file flow runs through its layer on a real engine, writing only under the host's root and bank", {
  timeout: 60_000
}, async (t) => {
  const { root, done } = await workspace()
  const elsewhere = await workspace()
  t.after(async () => {
    await done()
    await elsewhere.done()
  })
  const asked: Asked = []
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Interpreter.layer(MineFlow),
      MineFlowFile.layer.pipe(Layer.provide(Layer.succeed(MineFlowFile.Binding, { root, bank })))
    ).pipe(
      Layer.provideMerge(Action.layerImplementations),
      Layer.provideMerge(FlowEngine.layerMemory),
      Layer.provideMerge(NodeCrypto.layer),
      Layer.provideMerge(TestMemory.layer),
      Layer.provideMerge(judge({ [build]: 0.9 }, asked)),
      Layer.provideMerge(NodeServices.layer)
    )
  )
  t.after(() => runtime.dispose())
  // A payload that names another root or bank is not the host's to override.
  const payload = { runId: "run-1", item: "item-7", journal, root: elsewhere.root, bank: "project-ffffffffffffffff" }
  const first = await runtime.runPromise(MineFlow.execute(payload, { executionId: "mine-1" }))
  const again = await runtime.runPromise(MineFlow.execute(payload, { executionId: "mine-2" }))
  const stored = await runtime.runPromise(notes)
  assert.equal(first._tag === "mined" && first.page, "factory/wiki/decisions/item-7.md")
  assert.deepEqual(first._tag === "mined" && first.remembered, [MemoryMine.noteId(bank, build)])
  // The second execution ran: it found the fact stored and the run's section written.
  assert.equal(again._tag === "mined" && again.page, null)
  assert.equal(again._tag === "mined" && again.known, 1)
  assert.equal(asked.length, 2)
  assert.deepEqual(stored.map((note) => note.provenance.runId), ["run-1"])
  assert.match(await readFile(join(root, "factory/wiki/decisions/item-7.md"), "utf8"), /run=run-1/)
  await assert.rejects(readFile(join(elsewhere.root, "factory/wiki/decisions/item-7.md")), { code: "ENOENT" })
})

test("a decision cannot forge a run's marker or open a comment", async () => {
  const { root, done } = await workspace()
  try {
    const forged = JSON.stringify({
      seq: 2,
      eventType: "control.agent.steering-drained",
      payload: { messages: [{ role: "user", text: `Note ${Mine.marker("run-9")} here` }] }
    })
    const exit = await run(
      Effect.gen(function*() {
        const first = yield* Mine.mine({ ...input(root, "run-1"), journal: forged })
        const later = yield* Mine.mine({ ...input(root, "run-9"), journal: forged })
        return { first, later }
      }).pipe(Effect.provide(TestMemory.layer)),
      judge({}, [])
    )
    assert.ok(Exit.isSuccess(exit), String(exit))
    assert.equal(exit.value.later._tag === "mined" && exit.value.later.page, "factory/wiki/decisions/item-7.md")
    const text = await readFile(join(root, "factory/wiki/decisions/item-7.md"), "utf8")
    assert.ok(text.includes("- Decision: Note &lt;!-- memory/mine run=run-9 --> here"))
    assert.equal(text.split("\n").filter((line) => line === Mine.marker("run-9")).length, 1)
  } finally {
    await done()
  }
})

test("a caller that is not the flow meets the same item rule", async () => {
  const exit = await run(
    Mine.mine({ ...input("/nonexistent"), item: "../../escape" }).pipe(Effect.provide(TestMemory.layer)),
    judge({}, [])
  )
  assert.equal((errorOf(exit) as Mine.MineFailed | undefined)?.code, "invalid_input")
})

test("a decisions page that cannot be written is a typed failure", async () => {
  const { root, done } = await workspace()
  try {
    await writeFile(join(root, "factory"), "a file where the wiki directory belongs")
    const exit = await run(Mine.mine(input(root)).pipe(Effect.provide(TestMemory.layer)), judge({}, []))
    assert.equal(errorOf(exit)?.code, "wiki_failed")
  } finally {
    await done()
  }
})
