/**
 * The sentence a command's own failure reads as, when the flow never produced
 * a result of its own: the harness refused or failed the call, or the chain
 * refused the agent's authority for it. The raw message stays on the error
 * (the agent's `refused` hook and diagnostics read it); a person reads this.
 */
import type { Authorize } from "@smthrs/chain"
import type { HarnessError } from "@smthrs/harness/HarnessError"
import { presentUserFailure, type UserFailureCopy, type UserFailureRegistry } from "@smthrs/rpc/UserFailure"
import { runCause } from "../state/RunCause"

type AuthorizeError = Authorize.AuthorizeError

/** Every failure a command's invocation can settle with before its flow answers. */
export type CommandTaggedFailure = HarnessError | AuthorizeError

const AUTHORIZE_COPY = {
  denied: (name: string): UserFailureCopy => ({ fault: "user", sentence: `Smithers isn't allowed to run /${name} here.`, actions: [] }),
  approval_required: (name: string): UserFailureCopy => ({ fault: "wait", sentence: `/${name} needs your approval first.`, actions: [] }),
  authorize_unavailable: (name: string): UserFailureCopy => ({
    fault: "bug",
    sentence: `Smithers couldn't check whether it may run /${name}. Not your fault.`,
    actions: ["retry"]
  })
} as const satisfies Record<AuthorizeError["code"], (name: string) => UserFailureCopy>

const harnessCopy = (name: string, failure: HarnessError): UserFailureCopy =>
  failure.code === "suspended"
    ? { fault: "wait", sentence: `/${name} is waiting for permission.`, actions: [] }
    : {
      fault: failure.code === "model_failed" || failure.code === "completion_unjudged" ? "dependency"
        : failure.code === "engine_failed" ? "infra"
        : failure.code === "read_only_cap" || failure.code === "completion_incomplete" ||
            failure.code === "claim_unproven"
        ? "factory"
        : "bug",
      sentence: runCause(`/harness/HarnessError/${failure.code}`) ?? `/${name} failed. Not your fault.`,
      actions: ["retry"]
    }

const registryFor = (name: string): UserFailureRegistry<CommandTaggedFailure> => ({
  "/harness/HarnessError": failure => harnessCopy(name, failure),
  "/chain/AuthorizeError": failure => AUTHORIZE_COPY[failure.code](name)
})

/**
 * The one sentence for a command that failed before its flow answered. An
 * error of any other shape gets the generic sentence and goes to `report`.
 */
export const commandFailureSentence = (name: string, error: unknown, report: (error: unknown) => void = () => {}): string =>
  presentUserFailure(registryFor(name), error, {
    onUnknown: report,
    unknown: { fault: "bug", sentence: `/${name} failed. Not your fault.`, actions: ["retry"] }
  }).sentence
