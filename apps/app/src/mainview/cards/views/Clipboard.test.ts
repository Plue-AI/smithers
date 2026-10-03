import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, mock, test } from "bun:test"
import { copyText } from "@smthrs/ui/copy"

GlobalRegistrator.register()
afterAll(() => GlobalRegistrator.unregister())
const originalClipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
const originalExec = Object.getOwnPropertyDescriptor(document, "execCommand")
afterEach(() => {
  if (originalClipboard) Object.defineProperty(navigator, "clipboard", originalClipboard)
  else Reflect.deleteProperty(navigator, "clipboard")
  if (originalExec) Object.defineProperty(document, "execCommand", originalExec)
  else Reflect.deleteProperty(document, "execCommand")
  document.body.innerHTML = ""
})
const clipboard = (value: unknown) => Object.defineProperty(navigator, "clipboard", { configurable: true, value })
const legacy = (fn: unknown) => Object.defineProperty(document, "execCommand", { configurable: true, value: fn })

test("secure clipboard receives exact text", async () => {
  const writeText = mock(async (_text: string) => {})
  clipboard({ writeText })
  expect(await copyText("hello\nworld")).toEqual({ ok: true })
  expect(writeText).toHaveBeenCalledWith("hello\nworld")
})
test("plain HTTP fallback copies exact text and restores focus and selection", async () => {
  clipboard(undefined)
  document.body.innerHTML = '<button>Copy</button><p>selected</p>'
  const button = document.querySelector("button")!
  button.focus()
  const range = document.createRange(); range.selectNodeContents(document.querySelector("p")!)
  document.getSelection()!.addRange(range)
  const exec = mock((command: string) => {
    expect(command).toBe("copy")
    expect((document.activeElement as HTMLTextAreaElement).value).toBe("plain HTTP")
    return true
  })
  legacy(exec)
  expect(await copyText("plain HTTP")).toEqual({ ok: true })
  expect(exec).toHaveBeenCalledTimes(1)
  expect(document.activeElement).toBe(button)
  expect(document.querySelector("textarea")).toBeNull()
  expect(document.getSelection()!.toString()).toBe("selected")
})
test("unavailable fallback returns a visible failure result", async () => {
  clipboard(undefined); legacy(undefined)
  expect(await copyText("text")).toEqual({ ok: false, code: "clipboard-unavailable", cause: undefined })
})
for (const throws of [false, true]) test(`fallback failure cleans up (${throws})`, async () => {
  clipboard(undefined); legacy(() => { if (throws) throw new Error("denied"); return false })
  const result = await copyText("text")
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.code).toBe("clipboard-write-failed")
  expect(document.querySelector("textarea")).toBeNull()
})
test("rejected Clipboard API normalizes failure", async () => {
  const cause = new Error("denied")
  clipboard({ writeText: async () => { throw cause } })
  expect(await copyText("text")).toEqual({ ok: false, code: "clipboard-write-failed", cause })
})
test("refused Clipboard API copies once through the fallback", async () => {
  const writeText = mock(async () => { throw new Error("denied") })
  clipboard({ writeText })
  const exec = mock((command: string) => {
    expect(command).toBe("copy")
    expect((document.activeElement as HTMLTextAreaElement).value).toBe("refused write")
    return true
  })
  legacy(exec)
  expect(await copyText("refused write")).toEqual({ ok: true })
  expect(writeText).toHaveBeenCalledTimes(1)
  expect(exec).toHaveBeenCalledTimes(1)
  expect(document.querySelector("textarea")).toBeNull()
})
test("host override is awaited", async () => {
  let complete!: () => void
  const pending = new Promise<void>(resolve => { complete = resolve })
  const host = mock((_text: string) => pending)
  let settled = false
  const result = copyText("host", host).then(value => { settled = true; return value })
  await Promise.resolve()
  expect(settled).toBe(false)
  complete()
  expect(await result).toEqual({ ok: true })
  expect(host).toHaveBeenCalledWith("host")
})

test("native rejection survives an unsuccessful fallback", async () => {
  const cause = new Error("permission denied")
  clipboard({ writeText: async () => { throw cause } })
  legacy(() => false)
  expect(await copyText("text")).toEqual({ ok: false, code: "clipboard-write-failed", cause })
})
