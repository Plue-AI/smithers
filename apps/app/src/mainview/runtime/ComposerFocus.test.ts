import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { beforeAll, afterAll, expect, test } from "bun:test"
import { rememberComposerFocus, restoreComposerFocus } from "./ComposerFocus"

beforeAll(() => GlobalRegistrator.register())
afterAll(async () => { await GlobalRegistrator.unregister() })
const setup = () => {
  document.body.innerHTML = '<section><input value="keep selection"></section><div class="composer-wrap"><textarea></textarea></div><button>Chat</button>'
  const input = document.querySelector("input")!, overlay = document.querySelector("textarea")!, fallback = document.querySelector("button")!
  // Happy DOM does not lay out controls; only visibility geometry is supplied.
  input.getClientRects = () => [new DOMRect(0, 0, 100, 20)] as unknown as DOMRectList
  input.focus()
  input.setSelectionRange(2, 6)
  rememberComposerFocus(document)
  overlay.focus()
  return { input, overlay, fallback }
}

test("dismissal restores the opener and cursor once, without retaining it for the next dismissal", () => {
  const f = setup()
  restoreComposerFocus(document, f.fallback)
  expect(document.activeElement).toBe(f.input)
  expect([f.input.selectionStart, f.input.selectionEnd]).toEqual([2, 6])
  f.overlay.focus()
  restoreComposerFocus(document, f.fallback)
  expect(document.activeElement).toBe(f.fallback)
})

for (const invalid of ["removed", "hidden", "inert", "aria-hidden", "disabled", "no-layout", "cannot-focus"] as const) test(`an opener that is ${invalid} falls back to Chat`, () => {
  const f = setup()
  if (invalid === "removed") f.input.remove()
  else if (invalid === "hidden" || invalid === "inert") f.input.parentElement!.setAttribute(invalid, "")
  else if (invalid === "aria-hidden") f.input.parentElement!.setAttribute("aria-hidden", "true")
  else if (invalid === "disabled") f.input.disabled = true
  else if (invalid === "no-layout") f.input.getClientRects = () => [] as unknown as DOMRectList
  else f.input.focus = () => {}
  restoreComposerFocus(document, f.fallback)
  expect(document.activeElement).toBe(f.fallback)
})

test("remembering body clears an earlier opener and a missing fallback is harmless", () => {
  const f = setup()
  f.overlay.blur()
  expect(document.activeElement).toBe(document.body)
  rememberComposerFocus(document)
  restoreComposerFocus(document, null)
  expect(document.activeElement).toBe(document.body)
  restoreComposerFocus(document, f.fallback)
  expect(document.activeElement).toBe(f.fallback)
})

test("an already-focused composer cannot become its own restoration target", () => {
  const f = setup()
  rememberComposerFocus(document)
  restoreComposerFocus(document, f.fallback)
  expect(document.activeElement).toBe(f.fallback)
})
