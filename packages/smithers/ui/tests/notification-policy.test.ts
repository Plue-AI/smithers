import { expect, test } from "bun:test"
import { noticeDismissDelay, workNoticeVisible } from "../src/notification-policy"

test("a request stays visible through unresolved launch and execution", () => {
  for (const status of ["requested", "queued", "running", "waiting", "parked"]) {
    expect(workNoticeVisible({ status, startedAt: 0 }, 299)).toBe(false)
    expect(workNoticeVisible({ status, startedAt: 0 }, 300)).toBe(true)
    expect(workNoticeVisible({ status, startedAt: 0 }, 100000)).toBe(true)
  }
})

test("only real settlement starts expiry; fast successes never flash", () => {
  expect(workNoticeVisible({ status: "done", startedAt: 0, endedAt: 100 }, 300)).toBe(false)
  expect(workNoticeVisible({ status: "done", startedAt: 0, endedAt: 300 }, 4299)).toBe(true)
  expect(workNoticeVisible({ status: "done", startedAt: 0, endedAt: 300 }, 4300)).toBe(false)
})

test("failures survive debounce and elapsed time unless explicitly overridden", () => {
  const failed = { status: "failed", startedAt: 0, endedAt: 1 }
  expect(workNoticeVisible(failed, 1)).toBe(true)
  expect(workNoticeVisible(failed, 100000)).toBe(true)
  expect(noticeDismissDelay("failed")).toBeUndefined()
  expect(noticeDismissDelay("failed", 4000, 50)).toBe(50)
  expect(noticeDismissDelay("ok")).toBe(4000)
  expect(noticeDismissDelay("cancelled")).toBe(4000)
})
