import { NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Effect, PlatformError } from "effect"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { expect, it } from "vitest"
import { GitWorktree } from "../src/internal/GitWorktree.ts"

it("commit resolution reports Git startup failure without trying another ref and succeeds after transport recovery", async () => {
  const root = mkdtempSync(join(tmpdir(), "std-git-startup-"))
  const commands: Array<{ command: string; args: ReadonlyArray<string> }> = []
  try {
    execFileSync("git", ["init", "--quiet", root])
    execFileSync("git", [
      "-C",
      root,
      "-c",
      "user.name=Unit Fixture",
      "-c",
      "user.email=unit@example.test",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture"
    ])
    const committed = execFileSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" }).trim()
    const result = await Effect.runPromise(
      Effect.gen(function*() {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        let broken = true
        const spawner = ChildProcessSpawner.makeNoop({
          spawn: (command) => {
            if (command._tag === "StandardCommand") commands.push({ command: command.command, args: command.args })
            return broken ?
              Effect.fail(PlatformError.systemError({
                _tag: "NotFound",
                module: "ChildProcessSpawner",
                method: "spawn",
                description: "controlled missing git executable"
              })) :
              real.spawn(command)
          }
        })
        const error = yield* Effect.flip(
          GitWorktree.resolveCommit(root, ["HEAD", "fallback"]).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
          )
        )
        broken = false
        const retry = yield* GitWorktree.resolveCommit(root, ["HEAD", "fallback"]).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        return { error, retry }
      }).pipe(Effect.provide(NodeServices.layer))
    )
    expect(result.error).toMatchObject({
      code: "command_failed",
      message: "git could not run: exec: git: NotFound: ChildProcessSpawner.spawn: controlled missing git executable"
    })
    expect(result.retry).toEqual({ ref: "HEAD", commit: committed })
    expect(commands).toEqual([
      { command: "git", args: ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"] },
      { command: "git", args: ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD^{commit}"] }
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
