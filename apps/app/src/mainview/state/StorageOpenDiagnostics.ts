import { sqliteFault, type OpfsHandleContention, type SqliteFault } from "./OpfsFaultDetail"

/** Fixed vocabulary only: worker errors can contain SQL or local row data. */
export type StorageOpenFault = "timeout" | "worker-unavailable" | "worker-invalid-config" | "worker-internal" | "permission" | "invalid-state" | "other"

export interface StorageOpenDiagnostic {
  readonly code: "opfs_open_failed"
  readonly fault: StorageOpenFault
  readonly attempts: number
  readonly budgetMs: number
  readonly sqlite: SqliteFault
  readonly handle: OpfsHandleContention
}

export class OpfsOpenTimeout extends Error {
  override readonly name = "OpfsOpenTimeout"
  constructor(budgetMs: number) { super(`OPFS did not open within ${budgetMs}ms`) }
}

export const storageOpenFault = (error: unknown): StorageOpenFault => {
  let fault: StorageOpenFault = "other"
  if (typeof error === "object" && error !== null && (error as { readonly name?: unknown }).name === "OpfsOpenTimeout") fault = "timeout"
  else if (typeof error === "object" && error !== null) {
    const { name, code } = error as { readonly name?: unknown; readonly code?: unknown }
    if (name === "PersistenceUnavailableError" || (name === "OPFSWorkerRequestError" && code === "PERSISTENCE_UNAVAILABLE")) fault = "worker-unavailable"
    else if (name === "InvalidPersistedCollectionConfigError" || (name === "OPFSWorkerRequestError" && code === "INVALID_CONFIG")) fault = "worker-invalid-config"
    else if (name === "OPFSWorkerRequestError" && code === "INTERNAL") fault = "worker-internal"
    else if (name === "NotAllowedError" || name === "SecurityError") fault = "permission"
    else if (name === "InvalidStateError" || name === "NoModificationAllowedError") fault = "invalid-state"
  }
  return fault
}

export const storageOpenDiagnostic = (
  error: unknown, attempts: number, budgetMs: number, handle: OpfsHandleContention
): StorageOpenDiagnostic => ({
  code: "opfs_open_failed", fault: storageOpenFault(error), attempts, budgetMs, sqlite: sqliteFault(error), handle
})
