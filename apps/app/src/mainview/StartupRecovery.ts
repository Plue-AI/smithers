import { createRecoveryDownload } from "./state/BrowserStorageRecovery"
import { createStorageRecoveryAction } from "./state/StorageRecoveryAction"
import type { StorageRecoveryHost } from "./state/StorageRecoveryAction"
import { applyFlow } from "./flows/FlowAction"
import {
  RECOVERY_DOWNLOAD_LABEL,
  RECOVERY_PRIVATE_WARNING,
  RECOVERY_RESET_CONFIRM_LABEL,
  RECOVERY_RESET_LABEL,
  STORAGE_RECOVERY_EXPORT,
  STORAGE_RECOVERY_RESET
} from "./state/StorageRecoveryContract"

/** Which recovery doors a failure offers; each one is a `UserFailureAction`. */
export interface StartupRecoveryDoors {
  readonly download: boolean
  readonly reset: boolean
}

const BOTH_DOORS: StartupRecoveryDoors = { download: true, reset: true }

/** A non-React projection: the watchdog must also work when React never boots. */
export const createStartupRecovery = (
  documentTarget: Document,
  host?: StorageRecoveryHost,
  loadFlow: () => Promise<typeof import("./flows/StorageRecoveryFlow")> = () => import("./flows/StorageRecoveryFlow"),
  doors: StartupRecoveryDoors = BOTH_DOORS
) => {
  let download: ReturnType<typeof createRecoveryDownload> | undefined
  const action = createStorageRecoveryAction(
    host ?? {
      read: async () => (await import("./state/AppStore")).readUnopenedBrowserRecovery(),
      download: (json) => (download ??= createRecoveryDownload(documentTarget)).download(json),
      reset: async () => (await import("./state/AppStore")).resetLocalBrowserStorage()
    },
    "user"
  )
  const element = documentTarget.createElement("section")
  const warning = documentTarget.createElement("p")
  warning.textContent = RECOVERY_PRIVATE_WARNING
  const button = documentTarget.createElement("button")
  button.type = "button"
  applyFlow(button, STORAGE_RECOVERY_EXPORT)
  /*
   * The second door out of a failed boot. A profile too large to load could
   * only ever download itself; now it can also start over, without the human
   * leaving the app to delete OPFS files from a different page.
   */
  const reset = documentTarget.createElement("button")
  reset.type = "button"
  applyFlow(reset, STORAGE_RECOVERY_RESET)
  const status = documentTarget.createElement("p")
  status.setAttribute("role", "status")
  status.setAttribute("aria-live", "polite")
  const resetStatus = documentTarget.createElement("p")
  resetStatus.setAttribute("role", "status")
  resetStatus.setAttribute("aria-live", "polite")
  const render = (): void => {
    const row = action.state.get("recovery")
    button.disabled = row?.phase === "preparing"
    button.textContent = row?.phase === "preparing" ? "Preparing recovery file…" : RECOVERY_DOWNLOAD_LABEL
    status.textContent = row?.message ?? ""
    const erase = action.state.get("reset")
    reset.disabled = erase?.phase === "resetting"
    reset.textContent = erase?.phase === "armed" ? RECOVERY_RESET_CONFIRM_LABEL : RECOVERY_RESET_LABEL
    resetStatus.textContent = erase?.message ?? ""
  }
  const subscription = action.state.subscribeChanges(render)
  render()
  /**
   * Run one of this panel's flows. The startup shell must not initialize the
   * engine before the app's async boot boundary, so the binding loads only
   * when the human takes the action.
   */
  const invoke = (
    pick: (module: Awaited<ReturnType<typeof loadFlow>>) => Parameters<
      Awaited<ReturnType<typeof loadFlow>>["invokeStartupRecovery"]
    >[0]
  ): void => {
    void loadFlow().then((module) => module.invokeStartupRecovery(pick(module))).catch(async () => {
      // The Flow normally returns a structured failure. An engine defect must
      // not turn raw host errors into browser error telemetry either.
      try {
        await action.bindingUnavailable()
      } catch {
        console.warn("Smithers: the local recovery action could not finish. Reload before retrying.")
      }
    })
  }
  button.onclick = () => invoke((module) => module.storageRecoveryExportFlow(action.run))
  reset.onclick = () => invoke((module) => module.storageRecoveryResetFlow(action.reset))
  if (doors.download) element.append(warning, button, status)
  if (doors.reset) element.append(reset, resetStatus)
  let closing: Promise<void> | undefined
  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    button.onclick = null
    button.disabled = true
    reset.onclick = null
    reset.disabled = true
    subscription.unsubscribe()
    closing = action.dispose().finally(() => download?.dispose())
    return closing
  }
  return { element, dispose }
}
