import { expect, test } from "bun:test"
import { openBrowserWASQLiteOPFSDatabase } from "@tanstack/browser-db-sqlite-persistence"
import { DurableStorageConflictError } from "../chain/DurableCollection"
import { WriterMovedToAnotherTabError } from "./StorageRecoveryContract"
import { storageWriteDiagnostic } from "./StorageWriteDiagnostics"

test("local write diagnostics name fixed fault classes without carrying error content", () => {
  const privateText = "PRIVATE SQL /home/person/secret.json credential=top-secret"
  const cases = [
    [new WriterMovedToAnotherTabError(), "writer-moved", "other"],
    [new DurableStorageConflictError(privateText), "storage-conflict", "other"],
    [Object.assign(new Error(privateText), { name: "QuotaExceededError" }), "storage-full", "other"],
    [Object.assign(new Error(privateText), { name: "OPFSWorkerRequestError", code: "INTERNAL" }), "storage-unavailable", "internal"],
    [Object.assign(new Error(privateText), { name: "OPFSWorkerRequestError", code: "PERSISTENCE_UNAVAILABLE" }), "storage-unavailable", "unavailable"],
    [Object.assign(new Error(privateText), { name: "OPFSWorkerRequestError", code: "INVALID_CONFIG" }), "storage-unavailable", "invalid-config"],
    [Object.assign(new Error(privateText), { name: "OPFSWorkerRequestError", code: "UNEXPECTED" }), "storage-unavailable", "other"],
    [Object.assign(new Error(privateText), { name: "PersistenceUnavailableError" }), "storage-unavailable", "unavailable"],
    [Object.assign(new Error(privateText), { name: "InvalidPersistedCollectionConfigError" }), "storage-unavailable", "invalid-config"],
    [Object.assign(new Error(privateText), { name: privateText, code: privateText }), "storage-unavailable", "other"],
    [privateText, "storage-unavailable", "other"],
    [null, "storage-unavailable", "other"]
  ] as const
  for (const [error, fault, worker] of cases) {
    const diagnostic = storageWriteDiagnostic(error, "event")
    expect(diagnostic).toEqual({ fault, worker, stage: "event" })
    expect(JSON.stringify(diagnostic)).not.toContain(privateText)
  }
  expect(storageWriteDiagnostic(new Error(privateText), "checkpoint").stage).toBe("checkpoint")
})

test("the installed OPFS client errors use the classified names", async () => {
  const invalid = await openBrowserWASQLiteOPFSDatabase({ databaseName: " " }).catch(error => error)
  expect(storageWriteDiagnostic(invalid, "event")).toEqual({
    fault: "storage-unavailable", worker: "invalid-config", stage: "event"
  })
  const unavailable = await openBrowserWASQLiteOPFSDatabase({ databaseName: "test" }).catch(error => error)
  expect(storageWriteDiagnostic(unavailable, "event")).toEqual({
    fault: "storage-unavailable", worker: "unavailable", stage: "event"
  })
})
