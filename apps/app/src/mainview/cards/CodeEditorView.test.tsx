import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot, type Root } from "react-dom/client"
import type { FileCard } from "@smthrs/rpc/FileCard"
import { CodeEditorSurface } from "./CodeEditorSurface"
import type { EditorBinding } from "@smthrs/ui/adapters/code-editor"
import { EditorView } from "@codemirror/view"
import { Compartment } from "@codemirror/state"
import { authorRanges } from "./liveDoc"
import { cardActions } from "../flows/cardActions"

GlobalRegistrator.register()
const roots: Root[] = []
afterEach(() => { for (const root of roots.splice(0)) flushSync(() => root.unmount()); document.body.replaceChildren() })
afterAll(async () => { for (let i = 0; i < 3; i++) await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })
const model: FileCard = { path: "src/b.ts", branch: "T1", language: "typescript", digest: "fixture-sha",
  content: { kind: "text", text: '\n\n\n\nadd(1, "2")\n' }, mode: "read_only", diagnostics: [], authors: [], editors: [], reveal: { line: 5, col: 3 } }
const render = (file: FileCard, gestures = false, initialBinding?: EditorBinding) => {
  const calls: unknown[] = []
  const bindings = cardActions<"hover" | "definition">((tag, input) => calls.push([tag, input]), gestures ? [
    { tag: "code.hover", label: "", gesture: "hover", command_input: { path: file.path, line: 5, col: 3 }, resolve_input: input => ({ path: input.path!, line: Number(input.line), col: Number(input.col) }) },
    { tag: "code.definition", label: "", gesture: "definition", command_input: { path: file.path, line: 5, col: 3 }, resolve_input: input => ({ path: input.path!, line: Number(input.line), col: Number(input.col) }) }
  ] : [])
  const host = document.createElement("div"); document.body.append(host)
  const root = createRoot(host); roots.push(root)
  const update = (next: FileCard, binding = initialBinding) => flushSync(() => root.render(<CodeEditorSurface binding={binding} model={next} view={{ maximized: false }} {...bindings} onView={() => {}} />))
  update(file)
  return { host, calls, update }
}

test.each([
  [{ kind: "binary", bytes: 1_200_000 }, "Binary file · 1.2 MB"],
  [{ kind: "too_large", bytes: 4_100_000, text: "must not render" }, "Too large to co-edit · 4.1 MB"]
] as const)("non-text state has literal size and supplied GitHub link", (content, expected) => {
  const { host } = render({ ...model, content, github_url: "https://github.com/acme/repo/blob/main/src/b.ts" })
  expect(host.textContent).toContain(expected)
  expect(host.querySelector("a")?.textContent).toBe("on GitHub ↗")
  expect(host.querySelector("a")?.getAttribute("href")).toBe("https://github.com/acme/repo/blob/main/src/b.ts")
  expect(host.querySelector('.cm-editor')).toBeNull()
  expect(host.textContent).not.toContain("must not render")
})
test("keyboard gestures dispatch literal UTF-16 position through cardActions without changing selection", () => {
  const { host, calls } = render(model, true)
  const surface = host.querySelector<HTMLElement>(".cm-content")!
  surface.focus()
  const selectedText = document.createTextNode("keep this selection")
  document.body.append(selectedText)
  const range = document.createRange()
  range.setStart(selectedText, 5); range.setEnd(selectedText, 9)
  window.getSelection()!.addRange(range)
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: " ", code: "Space", ctrlKey: true, bubbles: true, cancelable: true }))
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true, cancelable: true }))
  expect(calls).toEqual([["code.hover", { path: "src/b.ts", line: 5, col: 3 }], ["code.definition", { path: "src/b.ts", line: 5, col: 3 }]])
  expect(document.activeElement).toBe(surface)
  expect(window.getSelection()?.toString()).toBe("this")
})
test("unavailable capability binds no gesture, even with live mode or persisted hover", () => {
  const { host, calls } = render({ ...model, mode: "live", hover: { line: 5, col: 3, markdown: "old answer" } })
  const surface = host.querySelector<HTMLElement>(".cm-content")!
  surface.dispatchEvent(new KeyboardEvent("keydown", { key: "F12", bubbles: true }))
  expect(calls).toEqual([])
  // axe scrollable-region-focusable: scrolling remains keyboard accessible without gestures.
  expect(surface.getAttribute("tabindex")).toBe("0")
  expect(surface.hasAttribute("data-flow")).toBe(false)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
})
test("changing text updates the same view and preserves the scrolling panel", () => {
  const { host, update } = render(model)
  const view = host.querySelector('.cm-editor')
  const body = host.querySelector<HTMLElement>(".smithers-card-body")!
  body.scrollTop = 40
  update({ ...model, content: { kind: "text", text: "changed bytes" } })
  expect(host.querySelector('.cm-editor')).toBe(view)
  expect(host.querySelector(".cm-content")?.textContent).toBe("changed bytes")
  expect(body.scrollTop).toBe(40)
})

