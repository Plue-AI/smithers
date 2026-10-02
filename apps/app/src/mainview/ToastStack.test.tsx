import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { ToastStack } from "./ToastStack"
import type { Toast } from "./state/AppState"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

const RAW = "TypeError: Failed to fetch\n    at listRuns (runs.ts:259)"
const toast = (status: Toast["status"], detail: string): Toast =>
  ({ id: `toast-${status}`, key: status, title: "Loading runs…", detail, status, createdAt: 1, updatedAt: 1 })

/** Mounts the stack and returns a re-render for the same root. */
const mount = (toasts: ReadonlyArray<Toast>): ((next: ReadonlyArray<Toast>) => void) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const show = (next: ReadonlyArray<Toast>) =>
    flushSync(() => root.render(<ToastStack toasts={next} onDismiss={() => {}} onAction={() => {}} />))
  show(toasts)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return show
}

const render = (toasts: ReadonlyArray<Toast>): HTMLElement => {
  mount(toasts)
  return document.body
}

/** `count` toasts one tick apart, oldest first; the indices in `failed` failed. */
const stack = (count: number, failed: ReadonlyArray<number> = []): Array<Toast> =>
  Array.from({ length: count }, (_, at) => ({
    id: `toast-${at}`, key: `work-${at}`, title: `Work ${at}`, detail: "",
    status: failed.includes(at) ? "failed" : "running", createdAt: at, updatedAt: at
  }))
const titles = (): Array<string | null> =>
  [...document.querySelectorAll(".toast-stack .toast-title")].map(title => title.textContent)
const moreRow = (): HTMLButtonElement | null => document.querySelector<HTMLButtonElement>(".toast-stack .toast-more")

test("a failed toast keeps its title in view and its caught detail behind a collapsed Details", () => {
  const notice = render([toast("failed", RAW)]).querySelector<HTMLElement>('.toast[data-toast-status="failed"]')!
  expect(notice.querySelector(".toast-title")?.textContent).toBe("Loading runs…")
  const details = notice.querySelector<HTMLDetailsElement>("details.toast-detail")!
  expect(details.open).toBe(false)
  expect(details.querySelector("summary")?.textContent).toBe("Details")
  expect(details.querySelector("pre")?.textContent).toBe(RAW)
  expect(details.querySelector("pre")?.tabIndex).toBe(0)
  // Nothing outside the collapsed Details carries the raw text.
  const visible = [...notice.childNodes].map(node => node.textContent ?? "").join("").replace(details.textContent ?? "", "")
  expect(visible).not.toContain("Failed to fetch")
})

test("running, done and cancelled toasts show their detail as progress words, not behind Details", () => {
  const host = render([toast("running", "3 of 5 checked"), toast("ok", "12 runs"), toast("cancelled", "Cancelled")])
  for (const [status, detail] of [["running", "3 of 5 checked"], ["ok", "12 runs"], ["cancelled", "Cancelled"]] as const) {
    const notice = host.querySelector<HTMLElement>(`.toast[data-toast-status="${status}"]`)!
    expect(notice.querySelector("details")).toBeNull()
    expect(notice.querySelector(".toast-detail")?.textContent).toBe(detail)
  }
})

test("a toast with no detail draws neither the line nor the Details", () => {
  const host = render([toast("failed", ""), toast("ok", "")])
  expect(host.querySelector(".toast-detail")).toBeNull()
  expect(host.querySelector("details")).toBeNull()
})

/* #3420: six toasts covered forms and panes. The newest three show; one row holds the rest. */
test("five toasts show the newest three, then one +2 more row that closes the stack", () => {
  render(stack(5))
  expect(titles()).toEqual(["Work 4", "Work 3", "Work 2"])
  const row = moreRow()!
  expect([row.tagName, row.type, row.textContent, row.getAttribute("aria-expanded")]).toEqual(["BUTTON", "button", "+2 more", "false"])
  expect(document.querySelector(".toast-stack")!.lastElementChild).toBe(row)
})

test("the row shows all five and collapses back to three, and focus stays on it", () => {
  render(stack(5))
  const row = moreRow()!
  row.focus()
  flushSync(() => row.click())
  expect(titles()).toEqual(["Work 4", "Work 3", "Work 2", "Work 1", "Work 0"])
  expect([moreRow(), row.textContent, row.getAttribute("aria-expanded")]).toEqual([row, "Fewer", "true"])
  expect(document.activeElement).toBe(row)
  flushSync(() => row.click())
  expect(titles()).toEqual(["Work 4", "Work 3", "Work 2"])
  expect([moreRow(), row.textContent, row.getAttribute("aria-expanded")]).toEqual([row, "+2 more", "false"])
  expect(document.activeElement).toBe(row)
})

test("the cap reorders nothing: each failure keeps its place, its alert role and its Dismiss", () => {
  // The newest toast failed and leads; an older failure waits behind the row in its own place.
  render(stack(5, [4, 1]))
  const roles = () => [...document.querySelectorAll(".toast-stack .toast")].map(toast => toast.getAttribute("role"))
  expect(titles()).toEqual(["Work 4", "Work 3", "Work 2"])
  expect(roles()).toEqual(["alert", "status", "status"])
  flushSync(() => moreRow()!.click())
  expect(titles()).toEqual(["Work 4", "Work 3", "Work 2", "Work 1", "Work 0"])
  expect(roles()).toEqual(["alert", "status", "status", "alert", "status"])
  expect(document.querySelectorAll('.toast[data-toast-status="failed"] .toast-dismiss')).toHaveLength(2)
})

test("a stack of exactly three shows every toast and no row", () => {
  render(stack(3))
  expect(titles()).toEqual(["Work 2", "Work 1", "Work 0"])
  expect(moreRow()).toBeNull()
})

test("an opened stack closes once its overflow clears, so new overflow is capped again", () => {
  const show = mount(stack(5))
  flushSync(() => moreRow()!.click())
  expect(titles()).toHaveLength(5)
  show(stack(3))
  expect(moreRow()).toBeNull()
  show(stack(6))
  expect(titles()).toEqual(["Work 5", "Work 4", "Work 3"])
  expect(moreRow()?.textContent).toBe("+3 more")
})
