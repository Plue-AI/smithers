import { refusalCopy, type RefusalDoor } from "@smthrs/rpc/RefusalCopy"
import {
  presentUserFailure,
  type UserFailure,
  type UserFailureAction,
  type UserFailureCopy,
  type UserFailureRegistry
} from "@smthrs/rpc/UserFailure"
import type { ApplicationClientError } from "../../runtime/ApplicationClient"
import type { RepositorySignInRequired } from "../seams/SeamContext"
import { STATE_FAILURE_COPY, type StateTaggedFailure } from "../StateFailureCopy"
import type { SweepRequestTooLargeError } from "./ConversationSweep"

/** Every tagged failure a controller act can throw at a person. */
export type AppTaggedFailure =
  | StateTaggedFailure
  | ApplicationClientError
  | RepositorySignInRequired
  | SweepRequestTooLargeError

const REFUSAL_ACTIONS: ReadonlySet<string> = new Set<UserFailureAction>(["retry", "sign-in"])

/*
 * An API refusal already has written copy per fault and code (RefusalCopy).
 * Its lead is the sentence; the server's own words stay in Details.
 */
const clientRefusalCopy = (failure: ApplicationClientError): UserFailureCopy => {
  const copy = refusalCopy(failure.refusal)
  const signIn = failure.code === "auth-missing" || failure.code === "unauthenticated"
  return {
    fault: failure.refusal.fault,
    sentence: signIn ? "Sign in to continue." : copy.lead,
    actions: signIn ? ["sign-in"] : copy.doors.filter((door): door is RefusalDoor & UserFailureAction => REFUSAL_ACTIONS.has(door))
  }
}

export const APP_FAILURE_COPY: UserFailureRegistry<AppTaggedFailure> = {
  ...STATE_FAILURE_COPY,
  ApplicationClientError: clientRefusalCopy,
  RepositorySignInRequired: { fault: "user", sentence: "Sign in to continue.", actions: ["sign-in"] },
  SweepRequestTooLargeError: {
    fault: "user",
    sentence: "This conversation is too large to summarize. Nothing was cleared.",
    actions: []
  }
}

/**
 * A controller failure as a person sees it. An untagged error gets `unknown`
 * (the generic bug sentence by default) and goes to `report`; its message is
 * never the sentence.
 */
export const presentAppFailure = (
  error: unknown,
  report: (error: unknown) => void,
  unknown?: UserFailureCopy
): UserFailure =>
  presentUserFailure(APP_FAILURE_COPY, error, { onUnknown: report, ...(unknown === undefined ? {} : { unknown }) })
