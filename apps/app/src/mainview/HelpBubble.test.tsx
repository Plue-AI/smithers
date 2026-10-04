import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll,afterEach,expect,spyOn,test } from "bun:test"
import { useState } from "react"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import { HelpBubble } from "./HelpBubble"

GlobalRegistrator.register()
afterAll(async () => {
  for (let tick = 0; tick < 3; tick++) await new Promise(resolve => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})
const cleanups: Array<() => void> = []
afterEach(() => { while (cleanups.length) cleanups.pop()?.() })

function mount() {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  let activations = 0
  function Example() {
    const [open, setOpen] = useState(true)
    return <HelpBubble id="example-help" open={open} content="Choose this action." onDismiss={() => setOpen(false)}>
      <button aria-describedby={open ? "example-help" : undefined} onClick={() => activations++}>Action</button>
    </HelpBubble>
  }
  flushSync(() => root.render(<Example />))
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  return { host, activations: () => activations, target: host.querySelector<HTMLButtonElement>(".help-anchor-target button")! }
}

test("floating help clears nearby actions and caps its height at the viewport edge", () => {
  const viewport = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth")
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 844 })
  cleanups.push(() => { if (viewport) Object.defineProperty(document.documentElement, "clientWidth", viewport); else Reflect.deleteProperty(document.documentElement, "clientWidth") })
  const bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [x, y, width, height] = this.matches(".help-anchor") ? [600, 340, 60, 44]
      : this.matches(".help-bubble") ? [460, 260, 340, 80]
      : this.matches("footer") ? [0, 330, 844, 60]
      : this.matches("#nearby-actions") ? [400, 274, 200, 44]
      : [0, 0, 0, 0]
    return DOMRect.fromRect({ x, y, width, height })
  })
  cleanups.push(() => bounds.mockRestore())
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => root.render(<>
    <div id="nearby-actions"><button>Review changes</button></div>
    <footer><HelpBubble id="chat-help" open placement="above" avoid="#nearby-actions"
      content="Tap Chat anytime to open Chat and commands." onDismiss={() => {}}><button>Chat</button></HelpBubble></footer>
  </>))
  const bubble = host.querySelector<HTMLElement>(".help-bubble")!
  // The footer alone needs 10px; the actions need 66px above the target.
  expect(bubble.style.bottom).toBe("calc(100% + 66px)")
  expect(parseFloat(bubble.style.maxHeight)).toBeLessThanOrEqual(274 - 16)
})

test("floating help stays inside an ancestor that clips it (#1755)", () => {
  const viewport = Object.getOwnPropertyDescriptor(document.documentElement, "clientWidth")
  Object.defineProperty(document.documentElement, "clientWidth", { configurable: true, value: 390 })
  cleanups.push(() => { if (viewport) Object.defineProperty(document.documentElement, "clientWidth", viewport); else Reflect.deleteProperty(document.documentElement, "clientWidth") })
  const bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [x, y, width, height] = this.matches(".help-anchor") ? [200, 740, 60, 44]
      : this.matches(".help-bubble") ? [0, 640, Math.min(340, parseFloat(this.style.width) || 340), 80]
      : this.matches(".shell") ? [60, 0, 330, 800]
      : this.matches("footer") ? [60, 730, 330, 60]
      : [0, 0, 0, 0]
    return DOMRect.fromRect({ x, y, width, height })
  })
  cleanups.push(() => bounds.mockRestore())
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => root.render(<div className="shell" style={{ overflowX: "hidden" }}>
    <footer><HelpBubble id="chat-help" open placement="above" content="Press Chat." onDismiss={() => {}}><button>Chat</button></HelpBubble></footer>
  </div>))
  const bubble = host.querySelector<HTMLElement>(".help-bubble")!
  const width = parseFloat(bubble.style.width)
  const left = 200 + parseFloat(bubble.style.left)
  expect(left).toBeGreaterThanOrEqual(60)
  expect(left + width).toBeLessThanOrEqual(390 - 16)
})

test("guidance does not steal focus, trap Tab, or activate its target", () => {
  const previous = document.createElement("button")
  document.body.append(previous)
  previous.focus()
  const { host, target, activations } = mount()
  expect(document.activeElement).toBe(previous)
  target.focus()
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })
  target.dispatchEvent(tab)
  expect(tab.defaultPrevented).toBe(false)
  expect(host.querySelector('[role="dialog"]')).toBeNull()
  expect(activations()).toBe(0)
  previous.remove()
})

