import { flushSync } from "react-dom"
import { createRoot } from "react-dom/client"
import type { Root } from "react-dom/client"
import { AppRoot } from "./AppRoot"
import { configureControllerBoot } from "./ControllerProvider"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { loadRuntimeApplicationClient, runtimeClientErrorFetch } from "./runtime/ApplicationTransport"
import { warmBootstrap } from "./runtime/Runtime"
import { createClientErrorReporter } from "./state/ClientErrors"

/*
 * Mount the app into a page that is already showing something else: the
 * smithers.sh home page imports this module after its `load` event and calls
 * `mountApp` on Get started for free, so the app arrives in the same document without a
 * navigation. Importing arms nothing; warmApp only fetches bootstrap, and
 * mountApp starts boot and arms the startup watchdog when the shell mounts.
 */

export interface MountAppOptions {
  /** Keep the address bar on the current URL instead of frame paths (runtime/FrameHistory.ts). */
  readonly keepUrl?: boolean
}

export interface MountedApp {
  readonly unmount: () => void
  /** The app's single entrance wordmark inside `container`, read right after the synchronous render. */
  readonly mark: HTMLElement | null
}

/** Warm only the GET; homepage preloading must not create saved app state. */
export const warmApp = () => loadRuntimeApplicationClient().then((client) => warmBootstrap(client.fetch))

/*
 * The app owns the lookup of its own mark so a caller (the home page's view
 * transition) never guesses the app's DOM: since the "one global logo"
 * refactor the mark lives in SessionNavigation's header
 * (.session-shell > .session-navigation > .guide-wordmark).
 */
export const appWordmark = (container: HTMLElement): HTMLElement | null =>
  container.querySelector<HTMLElement>(".session-shell > .session-navigation > .guide-wordmark")

/**
 * The appearance the app paints with: the stored theme and palette, else the
 * viewer's scheme. The same reading apps/site's AppShell.astro and
 * mainview/index.html run inline before first paint.
 */
export const applyAppearance = (root: HTMLElement = document.documentElement): void => {
  let theme: string | null = null
  let palette: string | null = null
  try {
    theme = window.localStorage.getItem("smithers-mvp.theme")
    palette = window.localStorage.getItem("smithers-mvp.palette")
  } catch {
    // A refused storage is not a reason to paint nothing: the scheme decides.
  }
  if (theme !== "light" && theme !== "dark") {
    theme = window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light"
  }
  root.setAttribute("data-theme", theme)
  if (typeof palette === "string" && /^[a-z][a-z-]*$/.test(palette)) root.setAttribute("data-palette", palette)
}

/** Unsubscribe React live queries before the pagehide owner closes their collections. */
export const unmountOnPageHide = (root: Root, page: Window = window): (() => void) => {
  const unmount = () => {
    page.removeEventListener("pagehide", unmount)
    flushSync(() => root.unmount())
  }
  page.addEventListener("pagehide", unmount)
  return unmount
}

/**
 * Render the app into `container` synchronously: the entrance wordmark
 * (SessionNavigationFallback) is in the DOM when this returns, so a caller's
 * view transition can capture it. Mount first; boot fills in the controls
 * while the shell and body Suspense fallbacks keep the app visible.
 */
export function mountApp(container: HTMLElement, options: MountAppOptions): MountedApp {
  applyAppearance()
  const clientErrors = createClientErrorReporter({ fetchImpl: runtimeClientErrorFetch })
  configureControllerBoot({ keepUrl: options.keepUrl === true, clientErrors })
  const watchdog = browserStartupWatchdog({ clientErrors })
  const root = createRoot(container)
  // Register before boot: ControllerBoot's pagehide handler disposes the store.
  const unmount = unmountOnPageHide(root)
  flushSync(() => root.render(<AppRoot watchdog={watchdog} />))
  return { unmount, mark: appWordmark(container) }
}
