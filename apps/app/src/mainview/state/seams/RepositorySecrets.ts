/*
 * A repository's CI secrets (GET /api/repos/{owner}/{repo}/secrets): the one
 * store the secrets card, /secrets.list, .set, .delete, .scope and .bind all
 * address. Metadata only: the wire has no value. The agent environment's
 * secrets (EnvironmentSeam.ts) are a different store.
 */
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface RepositorySecret {
  readonly name: string
  readonly mainOnly: boolean
  readonly hosts: ReadonlyArray<string>
  readonly matchHeaders: ReadonlyArray<string>
  /** The wire's ISO timestamp, or null when the answer carries none. */
  readonly updatedAt: string | null
  /** The platform found a subscription token in it and refuses to use it. */
  readonly reconnect: boolean
}

/** The secrets collection URL, or one secret's when a name is given. */
export const repositorySecretsUrl = (ctx: SeamContext, repo: string, name?: string): string => {
  const [owner = "", repoName = ""] = repo.split("/")
  const base = `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/secrets`
  return name === undefined ? base : `${base}/${encodeURIComponent(name)}`
}

const strings = (value: unknown): ReadonlyArray<string> | null => {
  if (value === undefined || value === null) return []
  return Array.isArray(value) && value.every((entry): entry is string => typeof entry === "string") ? value : null
}

const parseSecrets = (wire: unknown): RepositorySecret[] | null => {
  if (!Array.isArray(wire)) return null
  const out: RepositorySecret[] = []
  for (const entry of wire) {
    const row = entry as { name?: unknown; main_only?: unknown; hosts?: unknown; match_headers?: unknown; updated_at?: unknown; reconnect_required?: unknown } | null
    if (typeof row !== "object" || row === null || typeof row.name !== "string" || row.name === "") return null
    const hosts = strings(row.hosts)
    const matchHeaders = strings(row.match_headers)
    if (hosts === null || matchHeaders === null) return null
    out.push({
      name: row.name,
      mainOnly: row.main_only === true,
      hosts,
      matchHeaders,
      updatedAt: typeof row.updated_at === "string" && row.updated_at !== "" ? row.updated_at : null,
      reconnect: row.reconnect_required === true
    })
  }
  return out
}

/** GET the repository's secrets; an honest string on any failure. */
export const readRepositorySecrets = async (ctx: SeamContext, repo: string): Promise<ReadonlyArray<RepositorySecret> | string> => {
  let response: Response
  try {
    response = await ctx.http(repositorySecretsUrl(ctx, repo))
  } catch {
    return `The secrets for ${repo} couldn't be read — the platform didn't answer.`
  }
  if (!response.ok) return readErrorMessage(response, `The secrets for ${repo} couldn't be read (HTTP ${response.status}).`)
  const secrets = parseSecrets(await response.json().catch(() => null))
  return secrets ?? `The secrets answer for ${repo} wasn't in the expected shape.`
}
