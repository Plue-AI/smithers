/**
 * `smthrs egress`: a repository's egress allowlist (#2653). Its owner lists
 * the hosts the repository's sandboxes may reach besides the deployment's own
 * list, allows one more or denies one again; every running sandbox of the
 * repository reloads the new list. Each write names only its own host, so two
 * owners writing at once never undo each other (#3263).
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


/** @private
 * @since 1.0.0
 */
export const egress: Record<string, Handler> = {
  "egress list": (c, _a, o) => ProductApi.getApiReposOwnerRepoEgressPolicy(c, { path: target(c, o) }),
  // A host already listed is added again: the write is what reloads the running sandboxes.
  "egress allow": (c, a, o) =>
    ProductApi.patchApiReposOwnerRepoEgressPolicy(c, { path: target(c, o), body: { add: [host(a.host)] } }),
  "egress deny": async (c, a, o) => {
    const path = target(c, o), unwanted = host(a.host)
    // The read only refuses a typo; the removal itself is atomic on the server.
    const current = await ProductApi.getApiReposOwnerRepoEgressPolicy(c, { path })
    if (!current.allow_domains.includes(unwanted)) {
      throw new Refused({ fault: "user", code: "not_allowed", message: `${unwanted} is not on the allowlist` })
    }
    return ProductApi.patchApiReposOwnerRepoEgressPolicy(c, { path, body: { remove: [unwanted] } })
  }
}
