import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, expect, test } from "bun:test"
import { act } from "react"
import { createRoot, type Root } from "react-dom/client"
import { ControllerTestProvider } from "./ControllerContext"
import { createAppController, type AppController } from "./state/AppController"
import { createAppStore } from "./state/AppStore"
import { memoryStorage, silentAgent } from "./state/TestFixtures"
import { TranscriptMessage } from "./TranscriptMessage"

GlobalRegistrator.register()
const reactEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
const previousActEnvironment = reactEnvironment.IS_REACT_ACT_ENVIRONMENT
reactEnvironment.IS_REACT_ACT_ENVIRONMENT = true
const clipboardDescriptor = Object.getOwnPropertyDescriptor(navigator, "clipboard")
const roots = new Set<Root>()
const controllers = new Set<AppController>()

afterEach(async () => {
  act(() => { for (const root of roots) root.unmount() })
  roots.clear()
  document.body.textContent = ""
  for (const controller of controllers) await controller.dispose()
  controllers.clear()
  if (clipboardDescriptor === undefined) delete (navigator as { clipboard?: Clipboard }).clipboard
  else Object.defineProperty(navigator, "clipboard", clipboardDescriptor)
})

afterAll(async () => {
  for (let tick = 0; tick < 3; tick += 1) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
  reactEnvironment.IS_REACT_ACT_ENVIRONMENT = previousActEnvironment
})

const setClipboard = (clipboard: Pick<Clipboard, "writeText"> | undefined): void => {
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: clipboard })
}

const mount = async () => {
  const store = await createAppStore({ kind: "localStorage", storage: memoryStorage() })
  const controller = createAppController(store, silentAgent)
  controllers.add(controller)
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  act(() => root.render(
    <ControllerTestProvider controller={controller}>
      <TranscriptMessage entry={{ kind: "message", message: {
        id: "copy-test", role: "smithers", text: "A message to copy", status: "complete", createdAt: 1, ordinal: 1
      } }} />
    </ControllerTestProvider>
  ))
  return { button: host.querySelector<HTMLButtonElement>('[data-flow="chat.copy-message"]')!, store }
}

const settle = async (): Promise<void> => {
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
}

test("Copy message stays unchanged when the clipboard is unavailable", async () => {
  setClipboard(undefined)
  const { button, store } = await mount()
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  act(() => button.click())
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  await settle()
  expect([...store.collections.toasts.values()].some(toast => toast.status === "failed" && toast.detail.includes("clipboard"))).toBe(true)
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  expect(button.title).toBe("Copy message")
  expect(button.textContent).not.toContain("Copied")
})

test("Copy message shows Copied only after the clipboard write succeeds", async () => {
  let finishWrite!: () => void
  let writtenText = ""
  setClipboard({ writeText: text => {
    writtenText = text
    return new Promise<void>(resolve => { finishWrite = resolve })
  } })
  const { button } = await mount()
  act(() => button.click())
  await settle()
  expect(writtenText).toBe("A message to copy")
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  await act(async () => { finishWrite(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button.getAttribute("aria-label")).toBe("Copied")
  expect(button.title).toBe("Copied")
  expect(button.textContent).toContain("Copied")
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 1250)) })
  expect(button.getAttribute("aria-label")).toBe("Copy message")
})

test("Copy message stays unchanged when the browser refuses the write", async () => {
  setClipboard({ writeText: async () => { throw Object.assign(new Error("permission denied"), { name: "NotAllowedError" }) } })
  const { button, store } = await mount()
  act(() => button.click())
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  await settle()
  expect([...store.collections.toasts.values()].some(toast => toast.status === "failed" && toast.detail.includes("refused the clipboard"))).toBe(true)
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  expect(button.textContent).not.toContain("Copied")
})

test("an older clipboard result cannot confirm a newer pending copy", async () => {
  const writes: Array<() => void> = []
  setClipboard({ writeText: () => new Promise<void>(resolve => { writes.push(resolve) }) })
  const { button } = await mount()
  act(() => button.click())
  await settle()
  act(() => button.click())
  await settle()
  expect(writes).toHaveLength(2)
  await act(async () => { writes[0]!(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button.getAttribute("aria-label")).toBe("Copy message")
  await act(async () => { writes[1]!(); await new Promise(resolve => setTimeout(resolve, 0)) })
  expect(button.getAttribute("aria-label")).toBe("Copied")
})

test("an older confirmation timer cannot clear a newer confirmation", async () => {
  const resetCallbacks: Array<() => void> = []
  const originalSetTimeout = window.setTimeout
  window.setTimeout = ((handler: TimerHandler, timeout?: number, ...args: unknown[]) => {
    if (timeout === 1200 && typeof handler === "function") {
      resetCallbacks.push(() => handler(...args))
      return 0
    }
    return originalSetTimeout(handler, timeout, ...args)
  }) as typeof window.setTimeout
  try {
    setClipboard({ writeText: async () => {} })
    const { button } = await mount()
    act(() => button.click())
    await settle()
    expect(button.getAttribute("aria-label")).toBe("Copied")
    act(() => button.click())
    await settle()
    expect(resetCallbacks).toHaveLength(2)
    act(() => resetCallbacks[0]!())
    expect(button.getAttribute("aria-label")).toBe("Copied")
    act(() => resetCallbacks[1]!())
    expect(button.getAttribute("aria-label")).toBe("Copy message")
  } finally {
    window.setTimeout = originalSetTimeout
  }
})
