import { actorSharedState } from "../ActorBindings"
import { preparedView, type ViewAction } from "../PreparedView"
/*
 * The agent-environment seam: GET/PUT /api/repos/{owner}/{repo}/
 * agent-environment. Environment VARS and the setup script read and write
 * here; SECRETS are write-only upstream and only their metadata (name, egress
 * binding, updated time) is parsed, for the secrets card (SecretsSeam.ts).
 * Reference: multi src/smithersCloud/agentEnvironment.ts.
 */
import type { Card } from "../AppState"
import { resolveTargetRepo } from "../RepoContext"
import type { SeamContext } from "./SeamContext"
import { readErrorMessage } from "./SeamContext"

export interface EnvironmentSeam {
  readonly viewEnvironment: ViewAction<[repo?: string]>
  /** `assignment` is one `NAME=value` pair; the seam validates the shape. */
  readonly setEnvironmentVar: (assignment: string, repo?: string) => ReturnType<ViewAction<[repo?: string]>>
  /** Saves the platform's redacted answer back, which drops a refused subscription token. */
  readonly removeSubscriptionToken: ViewAction<[repo?: string]>
}

/** The variable-name shape the platform accepts (multi environmentStore.ts). */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

interface EnvironmentVariable {
  readonly name: string
  readonly value: string
}

/**
 * One secret's metadata, mirrored from plue's AgentEnvironmentSecretMetadata:
 * there is no value field upstream, so none exists here. `hosts` and
 * `matchHeaders` are the egress-proxy binding; both empty means a setup-only
 * secret the guest holds as a NAME placeholder.
 */
export interface SecretMetadata {
  readonly name: string
  readonly hosts: ReadonlyArray<string>
  readonly matchHeaders: ReadonlyArray<string>
  /** The wire's ISO timestamp, or null when the answer carries none. */
  readonly updatedAt: string | null
}

/** The platform's answer, camel-cased; secret VALUES never exist here. */
export interface EnvironmentConfig {
  readonly setupScript: string
  readonly env: ReadonlyArray<EnvironmentVariable>
  readonly secrets: ReadonlyArray<SecretMetadata>
  /** The platform redacted a subscription token it refuses to use. */
  readonly reconnect: boolean
}

/** A list of strings, or null when the field is present with another shape; an absent field is an empty list. */
const parseStrings = (value: unknown): ReadonlyArray<string> | null => {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value)) return null
  const out: string[] = []
  for (const entry of value) {
    if (typeof entry !== "string") return null
    out.push(entry)
  }
  return out
}

/*
 * The wire answer, mirrored from multi's parseAgentEnvironmentConfig and
 * plue's AgentEnvironmentResponse: snake_case fields, env rows {name, value},
 * secret rows {name, hosts, match_headers, updated_at} with no value. Off-shape
 * answers null out rather than throwing; the seam's channel is the honest
 * error string. Exported for the secrets seam, which reads the same document.
 */
export const parseEnvironment = (wire: unknown): EnvironmentConfig | null => {
  if (typeof wire !== "object" || wire === null) return null
  const row = wire as { setup_script?: unknown; env?: unknown; secrets?: unknown; reconnect_required?: unknown }
  if (typeof row.setup_script !== "string" || !Array.isArray(row.env) || !Array.isArray(row.secrets)) {
    return null
  }
  const env: EnvironmentVariable[] = []
  for (const entry of row.env) {
    const pair = entry as { name?: unknown; value?: unknown } | null
    if (typeof pair !== "object" || pair === null) return null
    if (typeof pair.name !== "string" || pair.name === "" || typeof pair.value !== "string") return null
    env.push({ name: pair.name, value: pair.value })
  }
  const secrets: SecretMetadata[] = []
  for (const entry of row.secrets) {
    const secret = entry as { name?: unknown; hosts?: unknown; match_headers?: unknown; updated_at?: unknown } | null
    if (typeof secret !== "object" || secret === null) return null
    if (typeof secret.name !== "string" || secret.name === "") return null
    const hosts = parseStrings(secret.hosts)
    const matchHeaders = parseStrings(secret.match_headers)
    if (hosts === null || matchHeaders === null) return null
    secrets.push({
      name: secret.name,
      hosts,
      matchHeaders,
      updatedAt: typeof secret.updated_at === "string" && secret.updated_at !== "" ? secret.updated_at : null
    })
  }
  return { setupScript: row.setup_script, env, secrets, reconnect: row.reconnect_required === true }
}

/** The one agent-environment document URL for a repository. */
export const environmentUrl = (ctx: SeamContext, repo: string): string => {
  const [owner = "", name = ""] = repo.split("/")
  return `${ctx.baseUrl}/api/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/agent-environment`
}

/** GET the environment; an honest string on any failure, the config otherwise. */
export const readEnvironment = async (ctx: SeamContext, repo: string): Promise<EnvironmentConfig | string> => {
  let response: Response
  try {
    response = await ctx.http(environmentUrl(ctx, repo))
  } catch {
    return `The agent environment for ${repo} couldn't be read — the platform didn't answer.`
  }
  if (!response.ok) {
    return readErrorMessage(
      response,
      `The agent environment for ${repo} couldn't be read (HTTP ${response.status}).`
    )
  }
  const body: unknown = await response.json().catch(() => null)
  const config = parseEnvironment(body)
  if (config === null) {
    return `The agent-environment answer for ${repo} wasn't in the expected shape.`
  }
  return config
}

