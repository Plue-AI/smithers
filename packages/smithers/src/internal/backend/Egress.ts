/**
 * `smthrs egress`: a repository's egress allowlist (#2653). Its owner lists
 * the hosts the repository's sandboxes may reach, allows one more or denies
 * one again; every running sandbox of the repository reloads the new list.
 * @since 1.0.0
 */

import { Refused, UsageError } from "../../CliError.ts"
import { type Client, str, type Values } from "./Client.ts"
import * as ProductApi from "./ProductApi.ts"
import type { Handler } from "./Resources.ts"

const target = (c: Client, o: Values) => {
  const [owner = "", repo = ""] = c.repo(o.repo).split("/").map(decodeURIComponent)
  return { owner, repo }
}

/** A host as the backend stores it: trimmed, lower-case, without a trailing dot. */
const host = (value: unknown): string => {
  const name = str(value).trim().toLowerCase().replace(/\.$/, "")
  if (!name) throw new UsageError({ message: "A host is required" })
  return name
}

const replace = (c: Client, path: { owner: string; repo: string }, domains: Array<string>) =>
  ProductApi.putApiReposOwnerRepoEgressPolicy(c, { path, body: { allow_domains: domains } })

/** @private
 * @since 1.0.0
 */
export const egress: Record<string, Handler> = {
  "egress list": (c, _a, o) => ProductApi.getApiReposOwnerRepoEgressPolicy(c, { path: target(c, o) }),
  "egress allow": async (c, a, o) => {
    const path = target(c, o), wanted = host(a.host)
    const { allow_domains } = await ProductApi.getApiReposOwnerRepoEgressPolicy(c, { path })
    // A host already listed is written again: the write is what reloads the running sandboxes.
    return replace(c, path, allow_domains.includes(wanted) ? allow_domains : [...allow_domains, wanted])
  },
  "egress deny": async (c, a, o) => {
    const path = target(c, o), unwanted = host(a.host)
    const current = await ProductApi.getApiReposOwnerRepoEgressPolicy(c, { path })
    if (!current.allow_domains.includes(unwanted)) {
      throw new Refused({ fault: "user", code: "not_allowed", message: `${unwanted} is not on the allowlist` })
    }
    return replace(c, path, current.allow_domains.filter((domain) => domain !== unwanted))
  }
}
