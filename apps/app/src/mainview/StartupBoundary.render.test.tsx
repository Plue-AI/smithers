import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"

GlobalRegistrator.register()
const roots = new Set<Root>()

afterAll(async () => {
  // React's scheduler finishes a commit in a task of its own; unregistering the
  // DOM before it runs takes `window` away mid-flight.
  await new Promise((resolve) => setTimeout(resolve, 0))
  await GlobalRegistrator.unregister()
})

afterEach(() => {
  flushSync(() => {
    for (const root of roots) root.unmount()
  })
  roots.clear()
  document.body.textContent = ""
})

const mount = (children: React.ReactNode): void => {
  const host = document.createElement("div")
  document.body.append(host)
  const root = createRoot(host)
  roots.add(root)
  flushSync(() => root.render(children))
}

const withExpectedReactError = (run: () => void): void => {
  const original = console.error
  console.error = () => {}
  try {
    run()
  } finally {
    console.error = original
  }
}

/*
 * Stands in for `use(bootPromise)`: a rejected boot is delivered to the
 * boundary as a throw from the child's render, which is the only thing the
 * boundary itself can observe.
 */
const Throws = ({ error }: { readonly error: Error }) => {
  throw error
}

describe("the startup error boundary", () => {
  /*
   * The defect this pins: apps/app had no error boundary at all, so a rejected
   * boot thrown by `use()` tore the tree down and left a blank page with no
   * message — the exact failure the startup watchdog exists to report.
   */
  test("renders the startup panel and reports the failure", () => {
    let reported: unknown
    withExpectedReactError(() =>
      mount(
        <StartupErrorBoundary onError={(error) => void (reported = error)}>
          <Throws error={new Error("create app store: opfs unavailable")} />
        </StartupErrorBoundary>
      )
    )
    expect(document.querySelector("h1")?.textContent).toBe("Smithers could not start. Not your fault.")
    // The raw text is kept, behind the collapsed Details only.
    expect(document.querySelector("details:not([open]) pre")?.textContent).toContain("opfs unavailable")
    expect(reported).toBeInstanceOf(Error)
  })

  test("renders children untouched when nothing throws", () => {
    mount(
      <StartupErrorBoundary onError={() => {}}>
        <p>the app</p>
      </StartupErrorBoundary>
    )
    expect(document.body.textContent).toBe("the app")
  })
})

describe("the mounted signal", () => {
  test("reports the mount and renders nothing itself", () => {
    let mounted = 0
    mount(
      <StartupErrorBoundary onError={() => {}}>
        <MountedSignal onMounted={() => void (mounted += 1)} />
        <p>the app</p>
      </StartupErrorBoundary>
    )
    expect(mounted).toBe(1)
    expect(document.body.textContent).toBe("the app")
  })

  test("never reports a mount when the tree it sits in fails first", () => {
    let mounted = 0
    withExpectedReactError(() =>
      mount(
        <StartupErrorBoundary onError={() => {}}>
          <MountedSignal onMounted={() => void (mounted += 1)} />
          <Throws error={new Error("boot rejected")} />
        </StartupErrorBoundary>
      )
    )
    expect(mounted).toBe(0)
    expect(document.body.textContent).toContain("Smithers could not start. Not your fault.")
  })
})
