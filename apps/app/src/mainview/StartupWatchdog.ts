import { createStartupErrorElement, STARTUP_PAGE_BACKGROUND, startupErrorMessage } from "./StartupError"
import { presentStartupFailure, StartupTimedOut } from "./StartupFailure"
import { createClientErrorReporter } from "./state/ClientErrors"
import type { ClientErrorReporter } from "./state/ClientErrors"

export interface StartupWatchdogOptions {
  readonly timeoutMs: number
  readonly document?: Document
  readonly window?: Window
  readonly clientErrors?: ClientErrorReporter
}

export interface StartupWatchdog {
  /** The app mounted. Nothing after this renders a failure panel. */
  readonly markMounted: () => void
  /** React reported a boot failure and is rendering its own panel; stand down. */
  readonly handleRenderFailure: (error: unknown) => void
  readonly reportFailure: (error: unknown) => void
  readonly stop: () => Promise<void>
}

/**
 * Guards the failure mode where the app never mounts. This intentionally lives
 * outside React, because a React that never runs cannot report itself.
 *
 * Mounting is an explicit signal, never inferred from the DOM. Both entries
 * fill `#root` with the persistent entrance before the app exists, so
 * "is `#root` empty"
 * answers "no" from the first frame and would disable this guard entirely.
 */
export const startStartupWatchdog = (options: StartupWatchdogOptions): StartupWatchdog => {
  const documentTarget = options.document ?? document
  const windowTarget = options.window ?? window
  const clientErrors = options.clientErrors ?? createClientErrorReporter()
  let firstBootError: unknown
  let settled = false
  let panel: ReturnType<typeof createStartupErrorElement> | undefined
  let overlay: HTMLElement | undefined
  const releasePanel = (): Promise<void> => {
    const current = panel
    panel = undefined
    overlay?.remove()
    overlay = undefined
    return current?.dispose() ?? Promise.resolve()
  }
  const remember = (error: unknown): void => {
    if (firstBootError !== undefined || settled) return
    firstBootError = error
  }
  const onError = (event: ErrorEvent): void => {
    const error = event.error ?? event.message
    remember(error)
    clientErrors.report("error", error)
  }
  const onRejection = (event: PromiseRejectionEvent): void => {
    remember(event.reason)
    clientErrors.report("unhandledrejection", event.reason)
  }
  windowTarget.addEventListener("error", onError)
  windowTarget.addEventListener("unhandledrejection", onRejection)
  const markMounted = (): void => {
    settled = true
    windowTarget.clearTimeout(timer)
    void releasePanel().catch(() => console.warn("Smithers: local recovery cleanup could not finish."))
  }
  const stop = (): Promise<void> => {
    settled = true
    windowTarget.clearTimeout(timer)
    windowTarget.removeEventListener("error", onError)
    windowTarget.removeEventListener("unhandledrejection", onRejection)
    return releasePanel()
  }
  const reportFailure = (reason: unknown): void => {
    if (settled || panel !== undefined) return
    windowTarget.clearTimeout(timer)
    clientErrors.report("error", reason)
    console.error("Smithers failed to start", reason, firstBootError)
    // React still owns #root while its boot promise is pending. Replacing its
    // children strands a late successful boot on this error forever. Keep the
    // tree intact underneath a separate panel; markMounted removes the panel
    // when a slow network or storage operation finally completes.
    // The reporter above already has this failure; the panel only presents it.
    panel = createStartupErrorElement(documentTarget, {
      ...presentStartupFailure(reason),
      detail: startupErrorMessage(reason, firstBootError)
    })
    overlay = documentTarget.createElement("div")
    overlay.dataset.startupFailure = "true"
    overlay.setAttribute("style", `position: fixed; inset: 0; z-index: 2147483647; overflow: auto; background: ${STARTUP_PAGE_BACKGROUND}`)
    overlay.append(panel.element)
    documentTarget.body.append(overlay)
  }
  const timer = windowTarget.setTimeout(() => {
    reportFailure(new StartupTimedOut(options.timeoutMs))
  }, options.timeoutMs)
  return {
    markMounted,
    handleRenderFailure: (error) => {
      clientErrors.report("error", error)
      if (settled) return
      markMounted()
      console.error("Smithers failed to start", error, firstBootError)
    },
    reportFailure,
    stop
  }
}

/** Allow cold bundles and saved-state loading to settle. Boot never waits on a remote read. */
export const DEFAULT_BOOT_TIMEOUT_MS = 60_000

let browserInstance: StartupWatchdog | undefined

/**
 * The one watchdog a browser page has.
 *
 * An entry starts it and the tree it renders reports into it, so both halves
 * address the same watch. Both entries are browser-only — main.tsx's `#root`
 * render and apps/site's Astro `client:only` island — so this is only ever
 * reached with a `window` in hand.
 */
export const browserStartupWatchdog = (
  options: Partial<StartupWatchdogOptions> = {}
): StartupWatchdog => (browserInstance ??= startStartupWatchdog({ timeoutMs: DEFAULT_BOOT_TIMEOUT_MS, ...options }))
