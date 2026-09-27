/**
 * Rate Limiting adapter for the per-credential budget contract.
 *
 * @since 0.1.0
 */

import type { CredentialBudget } from "./protocol.ts"

/**
 * Adapts the two Rate Limiting bindings to the per-credential budget contract.
 *
 * Both are keyed by the SHA-256 the handler already computed to classify the
 * credential, never by the bearer value, so the bindings' counters hold no
 * secret. `findMissing` draws on the tighter binding because one probe fans
 * out to up to a thousand metered R2 calls. An outcome that does not say
 * `success` is a refusal: a budget the platform cannot vouch for admits
 * nothing.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeCredentialBudget = (requests: RateLimit, findMissing: RateLimit): CredentialBudget => ({
  async charge(credentialDigest, route) {
    const binding = route === "findMissing" ? findMissing : requests
    const outcome = await binding.limit({ key: credentialDigest })
    return outcome.success === true
  }
})
