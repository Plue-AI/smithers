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
    const diagnostic = storageOpenDiagnostic(error, 5, 4000, "unknown")
    expect(diagnostic).toEqual({ code: "opfs_open_failed", fault, attempts: 5, budgetMs: 4000, sqlite: "other", handle: "unknown" })
    expect(JSON.stringify(diagnostic)).not.toContain(secret)
  }
})

test("an open that another context blocks names the handle holders and the SQLite result", () => {
  expect(storageOpenDiagnostic(new OpfsOpenTimeout(4000), 5, 4000, { held: 1, waiting: 1 })).toEqual({
    code: "opfs_open_failed", fault: "timeout", attempts: 5, budgetMs: 4000, sqlite: "other", handle: { held: 1, waiting: 1 }
  })
  const cantOpen = { name: "OPFSWorkerRequestError", code: "INTERNAL", message: "unable to open database file" }
  expect(storageOpenDiagnostic(cantOpen, 5, 4000, { held: 0, waiting: 0 })).toEqual({
    code: "opfs_open_failed", fault: "worker-internal", attempts: 5, budgetMs: 4000, sqlite: "cantopen", handle: { held: 0, waiting: 0 }
  })
})
