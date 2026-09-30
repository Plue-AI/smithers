import * as NodePath from "@effect/platform-node/NodePath"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, FileSystem, Layer, Result } from "effect"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as AtomicFileSystem from "../src/AtomicFileSystem.ts"

it.each(["before grant", "during grant"])("refuses a logical workspace retargeted %s", async (phase) => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "smithers-batch-root-alias-")))
  const original = join(directory, "original")
  const replacement = join(directory, "replacement")
  const logical = join(directory, "workspace")
  const grants: Array<string> = []
  let retargetOnGrant = false
  const retarget = async () => {
    await unlink(logical)
    await symlink(replacement, logical)
  }
  try {
    await mkdir(original)
    await mkdir(replacement)
    await writeFile(join(original, "a"), "original private bytes")
    await writeFile(join(replacement, "a"), "replacement public bytes")
    await symlink(original, logical)
    const host = KernelFileSystem.layer.pipe(
      Layer.provide(AtomicFileSystem.layer),
      Layer.provide(NodePath.layer),
      Layer.provide(Workspace.layer(logical)),
      Layer.provide(Layer.succeed(GrantStore.GrantStore, {
        ...GrantStore.makeNoop,
        check: (capability) =>
          Effect.promise(async () => {
            grants.push(capability.resource)
            if (retargetOnGrant) await retarget()
          })
      }))
    )
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const baseline = yield* KernelFileSystem.batch(fs)!.execute([{ operation: "digest", path: "a" }])
        expect(Result.getOrThrow(baseline.entries[0]!.result)).toMatchObject({
          digest: createHash("sha256").update("original private bytes").digest("hex")
        })
        expect(grants).toEqual([join(logical, "a")])
        grants.length = 0
        if (phase === "before grant") yield* Effect.promise(retarget)
        else retargetOnGrant = true
        const before = AtomicFileSystem.helperSpawns()
        const result = yield* Effect.result(KernelFileSystem.batch(fs)!.execute([{ operation: "digest", path: "a" }]))
        expect(result).toMatchObject({ _tag: "Failure", failure: { reason: { _tag: "Busy" } } })
        expect(grants).toEqual(phase === "before grant" ? [] : [join(logical, "a")])
        // The measured batch never starts. Retargeted during the grant, the
        // two authorization resolutions already ran against the pinned root.
        expect(AtomicFileSystem.helperSpawns() - before).toBe(phase === "before grant" ? 0 : 2)
      }).pipe(Effect.provide(host))
    )
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
