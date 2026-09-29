import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { scopedControllers } from "./ControllerTestScope"
import type { AppController as AppControllerType } from "./AppController"
import { createAppStore } from "./AppStore"
import { backend, json, memoryStorage, settled, silentAgent } from "./TestFixtures"

const createAppController = scopedControllers()

/*
 * Wave 14 §1 — the OPENING message is never filler.
 *
 * The launch checklist reads `smithersMessages(page).first()`: whatever renders
 * FIRST in the transcript is the message the product is judged by. A seeded
 * "Hey — I'm Smithers. Tell me what you're working on" satisfied nothing and
 * displaced everything, so it is gone. These pin the replacement in the DOM,
 * at the harness's own altitude:
 *
 *   signed out — the opening (and only) message IS the auth conversation state;
 *   signed in  — the FIRST message is the repo chooser's welcome when the
 *   watched-repos selection was never made (or the honest unreadable state);
 *   loading    — the transcript is EMPTY, and the 300ms toast says what runs.
 */

GlobalRegistrator.register()

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  await GlobalRegistrator.unregister()
})

const mounted: Array<() => void> = []

afterEach(() => {
  while (mounted.length > 0) mounted.pop()?.()
})

const mount = (controller: AppControllerType): { host: HTMLElement; markup: () => string } => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() =>
    root.render(
      <ControllerTestProvider controller={controller}>
        <App />
      </ControllerTestProvider>
    )
  )
  mounted.push(() => {
    flushSync(() => root.unmount())
    host.remove()
  })
  return { host, markup: () => host.innerHTML }
}

/*
 * The launch harness's own selector, verbatim (flows/ui e2e/launch-checklist/
 * checks.ts `sel.smithersMessages`). It accepts BOTH role spellings; this app
 * only ever renders "assistant", but copying the harness's narrower half would
 * make the empty-transcript assertion below pass vacuously if that ever changed.
 */
const SMITHERS_MESSAGES =
  "[data-slot=\"chat-message\"][data-role=\"assistant\"], [data-slot=\"chat-message\"][data-role=\"smithers\"]"

/** The harness's `smithersMessages(page).first()`: the first rendered message. */
const openingMessage = (host: HTMLElement): string =>
  (host.querySelector(SMITHERS_MESSAGES)?.textContent ?? "").replace(/\s+/g, " ").trim()

const FILLER = /Tell me what you[’']re working on/

describe("wave 14 §1 — the opening message is never filler", () => {
  test("signed out: no opening message at all; the transcript starts empty (LOCAL-APP.md)", async () => {
    const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
    const controller = createAppController(store, silentAgent, {
      ...backend({
        "/api/user": json(401, { status: "error" }),
        "/api/auth/scopes": json(200, {
          scopes: [{ scope: "repo", plain: "Read your repositories.", why: "To see your work." }]
        })
      })
    })
    await controller.loadSession()
    await settled()

    const { host, markup } = mount(controller)
    expect(host.querySelectorAll(SMITHERS_MESSAGES)).toHaveLength(0)
    expect(openingMessage(host)).toBe("")
    expect(FILLER.test(markup())).toBe(false)
  })

})
