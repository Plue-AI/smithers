/**
 * Bootstrap responses for native and web application sessions.
 *
 * @since 1.0.0
 */

import { z } from "zod"

/**
 * Shared app api version used by the host and its clients.
 *
 * @since 1.0.0
 * @category constants
 */
export const APP_API_VERSION = 1 as const
/**
 * The app bootstrap route shared by server and client.
 *
 * @since 1.0.0
 * @category constants
 */
export const APP_BOOTSTRAP_PATH = "/api/bootstrap"

/**
 * Validates runtime capability values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const RuntimeCapabilitySchema = z.enum([
  "agent",
  "model.turn", // sealed turns on a configured model, independent of the default agent
  "recommend", // provider-backed command recommendations
  "commands.select", // the decision model selects each chat message's commands (POST /api/commands/select)
  "browser.read", // guarded, pinned HTTPS page reads on this host
  "identity",
  "install", // this origin serves the single-owner install setup routes
  "github", // GitHub OAuth and import are configured on this host
  "cloud",
  "billing.balance", // the host serves an account balance read, independently of checkout
  "billing.overview",
  "billing.plans",
  "billing.checkout",
  "billing.portal",
  // Cloud doors a host serves itself, declared by the host that opens them
  // (packages/rpc/src/HostCapabilities.ts holds the per-host tables).
  "cloud.terminal", // this origin tunnels workspace terminals (/api/cloud-ws/*)
  "cloud.pat", // a host-held Smithers Cloud PAT session (/api/cloud-auth/*)
  /*
   * The desktop shell (Electrobun) serves this origin: its renderer relay
   * appends the row to the backend's bootstrap, and the packaged Bun host
   * emits it when the shell starts it. No web origin — hosted or self-hosted —
   * ever reports it, so native-shell UI reads this row and never `host`.
   */
  "native.shell"
])
/**
 * The decoded value accepted by {@link RuntimeCapabilitySchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type RuntimeCapability = z.infer<typeof RuntimeCapabilitySchema>

/**
 * Validates app bootstrap values at the RPC boundary.
 *
 * @since 1.0.0
 * @category schemas
 */
export const AppBootstrapSchema = z.object({
  apiVersion: z.literal(APP_API_VERSION),
  /**
   * The API surface: `cloud` is every web origin the product serves — the
   * Worker, the hosted backend and a self-hosted backend alike — and `local`
   * is the Bun host (`apps/app/src/bun/server.ts`). Which shell shows the page
   * is the `native.shell` capability, and which sign-in door the origin has is
   * `authFlow`; neither is read from this field.
   */
  host: z.enum(["cloud", "local"]),
  version: z.string(),
  buildSha: z.string(),
  // Capability names are additive within this API version. Validate the wire
  // shape before filtering so a newer host cannot disable an older client,
  // while malformed rows still fail and producers retain the strict enum.
  capabilities: z.array(z.string()).transform((capabilities) =>
    capabilities.filter(
      (capability): capability is RuntimeCapability => RuntimeCapabilitySchema.safeParse(capability).success
    )
  ),
  authFlow: z.enum(["redirect", "credentials", "native-handoff", "both", "none"]),
  sandbox: z.object({
    platform: z.string(),
    mode: z.enum(["enforced", "trusted-only", "unavailable"]),
    /** What this host actually enforces per child: the loader profile is macOS-only and target runs are never wrapped. */
    policies: z.object({
      loader: z.enum(["enforced", "unenforced"]),
      targetRun: z.enum(["enforced", "unenforced"])
    }).optional()
  }).nullable()
})
/**
 * The decoded value accepted by {@link AppBootstrapSchema}.
 *
 * @since 1.0.0
 * @category models
 */
export type AppBootstrap = z.infer<typeof AppBootstrapSchema>

/**
 * True when the bootstrap lists the capability.
 *
 * @since 1.0.0
 * @category conversions
 */
export const hasCapability = (bootstrap: AppBootstrap, capability: RuntimeCapability): boolean =>
  bootstrap.capabilities.includes(capability)

/**
 * True when the desktop shell serves this origin (`native.shell`). Every
 * native-shell behaviour in the app reads this and never `host`: a self-hosted
 * backend is a web origin like the hosted one, and only the shell reports the row.
 * A missing bootstrap is no shell.
 *
 * @since 1.0.0
 * @category conversions
 */
export const nativeShell = (bootstrap: Pick<AppBootstrap, "capabilities"> | undefined): boolean =>
  bootstrap !== undefined && bootstrap.capabilities.includes("native.shell")
