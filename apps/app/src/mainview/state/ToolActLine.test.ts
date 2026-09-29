import { expect, test } from "bun:test"
import { toolActLine } from "./ToolActLine"

test("a queued flow's act line says requested, never started", () => {
  const call = { callId: "call", name: "commands", args: JSON.stringify({ action: "execute", name: "flow.run", args: "review o/r" }) }
  expect(toolActLine(call, "run-requested workflow=review request=saved repo=o/r")).toBe("Smithers requested a review run on o/r")
  expect(toolActLine(call, "run-started workflow=review run=remote repo=o/r")).toBe("Smithers started a review run on o/r")
})
test("a padded slash command name renders the canonical receipt", () => {
  const call = { callId: "call", name: "commands", args: JSON.stringify({ action: "execute", name: "  //world.new-note  " }) }
  expect(toolActLine(call, "executed /world.new-note")).toBe("Smithers ran /world.new-note")
  expect(toolActLine({ ...call, args: JSON.stringify({ action: "execute", name: "world.new-note" }) }, "executed /world.new-note")).toBe("Smithers ran /world.new-note")
})

test("a padded browser name renders the host receipt", () => {
  const call = {
    callId: "call",
    name: "commands",
    args: JSON.stringify({ action: "execute", name: "  /browser  ", args: "https://example.com/page" })
  }
  expect(toolActLine(call, "executed /browser")).toBe("Smithers read example.com")
  expect(toolActLine({ ...call, args: JSON.stringify({ action: "execute", name: "browser", args: "https://example.com/page" }) }, "executed /browser")).toBe("Smithers read example.com")
})

