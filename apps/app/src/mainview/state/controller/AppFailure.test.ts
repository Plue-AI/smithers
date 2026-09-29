import { describe, expect, test } from "bun:test"
import { USER_FAILURE_ACTIONS } from "@smthrs/rpc/UserFailure"
import { DurableStorageConflictError, StaleDurableMutationError } from "../../chain/DurableCollection"
import { PrivacyCleanupPending, PrivacyMarkerUnreadable } from "../../chain/PrivacyRetirement"
import { InvalidSchemaStampError } from "../../chain/SchemaStamp"
import { UnknownPersistenceBackendError, UnsupportedLocalStorageSchemaError } from "../../chain/SchemaVersion"
import { FutureSqliteSchemaError, OversizedSqliteCollectionError, UnreadableSqliteStateError } from "../../chain/SqliteRowStorage"
import { StorageRecoveryError } from "../../chain/StorageRecovery"
import { StorageDecoderError } from "../../chain/StoredRowDecoder"
import { AuthoritativeStorageError, UnsupportedStorageEnvelopeError } from "../../chain/TransactionalStorage"
import { AgentJournalIntegrityError } from "../../runtime/AgentPort"
import { ApplicationClientError } from "../../runtime/ApplicationClient"
import { presentStartupFailure } from "../../StartupFailure"
import { AppEventIntegrityError, AppProjectorVersionError } from "../AppEventStream"
import { AmbiguousPersistenceBackendError } from "../AppStore"
import { InvalidAppTransitionError } from "../AppTransitionValidation"
import { lostActRefusal } from "../BrowserWriteFailure"
import { InvalidEventValueError } from "../EventValue"
import { HttpTurnIntegrityError } from "../HttpTurn"
import { RuntimeProjectionIntegrityError } from "../RuntimeProjection"
import { RepositorySignInRequired } from "../seams/SeamContext"
import {
  HeldBrowserStorageError,
  StorageWriteFailedError,
  WriterHeldByAnotherTabError,
  WriterMovedToAnotherTabError
} from "../StorageRecoveryContract"
import { SweepRequestTooLargeError } from "./ConversationSweep"
import { presentAppFailure } from "./AppFailure"

const every = (): ReadonlyArray<Error & { readonly _tag: string }> => [
  new StorageDecoderError("non-json"),
  new StorageDecoderError("unstable"),
  new UnknownPersistenceBackendError(),
  new UnsupportedLocalStorageSchemaError("9", 3),
  new StaleDurableMutationError("messages", "m-1"),
  new DurableStorageConflictError("messages/m-1"),
  new UnsupportedStorageEnvelopeError(9, 2),
  new AuthoritativeStorageError("runs"),
  new InvalidSchemaStampError("smithers.schema"),
  new OversizedSqliteCollectionError("runs", 1024),
  new FutureSqliteSchemaError(9, 2),
  new UnreadableSqliteStateError("legacy row"),
  new StorageRecoveryError("limit"),
  new StorageRecoveryError("changed"),
  new StorageRecoveryError("unreadable"),
  new AmbiguousPersistenceBackendError(),
  new AppProjectorVersionError(99),
  new AppEventIntegrityError("gap"),
  new InvalidEventValueError("unsupported-value"),
  new InvalidAppTransitionError(),
  new RuntimeProjectionIntegrityError("cursor regressed"),
  new AgentJournalIntegrityError("replay boundary missing"),
  new HttpTurnIntegrityError("tool leg mismatch"),
  new HeldBrowserStorageError(),
  new WriterHeldByAnotherTabError(),
  new WriterMovedToAnotherTabError(),
  new StorageWriteFailedError(),
  new ApplicationClientError("forbidden", "role lacks repo:write", 403, "forbidden"),
  new RepositorySignInRequired("401 from /api/repos"),
  new SweepRequestTooLargeError(),
  new PrivacyCleanupPending(),
  new PrivacyMarkerUnreadable()
]

const noReport = (error: unknown): void => { throw new Error(`reported a tagged failure: ${String(error)}`) }

