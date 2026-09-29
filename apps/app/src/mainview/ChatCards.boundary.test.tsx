import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, spyOn, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { CardBodyBoundary } from "./ChatCards"

GlobalRegistrator.register()
afterAll(async () => {
  // Let React's scheduled cleanup finish before removing the browser globals.
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

function FailedViewer({ message }: { message: string }): never { throw Error(message) }
const render = (message?: string) => {
  const errors = spyOn(console, "error").mockImplementation(() => {})
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const commands: string[] = []
  flushSync(() => root.render(<CardBodyBoundary cardId="saved-file" onRunCommand={name => { commands.push(name) }}>
    {message ? <FailedViewer message={message} /> : <p>Saved file</p>}
  </CardBodyBoundary>))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove(); errors.mockRestore() })
  return { host, commands }
}

for (const message of ["Failed to fetch dynamically imported module: /assets/file-old.js", "Loading chunk 14 failed", "Importing a module script failed."]) {
  test(`a stale viewer offers the existing reload flow: ${message}`, () => {
    const { host, commands } = render(message)
    const reload = host.querySelector<HTMLButtonElement>('[data-flow="chat.reload"]')!
    const alert = host.querySelector<HTMLElement>('[role="alert"]')!
    expect(alert.querySelector("p")?.textContent).toBe("This card's viewer changed in an update. Reload the app to see it.")
    expect(alert.dataset.failure).toBe("CardViewerOutdated")
    expect(alert.querySelector("details pre")?.textContent).toContain(message)
    expect(reload.textContent).toBe("Reload app")
    expect(reload.type).toBe("button")
    expect(reload.disabled).toBe(false)
    reload.focus()
    expect(document.activeElement).toBe(reload)
    reload.click()
    expect(commands).toEqual(["chat.reload"])
  })
}

test("healthy cards and payload errors do not claim the app was updated", () => {
  const healthy = render()
  expect(healthy.host.textContent).toBe("Saved file")
  expect(healthy.host.querySelector('[data-flow="chat.reload"]')).toBeNull()
  const failed = render("Missing payload field")
  const alert = failed.host.querySelector<HTMLElement>('[role="alert"]')!
  expect(alert.querySelector("p")?.textContent).toBe("This card could not be shown. Not your fault.")
  expect(alert.dataset.fault).toBe("bug")
  expect(alert.dataset.failure).toBeUndefined()
  expect(alert.querySelector("p")?.textContent).not.toContain("Missing payload field")
  const details = alert.querySelector("details")!
  expect(details.open).toBe(false)
  expect(details.querySelector("pre")?.textContent).toContain("Missing payload field")
  expect(failed.host.querySelector("button")).toBeNull()
})
