import "../../src/mainview/index.css"
import { resolveApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { createApplicationClient } from "../../src/mainview/runtime/ApplicationClient"
import { useCallback, useSyncExternalStore } from "react"
import { createRoot } from "react-dom/client"
import { HomeCardSchema } from "@smthrs/rpc/HomeCard"
import { projectHome } from "../../src/mainview/runtime/HomeProjection"
import { LiveChannel } from "../../src/mainview/runtime/LiveChannel"
import { HomeView } from "../../src/mainview/cards/views/HomeView"
import { SettingsView } from "../../src/mainview/cards/views/SettingsView"
import { SettingsContainer } from "../../src/mainview/cards/SettingsContainer"
import { createAppStore } from "../../src/mainview/state/AppStore"
import { createAppController } from "../../src/mainview/state/AppController"
import { silentAgent, applicationIdentityFromFetch } from "../../src/mainview/state/TestFixtures"

// Mounted production readers, cardActions and dispatcher over the composed API.
// No DesignWorld data or intercepted HTTP/live frames supply these cards.
const http = createApplicationClient(resolveApplicationTarget({ apiVersion: 1, mode: "web-selfhost", apiOrigin: "", auth: { kind: "session" }, cors: "same-origin", developerExternal: false }, location.origin)).fetch
const store = await createAppStore({ kind: "localStorage", storage: localStorage })
const controller = createAppController(store, silentAgent, {
  baseUrl: location.origin, fetchImpl: http,
  applicationIdentity: applicationIdentityFromFetch(http, location.origin),
  bootstrap: { apiVersion: 1, host: "cloud", version: "test", buildSha: "test", authFlow: "redirect", sandbox: null, capabilities: ["identity", "install"] }
})
await controller.showSettings()
const live = new LiveChannel()
live.registerProjection("home", projectHome)
const actions = { actions: [], gestures: {}, view: { maximized: false }, onAction() {}, onView() {} }
function Mount() {
  const home = useSyncExternalStore(
    useCallback((notify: () => void) => live.subscribe("home", notify), []),
    useCallback(() => live.getSnapshot("home"), [])
  )
  const model = HomeCardSchema.safeParse(home?.data)
  return <>{model.success && <HomeView {...actions} model={model.data} />}
    <SettingsContainer View={SettingsView} install={controller.installSnapshots} owner origin={location.origin}
      view={{ maximized: false }} onView={() => {}}
      dispatch={(name, payload, gesture) => controller.commands.submit({ name, payload: (payload ?? {}) as Record<string, unknown>, actor: "user", gesture })} />
  </>
}
createRoot(document.getElementById("root")!).render(<Mount />)
Object.assign(window, { parallelAdmission: {
  cursor: () => live.getSnapshot("home")?.cursor,
  effective: () => (live.getSnapshot("home")?.data as { parallel?: number } | undefined)?.parallel,
  seeded: () => controller.installSnapshots.get().seed !== undefined
} })
