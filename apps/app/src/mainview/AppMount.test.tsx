import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { useLiveQuery } from "@tanstack/react-db"
import type { StorageApi } from "@tanstack/db"
import { appWordmark, unmountOnPageHide } from "./AppMount"
import { createAppStore } from "./state/AppStore"
import { SessionNavigationFallback } from "./SessionNavigation"
import { SessionShell } from "./SessionShell"

GlobalRegistrator.register()
const roots = new Set<Root>()
const memoryStorage = (): StorageApi => {
  const data = new Map<string, string>()
  return {
    getItem: key => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: key => void data.delete(key)
  }
}

afterAll(async () => {
  // React's scheduler finishes a commit in tasks of its own; unregistering the
  // DOM before they run takes `window` away mid-flight (ConnectorsEmpty's
  // three-tick drain, the pattern that covers it).
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

const mount = (children: React.ReactNode): HTMLElement => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(children))
  return host
}

describe("the mounted app's entrance mark", () => {
  test("is the single .guide-wordmark inside .session-navigation", () => {
    // The synchronous entrance AppRoot paints before the controller boots.
    const host = mount(<SessionShell navigation={<SessionNavigationFallback />} />)
    const mark = appWordmark(host)
    expect(mark).not.toBeNull()
    expect(mark?.closest(".session-navigation")).not.toBeNull()
    expect(host.querySelectorAll(".guide-wordmark").length).toBe(1)
    // The regression: the pre-refactor selector matches nothing, so the home
    // page's view transition had no new-state mark to morph onto.
    expect(host.querySelector(".session-shell > .guide-wordmark")).toBeNull()
  })
})

test("pagehide unmounts live queries before AppStore teardown", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  const warning = spyOn(console, "warn")
  function LiveCards() {
    useLiveQuery(store.collections.cards)
    useLiveQuery(store.collections.savedSignInPrompts)
    return null
  }
  try {
    const unmount = unmountOnPageHide(root)
    flushSync(() => root.render(<LiveCards />))
    window.dispatchEvent(new Event("pagehide"))
    await store.dispose?.()
    expect(warning.mock.calls.filter(args => args.some(arg => String(arg).includes("manually cleaned up while live query")))).toEqual([])
    unmount()
  } finally {
    warning.mockRestore()
    await store.dispose?.()
    host.remove()
  }
})
