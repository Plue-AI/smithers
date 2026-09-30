/**
 * `smthrs workspace children`: spawn, list and stop a workspace's children
 * (#2802). Outside a workspace it uses the signed-in account; inside one it
 * uses the workspace's own children credential, which reaches only these
 * routes of that workspace.
 * @since 1.0.0
 */

import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { UsageError } from "../../CliError.ts"
import { type Client, esc, object, str, type Values } from "./Client.ts"
import type { Handler } from "./Resources.ts"

/** Where the control plane writes the workspace's identity and credential.
 * @private
 * @since 1.0.0
 */
export const guest = {
  config: "/etc/smithers/workspace-coding.json",
  token: ".config/smithers/workspace-children-token"
}

interface Target {
  readonly path: string
  readonly options: { origin?: string; token?: string }
}

const read = async (path: string): Promise<string | undefined> => {
  try {
    return (await readFile(path, "utf8")).trim()
  } catch {
    return undefined
  }
}

/** The workspace this machine is, when it holds a children credential. */
const inside = async (c: Client): Promise<{ id: string; slug: string; origin: string; token: string } | undefined> => {
  const [config, token] = await Promise.all([
    read(c.env.SMITHERS_WORKSPACE_CODING_CONFIG ?? guest.config),
    read(c.env.SMITHERS_WORKSPACE_CHILDREN_TOKEN_FILE ?? join(c.home, guest.token))
  ])
  if (!config || !token) return undefined
  let parsed: Values
  try {
    parsed = object(JSON.parse(config))
  } catch {
    return undefined
  }
  const id = str(parsed.workspaceId), slug = str(parsed.repositorySlug), api = str(parsed.apiBaseUrl)
  if (!id || !slug || !api) return undefined
  return { id, slug, origin: api.replace(/\/+$/, "").replace(/\/api$/, ""), token }
}

/** The parent's children path and the credential that reaches it. */
const target = async (c: Client, o: Values): Promise<Target> => {
  const here = o.repo === undefined ? await inside(c) : undefined
  const id = str(o.workspace) || here?.id
  if (!id) throw new UsageError({ message: "--workspace is required outside a workspace" })
  if (here && id.toLowerCase() === here.id.toLowerCase()) {
    return {
      path: `/api/repos/${here.slug.split("/").map(esc).join("/")}/workspaces/${esc(id)}/children`,
      options: { origin: here.origin, token: here.token }
    }
  }
  return { path: `${c.repoPath(o.repo ?? here?.slug)}/workspaces/${esc(id)}/children`, options: {} }
}

const count = (value: unknown): number => {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new UsageError({ message: "--count must be a positive whole number" })
  return n
}

/** @private
 * @since 1.0.0
 */
export const workspaceChildren: Record<string, Handler> = {
  "workspace children spawn": async (c, _a, o) => {
    const { path, options } = await target(c, o)
    const body: Values = { count: count(o.count) }
    if (o.profile !== undefined) body.profile = str(o.profile)
    if (o.ttl !== undefined) body.ttl_secs = Number(o.ttl)
    return c.request("POST", path, body, options)
  },
  "workspace children list": async (c, _a, o) => {
    const { path, options } = await target(c, o)
    return c.request("GET", path, undefined, options)
  },
  "workspace children stop": async (c, a, o) => {
    const { path, options } = await target(c, o)
    return c.request("POST", `${path}/${esc(a.child)}/stop`, undefined, options)
  }
}
