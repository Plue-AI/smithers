/**
 * Configured provider diagnostics.
 * @since 1.0.0
 */

import * as Environment from "@smthrs/integrations/Environment"
import * as GitHub from "@smthrs/integrations/github"
import * as Linear from "@smthrs/integrations/linear"
import * as Telegram from "@smthrs/integrations/telegram"
import { Effect, Redacted } from "effect"
import { Cli, z } from "incur"
import { existsSync, readFileSync } from "node:fs"
import { resolve } from "node:path"
import * as Presentation from "../cli/Presentation.ts"
import * as CliError from "../CliError.ts"
import { withCredentials } from "./Credentials.ts"
import { localFields, type LocalOptions, localRoot } from "./Store.ts"

/** An integration request this command refuses; the operator fixes the configuration or the host setup. */
const refused = (fault: CliError.Fault, message: string): CliError.Refused =>
  new CliError.Refused({ fault, code: "operator_failed", message })

// Every operator command reports failures as operator_failed.
const execute = <A>(context: Presentation.Failing, body: () => Promise<A>) =>
  Presentation.guard(context, body, {
    code: "operator_failed",
    next: Presentation.runs({
      otherwise: [{ command: "integrations list", description: "Inspect configured integrations" }]
    })
  })

const provider = z.enum(["github", "linear", "telegram"])
const endpoint = z.string().url().refine((text) => {
  const url = new URL(text)
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
  return (url.protocol === "https:" || (url.protocol === "http:" && loopback)) && url.username === "" &&
    url.password === "" && url.search === "" && url.hash === ""
}, "API endpoint must be HTTP(S), over TLS unless loopback, and without credentials, query or fragment")
const entry = z.strictObject({
  id: z.string().min(1),
  provider,
  tokenEnv: z.string().min(1).optional(),
  credentialId: z.string().min(1).optional(),
  apiBaseUrl: endpoint.optional()
}).refine(
  (item) => item.tokenEnv === undefined || item.credentialId === undefined,
  "Use tokenEnv or credentialId, not both"
)
const configuration = z.strictObject({ version: z.literal(1), integrations: z.array(entry) })

/** One integration's public configuration, containing references rather than tokens.
 * @category models
 * @since 1.0.0
 */
export type Integration = z.infer<typeof entry>

/**
 * What the host already trusts for each provider: the credential variables the
 * provider's own client resolves, its public API, and the host variable that
 * names a self-hosted deployment instead.
 */
const authority = {
  github: {
    tokenEnv: ["SMITHERS_GITHUB_TOKEN", "GITHUB_TOKEN"],
    apiBaseUrl: GitHub.Config.DEFAULT_API_BASE_URL,
    apiBaseUrlEnv: "SMITHERS_GITHUB_API_BASE_URL"
  },
  linear: {
    tokenEnv: ["SMITHERS_LINEAR_API_KEY"],
    apiBaseUrl: Linear.Config.DEFAULT_API_BASE_URL,
    apiBaseUrlEnv: "SMITHERS_LINEAR_API_BASE_URL"
  },
  telegram: {
    tokenEnv: ["SMITHERS_TELEGRAM_BOT_TOKEN"],
    apiBaseUrl: Telegram.Config.DEFAULT_API_BASE_URL,
    apiBaseUrlEnv: "SMITHERS_TELEGRAM_API_BASE_URL"
  }
} as const

const defaultTokenEnv = (kind: Integration["provider"]) => authority[kind].tokenEnv[0]

/** The credential variables a declaration may read: the provider's own, plus whatever the host authorizes. */
const authorizedTokenEnv = (kind: Integration["provider"], env: Readonly<Record<string, string | undefined>>) =>
  new Set<string>([
    ...authority[kind].tokenEnv,
    ...(env["SMITHERS_INTEGRATION_TOKEN_ENV"] ?? "").split(",").map((name) => name.trim()).filter((name) =>
      name.length > 0
    )
  ])

