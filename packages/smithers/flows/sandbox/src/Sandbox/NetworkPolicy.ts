/**
 * The provider-neutral guest network option.
 *
 * @since 0.1.0
 */

/**
 * What a provisioned machine may reach over the network.
 *
 * `"none"` gives the guest no network. `{ allow }` denies egress except to
 * the listed hosts: each entry is an exact DNS name such as
 * `registry.npmjs.org`, or `*.` followed by one, such as `*.npmjs.org`, which
 * matches every name below that suffix. List the suffix itself separately
 * when it must be reachable: Microsandbox and Vercel deny it unless listed,
 * and Daytona does not document either way. Microsandbox and Vercel answer
 * DNS only for listed names, and an empty list denies all egress, DNS
 * included; Daytona does not document its DNS handling.
 *
 * A provider enforces the policy with its own mechanism or refuses it when
 * `make` is called, before any machine exists; it never accepts a policy it
 * cannot enforce.
 *
 * @category models
 * @since 0.1.0
 */
export type NetworkPolicy = "none" | { readonly allow: ReadonlyArray<string> }

const label = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?"
const host = new RegExp(`^(?:\\*\\.)?(?:${label}\\.)*${label}$`, "i")

/**
 * Checks a network policy's shape and host grammar, throwing on anything
 * else, and returns it.
 *
 * @category validation
 * @since 0.1.0
 */
export const validateNetworkPolicy = (provider: string, policy: NetworkPolicy): NetworkPolicy => {
  if (policy === "none") return policy
  if (typeof policy !== "object" || policy === null || !Array.isArray(policy.allow)) {
    throw new TypeError(`${provider}: network must be "none" or { allow: string[] }`)
  }
  for (const entry of policy.allow) {
    if (typeof entry !== "string" || entry.length > 253 || !host.test(entry)) {
      throw new TypeError(`${provider}: network allowlist entry is not a host name: ${String(entry)}`)
    }
  }
  return policy
}

/**
 * Refuses any network policy, for a provider that cannot enforce one.
 *
 * @category validation
 * @since 0.1.0
 */
export const refuseNetworkPolicy = (provider: string, policy: NetworkPolicy | undefined): void => {
  if (policy !== undefined) {
    throw new TypeError(`${provider}: cannot enforce a network policy; omit \`network\``)
  }
}