const alice = { kind: "person" as const, login: "alice", name: "Alice", avatar_url: "", color_index: 2 as const }
const agent = { kind: "agent" as const, agent: "coding" as const, id: "coding-7", avatar_url: "", color_index: 6 as const }
const live: FileCard = { ...model, mode: "live", content: { kind: "text", text: "alpha\nbeta\n" },
  authors: [alice, agent], editors: [{ actor: alice, line: 1 }, { actor: agent, line: 2 }], saved: "saving", reveal: undefined }

test("live editor renders author ranges and person/agent line flags, then updates the same editor", () => {
  const attribution = new Compartment()
  const binding = { text: "alpha\nbeta\n", extensions: attribution.of(authorRanges.of([
    { from: 0, to: 5, actor: alice }, { from: 6, to: 10, actor: agent }
  ])) }
  const { host, update } = render(live, false, binding)
  expect([...host.querySelectorAll(".code-author")].map(node => [node.textContent, (node as HTMLElement).style.getPropertyValue("--who")])).toEqual([
    ["alpha", "var(--lane-2)"], ["beta", "var(--lane-6)"]
  ])
  expect([...host.querySelectorAll(".code-name-flag")].map(node => [node.textContent, node.getAttribute("data-kind")])).toEqual([
    ["Alice", "person"], ["Coding agent", "agent"]
  ])
  expect(host.querySelector(".cm-ySelection, .cm-ySelectionCaret")).toBeNull()
  expect(host.querySelector(".code-saved")?.textContent).toBe("Saving…")
  const dom = host.querySelector<HTMLElement>(".cm-editor")!
  const editor = EditorView.findFromDOM(dom)!
  editor.dispatch({ effects: attribution.reconfigure(authorRanges.of([{ from: 6, to: 10, actor: alice }])) })
  expect([...host.querySelectorAll(".code-author")].map(node => node.textContent)).toEqual(["beta"])
  update({ ...live, saved: "saved", editors: [{ actor: agent, line: 1 }] })
  expect(host.querySelector(".cm-editor")).toBe(dom)
  expect(host.querySelector(".code-saved")?.textContent).toBe("Saved to the machine")
  expect(host.querySelectorAll(".code-name-flag")).toHaveLength(1)
  expect(host.querySelector(".code-name-flag")?.textContent).toBe("Coding agent")
  update({ ...live, mode: "read_only" })
  expect(host.querySelector(".cm-editor")).toBe(dom)
  expect(host.querySelector(".code-author, .code-name-flag, .code-saved, .code-avatar-stack")).toBeNull()
  expect(host.querySelector(".cm-content")?.getAttribute("aria-readonly")).toBe("true")
})

test("absent binding never infers live indicators from persisted props", () => {
  const { host } = render(live)
  expect(host.querySelector('[data-mode="read_only"]')).not.toBeNull()
  expect(host.querySelector(".code-author, .code-name-flag, .code-saved, .code-avatar-stack, button[data-flow]")).toBeNull()
})

test("unknown authors and out-of-document presence stay absent; hostile actor labels stay inert", () => {
  const hostile = { ...alice, name: '<script>alert(1)</script>' }
  const binding = { text: "alpha\nbeta\n", extensions: authorRanges.of([
    { from: -5, to: 5, actor: hostile }, { from: 6, to: 100, actor: agent }, { from: 100, to: 110, actor: hostile }
  ]) }
  const { host } = render({ ...live, authors: [hostile], editors: [{ actor: hostile, line: 1 }, { actor: agent, line: 99 }], saved: undefined }, false, binding)
  expect(host.querySelectorAll(".code-author")).toHaveLength(1)
  expect(host.querySelector(".code-author")?.textContent).toBe("alpha")
  expect(host.querySelectorAll(".code-name-flag")).toHaveLength(1)
  expect(host.querySelector(".code-name-flag")?.textContent).toBe('<script>alert(1)</script>')
  expect(host.querySelector("script, .code-saved")).toBeNull()
})
