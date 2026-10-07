import { createRoot, nativeHttp } from "./views/testDom"
import { act } from "react"
import { expect, test } from "bun:test"
import { SettingsContainer } from "./SettingsContainer"
import { SettingsView } from "./views/SettingsView"
import { createAppStore } from "../state/AppStore"
import { scopedControllers } from "../state/ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "../state/TestFixtures"

Object.assign(globalThis, nativeHttp)
const createAppController = scopedControllers()
const address = process.env.SMITHERS_PARALLEL_BOUNDARY_URL

// Go's TestParallelSettingsCardBoundary starts the production install router
// with PostgreSQL and supplies a real owner session. No setter or response is mocked.
test.skipIf(!address)("TestParallelSettingsCardBoundary", async () => {
  const writes: unknown[] = []
  const http = (input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new nativeHttp.Headers(init?.headers)
    headers.set("Cookie", `smithers_session=${process.env.SMITHERS_PARALLEL_BOUNDARY_COOKIE}; __csrf=parallel-card`)
    headers.set("Origin", "http://localhost:4000")
    headers.set("X-CSRF-Token", "parallel-card")
    headers.set("Host", "localhost:4000")
    if (init?.method === "PUT") writes.push(JSON.parse(String(init.body)))
    return nativeHttp.fetch(input, { ...init, headers })
  }
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent, { baseUrl: address, fetchImpl: http,
    bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] } })
  await controller.showSettings()
  await waitFor(() => controller.installSnapshots.get().model?.parallel === 2)
  expect(controller.installSnapshots.get().seed).toBeUndefined()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  await act(async () => root.render(<SettingsContainer View={SettingsView} install={controller.installSnapshots}
    owner origin="http://localhost:4000" view={{ maximized: false }} onView={() => {}}
    dispatch={(name, payload, gesture) => controller.commands.submit({ name, payload: (payload ?? {}) as Record<string, unknown>, actor: "user", gesture })} />))
  const button = host.querySelector<HTMLButtonElement>('[aria-label="More TODOs at once"]')!
  expect(button).not.toBeNull()
  expect(button.dataset.flow).toBe("settings.parallel")
  await act(async () => button.click())
  await act(async () => { await waitFor(() => controller.installSnapshots.get().model?.parallel === 3) })
  expect(writes).toEqual([{ parallel: 3 }])
  expect([...host.querySelectorAll("dt")].find(row => row.textContent === "TODOs at once")?.nextElementSibling?.textContent).toContain("3")
  const saved = await http(`${address}/api/install`).then(response => response.json())
  expect(saved.parallel).toBe(3)
  await act(async () => root.unmount())
})
