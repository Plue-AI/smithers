import { describe, expect, it } from "bun:test"
import { EventEmitter } from "node:events"
import * as Clipboard from "../src/clipboard.ts"

const selected = (text: string) => ({ getSelectedText: () => text })

describe("copyOnSelect", () => {
  it("copies a finished selection and reports it", async () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    const reported: Array<string> = []
    Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), (text) => reported.push(text))
    renderer.emit("selection", selected("Flow grep timed out"))
    await Bun.sleep(0)
    expect(copied).toEqual(["Flow grep timed out"])
    expect(reported).toEqual(["Flow grep timed out"])
  })

  it("ignores a click that selected nothing", () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), () => {})
    renderer.emit("selection", selected(""))
    renderer.emit("selection", selected("  \n"))
    expect(copied).toEqual([])
  })

  it("reports a copy the clipboard refused as a failure, not a copy", async () => {
    const renderer = new EventEmitter()
    const reported: Array<string> = []
    const failed: Array<string> = []
    Clipboard.copyOnSelect(renderer, async () => false, (text) => reported.push(text), (text) => failed.push(text))
    renderer.emit("selection", selected("text"))
    await Bun.sleep(0)
    expect(reported).toEqual([])
    expect(failed).toEqual(["text"])
  })

  it("stops copying after unsubscribe", () => {
    const renderer = new EventEmitter()
    const copied: Array<string> = []
    const stop = Clipboard.copyOnSelect(renderer, (text) => (copied.push(text), true), () => {})
    stop()
    renderer.emit("selection", selected("text"))
    expect(copied).toEqual([])
  })
})

describe("write", () => {
  it("tries wl-copy under Wayland before the X11 commands", () => {
    expect(Clipboard.commands("linux", { WAYLAND_DISPLAY: "wayland-0" }).map(([command]) => command)).toEqual([
      "wl-copy",
      "xclip",
      "xsel"
    ])
    expect(Clipboard.commands("linux", {}).map(([command]) => command)).toEqual(["xclip", "xsel"])
    expect(Clipboard.commands("darwin", {}).map(([command]) => command)).toEqual(["pbcopy"])
  })

  it("returns before the clipboard command exits and falls through a missing one", async () => {
    const pending = Clipboard.write("x", [["definitely-not-a-clipboard", []], ["sh", [
      "-c",
      "sleep 0.2; cat >/dev/null"
    ]]])
    expect(pending).toBeInstanceOf(Promise)
    expect(await pending).toBe(true)
    expect(await Clipboard.write("x", [["definitely-not-a-clipboard", []]])).toBe(false)
  })
})
