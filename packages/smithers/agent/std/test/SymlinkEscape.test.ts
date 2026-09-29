/**
 * A planted symlink cannot carry a write, edit, or patch outside the workspace.
 *
 * `Preserve` follows an existing symlink to replace its target, so the
 * guarded filesystem it writes through must refuse a target outside the
 * workspace. These cases run the real kernel guard over the real Node
 * filesystem.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import { Rule } from "@smthrs/capability/Permission"
import * as KernelFileSystem from "@smthrs/kernel/FileSystem"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Cause, Effect, Exit, FileSystem, Layer, Option, type Path } from "effect"
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import type * as StdError from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

const guarded = (workspace: string) =>
  KernelFileSystem.layer.pipe(
    Layer.provide(
      Layer.effect(FileSystem.FileSystem, Effect.map(FileSystem.FileSystem, KernelFileSystem.withIsolatedFileSystem))
        .pipe(Layer.provide(NodeFileSystem.layer))
    ),
    Layer.provide(Layer.effect(
      GrantStore.GrantStore,
      GrantStore.make({
        attended: false,
        rules: [
          new Rule({
            effect: "allow",
            pattern: new CapabilityPattern({ action: "fs:*", resource: join(workspace, "**") })
          })
        ]
      })
    )),
    Layer.provide(Workspace.layer(workspace)),
    Layer.provideMerge(NodePath.layer)
  )

it.each(["write", "edit", "apply_patch"] as const)(
  "%s through a symlink to a host file is refused and the host file is untouched",
  async (tool) => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), "std-symlink-ws-")))
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "std-symlink-host-")))
    const secret = join(outside, "authorized_keys")
    try {
      writeFileSync(secret, "original host bytes\n")
      symlinkSync(secret, join(workspace, "link"))
      const call: Effect.Effect<unknown, StdError.StdError, FileSystem.FileSystem | Path.Path> = tool === "write"
        ? Write.run({ path: join(workspace, "link"), content: "planted\n" })
        : tool === "edit"
        ? Edit.run({ path: join(workspace, "link"), oldString: "original", newString: "planted" })
        : ApplyPatch.run({
          input: [
            "*** Begin Patch",
            `*** Update File: ${join(workspace, "link")}`,
            "@@",
            "-original host bytes",
            "+planted",
            "*** End Patch"
          ].join("\n")
        })
      const exit = await Effect.runPromiseExit(
        Effect.scoped(call.pipe(Effect.provide(guarded(workspace))))
      )
      expect(Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined)
        .toMatchObject({ code: "permission_denied", path: join(workspace, "link") })
      expect(readFileSync(secret, "utf8")).toBe("original host bytes\n")
      expect(readdirSync(outside)).toEqual(["authorized_keys"])
    } finally {
      rmSync(workspace, { recursive: true, force: true })
      rmSync(outside, { recursive: true, force: true })
    }
  }
)
