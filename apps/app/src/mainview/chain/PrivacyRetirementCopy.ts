import type { UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import type { PrivacyRetirementError } from "./PrivacyRetirement"

/*
 * What a person sees for each privacy cleanup failure. None is their fault.
 * No variant offers the recovery download: the export refuses while a cleanup
 * is unfinished, by design, so the button could never work.
 */
export const PRIVACY_RETIREMENT_COPY: UserFailureRegistry<PrivacyRetirementError> = {
  PrivacyCleanupPending: {
    fault: "infra",
    sentence: "Smithers could not finish clearing this browser's data.",
    actions: ["retry", "reset-local-data"]
  },
  PrivacyStorageUnavailable: {
    fault: "infra",
    sentence: "This browser's storage is not available to Smithers right now.",
    actions: ["retry", "reset-local-data"]
  },
  PrivacyKeyNotRemoved: {
    fault: "infra",
    sentence: "This browser did not delete Smithers data when asked.",
    actions: ["retry", "reset-local-data"]
  },
  PrivacyMarkerUnreadable: {
    fault: "bug",
    sentence: "Smithers could not read its cleanup record in this browser.",
    actions: ["reset-local-data"]
  },
  PrivacyConflictingErasureProof: {
    fault: "bug",
    sentence: "Smithers found conflicting cleanup records in this browser.",
    actions: ["reset-local-data"]
  },
  PrivacyMarkerMismatch: {
    fault: "bug",
    sentence: "Smithers' cleanup record does not match this browser's data.",
    actions: ["retry", "reset-local-data"]
  },
  PrivacyAuthorityMissing: {
    fault: "bug",
    sentence: "Smithers could not verify this browser's saved data.",
    actions: ["reset-local-data"]
  }
}
