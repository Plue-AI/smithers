import { expect, test } from "bun:test"
import stringWidth from "string-width"
import type { Run } from "../src/flows.ts"
import * as RunCard from "../src/run-card.ts"
import * as Transcript from "../src/transcript.ts"
import type { Tab } from "../src/workspace.ts"

const tab: Tab = {
  id: "fix",
  title: "Fix addition",
  depth: 0,
  prompt: "Fix addition.",
  seat: "test",
  file: "session",
  status: "running",
  startedAt: 1_000
}
const run: Run = {
  id: "words",
  flow: "wordcount",
  by: "user",
  input: {},
  requested: "{}",
  status: "running",
  startedAt: 1_000
}
const transcript = (calls: ReadonlyArray<Transcript.Call>): Transcript.Transcript => ({
  ...Transcript.empty,
  items: [{
    kind: "cell",
    id: "cell",
    index: 1,
    prose: "",
    source: "",
    status: "done",
    printed: "",
    startedAt: 1_000,
    calls
  }]
})
const edit: Transcript.Call = {
  flow: "edit",
  subject: "math.js",
  status: "ok",
  startedAt: 2_000,
  patches: [{ path: "math.js", patch: "--- a/math.js\n+++ b/math.js\n@@ -1 +1 @@\n-return a - b\n+return a + b" }]
}

test("a worker card settles in place with the final answer, frozen duration and actual receipts", () => {
  const history = transcript([
    edit,
    { flow: "bash", subject: "node old-check.mjs", status: "ok", exit: 1, startedAt: 3_000 },
    { flow: "bash", subject: "node check.mjs", status: "ok", exit: 0, startedAt: 4_000 }
  ])
  const active = RunCard.worker(tab, history, 25_000)
  const settled = RunCard.worker(
    { ...tab, status: "done", endedAt: 42_000, answer: "add returned a - b; it now returns a + b." },
    history,
    90_000
  )
  expect(settled.surface).toBe(active.surface)
  expect(settled.surface).toBe("tab:fix")
  expect(settled.title).toBe("Fix addition")
  expect(settled.duration).toBe("41s")
  expect(settled.answer).toBe("add returned a - b; it now returns a + b.")
  expect(settled.receipts.join(" · ")).toContain("math.js +1")
  expect(settled.receipts.join(" · ")).toContain("node check.mjs exit 0")
  expect(settled.receipts.join(" · ")).not.toContain("old-check")
  expect(settled.diff).toBe(true)
  expect(settled.undo).toBe(true)
  expect(settled.settled).toBe(true)
  expect(RunCard.worker({ ...tab, status: "done", endedAt: 42_000 }, history, 150_000).duration).toBe("41s")
})

test("a command failure reports its real exit and a refused call invents no exit receipt", () => {
  const failed = RunCard.worker(
    { ...tab, status: "failed", endedAt: 6_000 },
    transcript([
      { flow: "bash", subject: "node check.mjs", status: "failed", exit: 1, startedAt: 3_000 }
    ]),
    9_000
  )
  expect(failed.receipts.join(" · ")).toContain("node check.mjs exit 1")
  const refused = RunCard.worker(
    { ...tab, status: "failed", endedAt: 6_000 },
    transcript([
      { flow: "bash", subject: "node check.mjs", status: "failed", message: "Denied", denied: true, startedAt: 3_000 }
    ]),
    9_000
  )
  expect(refused.receipts.join(" · ")).not.toContain("exit")
})

test("a multiline command is one step and one receipt", () => {
  const script = "node -e \"process.exit(7)\"\nnode -e \"process.exit(0)\""
  const live = RunCard.worker(
    tab,
    transcript([{ flow: "bash", subject: script, status: "running", startedAt: 3_000 }]),
    5_000
  )
  expect(live.steps).toEqual(["◐ node -e \"process.exit(7)\"; node -e \"process.exit(0)\""])
  const settled = RunCard.worker(
    { ...tab, status: "done", endedAt: 6_000 },
    transcript([{ flow: "bash", subject: script, status: "ok", exit: 0, startedAt: 3_000 }]),
    9_000
  )
  expect(settled.receipts).toEqual(["node -e \"process.exit(7)\"; node -e \"process.exit(0)\" exit 0"])
})

