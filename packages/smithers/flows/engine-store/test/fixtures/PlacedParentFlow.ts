/**
 * The parent the cross-host recovery drill (#2784) drives on the caller
 * engine. Its one step is `RemoteWrite` as a child, which the caller's `Hosts`
 * table places on the serving engine. Declared in its own module because the
 * caller fixture process and the case that checks its journal need the same
 * declaration.
 */
import { Flow } from "@smthrs/flow"
import { Node } from "@smthrs/plan"
import * as Schema from "effect/Schema"
import { RemoteWrite } from "./RemoteCeilingFlow.ts"

export const PlacedParent = Flow.make("cross-host-recovery/parent", {
  payload: { name: Schema.String, waitMs: Schema.Number },
  success: Schema.String,
  body: (payload) => RemoteWrite.child(payload).pipe(Node.map((result) => `parent saw ${result}`))
})
