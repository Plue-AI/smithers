import * as Context from "effect/Context"
import * as Layer from "effect/Layer"
import * as Redacted from "effect/Redacted"
import { DEFAULT_UPSTREAM_TIMEOUT_MS } from "./Http"

/*
 * The deployment's configuration, read once and typed. Vars and secrets
 * arrive as Worker bindings (wrangler.jsonc `vars` and `wrangler secret put`)
 * under the names in `ServerEnvVars`;
 * this module turns that bag into `ServerConfig`, the service every seam
 * reads. Secrets are `Redacted` so a log line or an error message can never
 * carry one by accident; a seam unwraps the value at the moment it sets a
 * header.
 *
 * A blank or whitespace-only value is absent: `secret put` of an empty
 * string and an unset var read the same.
 */

/** The var and secret names, as bound on the Worker. */
export interface ServerEnvVars {
  readonly SMITHERS_BUILD_SHA?: string
  readonly SMITHERS_CHAT_URL?: string
  readonly SMITHERS_CHAT_ORIGIN?: string
  readonly SMITHERS_CHAT_AUTH_TOKEN?: string
  readonly CHAT_PRODUCT_SERVICE_TOKEN?: string
  readonly UPSTREAM_TIMEOUT_MS?: string
  readonly IDENTITY_UPSTREAM_URL?: string
  readonly IDENTITY_SERVICE_TOKEN?: string
  readonly BILLING_UPSTREAM_URL?: string
  readonly BILLING_AUTH_TOKEN?: string
  readonly BILLING_PRODUCT_SERVICE_TOKEN?: string
  readonly BILLING_ADMIN_TOKEN?: string
  readonly BILLING_CHECKOUT_ENABLED?: string
  readonly BILLING_PORTAL_ENABLED?: string
  readonly SMITHERS_CLOUD_API_BASE_URL?: string
  readonly PLUE_WORKER_EXCHANGE_TOKEN?: string
  readonly ANONYMOUS_TURN_SALT?: string
  readonly CEREBRAS_API_KEY?: string
  readonly CEREBRAS_MODEL_LIBRARIAN?: string
  readonly CEREBRAS_MODEL_FLOWS?: string
  readonly AI_GATEWAY_API_KEY?: string
  /** Optional: base64 of 32 random bytes. Unset disables only account credential enrollment. */
  readonly MODEL_VAULT_KEY?: string
  readonly SMITHERS_GITHUB_APP_ID?: string
  readonly SMITHERS_GITHUB_APP_PRIVATE_KEY?: string
  readonly GITHUB_TOKEN?: string
}

export const DEFAULT_CHAT_URL = "https://chat.smithers.sh/chat"
export const DEFAULT_APP_ORIGIN = "https://smithers.sh"
export const DEFAULT_CLOUD_API_BASE_URL = "https://api.jjhub.tech"

export interface ServerConfigShape {
  /** The sha the site build was stamped with; "unknown" on an unstamped deployment. */
  readonly buildSha: string
  readonly chatUrl: string
  readonly chatOrigin: string | undefined
  readonly chatAuthToken: Redacted.Redacted<string> | undefined
  readonly chatProductServiceToken: Redacted.Redacted<string> | undefined
  /** How long any one upstream gets to send HEADERS, in ms. */
  readonly upstreamTimeoutMs: number
  /** Unset = no seam can authenticate anyone, so every session-gated route refuses deployment_not_configured. */
  readonly identityUpstreamUrl: string | undefined
  readonly identityServiceToken: Redacted.Redacted<string> | undefined
  readonly billingUpstreamUrl: string | undefined
  readonly billingAuthToken: Redacted.Redacted<string> | undefined
  readonly billingProductServiceToken: Redacted.Redacted<string> | undefined
  readonly billingAdminToken: Redacted.Redacted<string> | undefined
  readonly billingCheckoutEnabled: boolean
  readonly billingPortalEnabled: boolean
  readonly cloudApiBaseUrl: string
  readonly plueWorkerExchangeToken: Redacted.Redacted<string> | undefined
  readonly anonymousTurnSalt: Redacted.Redacted<string> | undefined
  /** The Cerebras key the cloud roles (the Librarian, the Flows agent) spend. */
  readonly cerebrasApiKey: Redacted.Redacted<string> | undefined
  readonly cerebrasModelLibrarian: string | undefined
  readonly cerebrasModelFlows: string | undefined
  /** The Vercel AI Gateway key the composer pills and the turn route's front door spend on Jev. Unset, both refuse. */
  readonly aiGatewayApiKey: Redacted.Redacted<string> | undefined
  readonly modelVaultKey: Redacted.Redacted<string> | undefined
  readonly githubAppId: string | undefined
  readonly githubAppPrivateKey: Redacted.Redacted<string> | undefined
  readonly githubToken: Redacted.Redacted<string> | undefined
}

