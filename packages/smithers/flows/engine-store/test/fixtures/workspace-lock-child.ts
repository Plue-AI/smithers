/**
 * Holds the workspace commit lock until killed: materializes one file and
 * stalls its data write, after the lock is taken, forever.
 */
import * as NodeCrypto from "@effect/platform-node/NodeCrypto"
import * as ArtifactStore from "@smthrs/artifacts/ArtifactStore"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as AtomicFileSystem from "@smthrs/platform-node/AtomicFileSystem"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import { createHash } from "node:crypto"
import * as WorkspaceSandbox from "../../src/WorkspaceSandbox.ts"
import { hostPath } from "../HostPath.ts"

const root = process.argv[2]
if (root === undefined) {
  process.stderr.write("usage: workspace-lock-child.ts <root>\n")
  process.exitCode = 2
} else {
  const bytes = new TextEncoder().encode("child")
  const program = Effect.gen(function*() {
    const fs = yield* FileSystem.FileSystem
    const atomic = (fs as KernelFileSystem.AtomicHostFileSystem)[KernelFileSystem.AtomicFileSystemTypeId]
    const stalled = KernelFileSystem.withAtomicFileSystem({ ...fs }, {
      ...atomic,
      execute: (request) =>
        request.operation === "writeFile"
          ? Effect.sync(() => process.stdout.write("locked\n")).pipe(Effect.andThen(Effect.never))
          : atomic.execute(request)
    })
    const sandbox = WorkspaceSandbox.makeFileSystem(stalled, hostPath, ArtifactStore.makeNoop(), root)
    yield* sandbox.materialize({
      _tag: "Accepted",
      cache: { status: "disabled" },
      violations: [],
      result: {
        output: null,
        effects: [],
        provenance: { baseRevision: "base", inputs: [], outputs: [] },
        files: [{ path: "file", afterDigest: createHash("sha256").update(bytes).digest("hex"), after: bytes }]
      }
    } as never)
  }).pipe(Effect.provide(AtomicFileSystem.layer), Effect.provide(NodeCrypto.layer))
  Effect.runPromise(program).catch((cause) => {
    process.stderr.write(`${String(cause)}\n`)
    process.exitCode = 1
  })
}
