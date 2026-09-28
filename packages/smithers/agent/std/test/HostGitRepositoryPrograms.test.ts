/**
 * Host git never runs a program the repository names.
 *
 * A containerised agent writes the workspace's `.git` through the bind mount.
 * Checkpoints and baseline test runs then run git on the host over that
 * repository, so a hook, a `core.fsmonitor` command or a filter driver planted
 * there would run the agent's program outside its container.
 */
import { NodeServices } from "@effect/platform-node"
import { Effect } from "effect"
import { execFileSync } from "node:child_process"
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import * as Checkpoints from "../src/Checkpoints.ts"

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

it("capture and materialize run no hook, fsmonitor command or filter driver from the repository", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "std-host-git-")))
  const markers = realpathSync(mkdtempSync(join(tmpdir(), "std-host-git-markers-")))
  try {
    writeFileSync(join(root, "mod.py"), "value = 1\n")
    git(root, ["init", "-q"])
    git(root, ["config", "user.email", "rig@localhost"])
    git(root, ["config", "user.name", "rig"])
    git(root, ["add", "-A"])
    git(root, ["commit", "-qm", "base"])
    // What an agent with write access to the workspace plants.
    const hook = (name: string) => {
      const path = join(root, ".git", "hooks", name)
      writeFileSync(path, `#!/bin/sh\ntouch '${join(markers, name)}'\n`)
      chmodSync(path, 0o755)
    }
    mkdirSync(join(root, ".git", "hooks"), { recursive: true })
    hook("post-checkout")
    hook("reference-transaction")
    git(root, ["config", "core.fsmonitor", `touch '${join(markers, "fsmonitor")}'; false`])
    // A filter driver: git has no switch that ignores repository config or
    // `info/attributes`, so only a GIT_DIR the agent cannot write keeps it out.
    // `clean` fires when a capture hashes the edited file, `smudge` when a
    // checkout writes it. The in-tree `.gitattributes` names the same driver.
    git(root, ["config", "filter.planted.clean", `touch '${join(markers, "clean")}'; cat`])
    git(root, ["config", "filter.planted.smudge", `touch '${join(markers, "smudge")}'; cat`])
    git(root, ["config", "diff.planted.textconv", `touch '${join(markers, "textconv")}'; cat`])
    mkdirSync(join(root, ".git", "info"), { recursive: true })
    writeFileSync(join(root, ".git", "info", "attributes"), "* filter=planted diff=planted\n")
    writeFileSync(join(root, ".gitattributes"), "* filter=planted\n")
    writeFileSync(join(root, "mod.py"), "value = 2\n")

    await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* Checkpoints.makeGit({ root })
        yield* checkpoints.capture("cp-hostile")
        const read = yield* checkpoints.materialize(
          "cp-hostile",
          (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
        )
        // The checkpoint still holds the edit: the shadow records the tree, it
        // only refuses the repository's programs.
        expect(read).toBe("value = 2\n")
        yield* checkpoints.materialize(Checkpoints.baseId, () => Effect.void)
      }).pipe(Effect.provide(NodeServices.layer))
    )

    expect(existsSync(join(markers, "post-checkout"))).toBe(false)
    expect(existsSync(join(markers, "reference-transaction"))).toBe(false)
    expect(existsSync(join(markers, "fsmonitor"))).toBe(false)
    expect(existsSync(join(markers, "clean"))).toBe(false)
    expect(existsSync(join(markers, "smudge"))).toBe(false)
    expect(existsSync(join(markers, "textconv"))).toBe(false)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(markers, { recursive: true, force: true })
  }
}, 60_000)
