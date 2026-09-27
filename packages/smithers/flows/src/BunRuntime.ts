/** Bun host composition over the shared, injected durable runtime.
 * @since 1.0.0
 */

import * as Database from "@smthrs/database/bun/BunDatabase"
import * as Host from "@smthrs/platform-bun/BunHost"
import { makeNative } from "./internal/NativeRuntime.ts"
import type { NativeRuntimeApi } from "./internal/NativeRuntimeApi.ts"

export type { HostOptions } from "./internal/NativeRuntime.ts"
export { RuntimeConfigurationError } from "./Runtime.ts"
export type { Options } from "./Runtime.ts"

const runtime = makeNative({
  name: "BunRuntime",
  database: (filename) => Database.layer({ filename }),
  host: Host,
  crypto: Host.BunCrypto.layer
})

/** Provides the migrated stores over the native SQL driver.
 * @since 1.0.0
 * @category layers
 */
export const storage: NativeRuntimeApi["storage"] = runtime.storage
/** Builds the shared durable runtime in the caller’s Effect scope.
 * @since 1.0.0
 * @category layers
 */
export const make: NativeRuntimeApi["make"] = runtime.make
/** Provides the shared runtime with an explicitly supplied execution boundary.
 * @since 1.0.0
 * @category layers
 */
export const layer: NativeRuntimeApi["layer"] = runtime.layer
/** Provides the native host, guarded services, database and registered flows.
 * @since 1.0.0
 * @category layers
 */
export const layerHost: NativeRuntimeApi["layerHost"] = runtime.layerHost
/** Returns the conventional exit code for a native shutdown signal.
 * @since 1.0.0
 * @category layers
 */
export const signalExitCode: NativeRuntimeApi["signalExitCode"] = runtime.signalExitCode
/** Default graceful-shutdown deadline in milliseconds.
 * @since 1.0.0
 * @category layers
 */
export const defaultShutdownTimeoutMs: NativeRuntimeApi["defaultShutdownTimeoutMs"] = runtime.defaultShutdownTimeoutMs
/** Largest supported native shutdown timer delay.
 * @since 1.0.0
 * @category layers
 */
export const maximumShutdownTimeoutMs: NativeRuntimeApi["maximumShutdownTimeoutMs"] = runtime.maximumShutdownTimeoutMs
