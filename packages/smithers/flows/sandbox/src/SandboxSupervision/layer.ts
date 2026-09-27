/**
 * Provides a supervised spawner as a layer.
 *
 * @since 0.1.0
 */

import * as Layer from "effect/Layer"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import type { Provider } from "../RemoteChildProcessSpawner/Provider.ts"
import { make } from "./make.ts"
import type { Options } from "./Options.ts"

/**
 * Provides `ChildProcessSpawner` backed by a supervised remote session.
 *
 * Use it in place of `RemoteChildProcessSpawner.layer` when the provider can
 * be pinged. The two differ in one way that matters: under the plain adapter a
 * session that dies leaves its commands waiting forever, and under this one it
 * fails them so a retry policy can move the work to a fresh session.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (provider: Provider, options: Options): Layer.Layer<ChildProcessSpawner> =>
  Layer.effect(ChildProcessSpawner, make(provider, options))
