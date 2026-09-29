/**
 * An approved `bash` under the host's sandbox.
 *
 * The real `Bash` handler over the real `Exec`, the real kernel spawner, a
 * real unattended grant store, and this host's native confinement
 * (`@smthrs/platform-node/ProcessConfinement`). The command is approved, so
 * nothing before the spawn refuses it; what refuses `printf x > ../outside`
 * is the operating system, and the marker's absence is the evidence. The
 * suite runs where a mechanism exists, seatbelt on macOS and bubblewrap on a
 * Linux host with `bwrap`, and reports itself skipped elsewhere.
 */
import * as NodeChildProcessSpawner from "@effect/platform-node/NodeChildProcessSpawner"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { afterEach, describe, expect, it } from "@effect/vitest"
import { CapabilityPattern } from "@smthrs/capability/Capability"
import * as Permission from "@smthrs/capability/Permission"
import * as KernelChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import * as GrantStore from "@smthrs/kernel/GrantStore"
import * as Workspace from "@smthrs/kernel/Workspace"
import { Effect, Layer } from "effect"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as ProcessConfinement from "../../../flows/platform-node/src/ProcessConfinement.ts"
import * as ProcessSandbox from "../../../flows/platform-node/src/ProcessSandbox.ts"
import * as Bash from "../src/Bash.ts"

const available = !ProcessSandbox.isUnenforceable(ProcessSandbox.select({ network: "none" }, ProcessSandbox.host()))

const directories = new Set<string>()

const fixture = () => {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "flows-bash-confined-")))
  directories.add(base)
  const workspace = join(base, "workspace")
  mkdirSync(workspace)
  return { base, workspace }
}

afterEach(() => {
  for (const directory of directories) rmSync(directory, { recursive: true, force: true })
  directories.clear()
})

const rule = (action: CapabilityPattern["action"], resource: string) =>
  new Permission.Rule({ effect: "allow", pattern: new CapabilityPattern({ action, resource }) })

/** The std shell over the confined kernel spawner and a store holding `rules`. */
const layer = (workspace: string, rules: ReadonlyArray<Permission.Rule>) => {
  const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
  const grants = GrantStore.layer({ attended: false, rules }).pipe(
    Layer.provide(Workspace.layer(workspace)),
    Layer.orDie
  )
  return Layer.mergeAll(
    KernelChildProcessSpawner.layer.pipe(
      Layer.provide([
        grants,
        Workspace.layer(workspace),
        ProcessConfinement.layer(),
        Layer.provide(NodeChildProcessSpawner.layer, platform)
      ]),
      Layer.provide(platform)
    ),
    NodePath.layer
  )
}

describe.skipIf(!available)("bash under the host sandbox", () => {
  it.effect("cannot write outside the workspace once approved without an fs:write grant", () =>
    Effect.gen(function*() {
      const { base, workspace } = fixture()
      const result = yield* Bash.run({ mode: "unhermetic", command: "printf x > ../outside", cwd: workspace }).pipe(
        Effect.provide(layer(workspace, [rule("proc:spawn", "**")]))
      )
      expect(result.exitCode).not.toBe(0)
      expect(existsSync(join(base, "outside"))).toBe(false)
    }))

  it.effect("writes inside an fs:write grant and still nowhere outside it", () =>
    Effect.gen(function*() {
      const { base, workspace } = fixture()
      const inside = yield* Bash.run({ mode: "unhermetic", command: "printf granted > out/file", cwd: workspace }).pipe(
        Effect.provide(layer(workspace, [rule("proc:spawn", "**"), rule("fs:write", `${workspace}/out/**`)]))
      )
      const outside = yield* Bash.run({ mode: "unhermetic", command: "printf x > ../outside", cwd: workspace }).pipe(
        Effect.provide(layer(workspace, [rule("proc:spawn", "**"), rule("fs:write", `${workspace}/out/**`)]))
      )
      expect(inside.exitCode).toBe(0)
      expect(readFileSync(join(workspace, "out", "file"), "utf8")).toBe("granted")
      expect(outside.exitCode).not.toBe(0)
      expect(existsSync(join(base, "outside"))).toBe(false)
    }))
})
