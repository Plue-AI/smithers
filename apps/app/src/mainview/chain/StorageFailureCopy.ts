import { presentUserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import type { DurableStorageConflictError, StaleDurableMutationError } from "./DurableCollection"
import type { InvalidSchemaStampError } from "./SchemaStamp"
import type { UnknownPersistenceBackendError, UnsupportedLocalStorageSchemaError } from "./SchemaVersion"
import type { FutureSqliteSchemaError, OversizedSqliteCollectionError, UnreadableSqliteStateError } from "./SqliteRowStorage"
import type { StorageRecoveryError } from "./StorageRecovery"
import type { StorageDecoderError } from "./StoredRowDecoder"
import type { AuthoritativeStorageError, UnsupportedStorageEnvelopeError } from "./TransactionalStorage"

/** Every tagged failure this browser's saved-data layer throws. */
export type StorageTaggedFailure =
  | StorageDecoderError
  | UnknownPersistenceBackendError
  | UnsupportedLocalStorageSchemaError
  | StaleDurableMutationError
  | DurableStorageConflictError
  | UnsupportedStorageEnvelopeError
  | AuthoritativeStorageError
  | InvalidSchemaStampError
  | OversizedSqliteCollectionError
  | FutureSqliteSchemaError
  | UnreadableSqliteStateError
  | StorageRecoveryError

/* Saved data from a newer Smithers opens after an update; nothing was lost. */
const NEWER_DATA: UserFailureCopy = {
  fault: "user",
  sentence: "This browser's saved data is from a newer Smithers. Update Smithers to open it.",
  actions: ["retry", "download-recovery"]
}

/* The saved data is present but this build cannot trust it. The data was kept. */
const UNREADABLE_DATA: UserFailureCopy = {
  fault: "bug",
  sentence: "Smithers could not read this browser's saved data. Not your fault. It was kept as it was.",
  actions: ["retry", "download-recovery", "reset-local-data"]
}

/*
 * What a person sees for each saved-data failure. The raw message names
 * internal stores and schema numbers; it stays in Details.
 */
export const STORAGE_FAILURE_COPY: UserFailureRegistry<StorageTaggedFailure> = {
  StorageDecoderError: UNREADABLE_DATA,
  UnknownPersistenceBackendError: UNREADABLE_DATA,
  UnsupportedLocalStorageSchemaError: NEWER_DATA,
  UnsupportedStorageEnvelopeError: NEWER_DATA,
  FutureSqliteSchemaError: NEWER_DATA,
  InvalidSchemaStampError: UNREADABLE_DATA,
  AuthoritativeStorageError: UNREADABLE_DATA,
  UnreadableSqliteStateError: UNREADABLE_DATA,
  OversizedSqliteCollectionError: {
    fault: "bug",
    sentence: "This browser's saved data is too large for Smithers to open. Not your fault. It was kept as it was.",
    actions: ["download-recovery", "reset-local-data"]
  },
  StaleDurableMutationError: {
    fault: "infra",
    sentence: "That change was not saved. Not your fault. Make it again.",
    actions: ["retry"]
  },
  DurableStorageConflictError: {
    fault: "infra",
    sentence: "Another Smithers tab saved first, so that change was not saved. Not your fault. Reload, then make it again.",
    actions: ["retry"]
  },
  StorageRecoveryError: failure =>
    failure.code === "limit"
      ? {
        fault: "bug",
        sentence: "The recovery file is too large to download. Not your fault. Nothing was reset.",
        actions: []
      }
      : failure.code === "changed"
      ? {
        fault: "wait",
        sentence: "Another Smithers tab changed this browser's data during the download. Nothing was reset. Try again when it is idle.",
        actions: ["retry"]
      }
      : {
        fault: "bug",
        sentence: "Smithers could not read all of this browser's saved data for the recovery file. Not your fault. Nothing was reset.",
        actions: ["retry"]
      }
}

/** The sentence a person reads when the recovery download fails; the raw message stays internal. */
export const recoveryFailure = (error: StorageRecoveryError): string => presentUserFailure(STORAGE_FAILURE_COPY, error).sentence
