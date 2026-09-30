import { expect, test } from "bun:test"
import { createOperationalFailureReporter } from "./OperationalFailures"

test("operational reports dedupe per subject, expire, bound memory, and reset", () => {
  let now = 0
  const posts: unknown[] = []
  const failures = createOperationalFailureReporter({ now: () => now, ringSize: 2,
    clientErrors: { report: (kind, error) => posts.push({ kind, error }), reported: () => posts.length } })
  for (let i = 0; i < 4; i++) failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(1)
  expect(failures.recent()[0]).toMatchObject({ seam: "run.pump", lost: "app-bug", fault: "infra", subject: "a", count: 4 })
  failures.report("run.pump", new Error("disk"), "b")
  expect(posts).toHaveLength(2)
  now = 60_001
  failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(3)
  expect(failures.recent()).toHaveLength(2)
  failures.reset()
  expect(failures.recent()).toEqual([])
  failures.report("run.pump", new Error("disk"), "a")
  expect(posts).toHaveLength(4)
})

test("reporting survives a broken telemetry sink", () => {
  const failures = createOperationalFailureReporter({ clientErrors: {
    report: () => { throw Error("offline") }, reported: () => 0
  } })
  expect(() => failures.report("run.cancel", new Error("lost"))).not.toThrow()
  expect(failures.recent()).toHaveLength(1)
})

test("dedupe expires at the exact boundary and keeps the original evidence inside its window", () => {
  let now = 10
  const posts: Array<{ kind: string; error: unknown }> = []
  const failures = createOperationalFailureReporter({ now: () => now,
    clientErrors: { report: (kind, error) => posts.push({ kind, error }), reported: () => posts.length } })
  failures.report("run.pump", "original", "repo")
  now = 60_009
  failures.report("run.pump", "later", "repo")
  expect(failures.recent()).toEqual([{ seam: "run.pump", lost: "app-bug", fault: "infra", message: "original", subject: "repo", at: 10, count: 2 }])
  expect(posts).toHaveLength(1)
  now = 60_010
  failures.report("run.pump", "fresh", "repo")
  expect(failures.recent()).toEqual([
    { seam: "run.pump", lost: "app-bug", fault: "infra", message: "original", subject: "repo", at: 10, count: 2 },
    { seam: "run.pump", lost: "app-bug", fault: "infra", message: "fresh", subject: "repo", at: 60_010, count: 1 }
  ])
  expect(posts).toHaveLength(2)
  expect(posts[1]).toEqual({ kind: "operational", error: JSON.stringify({ seam: "run.pump", lost: "app-bug", fault: "infra", message: "fresh", subject: "repo", at: 60_010, count: 1 }) })
})

test("seams and subjects stay separate and eviction removes the oldest evidence", () => {
  const failures = createOperationalFailureReporter({ now: () => 0, ringSize: 3 })
  failures.report("run.pump", "first", "a")
  failures.report("run.cancel", "second", "a")
  failures.report("run.pump", "third", "b")
  expect(failures.recent().map(row => [row.seam, row.subject, row.message, row.count])).toEqual([
    ["run.pump", "a", "first", 1], ["run.cancel", "a", "second", 1], ["run.pump", "b", "third", 1]
  ])
  const snapshot = failures.recent()
  expect(snapshot).toHaveLength(3)
  Object.assign(snapshot[0]!, { message: "edited", count: 99 })
  failures.report("run.pump", "duplicate", "a")
  expect(failures.recent()[0]?.message).toBe("first")
  expect(failures.recent()[0]?.count).toBe(2)
  failures.report("run.cancel", "fourth", "b")
  expect(failures.recent().map(row => row.message)).toEqual(["second", "third", "fourth"])
})

test.each([1024, 1025])("caps a %i-character diagnostic without changing its classification", length => {
  const failures = createOperationalFailureReporter({ now: () => 0, ringSize: 0 })
  failures.report("run.pump", "x".repeat(length))
  expect(failures.recent()).toEqual([{ seam: "run.pump", lost: "app-bug", fault: "infra", message: "x".repeat(1024), subject: undefined, at: 0, count: 1 }])
  failures.report("run.cancel", "replacement")
  expect(failures.recent().map(row => row.message)).toEqual(["replacement"])
})

test("different failure classes for the same operation never swallow one another", () => {
  const failures = createOperationalFailureReporter({ now: () => 0 })
  failures.report("run.cancel", new DOMException("stopped", "AbortError"), "run-1")
  failures.report("run.cancel", "broken callback", "run-1")
  failures.report("run.cancel", new DOMException("stopped again", "AbortError"), "run-1")
  expect(failures.recent().map(row => [row.lost, row.fault, row.subject, row.count])).toEqual([
    ["cancelled", "user", "run-1", 2], ["app-bug", "infra", "run-1", 1]
  ])
  expect(failures.recent()[1]?.message).toBe("broken callback")
})


test.each([0, 25])("a configured %i ms window honors its exact boundary", window => {
  let now = 100
  const failures = createOperationalFailureReporter({ now: () => now, dedupeWindowMs: window })
  failures.report("run.pump", "first", "repo")
  if (window > 0) {
    now = 124
    failures.report("run.pump", "within", "repo")
    expect(failures.recent()).toEqual([{ seam: "run.pump", lost: "app-bug", fault: "infra", message: "first", subject: "repo", at: 100, count: 2 }])
  }
  now = 100 + window
  failures.report("run.pump", "boundary", "repo")
  expect(failures.recent()).toEqual([
    { seam: "run.pump", lost: "app-bug", fault: "infra", message: "first", subject: "repo", at: 100, count: window === 0 ? 1 : 2 },
    { seam: "run.pump", lost: "app-bug", fault: "infra", message: "boundary", subject: "repo", at: 100 + window, count: 1 }
  ])
})

test("a failed diagnostic clock neither interrupts the caller nor invents retained evidence", () => {
  const posts: unknown[] = []
  const failures = createOperationalFailureReporter({ now: () => { throw new Error("clock unavailable") },
    clientErrors: { report: (_kind, error) => posts.push(error), reported: () => posts.length } })
  expect(() => failures.report("run.pump", "original failure", "repo")).not.toThrow()
  expect(failures.recent()).toEqual([])
  expect(posts).toEqual([])
})
