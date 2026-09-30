import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { SessionNavigation } from "../SessionNavigation"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, settle, unavailableAgent } from "../state/TestFixtures"

GlobalRegistrator.register()
afterAll(async () => { await settle(); await GlobalRegistrator.unregister() })

test("the header carries the sign-in door and leaves itself empty once signed in", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent)
  const calls: string[] = []
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  try {
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-out", login: null, admin: false, scopesPlain: null }).isPersisted.promise
    flushSync(() => root.render(<ControllerTestProvider controller={{ ...controller, runCommand: name => { calls.push(name); return true } }}><SessionNavigation /></ControllerTestProvider>))
    await settle()
    const signIn = host.querySelector<HTMLButtonElement>('.session-navigation [data-testid="chrome-sign-in"]')
    expect(signIn?.textContent).toBe("Sign in with GitHub")
    expect(signIn?.dataset.flow).toBe("auth.sign-in")
    signIn!.focus()
    expect(document.activeElement).toBe(signIn)
    signIn!.click()
    expect(calls).toEqual(["auth.sign-in"])
    await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "reader", admin: false, scopesPlain: null }).isPersisted.promise
    await settle()
    expect(host.querySelector('[data-testid="chrome-sign-in"]')).toBeNull()
    expect(host.querySelector(".session-identity")).toBeNull()
    expect(host.querySelector(".session-navigation")?.textContent).not.toContain("reader")
    expect(calls).toEqual(["auth.sign-in"])
  } finally {
    flushSync(() => root.unmount()); host.remove(); await controller.dispose()
  }
})
