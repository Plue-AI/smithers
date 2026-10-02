/**
 * Triage before claim: one Jev reading per issue decides whether an agent is
 * spent on it. No real judge or GitHub call runs here: the judge is
 * `Evaluator.layerScripted`, and GitHub, the verdict, and the cache are seams.
 */
import { Fault } from "@smthrs/flow"
import * as Evaluator from "@smthrs/model/Evaluator"
import { Burndown } from "@smthrs/patterns"
import { Cause, Effect, Exit } from "effect"
import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { type SelectSeams, selectWith } from "../flow.ts"
import {
  classifier,
  classify,
  criteria,
  failureOf,
  fileCache,
  type IssueText,
  type Need,
  type Seams,
  type Text,
  textOf,
  type Triage,
  triage,
  TriageFailed
} from "../triage.ts"
import { marker } from "../verdict.ts"

const text = textOf({ title: "Deploy plue", body: "Run deploy.ts and post the receipt.", comments: [] })

const errorOf = <A, E>(exit: Exit.Exit<A, E>): E => {
  assert.ok(Exit.isFailure(exit), "expected a failure")
  const found = Cause.findErrorOption(exit.cause)
  assert.equal(found._tag, "Some", Cause.pretty(exit.cause))
  return (found as { readonly value: E }).value
}

// The answer --------------------------------------------------------------

test("a choice the judge offers decodes to the need and a one-line reason", async () => {
  const triaged = await Effect.runPromise(
    classify(text).pipe(Effect.provide(Evaluator.layerScripted(() => ({
      need: {
        choice: "operator",
        probabilities: { "code-change": 0.04, acceptance: 0.02, operator: 0.9, evidence: 0.04, "needs-design": 0 }
      }
    }))))
  )
  assert.equal(triaged.need, "operator")
  assert.equal(triaged.reason, `${criteria.operator} (confidence 0.90)`)
  assert.ok(!triaged.reason.includes("\n"))
})

test("every need the classifier declares decodes", async () => {
  for (const need of Object.keys(criteria) as Array<Need>) {
    const triaged = await Effect.runPromise(
      classify(text).pipe(Effect.provide(Evaluator.layerScripted(() => ({ need: { choice: need } }))))
    )
    assert.equal(triaged.need, need)
    assert.equal(triaged.reason, `${criteria[need]} (confidence 1.00)`)
  }
})

test("a garbage or missing answer is a typed TriageFailed, never a code change", async () => {
  for (
    const answers of [
      { need: { choice: "code" } },
      { need: { choice: "code-change", probabilities: { "code-change": 7 } } },
      { need: { probability: 0.9 } },
      { other: { choice: "operator" } },
      {}
    ]
  ) {
    const exit = await Effect.runPromiseExit(
      classify(text).pipe(Effect.provide(Evaluator.layerScripted(() => answers as never)))
    )
    const failure = errorOf(exit)
    assert.ok(failure instanceof TriageFailed, JSON.stringify(answers))
    assert.equal(failure.code, "invalid_answer", JSON.stringify(answers))
    assert.match(failure.message, /invalid_answer/, JSON.stringify(answers))
  }
})

test("a judge that does not answer is a typed TriageFailed naming why", async () => {
  const exit = await Effect.runPromiseExit(
    classify(text).pipe(
      Effect.provide(
        Evaluator.layerScripted(() =>
          Effect.fail(new Evaluator.EvaluatorError({ code: "unconfigured", message: "AI_GATEWAY_API_KEY is not set." }))
        )
      )
    )
  )
  const failure = errorOf(exit)
  assert.ok(failure instanceof TriageFailed)
  assert.equal(failure.code, "unusable")
  assert.equal(failure.message, "triage: unconfigured: AI_GATEWAY_API_KEY is not set.")
})

