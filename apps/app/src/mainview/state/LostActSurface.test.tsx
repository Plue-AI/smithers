import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { Schema } from "effect"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Card } from "./AppState"
import { FlowFormCardBody } from "../cards/FlowFormCards"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent } from "./TestFixtures"

/*
 * The other half of a lost act: the act that reached nothing because THIS APP
 * threw, not because the browser refused a write.
 *
 * A form field is the busiest door in the app — every flow form, including the
 * repository setup card's own question, commits each keystroke through
 * `form.set` — and the staging step that runs before its write is ordinary
 * code that can have an ordinary bug. When it threw, the throw left the
 * command through a `.then` with no `.catch`: the field snapped back to the
 * value it already had, no toast, no transcript line, and an unhandled
 * rejection in the console the person will never see. That is the same silence
 * a refused write used to have, reached by a different road.
 *
 * A bug is not a storage fault and must not borrow its words: "make it again;
 * if it fails twice, reload the page" is retry advice for something that will
 * never succeed. It gets its own arm, its own fault class, and a sentence that
 * says whose bug it is.
 */

GlobalRegistrator.register()
afterAll(async () => { await new Promise(resolve => setTimeout(resolve, 0)); await GlobalRegistrator.unregister() })

const createAppController = scopedControllers()

const APP_BUG =
  "Smithers hit a bug of its own, so that didn't finish. Not your fault, and nothing about what you did would have avoided it. Reload the page to see where it got to, then make the change again."

test("a bug in the staged form preparation reaches the person as a bug, not as silence", async () => {
  const unhandled: Array<unknown> = []
  const watch = (reason: unknown) => { unhandled.push(reason) }
  process.on("unhandledRejection", watch)
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  /*
   * Everything real but the one step under test: the store, its transactional
   * storage host, the controller, the registry and the card. `stagePendingCardInput`
   * is this app's own private preparation — a throw from there is this app's bug.
   */
  const controller = createAppController(
    { ...store, stagePendingCardInput: () => { throw new TypeError("the form card is not ready") } },
    silentAgent,
    {}
  )
  controller.renderFlowForm({ name: "repo.tree", args: undefined, via: "user", input: Schema.Struct({ purpose: Schema.String }) })
  await store.settled?.()
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const render = () => {
    const card = store.collections.cards.get("form-repo.tree")! as Extract<Card, { kind: "flow-form" }>
    flushSync(() => root.render(<FlowFormCardBody card={card} onRunCommand={(name, args) => { controller.runCommand(name, args) }} />))
  }
  render()
  const subscription = store.collections.cards.subscribeChanges(() => render())
  try {
    // The person's own gesture: typing into the field fires the input event the
    // control itself listens to, which is what dispatches form.set.
    const field = host.querySelector<HTMLInputElement>("input[data-testid='flow-form-purpose']")!
    field.value = "pending words"
    field.dispatchEvent(new Event("input", { bubbles: true }))
    await new Promise(resolve => setTimeout(resolve, 200))
    const transcript = [...store.collections.messages.values()].map(message => (message as { text?: string }).text ?? "")
    const toasts = [...store.collections.toasts.values()].map(toast => (toast as { detail?: string }).detail ?? "")
    // Where they are still looking, not only on a toast that leaves.
    expect(transcript).toEqual([APP_BUG])
    expect(toasts).toEqual([APP_BUG])
    // Not a storage fault's words: a bug is not fixed by freeing space or retrying.
    expect(transcript[0]).not.toContain("This browser")
    // Not the thrown message, not an internal id.
    expect(transcript[0]).not.toContain("the form card is not ready")
    expect(transcript[0]).not.toContain("form-repo.tree")
    // The write was never reached, so nothing was accepted.
    expect(store.collections.commandIntents.size).toBe(0)
    // Nothing escaped the app: an unhandled rejection is a line only a maintainer reads.
    expect(unhandled).toEqual([])
  } finally {
    process.off("unhandledRejection", watch)
    subscription.unsubscribe()
    flushSync(() => root.unmount())
    host.remove()
    await Promise.resolve(controller.dispose()).catch(() => {})
    await Promise.resolve(store.dispose?.()).catch(() => {})
  }
})
