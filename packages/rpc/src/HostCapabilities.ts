/**
 * Capabilities advertised by the current application host.
 *
 * @since 1.0.0
 */
import type { RuntimeCapability } from "./AppBootstrap.ts"

/**
 * The one place each host's bootstrap capability list is spelled out.
 *
 * The Worker (`apps/server/src/index.ts`, host `cloud`) and the Bun server
 * (`apps/app/src/bun/server.ts`, host `local`) call these with what they have
 * configured, and the parity test builds its registries from the same two
 * functions, so the matrix cannot drift from production. Each table is the
 * emission order; a row is kept only when its flag is on. The Go backend
 * (`packages/backend/internal/compose/bootstrap.go`) is a `cloud` host too,
 * hosted or self-hosted, and keeps its own list.
 */

/** What the Worker has configured. `terminal` names the same-origin workspace terminal relay.
 * @since 1.0.0
 * @category models
 */
export interface CloudCapabilityEnv {
  readonly overview?: boolean
  readonly plans?: boolean
  readonly portal?: boolean
  readonly balance?: boolean
  readonly browser?: boolean
  readonly identity: boolean
  readonly cloud: boolean
  readonly agent: boolean
  readonly checkout: boolean
  readonly terminal: boolean
  readonly recommend?: boolean
}

/** What a Bun launch has configured. `cloud` is the cloud upstream; offline launches have none.
 * `nativeShell` is true only when the desktop shell (`src/bun/NativeApp.ts`) started this host as its renderer origin.
 * @since 1.0.0
 * @category models
 */
export interface LocalCapabilityOptions {
  readonly overview?: boolean
  readonly plans?: boolean
  readonly portal?: boolean
  readonly balance?: boolean
  readonly browser?: boolean
  readonly agent: boolean
  readonly identity: boolean
  readonly cloud: boolean
  readonly recommend?: boolean
  readonly nativeShell?: boolean
}

const present = (rows: ReadonlyArray<readonly [RuntimeCapability, boolean]>): Array<RuntimeCapability> =>
  rows.filter(([, on]) => on).map(([capability]) => capability)

/** The Worker never emits `cloud.pat`: it holds no PAT session; the GitHub cookie is its only identity.
 * @since 1.0.0
 * @category conversions
 */
export const cloudCapabilities = (env: CloudCapabilityEnv): Array<RuntimeCapability> =>
  present([
    ["agent", env.agent],
    ["browser.read", env.browser === true],
    ["identity", env.identity],
    ["cloud", env.cloud],
    ["billing.balance", env.balance === true],
    ["billing.overview", env.overview === true],
    ["billing.plans", env.plans === true],
    ["billing.checkout", env.checkout],
    ["billing.portal", env.portal === true],
    ["cloud.terminal", env.terminal],
    ["recommend", env.recommend === true]
  ])

/**
 * Both cloud doors ride the Smithers Cloud upstream: without one, the Bun server
 * answers 501 on `/api/cloud-auth/*` and on the `/api/cloud-ws/` tunnel, so
 * claiming either would name a door the host has closed.
 * @since 1.0.0
 * @category conversions
 */
export const localCapabilities = (opts: LocalCapabilityOptions): Array<RuntimeCapability> =>
  present([
    ["agent", opts.agent],
    ["model.turn", true],
    ["browser.read", opts.browser === true],
    ["identity", opts.identity],
    ["cloud", opts.cloud],
    ["billing.balance", opts.balance === true],
    ["billing.overview", opts.overview === true],
    ["billing.plans", opts.plans === true],
    ["billing.portal", opts.portal === true],
    ["cloud.terminal", opts.cloud],
    ["cloud.pat", opts.cloud],
    ["recommend", opts.recommend === true],
    ["native.shell", opts.nativeShell === true]
  ])
