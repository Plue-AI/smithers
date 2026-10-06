import { strict as assert } from "node:assert"

// Go exits successfully for an unmatched -run and for skipped integration
// cases. Neither is fault evidence. Preserve the raw JSON stream in CI logs.
export function requireReachedGoFault(log: string, name: string): void {
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
  for (const test of leaves) {
    assert(events.some((event) => event.Action === "pass" && event.Test === test),
      `required fault subtest did not pass: ${test}`)
    const output = events.filter((event) => event.Test === test).map((event) => event.Output ?? "").join("")
    assert(/^CRASH-POINT [a-zA-Z0-9][a-zA-Z0-9-]*(?:[ \t][^\r\n]*)?\r?$/m.test(output),
      `required fault test logged no kill marker: ${test}`)
  }
}
