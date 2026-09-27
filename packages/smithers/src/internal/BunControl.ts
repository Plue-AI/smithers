/** Private Bun boundary for the shared native control host; no Node sidecar.
 * @since 1.0.0
 */

import * as BunCrypto from "@effect/platform-bun/BunCrypto"
import * as BunHttpClient from "@effect/platform-bun/BunHttpClient"
import * as BunServices from "@effect/platform-bun/BunServices"
import * as Database from "@smthrs/database/bun/BunDatabase"
import * as Runtime from "@smthrs/flows/BunRuntime"
import * as Gateway from "@smthrs/gateway/bun/BunGateway"
import * as Jj from "@smthrs/jj/bun/BunJj"
import * as RequestExecutor from "@smthrs/model/RequestExecutor"
import { Layer } from "effect"
import * as ControlFileSystem from "./ControlFileSystem.ts"
import * as NativeControl from "./NativeControl.ts"
import * as NativeControlDatabase from "./NativeControlDatabase.ts"

/** Select existing Bun adapters for the single native control composition.
 * @since 1.0.0
 * @private
 */
export const platform: NativeControl.Platform = {
  host: Layer.provideMerge(ControlFileSystem.layer(), BunServices.layer),
  crypto: BunCrypto.layer,
  database: (file) =>
    NativeControlDatabase.make((filename) => Database.layer({ filename }))(file).pipe(
      Layer.provide(BunServices.layer),
      Layer.orDie
    ),
  runtime: Runtime.layer,
  jj: Jj.layerAt,
  // Bun's fetch client exposes no replaceable dispatcher. The existing fixed
  // RequestExecutor transport is explicit about that platform limitation.
  requestExecutor: RequestExecutor.layer.pipe(Layer.provide(BunHttpClient.layer)),
  gateway: Gateway.layer,
  bearerPrincipal: Gateway.bearerPrincipal
}

/** Default Bun composition; private configured hosts reuse the same adapters.
 * @since 1.0.0
 * @private
 */
export const native = NativeControl.make(platform)
