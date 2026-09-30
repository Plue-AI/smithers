/** Where a submitted composer line goes. */
import { describe, expect, it } from "bun:test"
import * as Composer from "../src/composer.ts"
import * as Editor from "../src/editor.ts"

describe("route", () => {
  it("sends a plain line to the agent, a / line to commands and a ! line to the shell", () => {
    expect(Composer.route("fix the test", false)).toEqual({ _tag: "prompt" })
    expect(Composer.route("/model", false)).toEqual({ _tag: "command" })
    expect(Composer.route("!ls", false)).toEqual({ _tag: "shell", command: "ls", excluded: false })
    expect(Composer.route("!!ls", false)).toEqual({ _tag: "shell", command: "ls", excluded: true })
  })

  it("steers a worker with anything but a shell line or a command", () => {
    expect(Composer.route("also check refresh", true)).toEqual({ _tag: "steer" })
    expect(Composer.route("/chat", true)).toEqual({ _tag: "command" })
    expect(Composer.route("!ls", true)).toEqual({ _tag: "shell", command: "ls", excluded: false })
  })
})

describe("unknown commands", () => {
  it.each([
    ["flwo", "Unknown command /flwo. Try /flow."],
    ["modle", "Unknown command /modle. Try /model."],
    ["resme", "Unknown command /resme. Try /resume."],
    ["THEME", "Unknown command /THEME. Try /theme."],
    ["summry", "Unknown command /summry. Try /summary."]
  ])("suggests the nearest listed command for /%s", (typed, sentence) => {
    expect(Editor.unknown(typed)).toBe(sentence)
  })

  it.each(["hotkeys", "tabs", "stop", "retry", "ui", "x", "ab", "not-a-command"])(
    "suggests nothing when no listed command is close to /%s",
    (typed) => {
      expect(Editor.nearest(typed)).toBeUndefined()
      expect(Editor.unknown(typed)).toBe(`Unknown command /${typed}`)
    }
  )

  it("counts a swap of neighbors as one edit and prefers the fewest edits", () => {
    expect(Editor.nearest("nwe")?.name).toBe("new")
    expect(Editor.nearest("copi")?.name).toBe("copy")
    expect(Editor.nearest("fork")?.name).toBe("fork")
  })

  it("knows the listed commands and the unlisted wrapped workers and alias, and nothing removed", () => {
    for (const command of Editor.commands) expect(Editor.known(command.name)).toBe(true)
    for (const name of ["claude", "codex", "exit"]) expect(Editor.known(name)).toBe(true)
    for (const name of ["hotkeys", "tabs", "retry", "stop", "ui", "flwo", ""]) expect(Editor.known(name)).toBe(false)
  })

  it("no longer lists the removed commands", () => {
    const names = Editor.commands.map((command) => command.name)
    for (const removed of ["hotkeys", "tabs", "claude", "codex", "retry", "stop", "ui"]) {
      expect(names).not.toContain(removed)
    }
  })
})
