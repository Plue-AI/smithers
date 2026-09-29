/**
 * A process that pins a tree and then dies.
 *
 * A checkpoint is only worth anything if it survives the process that took it,
 * so the capture happens here and the reading happens somewhere else. It prints
 * `CAPTURED=<ref>` and then holds the process open until it is killed.
 *
 * Usage: `node checkpointChild.ts <repository root> <checkpoint id>`
 */
import * as NodeHost from "@smthrs/platform-node/NodeHost"
import { Checkpoints } from "@smthrs/std"
import * as Effect from "effect/Effect"

const [root, id] = process.argv.slice(2)
if (root === undefined || id === undefined) {
  process.stderr.write("usage: checkpointChild.ts <root> <id>\n")
  process.exit(2)
}

const snapshot = await Effect.runPromise(
  Effect.gen(function*() {
    const checkpoints = yield* Checkpoints.Checkpoints
    return yield* checkpoints.capture(id)
  }).pipe(
    Effect.provide(Checkpoints.layerGit({ root })),
    Effect.provide(NodeHost.layer),
    Effect.scoped,
    Effect.orDie
  )
)

process.stdout.write(`CAPTURED=${snapshot.ref}\n`)
// Held open with a real handle so the parent can kill a live process rather
// than one that already left.
setInterval(() => {}, 1_000)