const originOf = (text: string | undefined) => {
  if (text === undefined || text.length === 0) return undefined
  try {
    return new URL(text).origin
  } catch {
    return undefined
  }
}

/** The origins a declaration may send that credential to: the provider's public API and the host's own deployment. */
const authorizedOrigins = (kind: Integration["provider"], env: Readonly<Record<string, string | undefined>>) =>
  new Set(
    [originOf(authority[kind].apiBaseUrl), originOf(env[authority[kind].apiBaseUrlEnv])].filter((origin) =>
      origin !== undefined
    )
  )

/**
 * Rejects a declaration that pairs a credential or destination the host never authorized.
 *
 * Configuration inside the workspace chooses which secret a diagnostic
 * resolves and which origin receives it, so without this an unreviewed
 * repository could label an unrelated host secret as a provider token and have
 * it sent to an endpoint of its own choosing. Repository configuration selects
 * among host-authorized pairings; it does not create them.
 */
const authorize = (item: Integration, env: Readonly<Record<string, string | undefined>>): Integration => {
  if (item.tokenEnv !== undefined && !authorizedTokenEnv(item.provider, env).has(item.tokenEnv)) {
    throw refused(
      "policy",
      `Integration ${item.id} names unauthorized credential variable ${item.tokenEnv}; list it in SMITHERS_INTEGRATION_TOKEN_ENV to authorize it`
    )
  }
  const target = originOf(item.apiBaseUrl)
  if (target !== undefined && !authorizedOrigins(item.provider, env).has(target)) {
    throw refused(
      "policy",
      `Integration ${item.id} names unauthorized ${item.provider} endpoint ${target}; set ${
        authority[item.provider].apiBaseUrlEnv
      } to authorize it`
    )
  }
  return item
}

/** Reads versioned provider configuration, or discovers explicitly configured environment adapters.
 *
 * Every entry is authorized against the host environment, so configuration
 * committed to a repository can only select credentials and provider origins
 * the host itself configured.
 *
 * @category configuration
 * @since 1.0.0
 */
export const readIntegrations = (
  root: string,
  file = ".smithers/integrations.json",
  env = Environment.ambientEnvironment()
): ReadonlyArray<Integration> => {
  const path = resolve(root, file)
  if (!existsSync(path)) {
    if (file !== ".smithers/integrations.json") {
      throw refused("user", `Integration configuration does not exist: ${file}`)
    }
    return (["github", "linear", "telegram"] as const).flatMap((provider) => {
      const tokenEnv = provider === "github" && !env["SMITHERS_GITHUB_TOKEN"] && env["GITHUB_TOKEN"]
        ? "GITHUB_TOKEN"
        : defaultTokenEnv(provider)
      return env[tokenEnv] ? [{ id: provider, provider, tokenEnv }] : []
    })
  }
  let document: unknown
  try {
    document = JSON.parse(readFileSync(path, "utf8"))
  } catch {
    throw refused("user", `${file} is not valid JSON`)
  }
  const parsed = configuration.safeParse(document)
  if (!parsed.success) {
    // Our own refinement sentences, and only the path for the validator's
    // built-in ones: those can quote the offending value, and that value may
    // be a token pasted into the wrong field.
    throw refused(
      "user",
      `Invalid integrations configuration: ${
        [
          ...new Set(parsed.error.issues.map((issue) => {
            const path = issue.path.join(".") || "(root)"
            return issue.code === "custom" ? `${path}: ${issue.message}` : `${path} is invalid`
          }))
        ].join("; ")
      }`
    )
  }
  const ids = parsed.data.integrations.map((item) => item.id)
  if (new Set(ids).size !== ids.length) throw refused("user", "Integration IDs must be unique")
  return parsed.data.integrations.map((item) => authorize(item, env))
}

