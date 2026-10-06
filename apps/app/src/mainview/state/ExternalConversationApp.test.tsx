import type { StartAgentTurnRequest } from "@smthrs/rpc/NativeAgent"
import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import App from "../App"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppStore } from "./AppStore"
import { scopedControllers } from "./ControllerTestScope"
import { memoryStorage, settled, silentAgent, waitFor, writeLegacyCollection } from "./TestFixtures"
import fixtures from "./testdata/external-conversations.json"
import { MessageSchema } from "./AppState"

GlobalRegistrator.register()
const createController = scopedControllers()
const cleanups: Array<() => void> = []
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup() })
afterAll(async () => { await settled(); await GlobalRegistrator.unregister() })
const mount = (controller: ReturnType<typeof createController>) => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  flushSync(() => root.render(<ControllerTestProvider controller={controller}><App /></ControllerTestProvider>))
  const remove = () => { flushSync(() => root.unmount()); host.remove() }
  cleanups.push(remove)
  return { host, remove }
}

test("mounted conversation preserves external attribution, ordering and copy across durable reload", async () => {
  const storage = memoryStorage()
  writeLegacyCollection(storage, "app-messages", fixtures.map(row => MessageSchema.parse(row)))
  let copied = ""
  const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard")
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: async (text: string) => { copied = text } } })
  cleanups.push(() => { if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard); else delete (navigator as { clipboard?: Clipboard }).clipboard })
  let starts = 0
  let lastRequest = ""
  const agent = { ...silentAgent, startTurn: async (request: StartAgentTurnRequest) => { starts++; lastRequest = JSON.stringify(request); return { status: "started" as const } } }
  const store = await createAppStore({ kind: "localStorage", storage })
  const controller = createController(store, agent)
  const { host, remove } = mount(controller)
  const imported = [...host.querySelectorAll<HTMLElement>('article[data-origin="external"]')]
  expect(imported).toHaveLength(4)
  expect(imported[0]?.textContent).toContain("Ben")
  expect(imported[1]?.textContent).toContain("Claude Code for Ben")
  expect(imported[2]?.textContent).toContain("Tests failed")
  expect(imported[3]?.textContent).toContain("Codex for Ben")
  expect(imported.map(row => row.dataset.participantId)).toEqual([
    "participant-claude", "participant-claude", "participant-claude", "participant-codex"
  ])
  for (const row of imported) {
    expect([...row.querySelectorAll("button")].map(button => button.dataset.flow)).toEqual(["chat.copy-message"])
    expect(row.querySelector('a[href^="javascript:"]')).toBeNull()
  }
  flushSync(() => imported[1]!.querySelector<HTMLButtonElement>("button")!.click())
  await waitFor(() => copied !== "")
  expect(copied).toBe("pnpm test webhooks")
  expect(starts).toBe(0)
  const retry = await controller.commands.run("chat.retry")
  expect(retry.status).not.toBe("executed")
  expect(starts).toBe(0)
  expect(store.session().queuedPrompts ?? []).toHaveLength(0)
  // Persist a normal shared transition, then reload through the actual storage seam.
  await store.dispatch({ type: "theme.changed", actor: "user", theme: "dark" }).isPersisted.promise
  remove()
  cleanups.pop()
  await controller.dispose()
  await store.dispose?.()
  const restored = await createAppStore({ kind: "localStorage", storage })
  const next = createController(restored, agent)
  const reloadedMount = mount(next)
  const reloaded = reloadedMount.host
  expect(reloaded.querySelectorAll('article[data-origin="external"]')).toHaveLength(4)
  expect([...restored.collections.messages.values()].filter(row => row.origin === "external").sort((a, b) => a.ordinal - b.ordinal).map(row => row.source_id)).toEqual([
    "claude-1", "claude-2", "claude-3", "codex-1"
  ])
  expect(restored.collections.messages.get("external-claude-tool")?.correlation_id).toBe("tool-1")
  expect(restored.collections.messages.get("external-claude-error")?.correlation_id).toBe("tool-1")
  await next.commands.submit({ name: "chat.send", payload: { text: "Hello Smithers" }, actor: "user" })
  await waitFor(() => starts === 1)
  expect(starts).toBe(1)
  expect(lastRequest).not.toContain("Run the webhook tests")
  expect(lastRequest).not.toContain("malicious")
  expect([...restored.collections.messages.values()].filter(row => row.role === "user" && row.origin !== "external" && row.text === "Hello Smithers")).toHaveLength(1)
  reloadedMount.remove()
  cleanups.pop()
  await next.dispose()
  await restored.dispose?.()
})
