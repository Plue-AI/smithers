import { presentUserFailure } from "@smthrs/rpc/UserFailure"
import type { PlueFault } from "@smthrs/rpc/PlueFailureCodes"

const FAULTS: Readonly<Record<string, PlueFault>> = { user: "user", infra: "infra", permission: "policy", never: "policy", capacity: "factory", github: "dependency", conflict: "wait" }
const COPY: Readonly<Record<string, string>> = {
  unknown_github_user: "Unknown GitHub user", host_refused: "Key refused",
  owner_required: "Owner access required", no_install: "No install on this host",
  unreachable: "Could not reach this install", invalid_install: "Install response unavailable",
  invalid_error: "Install request failed", request_failed: "Install request failed",
  subscription_failed: "Install updates unavailable", handoff_failed: "GitHub App handoff unavailable",
  invalid_key: "Key refused", key_refused: "Key refused", model_refused: "Could not save model"
}
type ServiceRequestFailure = { readonly _tag: "ServiceRequestFailure"; readonly code?: string; readonly class: string }
/** Service detail stays diagnostic; command replies use authored failure copy. */
export const serviceFailureSentence = (value: { readonly class: string; readonly code?: string }): string => presentUserFailure<ServiceRequestFailure>({
  ServiceRequestFailure: failure => ({ fault: Object.hasOwn(FAULTS, failure.class) ? FAULTS[failure.class]! : "bug",
    sentence: failure.code !== undefined && Object.hasOwn(COPY, failure.code) ? COPY[failure.code]! : "The operation failed.", actions: [] })
}, { ...value, _tag: "ServiceRequestFailure" }).sentence