describe("presentAppFailure", () => {
  test("every tagged app failure presents a registered sentence, never its raw message", () => {
    for (const error of every()) {
      const failure = presentAppFailure(error, noReport)
      expect(failure.tag).toBe(error._tag)
      expect(failure.sentence.length).toBeGreaterThan(0)
      expect(failure.sentence).not.toContain(error.message)
      expect(failure.detail).toContain(error.message)
      for (const action of failure.actions) expect(USER_FAILURE_ACTIONS).toContain(action)
    }
  })

  test("internal store names, schema numbers and boundaries stay in Details", () => {
    const oversized = presentAppFailure(new OversizedSqliteCollectionError("runs", 1024), noReport)
    expect(oversized.sentence).not.toMatch(/runs|1024|SQLite/)
    expect(oversized.detail).toContain("1024")
    const future = presentAppFailure(new FutureSqliteSchemaError(9, 2), noReport)
    expect(future.sentence).toBe("This browser's saved data is from a newer Smithers. Update Smithers to open it.")
    expect(future.fault).toBe("user")
  })

  test("each recovery-download cause gets its own sentence and doors", () => {
    const [limit, changed, unreadable] = (["limit", "changed", "unreadable"] as const)
      .map(code => presentAppFailure(new StorageRecoveryError(code), noReport))
    expect(new Set([limit!.sentence, changed!.sentence, unreadable!.sentence]).size).toBe(3)
    expect(limit!.actions).toEqual([])
    expect(changed!.fault).toBe("wait")
    expect(changed!.actions).toEqual(["retry"])
    expect(unreadable!.fault).toBe("bug")
  })

  test("writer ownership and a lost write read exactly as the lost-act sentence the transcript speaks", () => {
    for (const error of [new WriterMovedToAnotherTabError(), new WriterHeldByAnotherTabError(), new DurableStorageConflictError("b")]) {
      expect(presentAppFailure(error, noReport).sentence).toBe(lostActRefusal(error))
    }
    expect(presentAppFailure(new WriterMovedToAnotherTabError(), noReport).actions).toEqual(["use-here"])
  })

  test("an API refusal uses its fault's lead and keeps the server's words out of the sentence", () => {
    const forbidden = presentAppFailure(new ApplicationClientError("forbidden", "role lacks repo:write", 403, "forbidden"), noReport)
    expect(forbidden.sentence).not.toContain("repo:write")
    expect(forbidden.detail).toContain("role lacks repo:write")
    for (const code of ["auth-missing", "unauthenticated"] as const) {
      const signIn = presentAppFailure(new ApplicationClientError(code, "no token", 401), noReport)
      expect(signIn.sentence).toBe("Sign in to continue.")
      expect(signIn.actions).toEqual(["sign-in"])
    }
  })

  test("a tagged cause under an untagged wrapper still presents the cause", () => {
    const wrapped = new Error("boot step failed", { cause: new AppEventIntegrityError("head") })
    expect(presentAppFailure(wrapped, noReport).tag).toBe("AppEventIntegrityError")
  })

  test("an unknown error gets the generic or supplied sentence and is reported once", () => {
    const reported: unknown[] = []
    const raw = new TypeError("Cannot read properties of undefined (reading 'id')")
    const generic = presentAppFailure(raw, error => reported.push(error))
    expect(generic.tag).toBeNull()
    expect(generic.sentence).toBe("Something went wrong on our side. Not your fault.")
    expect(generic.sentence).not.toContain("undefined")
    expect(generic.detail).toContain("reading 'id'")
    expect(reported).toEqual([raw])
    const own = presentAppFailure("boom", () => {}, { fault: "bug", sentence: "Sign-out didn't finish.", actions: [] })
    expect(own.sentence).toBe("Sign-out didn't finish.")
  })
})

describe("presentStartupFailure", () => {
  test("a saved-data failure at boot names the cause instead of the generic start failure", () => {
    const boot = presentStartupFailure(new OversizedSqliteCollectionError("runs", 1024))
    expect(boot.tag).toBe("OversizedSqliteCollectionError")
    expect(boot.sentence).toBe("This browser's saved data is too large for Smithers to open. Not your fault. It was kept as it was.")
    expect(boot.actions).toEqual(["download-recovery", "reset-local-data"])
    expect(presentStartupFailure(new Error("x")).sentence).toBe("Smithers could not start. Not your fault.")
  })
})
