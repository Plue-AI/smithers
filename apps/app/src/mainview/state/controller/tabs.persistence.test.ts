import { expect, test } from "bun:test"
import { createAppStore } from "../AppStore"
import { memoryStorage } from "../TestFixtures"

test("renderer boot preserves terminal/harness tabs, session identity and selected tab", async () => {
  const storage = memoryStorage()
  const first = await createAppStore({ kind: "localStorage", storage })
  for (const tab of [
    { id: "terminal", sessionId: "terminal", kind: "terminal", title: "Terminal", cwd: "~" },
    { id: "agent", sessionId: "agent", kind: "harness", harnessId: "codex", title: "Agent", cwd: "~" }
  ] as const) await first.dispatch({ type: "tab.opened", actor: "user", tab }).isPersisted.promise
  await first.dispatch({ type: "tab.close.asked", actor: "user", id: "agent" }).isPersisted.promise
  const reopened = await createAppStore({ kind: "localStorage", storage })
  expect(reopened.collections.tabs.get("terminal")).toMatchObject({ sessionId: "terminal", kind: "terminal" })
  expect(reopened.collections.tabs.get("agent")).toMatchObject({ sessionId: "agent", kind: "harness" })
  expect(reopened.session().activeTabId).toBe("agent")
  expect(reopened.session().pendingTabCloseId).toBeNull()
})