test("dismissing from the help returns focus to the same mounted target", () => {
  const { host, target, activations } = mount()
  const dismiss = host.querySelector<HTMLButtonElement>('[aria-label="Dismiss help"]')!
  dismiss.focus()
  flushSync(() => dismiss.click())
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(host.querySelector(".help-anchor-target button")).toBe(target)
  expect(document.activeElement).toBe(target)
  expect(target.hasAttribute("aria-describedby")).toBe(false)
  expect(activations()).toBe(0)
})

test("Escape dismisses help from its target without triggering an outer action", () => {
  const { host, target, activations } = mount()
  let outerEscapes = 0
  const escaped = () => outerEscapes++
  document.addEventListener("keydown", escaped)
  cleanups.push(() => document.removeEventListener("keydown", escaped))
  target.focus()
  flushSync(() => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })))
  expect(host.querySelector('[role="note"]')).toBeNull()
  expect(document.activeElement).toBe(target)
  expect(outerEscapes).toBe(0)
  expect(activations()).toBe(0)
})

test('an unfocused guided action glows without wearing a focus outline', async () => {
  const style = document.createElement('style')
  style.textContent = await Bun.file(new URL('./HelpBubble.css', import.meta.url)).text()
  document.head.append(style)
  cleanups.push(() => style.remove())
  const { target } = mount()
  const css = getComputedStyle(target)
  expect(css.outlineStyle).not.toBe('solid')
  expect(css.boxShadow).not.toBe('')
  expect(css.boxShadow).not.toBe('none')
})

test('coarse pointers hide tutorial and repository key chips at desktop width', async () => {
  const touch = Object.getOwnPropertyDescriptor(navigator, 'maxTouchPoints')
  Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: 1 })
  cleanups.push(() => { if (touch) Object.defineProperty(navigator, 'maxTouchPoints', touch); else Reflect.deleteProperty(navigator, 'maxTouchPoints') })
  const style = document.createElement('style')
  style.textContent = await Bun.file(new URL('./SessionShell.css', import.meta.url)).text()
  document.head.append(style)
  cleanups.push(() => style.remove())
  const { ShortcutButton } = await import('./ShortcutButton')
  const host = document.createElement('div')
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => root.render(<><footer className="app-chat-controls"><ShortcutButton shortcut="⌘K">Chat</ShortcutButton></footer><div className="guide-shell"><ShortcutButton shortcut="m">Mode</ShortcutButton></div></>))
  expect(matchMedia('(pointer: coarse)').matches).toBe(true)
  const chips = host.querySelectorAll('kbd')
  expect(chips.length).toBe(2)
  for (const chip of chips) expect(getComputedStyle(chip).display).toBe('none')
})

test("floating help clamps below a nearby goal instead of drawing over it", () => {
  const bounds = spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
    const [x, y, width, height] = this.matches(".help-anchor") ? [140, 512, 60, 44]
      : this.matches(".help-bubble") ? [16, 226, 288, 100]
      : this.matches("footer") ? [0, 504, 320, 64]
      : this.matches("#nearby-actions") ? [40, 344, 240, 144]
      : this.matches("#goal") ? [20, 154, 280, 80]
      : [0, 0, 0, 0]
    return DOMRect.fromRect({ x, y, width, height })
  })
  cleanups.push(() => bounds.mockRestore())
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  cleanups.push(() => { flushSync(() => root.unmount()); host.remove() })
  flushSync(() => root.render(<>
    <div id="goal">Issue Plan Commits Change</div>
    <div id="nearby-actions"><button>Review changes</button></div>
    <footer><HelpBubble id="chat-help" open placement="above" avoid="#nearby-actions" below="#goal"
      content="Tap Chat anytime to open Chat and commands." onDismiss={() => {}}><button>Chat</button></HelpBubble></footer>
  </>))
  const bubble = host.querySelector<HTMLElement>(".help-bubble")!
  expect(bubble.style.bottom).toBe("calc(100% + 168px)")
  expect(parseFloat(bubble.style.maxHeight)).toBe(84)
})