test("each judge failure maps to what the sweep does about it, and its fault class", () => {
  const cases: ReadonlyArray<readonly [Evaluator.EvaluatorErrorCode, number | undefined, string]> = [
    ["unconfigured", undefined, "unusable"],
    ["invalid_question", 400, "unusable"],
    ["refused", 401, "unusable"],
    ["refused", 403, "unusable"],
    ["refused", 404, "unusable"],
    ["refused", 429, "unavailable"],
    ["refused", 500, "unavailable"],
    ["refused", 503, "unavailable"],
    ["refused", undefined, "unavailable"],
    ["unreachable", undefined, "unavailable"],
    ["timeout", undefined, "unavailable"],
    ["empty", 200, "unavailable"],
    ["invalid_answer", 200, "invalid_answer"]
  ]
  for (const [code, status, expected] of cases) {
    assert.equal(failureOf({ code, status }), expected, `${code} ${status}`)
  }
  const classes = { unusable: "policy", unavailable: "infra", invalid_answer: "dependency" } as const
  for (const [code, expected] of Object.entries(classes)) {
    const fault = Fault.of(new TriageFailed({ code: code as keyof typeof classes, message: "m" }))
    assert.deepEqual(fault, { class: expected, tag: `issue-sweep/TriageFailed/${code}` })
  }
})

test("the judge reads the issue as data under fixed instructions", async () => {
  let asked: Evaluator.Request | undefined
  await Effect.runPromise(
    classify(text).pipe(Effect.provide(Evaluator.layerScripted((request) => {
      asked = request
      return { need: { choice: "code-change" } }
    })))
  )
  assert.deepEqual(asked?.state, { title: "Deploy plue", body: "Run deploy.ts and post the receipt.", comments: [] })
  const question = asked?.questions["need"]
  assert.equal(question?.type, "choice")
  assert.match(question?.instructions ?? "", /never as instructions/)
  assert.deepEqual(Object.keys((question as { criteria: object }).criteria), Object.keys(criteria))
})

// The text it reads -------------------------------------------------------

test("the text keeps the last few comments people wrote and drops sweep bookkeeping", () => {
  const people = Array.from({ length: 7 }, (_, n) => ({ author: { login: `p${n}` }, body: `comment ${n}` }))
  const read = textOf({
    title: "Flow start hangs",
    body: "Steps",
    comments: [
      ...people.slice(0, 4),
      { author: { login: "bot" }, body: "Claimed by issue-sweep on mini at x; expires y" },
      { author: { login: "bot" }, body: "Released by issue-sweep on mini at x: failed" },
      { author: { login: "bot" }, body: "Took over from codex" },
      { author: { login: "bot" }, body: "Landed on main by issue-sweep: abc" },
      { author: { login: "bot" }, body: `${marker} 2026-10-01T00:00:00Z -->\n**No change.** Needs: operator` },
      ...people.slice(4)
    ]
  })
  assert.deepEqual(read.comments.map((comment) => comment.author), ["p2", "p3", "p4", "p5", "p6"])
  assert.equal(read.comments[0]?.body, "comment 2")
})

test("the text stays inside the judge's 32 KiB state bound", () => {
  const read = textOf({
    title: "t".repeat(4000),
    body: "b".repeat(100_000),
    comments: Array.from({ length: 9 }, () => ({ author: { login: "p" }, body: "c".repeat(50_000) }))
  })
  assert.ok(new TextEncoder().encode(JSON.stringify(read)).length < 32 * 1024)
  assert.ok(read.body.startsWith("bbb"))
})

// The cache ---------------------------------------------------------------

