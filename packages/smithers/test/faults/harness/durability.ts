import { strict as assert } from "node:assert"

// File-level acceptance can span top-level tests, but every selected test
// must still execute a fault. A marker in an unrelated test cannot qualify it.
export function requireReachedGoFaultMatrix(log: string, names: readonly string[], points: readonly string[], contexts: readonly string[] = []): void {
  assert(names.length > 0, "required fault matrix has no acceptance tests")
  for (const name of names) requireReachedGoFault(log, name, contexts.length === 0 ? [] : points, contexts)
  for (const point of points) {
    assert(names.some(name => {
      try { requireReachedGoFault(log, name, [point]); return true }
      catch { return false }
    }), `required fault matrix boundary was not reached: ${point}`)
  }
}

// Go exits successfully for an unmatched -run and for skipped integration
// cases. Neither is fault evidence. Preserve the raw JSON stream in CI logs.
export function requireReachedGoFault(log: string, name: string, requiredPoints: readonly string[] = [], requiredContexts: readonly string[] = []): void {
  const events = log.split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
    Action?: string; Test?: string; Output?: string
  })
  assert(events.some((event) => event.Action === "pass" && event.Test === name),
    `required fault test did not pass: ${name}`)
  assert(!events.some((event) => event.Action === "skip" || event.Action === "fail"),
    `required fault test skipped or failed: ${name}`)
  const belongs = (test: string | undefined): test is string =>
    test === name || test?.startsWith(`${name}/`) === true
  const tests = [...new Set(events.filter((event) => belongs(event.Test)).map((event) => event.Test!))]
  // Matrix parents can pass after one child reaches a point while the other
  // children do no work. Each executed leaf must supply its own marker; a
  // parent's or sibling's output cannot qualify a different kill case.
  const leaves = tests.filter((test) => !tests.some((child) => child.startsWith(`${test}/`)))
  const reached = new Set<string>()
  const contexts = new Map(requiredContexts.map((context) => [context, new Set<string>()]))
  for (const test of leaves) {
    assert(events.some((event) => event.Action === "pass" && event.Test === test),
      `required fault subtest did not pass: ${test}`)
    const output = events.filter((event) => event.Test === test).map((event) => event.Output ?? "").join("")
    const markers = [...output.matchAll(/^(?:[ \t]+[^\r\n:]+\.go:\d+: )?CRASH-POINT ([a-zA-Z0-9][a-zA-Z0-9-]*)(?:[ \t][^\r\n]*)?\r?$/gm)]
    assert(markers.length > 0,
      `required fault test logged no kill marker: ${test}`)
    for (const marker of markers) {
      reached.add(marker[1]!)
      for (const [context, points] of contexts) {
        if (test.slice(name.length + 1).split("/").includes(context)) points.add(marker[1]!)
      }
    }
  }
  for (const point of requiredPoints) {
    assert(reached.has(point), `required fault boundary was not reached: ${name}/${point}`)
  }
  for (const [context, points] of contexts) {
    assert(points.size > 0, `required fault context was not reached: ${name}/${context}`)
    for (const point of requiredPoints) {
      assert(points.has(point), `required fault boundary was not reached: ${name}/${context}/${point}`)
    }
  }
}


// Setup has its own passing subtests. Qualify only the destructive crossing,
// and require its final recovery observation rather than borrowing setup or a
// sibling's marker/counts. Literal counts match the committed 20-file fixture.
export function requireRebaseRecoveryObservations(log: string, parent: string, rootOnly = false): void {
  const cells = rootOnly ? [{ name: `${parent}/crossing`, point: "rebase-post-capture" }]
    : ["people-present", "people-absent"].flatMap(presence =>
      ["rebase-post-capture", "rebase-mid", "rebase-post-apply"].flatMap(point =>
        Array.from({ length: 10 }, (_, run) => ({ name: `${parent}/${presence}/${point}/${String(run + 1).padStart(2, "0")}/crossing`, point }))))
  requireReachedGoFaultMatrix(log, cells.map(cell => cell.name), rootOnly ? ["rebase-post-capture"] : ["rebase-post-capture", "rebase-mid", "rebase-post-apply"])
  const events = log.split("\n").filter(Boolean).map(line => JSON.parse(line) as { Test?: string; Output?: string })
  for (const { name, point } of cells) {
    requireReachedGoFault(log, name, [point])
    const output = events.filter(event => event.Test === name).map(event => event.Output ?? "").join("")
    const observations = [...output.matchAll(/^(?:[ \t]+[^\r\n:]+\.go:\d+: )?CRASH-OBSERVATION (\{[^\r\n]*\})\r?$/gm)]
      .map(match => JSON.parse(match[1]!) as Record<string, unknown>)
    assert.equal(observations.length, 1, `required one final rebase recovery observation: ${name}`)
    assert.deepEqual(observations[0], { point, subject: "branch", writesAcknowledged: 20, writesFound: 20, rebaseEntries: 1, outboxDepth: 0 },
      `literal rebase recovery observation mismatch: ${name}`)
  }
}
