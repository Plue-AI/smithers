import { GlobalRegistrator } from "@happy-dom/global-registrator"
import { afterAll, afterEach, beforeEach, describe, expect, jest, spyOn, test } from "bun:test"
import { startStartupWatchdog } from "./StartupWatchdog"
import type { ClientErrorKind, ClientErrorReporter } from "./state/ClientErrors"

GlobalRegistrator.register()

afterAll(async () => {
  await GlobalRegistrator.unregister()
})

beforeEach(() => {
  document.body.innerHTML = "<div id=\"root\"></div>"
  jest.useFakeTimers()
})

afterEach(() => {
  jest.useRealTimers()
  document.body.textContent = ""
})

const reporter = (): {
  readonly reports: Array<readonly [ClientErrorKind, unknown]>
  readonly value: ClientErrorReporter
} => {
  const reports: Array<readonly [ClientErrorKind, unknown]> = []
  return {
    reports,
    value: {
      report: (kind, error) => void reports.push([kind, error]),
      reported: () => reports.length
    }
  }
}

const rootText = (): string => document.getElementById("root")?.textContent ?? ""
const failureText = (): string => document.querySelector("[data-startup-failure]")?.textContent ?? ""

describe("the startup watchdog outside React", () => {
  test("uses its configured timeout and renders a visible failure when nothing mounts", () => {
    const errors = reporter()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const watchdog = startStartupWatchdog({ timeoutMs: 73, clientErrors: errors.value })
    jest.advanceTimersByTime(72)
    expect(rootText()).toBe("")
    jest.advanceTimersByTime(1)
    expect(failureText()).toContain("Smithers is taking too long to start.")
    expect(failureText()).toContain("within 73ms")
    expect(errors.reports).toHaveLength(1)
    watchdog.stop()
    consoleError.mockRestore()
  })

  /*
   * The defect this pins: the watchdog used to infer "nothing mounted" from an
   * empty `#root`. Both entries fill `#root` before the app exists — the SPA
   * renders a Suspense fallback into it, the server renders the session shell
   * into it — so that inference answered "mounted" from the first frame and
   * disabled the guard completely.
   */
  test("still fires when a fallback shell filled the root but the app never mounted", () => {
    const errors = reporter()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const shell = document.createElement("div")
    shell.textContent = "Smithers is starting your session."
    document.getElementById("root")?.append(shell)
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    jest.advanceTimersByTime(10)
    expect(failureText()).toContain("Smithers is taking too long to start.")
    expect(rootText()).toBe("Smithers is starting your session.")
    watchdog.stop()
    consoleError.mockRestore()
  })

  test("reports both browser error channels and never clobbers an app that mounted", () => {
    const errors = reporter()
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("first") }))
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "second" }))
    watchdog.markMounted()
    const app = document.createElement("main")
    app.textContent = "the app"
    document.getElementById("root")?.append(app)
    jest.advanceTimersByTime(10)
    expect(errors.reports.map(([kind]) => kind)).toEqual(["error", "unhandledrejection"])
    expect(rootText()).toBe("the app")
    watchdog.stop()
  })

  test("keeps runtime and render error reporting after mount without triggering the boot panel", () => {
    const errors = reporter()
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    watchdog.markMounted()
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("after mount") }))
    window.dispatchEvent(Object.assign(new Event("unhandledrejection"), { reason: "after mount" }))
    watchdog.handleRenderFailure(new Error("render after mount"))
    jest.advanceTimersByTime(10)
    expect(errors.reports.map(([kind]) => kind)).toEqual(["error", "unhandledrejection", "error"])
    expect(rootText()).toBe("")
    watchdog.stop()
  })

  test("carries the earliest blank-page error as context for the failure it renders", () => {
    const errors = reporter()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    window.dispatchEvent(new ErrorEvent("error", { error: new Error("opfs worker died") }))
    jest.advanceTimersByTime(10)
    expect(failureText()).toContain("opfs worker died")
    expect(failureText()).toContain("Earliest error while the page was blank")
    watchdog.stop()
    consoleError.mockRestore()
  })

  test("a boot that finishes after the timeout keeps its mount point and dismisses the error", async () => {
    const errors = reporter()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const shell = document.createElement("main")
    shell.textContent = "Loading"
    document.getElementById("root")!.append(shell)
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    jest.advanceTimersByTime(10)
    expect(failureText()).toContain("Smithers is taking too long to start.")
    expect(shell.parentElement).toBe(document.getElementById("root"))
    shell.textContent = "The app is ready"
    watchdog.markMounted()
    expect(failureText()).toBe("")
    expect(rootText()).toBe("The app is ready")
    watchdog.reportFailure(new Error("a late timeout"))
    expect(failureText()).toBe("")
    await watchdog.stop()
    consoleError.mockRestore()
  })

  /*
   * React renders its own panel through StartupErrorBoundary, so the watchdog
   * stands down rather than wiping the root out from under it.
   */
  test("stands down once React has reported a boot failure", () => {
    const errors = reporter()
    const consoleError = spyOn(console, "error").mockImplementation(() => {})
    const watchdog = startStartupWatchdog({ timeoutMs: 10, clientErrors: errors.value })
    watchdog.handleRenderFailure(new Error("boot rejected"))
    const panel = document.createElement("main")
    panel.textContent = "Smithers failed to start"
    document.getElementById("root")?.append(panel)
    jest.advanceTimersByTime(10)
    expect(document.getElementById("root")?.querySelectorAll("main").length).toBe(1)
    expect(errors.reports.map(([kind]) => kind)).toEqual(["error"])
    watchdog.stop()
    consoleError.mockRestore()
  })
})
