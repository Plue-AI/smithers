import { expect, test } from "bun:test"
import type { PendingToolCall } from "./controller/context"
import { toolActLine } from "./ToolActLine"

const command = (name: string, args = "", action = "execute"): PendingToolCall => ({
  callId: "presentation-call", name: "commands", args: JSON.stringify({ name, action, args })
})

test("malformed or non-object arguments retain the actual tool name", () => {
  for (const args of ["{", "null", "true", "4", '"browser"', "[]", '{"name":4,"action":false,"args":null}']) {
    expect(toolActLine({ callId: "bad-args", name: "commands", args }, "executed /world")).toBe("Smithers ran /commands")
  }
  expect(toolActLine({ callId: "direct", name: "files.read", args: "{" }, "ok")).toBe("Smithers ran files.read")
})

test("catalog slash spelling is normalized in ordinary and refused acts", () => {
  for (const name of ["wiki.new-note", "/wiki.new-note", "///wiki.new-note"]) {
    expect(toolActLine(command(name), "executed /wiki.new-note")).toBe("Smithers ran /wiki.new-note")
    expect(toolActLine(command(name), "unknown-command: absent")).toBe("Smithers tried /wiki.new-note — unknown-command: absent")
  }
})

test("catalog listing, confirmation and forms report the actual human-facing action", () => {
  expect(toolActLine(command("world", "", "list"), "available commands")).toBe("Smithers checked what it can do here")
  expect(toolActLine(command("/flow.run"), "asked the user to confirm flow.run")).toBe("Smithers asked for confirmation of /flow.run")
  expect(toolActLine(command("//browser"), "rendered a form for url")).toBe("Smithers opened the /browser form")
  expect(toolActLine({ callId: "direct", name: "other", args: '{"action":"list"}' }, "ok")).toBe("Smithers ran other")
})

test("a successful browser receipt names the URL host and port without path or query", () => {
  for (const name of ["browser", "/browser.open"]) {
    expect(toolActLine(command(name, "https://example.com:8443/private?token=hidden#section"), "executed /browser")).toBe("Smithers read example.com:8443")
  }
  expect(toolActLine(command("browser", "relative/page"), "executed /browser")).toBe("Smithers read relative/page")
})

test("browser refusals never claim that the page was read", () => {
  expect(toolActLine(command("browser", "https://example.com"), "failed: network unavailable")).toBe("Smithers tried /browser — failed: network unavailable")
  expect(toolActLine(command("browser.open", "https://example.com"), "unknown-command: browser.open")).toBe("Smithers tried /browser.open — unknown-command: browser.open")
})

test("missing or wrongly typed nested values do not invent command or URL labels", () => {
  expect(toolActLine({ callId: "missing", name: "commands", args: '{"name":12,"args":"https://example.com"}' }, "ok")).toBe("Smithers ran /commands")
  expect(toolActLine({ callId: "action", name: "commands", args: '{"name":"world","action":12}' }, "ok")).toBe("Smithers ran /world")
})

test("launch acknowledgments use machine workflow and repo fields rather than input wording", () => {
  expect(toolActLine(command("flow.run", "invented other/repo"), "run-requested workflow=review request=saved repo=owner/repo")).toBe("Smithers requested a review run on owner/repo")
  expect(toolActLine(command("flow.run", "invented other/repo"), "run-started workflow=build run=live")).toBe("Smithers started a build run")
  expect(toolActLine(command("flow.create", "invented workflow"), "flow-requested request=saved")).toBe("Smithers requested a create-flow run")
  expect(toolActLine({ callId: "direct", name: "flow.run", args: "{}" }, "run-started run=live")).toBe("Smithers started a flow.run run")
})

test("unconfirmed or refused launches retain their actual result instead of claiming a run", () => {
  expect(toolActLine(command("flow.run"), "saved a draft")).toBe("Smithers ran /flow.run")
  expect(toolActLine(command("flow.run"), "failed: run-started workflow=review")).toBe("Smithers tried /flow.run — failed: run-started workflow=review")
  expect(toolActLine(command("flow.run"), "unknown-command: run-requested")).toBe("Smithers tried /flow.run — unknown-command: run-requested")
  expect(toolActLine(command("world"), "run-started workflow=review")).toBe("Smithers ran /world")
})

test("failure diagnostics collapse whitespace and retain exactly the supported display bound", () => {
  expect(toolActLine(command("world"), "failed:\n  permission\t denied\r\nnow")).toBe("Smithers tried /world — failed: permission denied now")
  for (const size of [159, 160, 161]) {
    const detail = "failed: " + "x".repeat(size - 8)
    const expected = "failed: " + "x".repeat(Math.min(size, 160) - 8)
    expect(toolActLine(command("world"), detail)).toBe("Smithers tried /world — " + expected)
  }
})

test("structured output is not copied into the act while prefixed failure detail remains visible", () => {
  expect(toolActLine(command("world"), '{"value":"private tool payload"}')).toBe("Smithers ran /world")
  expect(toolActLine(command("world"), "[1,2,3]")).toBe("Smithers ran /world")
  expect(toolActLine(command("world"), 'failed: {"message":"permission denied"}')).toBe('Smithers tried /world — failed: {"message":"permission denied"}')
})