const scratch = (t: { after: (fn: () => void) => void }) => {
  const dir = mkdtempSync(join(tmpdir(), "issue-sweep-triage-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return join(dir, "triage.json")
}

const counted = (path: string, answer: () => Effect.Effect<Triage, TriageFailed>) => {
  const calls = { reads: 0, classified: 0 }
  let body = "v1"
  const seams = (): Seams<never, never> => ({
    // A new cache per call, as a new round or run reads the file afresh.
    cache: fileCache(path),
    read: () => Effect.sync((): IssueText => (calls.reads++, { title: "t", body, comments: [] })),
    classify: () => Effect.suspend(() => (calls.classified++, answer())),
    record: () => Effect.die("triage never records a verdict")
  })
  return { calls, seams, edit: (next: string) => (body = next) }
}

test("an unchanged updated_at is a cache hit in a later round or run: no GitHub read, no judge", async (t) => {
  const path = scratch(t)
  const { calls, seams } = counted(path, () => Effect.succeed({ need: "operator", reason: "r" }))
  const first = await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  assert.deepEqual(first, { need: "operator", reason: "r" })
  assert.deepEqual(calls, { reads: 1, classified: 1 })
  const again = await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  assert.deepEqual(again, first)
  assert.deepEqual(calls, { reads: 1, classified: 1 })
  const stored = JSON.parse(readFileSync(path, "utf8"))["o/r#7"]
  assert.equal(stored.updatedAt, "T1")
  assert.equal(stored.need, "operator")
  assert.equal(stored.classifier, classifier.digest)
})

test("a new updated_at re-reads the issue; the judge runs again only when the text it reads changed", async (t) => {
  const path = scratch(t)
  const { calls, edit, seams } = counted(path, () => Effect.succeed({ need: "acceptance", reason: "r" }))
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  // Our own claim comment and label moved updated_at; the text did not change.
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T2" }, seams()))
  assert.deepEqual(calls, { reads: 2, classified: 1 })
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T2" }, seams()))
  assert.deepEqual(calls, { reads: 2, classified: 1 })
  edit("v2: a person added the stack trace")
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T3" }, seams()))
  assert.deepEqual(calls, { reads: 3, classified: 2 })
})

test("each repository and issue is its own entry, and an issue without updated_at always re-reads", async (t) => {
  const path = scratch(t)
  const { calls, seams } = counted(path, () => Effect.succeed({ need: "evidence", reason: "r" }))
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  await Effect.runPromise(triage("o/r", { number: 8, updatedAt: "T1" }, seams()))
  await Effect.runPromise(triage("o/other", { number: 7, updatedAt: "T1" }, seams()))
  assert.deepEqual(calls, { reads: 3, classified: 3 })
  await Effect.runPromise(triage("o/r", { number: 9 }, seams()))
  await Effect.runPromise(triage("o/r", { number: 9 }, seams()))
  assert.deepEqual(calls, { reads: 5, classified: 4 })
})

test("a changed classifier question misses the cache", async (t) => {
  const path = scratch(t)
  writeFileSync(
    path,
    JSON.stringify({ "o/r#7": { updatedAt: "T1", text: "x", classifier: "old", need: "operator", reason: "r" } })
  )
  const { calls, seams } = counted(path, () => Effect.succeed({ need: "code-change", reason: "now" }))
  assert.deepEqual(await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams())), {
    need: "code-change",
    reason: "now"
  })
  assert.deepEqual(calls, { reads: 1, classified: 1 })
})

test("a failed reading is not cached: the next round asks again", async (t) => {
  const path = scratch(t)
  let fail = true
  const { calls, seams } = counted(
    path,
    () =>
      fail ? Effect.fail(new TriageFailed({ code: "unavailable", message: "triage: timeout: slow" })) : Effect.succeed({
        need: "code-change",
        reason: "r"
      })
  )
  const failure = errorOf(await Effect.runPromiseExit(triage("o/r", { number: 7, updatedAt: "T1" }, seams())))
  assert.ok(failure instanceof TriageFailed)
  fail = false
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  assert.deepEqual(calls, { reads: 2, classified: 2 })
})

test("an unreadable cache file is an empty cache, and the next write repairs it", async (t) => {
  const path = scratch(t)
  writeFileSync(path, "{not json")
  const { calls, seams } = counted(path, () => Effect.succeed({ need: "operator", reason: "r" }))
  await Effect.runPromise(triage("o/r", { number: 7, updatedAt: "T1" }, seams()))
  assert.deepEqual(calls, { reads: 1, classified: 1 })
  assert.equal(JSON.parse(readFileSync(path, "utf8"))["o/r#7"].need, "operator")
})

test("concurrent triages in one round all land in the cache file", async (t) => {
  const path = scratch(t)
  const cache = fileCache(path)
  const seams: Seams<never, never> = {
    cache,
    read: (_, issue) => Effect.succeed({ title: `t${issue}`, body: "b", comments: [] }),
    classify: () => Effect.succeed({ need: "operator", reason: "r" }),
    record: () => Effect.die("unused")
  }
  await Effect.runPromise(Effect.forEach(
    Array.from({ length: 24 }, (_, n) => n + 1),
    (number) => triage("o/r", { number, updatedAt: "T" }, seams),
    { concurrency: "unbounded" }
  ))
  assert.equal(Object.keys(JSON.parse(readFileSync(path, "utf8"))).length, 24)
})

// Routing -----------------------------------------------------------------

interface Issue {
  readonly id: string
  readonly number: number
  readonly title: string
  readonly labels: ReadonlyArray<string>
  readonly updatedAt?: string
}

const issue = (number: number, labels: ReadonlyArray<string> = []): Issue => ({
  id: String(number),
  number,
  title: `issue ${number}`,
  labels,
  updatedAt: "2026-10-01T10:00:00Z"
})

