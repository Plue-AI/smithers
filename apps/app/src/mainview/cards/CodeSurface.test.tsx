import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { FileCard } from "@smthrs/rpc/FileCard"
import { disposeCodeViewPool } from "@smthrs/ui/adapters/code-view"
import { CodeSurface } from "./CodeSurface"
import { cardActions } from "../flows/cardActions"

GlobalRegistrator.register()
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); document.body.replaceChildren() })
afterAll(async () => { disposeCodeViewPool(); await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const model: FileCard = { path: "src/b.ts", branch: "T1", language: "typescript", digest: "fixture-sha",
  content: { kind: "text", text: '\n\n\n\nadd(1, "2")\n' }, mode: "read_only", diagnostics: [], authors: [], editors: [], reveal: { line: 5, col: 3 } }
const render = (file: FileCard, gestures = false) => {
  const calls: unknown[] = []
  const bindings = cardActions<"hover" | "definition">((tag, input) => calls.push([tag, input]), gestures ? [
    { tag: "code.hover", label: "", gesture: "hover", command_input: { path: file.path, line: 5, col: 3 }, resolve_input: input => ({ path: input.path!, line: Number(input.line), col: Number(input.col) }) },
    { tag: "code.definition", label: "", gesture: "definition", command_input: { path: file.path, line: 5, col: 3 }, resolve_input: input => ({ path: input.path!, line: Number(input.line), col: Number(input.col) }) }
  ] : [])
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const update = (next: FileCard) => flushSync(() => root.render(<CodeSurface model={next} view={{ maximized: false }} {...bindings} onView={() => {}} />))
  update(file)
  return { host, calls, update }
}

test.each([
  [{ kind: "binary", bytes: 1_200_000 }, "Binary file · 1.2 MB"],
  [{ kind: "too_large", bytes: 4_100_000, text: "must not render" }, "Too large to show · 4.1 MB"]
] as const)("non-text state has literal size and supplied GitHub link", (content, expected) => {
  const { host } = render({ ...model, content, github_url: "https://github.com/acme/repo/blob/main/src/b.ts" })
  expect(host.textContent).toContain(expected)
  expect(host.querySelector("a")?.textContent).toBe("on GitHub ↗")
  expect(host.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/repo/blob/main/src/b.ts")
  expect(host.querySelector('[data-slot="code-view"]')).toBeNull()
  expect(host.textContent).not.toContain("must not render")
})
test("keyboard gestures dispatch literal UTF-16 position through cardActions without changing selection", () => {
  const { host, calls } = render(model, true)
  const surface = host.querySelector<HTMLElement>(".code-surface")!
  surface.focus()
  const selectedText = document.createTextNode("keep this selection")
  document.body.append(selectedText)
  const range = document.createRange()
  range.setStart(selectedText, 5); range.setEnd(selectedText, 9)
  window.getSelection()!.addRange(range)
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F10", shiftKey: true, bubbles: true, cancelable: true }))
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true }))
  expect(calls).toEqual([["code.hover", { path: "src/b.ts", line: 5, col: 3 }], ["code.definition", { path: "src/b.ts", line: 5, col: 3 }]])
  expect(document.activeElement).toBe(surface)
  expect(window.getSelection()?.toString()).toBe("this")
})
test("unavailable capability binds no gesture, even with live mode or persisted hover", () => {
  const { host, calls } = render({ ...model, mode: "live", hover: { line: 5, col: 3, markdown: "old answer" } })
  const surface = host.querySelector<HTMLElement>(".code-surface")!
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true }))
  expect(calls).toEqual([])
  // axe scrollable-region-focusable: scrolling remains keyboard accessible without gestures.
  expect(surface.getAttribute("tabindex")).toBe("0")
  expect(surface.hasAttribute("data-flow")).toBe(false)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
})
test("changing text updates the same view and preserves the scrolling panel", () => {
  const { host, update } = render(model)
  const view = host.querySelector('[data-slot="code-view"]')
  const body = host.querySelector<HTMLElement>(".smithers-card-body")!
  body.scrollTop = 40
  update({ ...model, content: { kind: "text", text: "changed bytes\n" } })
  expect(host.querySelector('[data-slot="code-view"]')).toBe(view)
  expect(host.querySelector("pre")?.textContent).toBe("changed bytes\n")
  expect(body.scrollTop).toBe(40)
})