export class ServerConfig extends Context.Service<ServerConfig, ServerConfigShape>()("smithers-server/ServerConfig") {}

const text = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed === "" ? undefined : trimmed
}

const secret = (value: string | undefined): Redacted.Redacted<string> | undefined => {
  const trimmed = text(value)
  return trimmed === undefined ? undefined : Redacted.make(trimmed)
}

/** UPSTREAM_TIMEOUT_MS as the seams read it: a finite positive number of ms, else the default. */
export const upstreamTimeoutFrom = (value: string | undefined): number => {
  const parsed = Number(value ?? "")
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_UPSTREAM_TIMEOUT_MS
}

/*
 * The anonymous salt keeps its exact bytes: the per-address buckets are
 * `sha256(salt + "\n" + address)`, so trimming a salt that was stored with
 * surrounding whitespace would move every existing visitor to a fresh bucket.
 * An unset or empty salt is absent, as before.
 */
const exactSecret = (value: string | undefined): Redacted.Redacted<string> | undefined =>
  value === undefined || value === "" ? undefined : Redacted.make(value)

/** The configuration a bag of vars and secrets describes. */
export const configFrom = (env: ServerEnvVars): ServerConfigShape => ({
  buildSha: text(env.SMITHERS_BUILD_SHA) ?? "unknown",
  chatUrl: text(env.SMITHERS_CHAT_URL) ?? DEFAULT_CHAT_URL,
  chatOrigin: text(env.SMITHERS_CHAT_ORIGIN),
  chatAuthToken: secret(env.SMITHERS_CHAT_AUTH_TOKEN),
  chatProductServiceToken: secret(env.CHAT_PRODUCT_SERVICE_TOKEN),
  upstreamTimeoutMs: upstreamTimeoutFrom(env.UPSTREAM_TIMEOUT_MS),
  identityUpstreamUrl: text(env.IDENTITY_UPSTREAM_URL),
  identityServiceToken: secret(env.IDENTITY_SERVICE_TOKEN),
  billingUpstreamUrl: text(env.BILLING_UPSTREAM_URL),
  billingAuthToken: secret(env.BILLING_AUTH_TOKEN),
  billingProductServiceToken: secret(env.BILLING_PRODUCT_SERVICE_TOKEN),
  billingAdminToken: secret(env.BILLING_ADMIN_TOKEN),
  billingCheckoutEnabled: text(env.BILLING_CHECKOUT_ENABLED) === "1",
  billingPortalEnabled: text(env.BILLING_PORTAL_ENABLED) === "1",
  cloudApiBaseUrl: text(env.SMITHERS_CLOUD_API_BASE_URL) ?? DEFAULT_CLOUD_API_BASE_URL,
  plueWorkerExchangeToken: secret(env.PLUE_WORKER_EXCHANGE_TOKEN),
  anonymousTurnSalt: exactSecret(env.ANONYMOUS_TURN_SALT),
  cerebrasApiKey: secret(env.CEREBRAS_API_KEY),
  cerebrasModelLibrarian: text(env.CEREBRAS_MODEL_LIBRARIAN),
  cerebrasModelFlows: text(env.CEREBRAS_MODEL_FLOWS),
  aiGatewayApiKey: secret(env.AI_GATEWAY_API_KEY),
  modelVaultKey: secret(env.MODEL_VAULT_KEY),
  githubAppId: text(env.SMITHERS_GITHUB_APP_ID),
  githubAppPrivateKey: secret(env.SMITHERS_GITHUB_APP_PRIVATE_KEY),
  githubToken: secret(env.GITHUB_TOKEN)
})

export const configLayer = (env: ServerEnvVars): Layer.Layer<ServerConfig> => Layer.succeed(ServerConfig, configFrom(env))

/** A config for tests: every field absent unless overridden. */
export const testConfig = (overrides: Partial<ServerConfigShape> = {}): ServerConfigShape => ({ ...configFrom({}), ...overrides })

export const testConfigLayer = (overrides: Partial<ServerConfigShape> = {}): Layer.Layer<ServerConfig> =>
  Layer.succeed(ServerConfig, testConfig(overrides))