test("a failed git validation is the receipt; a state display after the check is not", () => {
  const checked = (last: Transcript.Call) =>
    RunCard.worker(
      { ...tab, status: "done", endedAt: 6_000 },
      transcript([{ flow: "bash", subject: "node check.mjs", status: "ok", exit: 0, startedAt: 3_000 }, last]),
      9_000
    ).receipts
  expect(checked({ flow: "bash", subject: "git diff --check", status: "ok", exit: 2, startedAt: 4_000 }))
    .toEqual(["git diff --check exit 2"])
  expect(checked({ flow: "bash", subject: "git status --porcelain", status: "ok", exit: 0, startedAt: 4_000 }))
    .toEqual(["node check.mjs exit 0"])
})

test("an undone patch remains inspectable and cannot be undone twice", () => {
  const undone = RunCard.worker(
    { ...tab, status: "done", endedAt: 6_000 },
    transcript([
      { ...edit, patches: edit.patches!.map((patch) => ({ ...patch, undone: true })) }
    ]),
    9_000
  )
  expect(undone.diff).toBe(true)
  expect(undone.undo).toBe(false)
  expect(undone.undone).toBe(true)
})

test("empty and pending work has no fabricated final answer or receipts", () => {
  for (const status of ["requested", "queued", "running", "waiting", "parked"] as const) {
    const card = RunCard.worker({ ...tab, status }, Transcript.empty, 1_300)
    expect(card.settled).toBe(false)
    expect(card.answer).toBeUndefined()
    expect(card.receipts).toEqual([])
    expect(card.diff).toBe(false)
    expect(card.undo).toBe(false)
  }
})

test("pending reads and edits use the same readable verbs as the shared cards", () => {
  const card = RunCard.worker(
    tab,
    transcript([
      { flow: "read", subject: "math.js", status: "running", startedAt: 1_000 },
      { flow: "edit", subject: "math.js", status: "running", startedAt: 1_000 }
    ]),
    9_000
  )
  expect(card.steps).toEqual(["◐ Reading math.js", "◐ Editing math.js"])
})

test("a worker keeps its requested or queued outcome until it starts", () => {
  for (const status of ["requested", "queued"] as const) {
    expect(RunCard.worker({ ...tab, status }, Transcript.empty, 1_000).outcome).toBe(status)
  }
})

test("an unresolved worker question says asks until it settles", () => {
  const history = transcript([{ flow: "ask", subject: "Which branch?", status: "running", startedAt: 1_000 }])
  expect(RunCard.worker(tab, history, 9_000).outcome).toBe("asks")
  expect(RunCard.worker({ ...tab, status: "done", endedAt: 9_000 }, history, 9_000).outcome).toBe("done")
})

test("failed cards show safe outcome words while keeping raw provider text out of Chat", () => {
  const raw = "TypeError: secret provider detail at /private/stack.js:123"
  const worker = RunCard.worker({ ...tab, status: "failed", endedAt: 2_000, message: raw }, Transcript.empty, 9_000)
  expect(worker.outcome).toContain("failed")
  expect(worker.outcome).not.toContain(raw)
  const flow = RunCard.flow({ ...run, status: "failed", endedAt: 2_000, message: raw }, 9_000)
  expect(flow.outcome).toBe("failed")
  expect(flow.outcome).not.toContain(raw)
})

test("cancelled work settles as stopped and cannot masquerade as a completed answer", () => {
  const worker = RunCard.worker({ ...tab, status: "cancelled", endedAt: 2_000 }, Transcript.empty, 9_000)
  const flow = RunCard.flow({ ...run, status: "cancelled", endedAt: 2_000 }, 9_000)
  for (const card of [worker, flow]) {
    expect(card.settled).toBe(true)
    expect(card.outcome).toBe("stopped")
    expect(card.answer).toBeUndefined()
    expect(card.result).toBeUndefined()
  }
})

test("a host-known flow failure keeps its safe cause and removes it on a retry", () => {
  const failed = {
    ...run,
    status: "failed" as const,
    endedAt: 2_000,
    message: "raw detail",
    failure: "No flow named words; /flows lists them."
  }
  expect(RunCard.flow(failed, 9_000).failure).toBe(failed.failure)
  expect(RunCard.flow({ ...failed, status: "running" }, 9_000).failure).toBeUndefined()
})

test("a flow shares the card identity and exposes its settled result without a second transcript row", () => {
  const active = RunCard.flow(run, 1_020)
  const settled = RunCard.flow({ ...run, status: "done", endedAt: 1_040, answer: "5" }, 9_000)
  expect(settled.surface).toBe(active.surface)
  expect(settled.surface).toBe("flow:words")
  expect(settled.title).toBe("wordcount")
  expect(settled.duration).toBe("40ms")
  expect(settled.result ?? settled.answer).toBe("5")
  expect(settled.settled).toBe(true)
  expect(settled.diff).toBe(false)
  expect(settled.undo).toBe(false)
})

