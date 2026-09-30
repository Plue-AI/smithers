import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, spyOn, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { AppContent, AppReady } from "./AppRoot"
import { ControllerContext } from "./ControllerContext"
import type { AppController } from "./state/AppController"

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

test("a recorded saved-store open failure replaces signup, actions, and navigation with reload recovery", () => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const controller = { store: { savedStoreUnavailable: true } } as unknown as AppController
  let renderedActions = 0
  const Actions = () => { renderedActions++; return <button>Start a new signup or run</button> }
  let mounted = 0
  const reload = spyOn(window.location, "reload").mockImplementation(() => {})
  try {
    flushSync(() => root.render(<ControllerContext value={controller}>
      <AppReady View={Actions} onMounted={() => { mounted++ }} />
    </ControllerContext>))
    expect(renderedActions).toBe(0)
    expect(mounted).toBe(1)
    expect(host.textContent).toContain("Storage unavailable")
    expect(host.textContent).toContain("Reload")
    expect(host.textContent).not.toContain("Start a new signup or run")
    expect(host.querySelector("[role=alert]")).not.toBeNull()
    expect(host.querySelectorAll("button")).toHaveLength(1)
    flushSync(() => host.querySelector<HTMLButtonElement>("button")!.click())
    expect(reload).toHaveBeenCalledTimes(1)
  } finally {
    reload.mockRestore()
    flushSync(() => root.unmount())
    host.remove()
  }
})

test("a normal store still renders its app content", () => {
  const host = document.createElement("div")
  const root = createRoot(host)
  const controller = { store: { savedStoreUnavailable: false } } as unknown as AppController
  try {
    flushSync(() => root.render(<ControllerContext value={controller}>
      <AppContent><button>Continue existing session</button></AppContent>
    </ControllerContext>))
    expect(host.textContent).toBe("Continue existing session")
  } finally {
    flushSync(() => root.unmount())
  }
})