const select = (entries: ReadonlyArray<Integration>, id?: string) => {
  if (id === undefined) return entries
  const selected = entries.filter((entry) => entry.id === id)
  if (selected.length === 0) throw refused("user", `Unknown integration ${id}`)
  return selected
}

const secret = async (options: LocalOptions, entry: Integration): Promise<string> => {
  if (entry.credentialId !== undefined) {
    return withCredentials(options, (service) =>
      service.get(entry.credentialId!).pipe(
        Effect.flatMap(service.resolve),
        Effect.map(Redacted.value)
      ), true)
  }
  const envName = entry.tokenEnv ?? defaultTokenEnv(entry.provider)
  const value = process.env[envName]
  if (value === undefined || value.length === 0) {
    throw refused("user", `Missing credential environment variable ${envName}`)
  }
  return value
}

/** Probes a provider through its real client, returning no credential or provider response body.
 *
 * Re-checks host authorization at the point the credential leaves the process,
 * so a caller holding a hand-built entry cannot reach an unauthorized origin.
 *
 * @category diagnostics
 * @since 1.0.0
 */
export const probe = async (entry: Integration, token: string, timeoutMs = 10_000) => {
  authorize(entry, Environment.ambientEnvironment())
  const operation = entry.provider === "github"
    ? GitHub.GitHubClient.make({ token, apiBaseUrl: entry.apiBaseUrl, maxRetries: 0 }, {}).request("GET", "/rate_limit")
    : entry.provider === "linear"
    ? Linear.LinearClient.make({ apiKey: token, apiBaseUrl: entry.apiBaseUrl }, {}).query(
      "query SmithersDoctor { viewer { id } }"
    )
    : Telegram.TelegramClient.make({ botToken: token, apiBaseUrl: entry.apiBaseUrl, maxRateLimitRetries: 0 }, {}).call(
      "getMe"
    )
  await Effect.runPromise(operation.pipe(Effect.timeout(timeoutMs)))
  return { id: entry.id, provider: entry.provider, healthy: true }
}

/** Builds provider discovery and diagnostics.
 * @category constructors
 * @since 1.0.0
 */
export const createIntegrationsCli = () => {
  const options = z.object({ ...localFields, config: z.string().default(".smithers/integrations.json") })
  const args = z.object({ id: z.string().optional() })
  return Cli.create("integrations", {
    description: "Inspect configured provider adapters"
  })
    .command("list", {
      description: "List configured integrations and credential references without making requests",
      mcp: { annotations: { readOnlyHint: true } },
      options,
      run: (context) =>
        execute(context, async () => readIntegrations(localRoot(context.options), context.options.config))
    })
    .command("doctor", {
      description: "Check configured credentials and probe provider authentication",
      mcp: { annotations: { readOnlyHint: true } },
      args,
      options: options.extend({
        offline: z.boolean().default(false),
        timeoutMs: z.number().int().positive().default(10_000)
      }),
      run: (context) =>
        execute(context, async () => {
          const entries = select(readIntegrations(localRoot(context.options), context.options.config), context.args.id)
          const results = await Promise.all(entries.map(async (entry) => {
            try {
              const token = await secret(context.options, entry)
              return context.options.offline ?
                { id: entry.id, provider: entry.provider, healthy: true, check: "credential-present" } :
                { ...await probe(entry, token, context.options.timeoutMs), check: "provider-authentication" }
            } catch {
              // Provider error objects can carry nested request details; diagnostics report only inert identifiers.
              return {
                id: entry.id,
                provider: entry.provider,
                healthy: false,
                check: context.options.offline ? "credential-present" : "provider-authentication",
                error: "Credential lookup or provider authentication failed"
              }
            }
          }))
          if (results.some((result) => !result.healthy)) {
            return context.error({
              code: "integration_unhealthy",
              exitCode: 1,
              message: JSON.stringify({ healthy: false, integrations: results })
            })
          }
          return { healthy: true, integrations: results }
        })
    })
}
