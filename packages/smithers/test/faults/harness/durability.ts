import { strict as assert } from "node:assert"

// File-level acceptance can span top-level tests, but every selected test
// must still execute a fault. A marker in an unrelated test cannot qualify it.
export function requireReachedGoFaultMatrix(log: string, names: readonly string[], points: readonly string[]): void {
  assert(names.length > 0, "required fault matrix has no acceptance tests")
  for (const name of names) requireReachedGoFault(log, name)
  for (const point of points) {
    assert(names.some(name => {
      try { requireReachedGoFault(log, name, [point]); return true }
      catch { return false }
    }), `required fault matrix boundary was not reached: ${point}`)
  }
}

// Go exits successfully for an unmatched -run and for skipped integration
// cases. Neither is fault evidence. Preserve the raw JSON stream in CI logs.
export function requireReachedGoFault(log: string, name: string, requiredPoints: readonly string[] = []): void {
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
  for (const test of leaves) {
    assert(events.some((event) => event.Action === "pass" && event.Test === test),
      `required fault subtest did not pass: ${test}`)
    const output = events.filter((event) => event.Test === test).map((event) => event.Output ?? "").join("")
    const markers = [...output.matchAll(/^CRASH-POINT ([a-zA-Z0-9][a-zA-Z0-9-]*)(?:[ \t][^\r\n]*)?\r?$/gm)]
    assert(markers.length > 0,
      `required fault test logged no kill marker: ${test}`)
    for (const marker of markers) reached.add(marker[1]!)
  }
  for (const point of requiredPoints) {
    assert(reached.has(point), `required fault boundary was not reached: ${name}/${point}`)
  }
}
