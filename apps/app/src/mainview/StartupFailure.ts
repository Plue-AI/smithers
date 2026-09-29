import { Data } from "effect"
import { presentUserFailure, type UserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import { PRIVACY_RETIREMENT_COPY } from "./chain/PrivacyRetirementCopy"
import type { PrivacyRetirementError } from "./chain/PrivacyRetirement"
import { STATE_FAILURE_COPY, type StateTaggedFailure } from "./state/StateFailureCopy"

/** The app never signalled that it mounted within the watchdog's budget. */
export class StartupTimedOut extends Data.TaggedError("StartupTimedOut")<{ readonly message: string }> {
  constructor(timeoutMs: number) { super({ message: `Smithers did not finish starting within ${timeoutMs}ms.` }) }
}

/** Every tagged failure the startup panels can receive. Later lanes add theirs here. */
export type StartupTaggedFailure = PrivacyRetirementError | StartupTimedOut | StateTaggedFailure

export const STARTUP_FAILURE_COPY: UserFailureRegistry<StartupTaggedFailure> = {
  ...STATE_FAILURE_COPY,
  ...PRIVACY_RETIREMENT_COPY,
  StartupTimedOut: {
    fault: "infra",
    sentence: "Smithers is taking too long to start. Not your fault.",
    actions: ["retry", "download-recovery", "reset-local-data"]
  }
}

/**
 * An untagged boot failure. Saved data may be the cause (a store too large or
 * too new to load), so the panel keeps the two doors out of it.
 */
export const STARTUP_UNKNOWN_FAILURE: UserFailureCopy = {
  fault: "bug",
  sentence: "Smithers could not start. Not your fault.",
  actions: ["retry", "download-recovery", "reset-local-data"]
}

/**
 * The panel copy for one boot failure. Both panels report every failure to the
 * client error sink at their boundary (StartupWatchdog), so `onUnknown` is for
 * a caller outside those boundaries.
 */
export const presentStartupFailure = (reason: unknown, onUnknown?: (error: unknown) => void): UserFailure =>
  presentUserFailure(STARTUP_FAILURE_COPY, reason, { unknown: STARTUP_UNKNOWN_FAILURE, ...(onUnknown === undefined ? {} : { onUnknown }) })