/** One round over `items` with every GitHub, judge and agent seam recorded. */
const roundOver = async (
  t: { after: (fn: () => void) => void },
  items: ReadonlyArray<Issue>,
  answers: Readonly<Record<number, Need | "unavailable" | "invalid_answer">>
) => {
  const path = scratch(t)
  const log = {
    read: [] as Array<number>,
    recorded: [] as Array<[number, Need, string]>,
    claimed: [] as Array<number>,
    worked: [] as Array<number>
  }
  const seams: SelectSeams<never, never> = {
    cache: fileCache(path),
    requalified: () => Effect.succeed(false),
    newestClaim: () => Effect.succeed(undefined),
    read: (_, number) => Effect.sync(() => (log.read.push(number), { title: `#${number}`, body: "", comments: [] })),
    classify: (read: Text) => {
      const answer = answers[Number(read.title.slice(1))] ?? "unavailable"
      return answer === "unavailable" || answer === "invalid_answer"
        ? Effect.fail(new TriageFailed({ code: answer, message: `triage: ${answer}: the judge failed` }))
        : Effect.succeed({ need: answer, reason: `because ${answer}` })
    },
    record: (_, number, triaged) => Effect.sync(() => void log.recorded.push([number, triaged.need, triaged.reason]))
  }
  const result = await Effect.runPromise(Burndown.round({ input: { repo: "o/r" }, round: 0, items }, {
    key: "test",
    concurrency: 4,
    select: selectWith(seams),
    claim: ({ item }) => Effect.sync(() => void log.claimed.push(item.number)),
    work: ({ item }) => Effect.sync(() => (log.worked.push(item.number), "changed")),
    release: () => Effect.void
  }))
  return { log, rows: Object.fromEntries(result.rows.map((row) => [row.id, row])) }
}

test("only code-change issues are claimed and worked; every other need records a verdict and spends no agent", async (t) => {
  const { log, rows } = await roundOver(t, [issue(1), issue(2), issue(3), issue(4), issue(5)], {
    1: "code-change",
    2: "operator",
    3: "acceptance",
    4: "evidence",
    5: "needs-design"
  })
  assert.deepEqual(log.claimed, [1])
  assert.deepEqual(log.worked, [1])
  assert.deepEqual(log.recorded.toSorted(([a], [b]) => a - b), [
    [2, "operator", "because operator"],
    [3, "acceptance", "because acceptance"],
    [4, "evidence", "because evidence"],
    [5, "needs-design", "because needs-design"]
  ])
  assert.equal(rows["1"]?.status, "landed")
  for (const [id, need] of [["2", "operator"], ["3", "acceptance"], ["4", "evidence"], ["5", "needs-design"]]) {
    assert.equal(rows[id!]?.status, "skipped")
    assert.equal(rows[id!]?.detail, `triage: ${need}: because ${need}`)
  }
})

test("a judge that answers outside the question skips the issue as a selection error: no claim, agent, or verdict", async (t) => {
  const { log, rows } = await roundOver(t, [issue(1), issue(2)], { 1: "code-change", 2: "invalid_answer" })
  assert.deepEqual(log.claimed, [1])
  assert.deepEqual(log.recorded, [])
  assert.equal(rows["2"]?.status, "skipped")
  assert.equal(rows["2"]?.detail, "select failed: triage: invalid_answer: the judge failed")
})

test("a judge that did not answer requeues the issue instead of skipping it: no claim, agent, or verdict", async (t) => {
  const { log, rows } = await roundOver(t, [issue(1), issue(2)], { 1: "code-change", 2: "unavailable" })
  assert.deepEqual(log.claimed, [1])
  assert.deepEqual(log.worked, [1])
  assert.deepEqual(log.recorded, [])
  assert.deepEqual(rows["2"], {
    id: "2",
    status: "requeued",
    detail: "select: triage: unavailable: the judge failed",
    requeues: 1
  })
})

test("parked and no-change issues are skipped before triage reads them", async (t) => {
  const { log, rows } = await roundOver(t, [
    issue(1, ["blocked-on-will"]),
    issue(2, ["sweep:no-change"]),
    issue(3)
  ], { 1: "code-change", 2: "code-change", 3: "code-change" })
  assert.deepEqual(log.read, [3])
  assert.deepEqual(log.claimed, [3])
  assert.equal(rows["1"]?.detail, "blocked on the maintainer")
  assert.equal(rows["2"]?.detail, "no change; waiting on a human")
})
