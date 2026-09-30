import { browserWriteFault, type BrowserWriteFault } from "./BrowserWriteFailure"

/** Fixed vocabulary only. Worker errors can contain SQL and local row data in their messages. */
export type StorageWriteStage = "event" | "checkpoint"
export type StorageWriteWorkerFault = "internal" | "unavailable" | "invalid-config" | "other"
export interface StorageWriteDiagnostic {
  readonly fault: BrowserWriteFault
  readonly worker: StorageWriteWorkerFault
  readonly stage: StorageWriteStage
}

const workerFault = (error: unknown): StorageWriteWorkerFault => {
  if (typeof error !== "object" || error === null) return "other"
  const { name, code } = error as { readonly name?: unknown; readonly code?: unknown }
  if (name === "OPFSWorkerRequestError" && code === "INTERNAL") return "internal"
  if (name === "PersistenceUnavailableError" ||
    (name === "OPFSWorkerRequestError" && code === "PERSISTENCE_UNAVAILABLE")) return "unavailable"
  if (name === "InvalidPersistedCollectionConfigError" ||
    (name === "OPFSWorkerRequestError" && code === "INVALID_CONFIG")) return "invalid-config"
  return "other"
}

export const storageWriteDiagnostic = (error: unknown, stage: StorageWriteStage): StorageWriteDiagnostic => ({
  fault: browserWriteFault(error), worker: workerFault(error), stage
})
