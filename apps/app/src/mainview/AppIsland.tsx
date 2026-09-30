import { configureControllerBoot } from "./ControllerProvider"
import { AppRoot } from "./AppRoot"
import { mountApp, warmApp } from "./AppMount"
import { browserStartupWatchdog } from "./StartupWatchdog"
import { runtimeClientErrorFetch } from "./runtime/ApplicationTransport"
import { createClientErrorReporter } from "./state/ClientErrors"

/*
 * The whole app as one React component, so every host mounts the same tree:
 * main.tsx renders it into `#root` for the Vite build the local origin and the
 * Electrobun shell serve, and the smithers.sh site renders it as a
 * `client:only` island at `/owner/name`. The startup watchdog is armed by
 * the first render, which both hosts run in the same task that evaluates
 * this module, not by the import: the smithers.sh home page imports this
 * chunk ahead of time for `mountApp` (AppMount.tsx), which mounts the same
 * AppRoot into a page that is already showing and arms the watchdog then.
 *
 * A repository path (`/owner/name`) opens that repository alone; the
 * homepage and `?tutorial` entries open the same app.
 */

let clientErrors: ReturnType<typeof createClientErrorReporter> | undefined

function AppIsland() {
  // One watchdog per page (browserStartupWatchdog is a singleton), so a re-render re-reads it.
  clientErrors ??= createClientErrorReporter({ fetchImpl: runtimeClientErrorFetch })
  configureControllerBoot({ clientErrors })
  const watchdog = browserStartupWatchdog({ clientErrors })
  return <AppRoot watchdog={watchdog} />
}

/*
 * `mountApp` rides on the component itself: Astro's island entry re-exports
 * only `default`, so a named export would not survive into the chunk the
 * home page imports.
 */
export default Object.assign(AppIsland, { mountApp, warmApp })