test("flow timing follows launch time and preserves multiline or empty outcomes", () => {
  expect(RunCard.flow({ ...run, launchedAt: 5_000 }, 5_300).duration).toBe("300ms")
  const multiline = RunCard.flow({
    ...run,
    status: "done",
    launchedAt: 5_000,
    endedAt: 17_000,
    answer: "  first\nsecond"
  }, 90_000)
  expect(multiline.duration).toBe("12s")
  expect(multiline.answer).toBe("first\nsecond")
  expect(multiline.result).toBeUndefined()
  const empty = RunCard.flow({ ...run, status: "done", launchedAt: 5_000, endedAt: 5_001, answer: "" }, 90_000)
  expect(empty.duration).toBe("1ms")
  expect(empty.result).toBeUndefined()
  expect(empty.answer).toBeUndefined()
})

test("flow module steps stay with running or multiline results while scalar results stay compact", () => {
  const steps = ["✓ Read math.js", "✓ node check.mjs exit 0"]
  expect(RunCard.flow(run, 9_000, steps).steps).toEqual(steps)
  expect(
    RunCard.flow({ ...run, status: "done", endedAt: 2_000, answer: "First result\nSecond result" }, 9_000, steps).steps
  ).toEqual(steps)
  expect(RunCard.flow({ ...run, status: "done", endedAt: 2_000, answer: "5" }, 9_000, steps).steps).toEqual([])
})

test("only successful request-only coordinator output gives way to host cards", () => {
  const coordinator = (calls: ReadonlyArray<Transcript.Call>) => ({
    ...transcript(calls),
    items: [
      { kind: "user" as const, id: "prompt", text: "Fix addition" },
      ...transcript(calls).items,
      { kind: "answer" as const, id: "ack", text: "Requested the fix." }
    ]
  })
  const request: Transcript.Call = { flow: "agent.delegate", subject: "Fix addition", status: "ok", startedAt: 1_000 }
  const raw = coordinator([request])
  expect(RunCard.chat(raw).items.map((item) => item.id)).toEqual(["prompt"])
  // Ctrl+O or the Cells filter shows the request's program above its card; the acknowledgement stays gone.
  expect(RunCard.chat(raw, true).items.map((item) => item.id)).toEqual(["prompt", "cell"])
  expect(RunCard.chat(raw, true).activity).toBeUndefined()
  expect(raw.items.map((item) => item.id)).toEqual(["prompt", "cell", "ack"])
  expect(RunCard.chat(coordinator([{ ...request, status: "failed" }])).items.map((item) => item.id))
    .toEqual(["prompt", "cell", "ack"])
  expect(RunCard.chat(coordinator([request, { ...request, flow: "read" }])).items.map((item) => item.id))
    .toEqual(["prompt", "cell", "ack"])
  const later = Transcript.user(raw, "What changed?", false, 5_000)
  const continued = {
    ...later,
    items: [...later.items, { kind: "answer" as const, id: "later-answer", text: "One file." }]
  }
  expect(RunCard.chat(continued).items.map((item) => item.id)).toEqual([
    "prompt",
    later.items.at(-1)!.id,
    "later-answer"
  ])
})

test.each(["", "one", "one\ntwo\nthree", "界".repeat(100), "a very long answer ".repeat(100)])(
  "the final message occupies at most two physical lines for %j",
  (answer) => {
    for (const width of [1, 10, 78, 108]) {
      const lines = RunCard.summary(answer, width)
      expect(lines.length).toBeLessThanOrEqual(2)
      for (const line of lines) expect(stringWidth(line)).toBeLessThanOrEqual(width)
    }
  }
)

test("final-message summaries preserve literal multiplication, language names and issue references", () => {
  const answer = "Use a * b in C# for issue #123."
  expect(RunCard.summary(answer, 80)).toEqual([answer])
})

test("a code-only final message keeps its content and operators within two physical lines", () => {
  const answer = "```js\nconst product = a * b\nreturn product\n// third line\n```"
  expect(RunCard.summary(answer, 80)).toEqual(["const product = a * b", "return product"])
  const narrow = RunCard.summary(answer, 12)
  expect(narrow).toHaveLength(2)
  expect(narrow.every((line) => stringWidth(line) <= 12)).toBe(true)
  expect(narrow.join(" ")).not.toContain("```")
})
