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
  const output = events.filter((event) => event.Test === name || event.Test?.startsWith(`${name}/`)).map((event) => event.Output ?? "").join("")
  assert(/^CRASH-POINT [a-zA-Z0-9][a-zA-Z0-9-]*(?:\s|$)/m.test(output),
    `required fault test logged no kill marker: ${name}`)
}
