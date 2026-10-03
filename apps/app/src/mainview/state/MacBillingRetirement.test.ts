import { expect, test } from "bun:test"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, silentAgent, waitFor } from "./TestFixtures"
import { createWebAgent } from "../native/WebAgent"
import { namespacesOf } from "../flows/registry"

const createAppController = scopedControllers()
const bootstrap = { apiVersion: 1, version: "test", buildSha: "test", host: "cloud", capabilities: ["identity", "agent", "cloud"], authFlow: "credentials", sandbox: null } as const

test("the Mac install has no billing palette namespace, flow, or producer", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const calls: string[] = []
  const controller = createAppController(store, silentAgent, { bootstrap: { ...bootstrap, capabilities: [...bootstrap.capabilities] },
    fetchImpl: async path => { calls.push(String(path)); return Response.json({}, { status: 404 }) } })
  expect(controller.commands.all().filter(command => command.name.startsWith("billing."))).toEqual([])
  expect(namespacesOf(controller.commands.all()).map(namespace => namespace.id)).not.toContain("billing")
  expect(await controller.showBalance()).toBe("Balance is unavailable on this host.")
  expect(await controller.showBillingPlans()).toBe("Plans are unavailable on this host.")
  expect(await controller.startCheckout()).toBeUndefined()
  expect(await controller.openBillingPortal()).toBe("The billing portal is unavailable on this host.")
  expect(calls.filter(path => path.includes('/billing'))).toEqual([])
  expect([...store.collections.cards.values()].filter(card => ['balance', 'billing-plans', 'grant-confirm'].includes(card.kind))).toEqual([])
})

test("a credit-exhausted HTTP turn on the Mac install states the typed failure with no plans card", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const agent = createWebAgent({ fetchImpl: async () => Response.json({ code: "out_of_credit", message: "Model credit spent." }, { status: 402 }) })
  const controller = createAppController(store, agent, { bootstrap: { ...bootstrap, capabilities: [...bootstrap.capabilities] },
    fetchImpl: async () => Response.json({}, { status: 404 }) })
  await store.dispatch({ type: "identity.session.loaded", actor: "system", state: "signed-in", login: "will", admin: false, scopesPlain: null }).isPersisted.promise
  await controller.send("Hello")
  await waitFor(() => store.session().phase === "idle")
  expect([...store.collections.messages.values()].map(message => message.text)).toContain("I couldn't complete that turn. Out of credit.")
  expect([...store.collections.cards.values()].some(card => ['balance', 'billing-plans', 'grant-confirm'].includes(card.kind))).toBe(false)
})
