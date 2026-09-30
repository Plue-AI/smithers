import { expect, test } from "bun:test"
import type { PendingToolCall } from "./controller/context"
import { toolActLine } from "./ToolActLine"

// The agent execution boundary accepts surrounding whitespace before stripping
// catalog slashes. Its visible receipt must identify that same command.
const call = (name: string, args = ""): PendingToolCall => ({
  callId: "normalized-receipt", name: "commands", args: JSON.stringify({ action: "execute", name, args })
})

test("accepted whitespace-padded command names keep canonical visible labels", () => {
  expect(toolActLine(call("world.new-note"), "executed /world.new-note")).toBe("Smithers ran /world.new-note")
  expect(toolActLine(call("  //world.new-note  "), "executed /world.new-note")).toBe("Smithers ran /world.new-note")
})

test("accepted whitespace-padded browser commands retain their read receipt", () => {
  expect(toolActLine(call("browser", "https://example.com/page"), "executed /browser")).toBe("Smithers read example.com")
  expect(toolActLine(call("  /browser  ", "https://example.com/page"), "executed /browser")).toBe("Smithers read example.com")
})