/** One `NAME=value` pair, split on the FIRST `=` so values may carry more. */
const parseAssignment = (assignment: string): EnvironmentVariable | string => {
  const text = assignment.trim()
  const eq = text.indexOf("=")
  if (eq === -1) {
    return `"${text}" isn't a NAME=value pair — write it like NODE_ENV=production`
  }
  const name = text.slice(0, eq)
  const value = text.slice(eq + 1)
  if (!ENV_NAME.test(name)) {
    return `"${name}" isn't a valid variable name — letters, digits, and underscores only, starting with a letter or underscore`
  }
  return { name, value }
}

/** The merge rule from multi's mergeAgentEnvironmentVariable: replace, then sort by name. */
const mergeVariable = (
  env: ReadonlyArray<EnvironmentVariable>,
  name: string,
  value: string
): EnvironmentVariable[] =>
  [...env.filter((variable) => variable.name !== name), { name, value }].sort((a, b) => a.name.localeCompare(b.name))

export const createEnvironmentSeam = (ctx: SeamContext): EnvironmentSeam => {
  const writes = actorSharedState(ctx, "environment-writes", () => new Map<string, Promise<void>>())
  const serialize = async <A>(repo: string, work: () => Promise<A>): Promise<A> => {
    const previous = writes.get(repo) ?? Promise.resolve()
    let release!: () => void
    const current = new Promise<void>((resolve) => {
      release = resolve
    })
    writes.set(repo, current)
    await previous
    try {
      return await work()
    } finally {
      release()
      if (writes.get(repo) === current) writes.delete(repo)
    }
  }
  const fetchEnvironment = (repo: string): Promise<EnvironmentConfig | string> => readEnvironment(ctx, repo)

  /**
   * The one env card per repo, re-surfaced at the transcript's end on every
   * read. Secrets are not this card's: /secrets.list renders their metadata.
   */
  const environmentCard = (repo: string, config: EnvironmentConfig): Card => {
    const card: Card = {
      id: `env-${repo}`,
      kind: "env",
      title: `Agent environment · ${repo}`,
      status: "active",
      createdAt: Date.now(),
      ordinal: ctx.nextOrdinal(),
      payload: {
        repo,
        vars: config.env.map((variable) => ({ name: variable.name, value: variable.value })),
        setupScript: config.setupScript === "" ? null : config.setupScript,
        ...(config.reconnect ? { reconnect: true } : {})
      }
    }
    return card
  }

  const viewEnvironment = preparedView(ctx, (repo?: string) => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    return { id: `env-${target.repo}`, title: `Agent environment · ${target.repo}`, read: async () => {
      const config = await fetchEnvironment(target.repo)
      return typeof config === "string" ? config : { card: environmentCard(target.repo, config) }
    } }
  })

  /** PUT the whole document; an honest string on failure, null once saved. */
  const putEnvironment = async (
    repo: string,
    setupScript: string,
    env: ReadonlyArray<EnvironmentVariable>,
    subject: string
  ): Promise<string | null> => {
    let response: Response
    try {
      response = await ctx.http(environmentUrl(ctx, repo), {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          setup_script: setupScript,
          env: env.map((variable) => ({ name: variable.name, value: variable.value }))
        })
      })
    } catch {
      return `${subject} couldn't be saved to ${repo} — the platform didn't answer.`
    }
    if (!response.ok) {
      return readErrorMessage(response, `${subject} couldn't be saved to ${repo} (HTTP ${response.status}).`)
    }
    await response.body?.cancel()
    return null
  }

  const setEnvironmentVar = async (assignment: string, repo?: string): ReturnType<ViewAction<[repo?: string]>> => {
    const pair = parseAssignment(assignment)
    if (typeof pair === "string") return pair
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    return serialize(target.repo, async () => {
      // Read-merge-write: the platform stores the WHOLE environment, so the
      // one pair merges into the current answer and the whole document goes
      // back (multi set-env-var/command.ts).
      const current = await fetchEnvironment(target.repo)
      if (typeof current === "string") return current
      // A refused token is removed on purpose (env.remove-token), never as a
      // side effect that could also drop a withheld setup script.
      if (current.reconnect) return `Remove the subscription token from ${target.repo} first.`
      const failure = await putEnvironment(target.repo, current.setupScript, mergeVariable(current.env, pair.name, pair.value), pair.name)
      if (failure !== null) return failure
      // The refreshed card states the platform's answer, not the local merge.
      return viewEnvironment(target.repo)
    })
  }

  const removeSubscriptionToken = async (repo?: string): ReturnType<ViewAction<[repo?: string]>> => {
    const target = resolveTargetRepo(ctx.store, repo)
    if ("error" in target) return target.error
    return serialize(target.repo, async () => {
      // The platform's answer already has the token redacted and its
      // variables left out; saving it back replaces the stored value.
      const current = await fetchEnvironment(target.repo)
      if (typeof current === "string") return current
      if (current.reconnect) {
        const failure = await putEnvironment(target.repo, current.setupScript, current.env, "The agent environment")
        if (failure !== null) return failure
      }
      return viewEnvironment(target.repo)
    })
  }

  return { viewEnvironment, setEnvironmentVar, removeSubscriptionToken }
}
