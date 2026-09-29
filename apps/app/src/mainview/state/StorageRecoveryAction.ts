import { createCollection, localOnlyCollectionOptions } from "@tanstack/db"
import { z } from "zod"
import { encodeStorageRecovery, StorageRecoveryError } from "../chain/StorageRecovery"
import { recoveryFailure } from "../chain/StorageFailureCopy"
import type { StorageRecoverySnapshot } from "../chain/StorageRecovery"
import {
  HeldBrowserStorageError,
  RECOVERY_HUMAN_ONLY,
  RECOVERY_RESET_ARMED,
  RECOVERY_RESET_FAILED,
  RECOVERY_RESET_HELD,
  RECOVERY_RESET_HUMAN_ONLY,
  RECOVERY_RESET_RUNNING
} from "./StorageRecoveryContract"
import { assertRecoverySnapshotCurrent } from "./BrowserStorageRecovery"
const CANCELED = "Recovery was canceled because the app closed. Saved data was not reset."

const RecoveryStateSchema = z.object({
  /* "recovery" is the download; "reset" is the erase, armed by its first press. */
  id: z.enum(["recovery", "reset"]),
  phase: z.enum(["idle", "preparing", "armed", "resetting", "ready", "failed", "canceled"]),
  message: z.string().nullable(),
  actor: z.enum(["system", "user", "smithers"]),
  revision: z.number().int().nonnegative()
})
type RecoveryState = z.infer<typeof RecoveryStateSchema>

export interface StorageRecoveryHost {
  readonly read: () => Promise<StorageRecoverySnapshot>
  /** A local browser handoff, never an HTTP upload or model/tool output. */
  readonly download: (json: string) => void | Promise<void>
  /**
   * Release this document's store handles, erase this browser's saved Smithers
   * data, and reload. Absent when the host cannot erase, and the act refuses.
   */
  readonly reset?: () => Promise<void>
}

/**
 * The same recovery act on a healthy page or before AppStore can boot. Only
 * ephemeral operation status lives here; private bytes never enter the state
 * projection. Every status change uses this dispatcher and records its actor.
 * A separate in-memory collection is necessary because the durable AppStore
 * may be the resource that refused to open.
 */
export const createStorageRecoveryAction = (host: StorageRecoveryHost, actor: "user" | "smithers") => {
  const state = createCollection(localOnlyCollectionOptions({
    id: `storage-recovery-${crypto.randomUUID()}`,
    schema: RecoveryStateSchema,
    getKey: (row) => row.id,
    initialData: [
      { id: "recovery", phase: "idle", message: null, actor: "system", revision: 0 },
      { id: "reset", phase: "idle", message: null, actor: "system", revision: 0 }
    ]
  }))
  let disposed = false
  let pending: Promise<string | void> | undefined
  let resetting: Promise<string | void> | undefined
  let closing: Promise<void> | undefined
  const dispatch = async (
    phase: RecoveryState["phase"],
    message: string | null,
    row: RecoveryState["id"] = "recovery"
  ): Promise<void> => {
    await state.update(row, (draft) => {
      draft.phase = phase
      draft.message = message
      draft.actor = actor
      draft.revision += 1
    }).isPersisted.promise
  }

  const run = (): Promise<string | void> => {
    // This host-owned actor check remains necessary even if a caller bypasses
    // the registry's modelInvocable filtering and invokes the binding directly.
    if (actor !== "user") return Promise.resolve(RECOVERY_HUMAN_ONLY)
    if (disposed) return Promise.resolve(CANCELED)
    if (resetting !== undefined) return resetting
    if (pending !== undefined) return pending
    pending = (async () => {
      await state.preload()
      if (disposed) return CANCELED
      await dispatch("preparing", null)
      try {
        const snapshot = await host.read()
        if (disposed) {
          await dispatch("canceled", CANCELED)
          return CANCELED
        }
        const json = encodeStorageRecovery(snapshot)
        assertRecoverySnapshotCurrent(snapshot)
        await host.download(json)
        await dispatch("ready", "Recovery download prepared.")
      } catch (error) {
        // Raw SQLite errors may carry user data. Only our closed public error
        // vocabulary reaches the state, flow result, transcript or telemetry.
        const message = disposed
          ? CANCELED
          : recoveryFailure(error instanceof StorageRecoveryError ? error : new StorageRecoveryError("unreadable"))
        await dispatch(disposed ? "canceled" : "failed", message)
        return message
      }
    })().finally(() => {
      pending = undefined
    })
    return pending
  }

  /*
   * The erase, as a two-press act on one button. Deleting every local byte on
   * a single click of a failure page is not a decision anyone makes on
   * purpose, so the first press arms the act and says what it will take with
   * it; the second runs it. Both presses are the same flow through the same
   * dispatcher, with the actor recorded — never ad-hoc DOM.
   */
  const reset = (): Promise<string | void> => {
    if (actor !== "user") return Promise.resolve(RECOVERY_RESET_HUMAN_ONLY)
    if (disposed) return Promise.resolve(CANCELED)
    if (resetting !== undefined) return resetting
    const erase = host.reset
    resetting = (async () => {
      await state.preload()
      if (disposed) return CANCELED
      if (erase === undefined) {
        // A human pressed a button. A host that cannot erase says so on the
        // panel; it does not arm a second press that would do nothing either.
        await dispatch("failed", RECOVERY_RESET_FAILED, "reset")
        return RECOVERY_RESET_FAILED
      }
      if (state.get("reset")?.phase !== "armed") {
        await dispatch("armed", RECOVERY_RESET_ARMED, "reset")
        return
      }
      // Finish an already-authorized download before erasing its source. New
      // downloads are fenced by resetting until this operation settles.
      await pending
      if (disposed) return CANCELED
      await dispatch("resetting", RECOVERY_RESET_RUNNING, "reset")
      try {
        await erase()
        // A successful erase reloads the page; nothing after this is seen.
      } catch (error) {
        const message = disposed
          ? CANCELED
          : error instanceof HeldBrowserStorageError
          ? RECOVERY_RESET_HELD
          : RECOVERY_RESET_FAILED
        await dispatch(disposed ? "canceled" : "failed", message, "reset")
        return message
      }
    })().finally(() => {
      resetting = undefined
    })
    return resetting
  }

  const dispose = (): Promise<void> => {
    if (closing !== undefined) return closing
    disposed = true
    closing = (async () => {
      try {
        await pending
        await resetting
      } finally {
        await state.cleanup()
      }
    })()
    return closing
  }
  /** A failed lazy binding load is still a visible, private-safe Flux transition. */
  const bindingUnavailable = async (): Promise<void> => {
    if (disposed || actor !== "user") return
    await state.preload()
    if (!disposed) await dispatch("failed", recoveryFailure(new StorageRecoveryError("unreadable")))
  }
  return { state, run, reset, dispose, bindingUnavailable }
}

export type StorageRecoveryAction = ReturnType<typeof createStorageRecoveryAction>
