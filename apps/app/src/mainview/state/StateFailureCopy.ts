import type { UserFailureCopy, UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import type { PrivacyRetirementError } from "../chain/PrivacyRetirement"
import { PRIVACY_RETIREMENT_COPY } from "../chain/PrivacyRetirementCopy"
import { STORAGE_FAILURE_COPY, type StorageTaggedFailure } from "../chain/StorageFailureCopy"
import type { AgentJournalIntegrityError } from "../runtime/AgentPort"
import type { AppEventIntegrityError, AppProjectorVersionError } from "./AppEventStream"
import type { AmbiguousPersistenceBackendError } from "./AppStore"
import type { InvalidAppTransitionError } from "./AppTransitionValidation"
import { LOST_ACT_COPY } from "./BrowserWriteFailure"
import type { InvalidEventValueError } from "./EventValue"
import type { HttpTurnIntegrityError } from "./HttpTurn"
import type { RuntimeProjectionIntegrityError } from "./RuntimeProjection"
import type {
  HeldBrowserStorageError,
  StorageWriteFailedError,
  WriterHeldByAnotherTabError,
  WriterMovedToAnotherTabError
} from "./StorageRecoveryContract"

/*
 * Type-only imports on purpose: the startup panel reads this table, and
 * importing AppStore for a value would initialize the store it is reporting on.
 */

/** Every tagged failure the app's saved state, event log and writer lock throw. */
export type StateTaggedFailure =
  | StorageTaggedFailure
  | PrivacyRetirementError
  | AmbiguousPersistenceBackendError
  | AppProjectorVersionError
  | AppEventIntegrityError
  | InvalidEventValueError
  | InvalidAppTransitionError
  | RuntimeProjectionIntegrityError
  | AgentJournalIntegrityError
  | HttpTurnIntegrityError
  | HeldBrowserStorageError
  | WriterHeldByAnotherTabError
  | WriterMovedToAnotherTabError
  | StorageWriteFailedError

/* The app refused its own record; that is a bug, and the record was kept. */
const INTEGRITY: UserFailureCopy = {
  fault: "bug",
  sentence: "Smithers found a problem in its own saved history. Not your fault. It was kept as it was.",
  actions: ["retry", "download-recovery", "reset-local-data"]
}

/* A change the app built did not fit its own contract, so nothing was written. */
const INVALID_CHANGE: UserFailureCopy = {
  fault: "bug",
  sentence: "Smithers hit a bug of its own, so that change was not saved. Not your fault.",
  actions: ["retry"]
}

const copyOf = ({ fault, sentence, actions }: UserFailureCopy): UserFailureCopy => ({ fault, sentence, actions })

export const STATE_FAILURE_COPY: UserFailureRegistry<StateTaggedFailure> = {
  ...STORAGE_FAILURE_COPY,
  ...PRIVACY_RETIREMENT_COPY,
  DurableStorageConflictError: copyOf(LOST_ACT_COPY["storage-conflict"]),
  AmbiguousPersistenceBackendError: {
    fault: "bug",
    sentence: "This browser holds two copies of Smithers' saved data. Not your fault. Neither was changed.",
    actions: ["download-recovery", "reset-local-data"]
  },
  AppProjectorVersionError: {
    fault: "user",
    sentence: "This browser's saved data is from a newer Smithers. Update Smithers to open it.",
    actions: ["retry", "download-recovery"]
  },
  AppEventIntegrityError: INTEGRITY,
  RuntimeProjectionIntegrityError: INTEGRITY,
  AgentJournalIntegrityError: {
    fault: "infra",
    sentence: "Smithers could not confirm the agent's reply. Not your fault. Try again.",
    actions: ["retry"]
  },
  HttpTurnIntegrityError: {
    fault: "infra",
    sentence: "Smithers could not confirm the agent's reply. Not your fault. Try again.",
    actions: ["retry"]
  },
  InvalidEventValueError: INVALID_CHANGE,
  InvalidAppTransitionError: INVALID_CHANGE,
  HeldBrowserStorageError: {
    fault: "user",
    sentence: "Smithers is still open in another tab, so this browser's data was not erased. Close the other tabs and try again.",
    actions: ["retry"]
  },
  WriterHeldByAnotherTabError: copyOf(LOST_ACT_COPY["writer-held"]),
  WriterMovedToAnotherTabError: copyOf(LOST_ACT_COPY["writer-moved"]),
  StorageWriteFailedError: copyOf(LOST_ACT_COPY["storage-unavailable"])
}
