import { expect, test } from "bun:test"
import { OpfsOpenTimeout, storageOpenDiagnostic } from "./StorageOpenDiagnostics"
import type { StorageOpenFault } from "./StorageOpenDiagnostics"

test("OPFS open diagnostics classify fixed failure kinds without exposing worker or row data", () => {
  const secret = "private SQL row contents"
  const cases: ReadonlyArray<readonly [unknown, StorageOpenFault]> = [
    [new OpfsOpenTimeout(4000), "timeout"],
    [{ name: "OpfsOpenTimeout", message: secret }, "timeout"],
    [{ name: "OPFSWorkerRequestError", code: "PERSISTENCE_UNAVAILABLE", message: secret }, "worker-unavailable"],
    [{ name: "PersistenceUnavailableError", message: secret }, "worker-unavailable"],
    [{ name: "OPFSWorkerRequestError", code: "INVALID_CONFIG", message: secret }, "worker-invalid-config"],
    [{ name: "InvalidPersistedCollectionConfigError", message: secret }, "worker-invalid-config"],
    [{ name: "OPFSWorkerRequestError", code: "INTERNAL", message: secret }, "worker-internal"],
    [new DOMException(secret, "SecurityError"), "permission"],
    [new DOMException(secret, "NotAllowedError"), "permission"],
    [new DOMException(secret, "InvalidStateError"), "invalid-state"],
    [new DOMException(secret, "NoModificationAllowedError"), "invalid-state"],
    [secret, "other"],
    [new Error(secret), "other"]
  ]
  for (const [error, fault] of cases) {
    const diagnostic = storageOpenDiagnostic(error, 5, 4000)
    expect(diagnostic).toEqual({ code: "opfs_open_failed", fault, attempts: 5, budgetMs: 4000 })
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
  }
})
