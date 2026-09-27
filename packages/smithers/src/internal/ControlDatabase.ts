/** Node adapter for the shared private control persistence layer.
 * @since 1.0.0
 */

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import { Layer } from "effect"
import * as NativeControlDatabase from "./NativeControlDatabase.ts"

/** Opens private control state with the existing Node database adapter.
 * @category layers
 * @since 1.0.0
 */
export const layer = (file: string) =>
  NativeControlDatabase.make((filename) => NodeDatabase.layer({ filename }))(file).pipe(
    Layer.provide(NodeServices.layer)
  )
