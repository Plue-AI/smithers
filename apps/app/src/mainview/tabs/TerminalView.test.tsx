import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, expect, test } from "bun:test"
import { createRoot } from "react-dom/client"
import { flushSync } from "react-dom"
import { ControllerTestProvider } from "../ControllerContext"
import { createAppController } from "../state/AppController"
import { createAppStore } from "../state/AppStore"
import { memoryStorage, settle, unavailableAgent } from "../state/TestFixtures"
import { TerminalView } from "./TerminalView"

GlobalRegistrator.register()
afterAll(async () => { await settle(); await GlobalRegistrator.unregister() })

test("replacing a terminal session detaches the old stream and attaches the new session", async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, unavailableAgent)
  const calls: string[] = []
  const sizes: Array<{ sessionId: string; cols: number; rows: number }> = []
  const originalResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(private readonly notify: ResizeObserverCallback) {}
    observe() { this.notify([], this as unknown as ResizeObserver) }
    unobserve() {}
    disconnect() {}
  } as typeof ResizeObserver
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  const testController = { ...controller, cloudTerminal: { ...controller.cloudTerminal,
    attach: (_repo: string, sessionId: string) => { calls.push(`attach ${sessionId}`); return () => { calls.push(`detach ${sessionId}`) } },
    resize: (sessionId: string, cols: number, rows: number) => { sizes.push({ sessionId, cols, rows }) }
  } }
  const render = (sessionId: string) => flushSync(() => root.render(
    <ControllerTestProvider controller={testController}>
      <TerminalView repo="reader/project" sessionId={sessionId} />
    </ControllerTestProvider>
  ))
  const until = async (count: number) => {
    for (let attempt = 0; calls.length < count && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10))
  }
  try {
    render("first"); await until(1)
    expect(calls).toEqual(["attach first"])
    render("second"); await until(3)
    expect(calls).toEqual(["attach first", "detach first", "attach second"])
    expect(sizes).toHaveLength(2)
    expect(sizes[1]).toEqual({ ...sizes[0]!, sessionId: "second" })
    render("second"); await settle()
    expect(calls).toHaveLength(3)
  } finally {
    flushSync(() => root.unmount()); host.remove(); await controller.dispose()
    globalThis.ResizeObserver = originalResizeObserver
  }
  expect(calls.at(-1)).toBe("detach second")
})
