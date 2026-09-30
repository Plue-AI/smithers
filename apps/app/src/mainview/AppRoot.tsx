import { StartupErrorPanel } from "./StartupError"
import { subscribeStorageFailure, storageFailure } from "./state/StorageFailure"
import { ViewSkeleton } from "./ViewSkeleton"
import { lazy, StrictMode, Suspense, useSyncExternalStore } from "react"
import type { ComponentType, ReactNode } from "react"
import { prepareControllerBoot, ControllerProvider } from "./ControllerProvider"
import { useController } from "./ControllerContext"
import { SessionNavigation, SessionNavigationFallback } from "./SessionNavigation"
import { SessionShell } from "./SessionShell"
import { MountedSignal, StartupErrorBoundary } from "./StartupBoundary"
import type { StartupWatchdog } from "./StartupWatchdog"
import "@fontsource/inter/400.css"
import "@fontsource/inter/500.css"
import "@fontsource/inter/600.css"
import "@fontsource/ibm-plex-mono/400.css"
import "@fontsource/ibm-plex-mono/500.css"
import "./index.css"

/*
 * The whole tree, without a watchdog of its own. AppIsland.tsx arms one at
 * module scope; AppMount.tsx arms one when it mounts, so the home page can
 * import this module ahead of time without starting the boot clock.
 */

// Fetch the view while the controller opens SQLite, before its provider suspends.
const appModule = import("./App")
let preparedViews: typeof import("./App") | undefined
void appModule.then(views => { preparedViews = views }, () => {})
// React's lazy boundary owns the error even if the download fails before render.
void appModule.catch(() => {})

const RepoApp = lazy(() => appModule.then(({ default: App }) => ({ default: App })))

export function AppContent({ children }: { readonly children: ReactNode }) {
  const controller = useController()
  if (controller.store.savedStoreUnavailable) return <main style={{ maxWidth: "36rem", margin: "3rem auto", padding: "1.5rem" }}>
    <div role="alert"><h1>Storage unavailable</h1></div>
    <button type="button" onClick={() => window.location.reload()}>Reload</button>
  </main>
  return children
}

/** The recovered-store gate wraps the interactive content; the navigation strip stands down with it. */
export function AppReady({ View, onMounted }: { readonly View: ComponentType; readonly onMounted: () => void }) {
  return <>
    <MountedSignal onMounted={onMounted} />
    <AppContent><View /></AppContent>
  </>
}

function AppNavigation() {
  return useController().store.savedStoreUnavailable ? null : <SessionNavigation />
}

export function AppRoot({
  watchdog
}: {
  readonly watchdog: Pick<StartupWatchdog, "markMounted" | "handleRenderFailure">
}) {
  const View = preparedViews?.default ?? RepoApp
  const failure = useSyncExternalStore(subscribeStorageFailure, storageFailure, storageFailure)
  if (failure !== undefined) return <StartupErrorPanel reason={failure} />
  const boot = prepareControllerBoot({})
  return (
    <StrictMode>
      <StartupErrorBoundary onError={watchdog.handleRenderFailure}>
        {/* One shell for the page's life: a late boot fills it in place instead of replacing it. */}
        <SessionShell navigation={<Suspense fallback={<SessionNavigationFallback />}><ControllerProvider boot={boot}><AppNavigation /></ControllerProvider></Suspense>}>
          <Suspense fallback={<ViewSkeleton />}>
            <ControllerProvider boot={boot}>
              <AppReady View={View} onMounted={watchdog.markMounted} />
            </ControllerProvider>
          </Suspense>
        </SessionShell>
      </StartupErrorBoundary>
    </StrictMode>
  )
}
