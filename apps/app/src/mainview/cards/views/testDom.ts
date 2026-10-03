import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { act } from "react"
import { afterEach } from "bun:test"

// Initialize the event environment before any test imports React DOM.
// Bun shares modules and globals across files in a directory run.
GlobalRegistrator.register()
Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true })
const { createRoot: createReactRoot } = await import("react-dom/client")
const roots = new Set<ReturnType<typeof createReactRoot>>()
export function createRoot(host: HTMLElement) {
  const root = createReactRoot(host)
  roots.add(root)
  const unmount = root.unmount.bind(root)
  root.unmount = () => { roots.delete(root); unmount() }
  return root
}
afterEach(() => {
  // Also release roots when an assertion interrupts a test's explicit close.
  act(() => { for (const root of roots) root.unmount() })
  document.body.replaceChildren()
  delete document.documentElement.dataset.theme
  document.getSelection()?.removeAllRanges()
})
