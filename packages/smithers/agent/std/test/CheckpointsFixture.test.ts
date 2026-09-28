/**
 * Checkpoints over a real repository, a real git, and a real process.
 *
 * `Checkpoints.test.ts` pins the argv and the relocation table against a
 * scripted spawner. It cannot say whether the thing works, because the whole of
 * the thing is git and a bind mount: a commit recorded without disturbing the
 * index, a detached worktree checked out *inside* the tree under test, a command
 * run in it through the path a container would use, and the checkout removed
 * afterwards with the live edit still standing.
 *
 * The container is a double rather than docker, and the double is the point: it
 * resolves `/testbed/...` to the workspace exactly as a bind mount does, so a
 * test that passes here is a test that the subpath — and only the subpath — is
 * what makes a checkpoint reachable from inside the container.
 */
import { NodeServices } from "@effect/platform-node"
import * as ChildProcessSpawner from "@smthrs/kernel/ChildProcessSpawner"
import { Deferred, Effect, Fiber, Layer } from "effect"
import type * as ChildProcess from "effect/unstable/process/ChildProcess"
import { execFileSync } from "node:child_process"
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { basename, dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as Bash from "../src/Bash.ts"
import * as Checkpoints from "../src/Checkpoints.ts"
import * as Container from "../src/Container.ts"
import * as TestRunner from "../src/TestRunner.ts"

const git = (root: string, args: ReadonlyArray<string>): string =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" })

/** A repository holding one file, at one commit. */
const repository = (prefix = "flows-checkpoint-"): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  // Check exact fixture bytes even with the Windows checkout default enabled.
  writeFileSync(join(root, ".gitattributes"), "* -text\n")
  writeFileSync(join(root, "mod.py"), "value = 'pristine'\n")
  writeFileSync(join(root, "probe.sh"), "#!/bin/bash\ncat mod.py\n", { mode: 0o755 })
  git(root, ["init", "-q"])
  git(root, ["config", "core.autocrlf", "true"])
  git(root, ["config", "user.email", "rig@localhost"])
  git(root, ["config", "user.name", "rig"])
  git(root, ["add", "-A"])
  git(root, ["commit", "-qm", "base"])
  return root
}

/**
 * A container whose mount is the workspace, resolved by rewriting the path.
 *
 * This is what `docker run -v "$WORK:/testbed"` does, minus docker: the
 * container's `/testbed` and the host's workspace are one directory under two
 * names. A scratch checkout under the workspace is therefore reachable from
 * inside at the same subpath, and one anywhere else on the host is not
 * reachable at all — which is the constraint that put `.flows-checkpoints`
 * inside the tree it belongs to.
 */
const mountedProcess = [
  "const { spawnSync } = require(\"node:child_process\")",
  "const [cwd, file, ...args] = process.argv.slice(1)",
  "const result = spawnSync(file, args, { cwd, stdio: \"inherit\" })",
  "if (result.error) throw result.error",
  "process.exit(result.status ?? 1)"
].join("\n")

const mounted = (root: string): Container.Container =>
  Container.make({
    exec: (request) =>
      Effect.succeed({
        file: process.execPath,
        args: [
          "--eval",
          mountedProcess,
          (request.cwd ?? "/testbed").replace(/^\/testbed/, () => root),
          request.file,
          ...request.args
        ],
        env: request.env
      })
  })

const services = (root: string) =>
  Layer.mergeAll(
    NodeServices.layer,
    Layer.succeed(Container.Container)(mounted(root))
  )

const store = (root: string, options: Partial<Checkpoints.GitOptions> = {}) =>
  Effect.provide(Checkpoints.makeGit({ root, ...options }), NodeServices.layer)

describe("Checkpoints over a real repository", () => {
  it("keeps overlapping materializations of the same id intact", async () => {
    const root = repository()
    const paths: Array<string> = []
    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-overlap")
      const entered = yield* Deferred.make<void>()
      const released = yield* Deferred.make<void>()
      const first = yield* checkpoints.materialize("cp-overlap", (found) =>
        Effect.gen(function*() {
          paths.push(found.host)
          writeFileSync(join(found.host, "lease.txt"), "first")
          yield* Deferred.succeed(entered, undefined)
          yield* Deferred.await(released)
          expect(readFileSync(join(found.host, "mod.py"), "utf8")).toBe("value = 'pristine'\n")
          expect(readFileSync(join(found.host, "lease.txt"), "utf8")).toBe("first")
        })).pipe(Effect.forkChild)
      yield* Deferred.await(entered)
      yield* checkpoints.materialize("cp-overlap", (found) =>
        Effect.sync(() => {
          paths.push(found.host)
          expect(readFileSync(join(found.host, "mod.py"), "utf8")).toBe("value = 'pristine'\n")
          expect(readFileSync(join(paths[0]!, "lease.txt"), "utf8")).toBe("first")
          const relocated = Checkpoints.relocate("read", { path: "mod.py" }, found)
          expect(relocated).toEqual({
            _tag: "Relocated",
            input: { path: `${found.host.slice(root.length + 1)}/mod.py` }
          })
        }))
      yield* Deferred.succeed(released, undefined)
      yield* Fiber.join(first)
    }))
    expect(new Set(paths).size).toBe(2)
    for (const path of paths) expect(existsSync(path)).toBe(false)
  }, 60_000)

  it("hands back the tree as it stood, while the live tree keeps the edit", async () => {
    const root = repository()
    // The tree the run opened on, recorded the way `snapshot-base.sh` records
    // it for a benchmark workspace.
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    // The agent's edit. This is the work a proof must not cost.
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

    const [pinned, base] = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      const snapshot = yield* checkpoints.capture("cp-0-1")
      expect(snapshot.ref).toMatch(/^[0-9a-f]{40}$/)
      const held = yield* checkpoints.materialize(
        "cp-0-1",
        (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
      )
      const opening = yield* checkpoints.materialize(
        Checkpoints.baseId,
        (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
      )
      return [held, opening]
    }))

    // The checkpoint minted after the edit holds the edit; `ctx.base` holds the
    // tree the run opened on. Two trees, both readable, neither of them the one
    // the run is working in.
    expect(pinned).toBe("value = 'fixed'\n")
    expect(base).toBe("value = 'pristine'\n")

    // And the live tree is untouched by any of it. This is the assertion that
    // would have failed on the recorded `sympy__sympy-13878` run, where the
    // only way to read the pristine bytes was `git checkout --`.
    expect(readFileSync(join(root, "mod.py"), "utf8")).toBe("value = 'fixed'\n")
    expect(git(root, ["status", "--porcelain"])).toContain("M mod.py")
  }, 60_000)

  it("leaves the repository's own index exactly as it found it", async () => {
    // The agent runs git in this workspace and its `git diff` is the run's
    // evidence. A capture that staged anything would be the harness editing the
    // evidence while recording it.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")
    writeFileSync(join(root, "staged.py"), "x = 1\n")
    git(root, ["add", "staged.py"])
    const before = git(root, ["status", "--porcelain"])

    await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-0-0")
    }))

    expect(git(root, ["status", "--porcelain"])).toBe(before)
    expect(git(root, ["stash", "list"])).toBe("")
  }, 60_000)

  it("never puts a checkpoint into anything that reads as history", async () => {
    // The defect this avoids is measured. Before the rig moved jj's store out
    // of the workspace, `git log --all` handed agents their own attempt commits
    // as if they were upstream work, and django-13346 applied two of them as a
    // fake fix. A checkpoint holds the agent's own edit, so naming one with a
    // ref would reintroduce that one wave later.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'the agent fix'\n")
    const historyBefore = git(root, ["log", "--all", "--oneline"])

    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      return yield* checkpoints.capture("cp-0-0")
    }))

    // The commit exists and holds the edit…
    expect(git(root, ["show", `${snapshot.ref}:mod.py`])).toBe("value = 'the agent fix'\n")
    // …and no command that reads history can reach it.
    expect(git(root, ["log", "--all", "--oneline"])).toBe(historyBefore)
    expect(git(root, ["for-each-ref", "--format=%(refname)"])).not.toContain("checkpoint")
    expect(git(root, ["stash", "list"])).toBe("")
    // It is named where a name is not history.
    expect(git(root, ["config", "--local", "--get", `${Checkpoints.configSection}.cp-0-0`]).trim())
      .toBe(snapshot.ref)
  }, 60_000)

  it("is reachable by fsck alone, even while it is checked out", async () => {
    // The one command that does see it, measured rather than assumed, because a
    // claim of invisibility that is only nearly true is how django-13346 read
    // its own snapshot back as upstream work. `fsck` reports an unreferenced
    // commit because that is what one is. The checkout is a standalone
    // repository rather than a worktree of this one, so `git log --all` in the
    // workspace does not list its HEAD even while the call runs in it.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'the agent fix'\n")

    const snapshot = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      const pinned = yield* checkpoints.capture("cp-0-0")
      const during = yield* checkpoints.materialize(
        "cp-0-0",
        () => Effect.sync(() => git(root, ["log", "--all", "--oneline"]))
      )
      expect(during).not.toContain(pinned.ref.slice(0, 7))
      return pinned
    }))

    expect(git(root, ["fsck", "--no-progress"])).toContain(`dangling commit ${snapshot.ref}`)
    expect(git(root, ["log", "--all", "--oneline"])).not.toContain(snapshot.ref.slice(0, 7))
    expect(git(root, ["worktree", "list"])).not.toContain(Checkpoints.scratchDirectory)
  }, 60_000)

  it("holds three trees apart in one frame, and touches none of them", async () => {
    // The shape the ruling buys, at full length: the run opens on one tree, the
    // cell edits, pins what it has, and edits again. Three readings, three
    // answers, and the live tree still holds the latest edit afterwards.
    const root = repository()
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    writeFileSync(join(root, "mod.py"), "value = 'half'\n")

    const seen = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-1-0")
      writeFileSync(join(root, "mod.py"), "value = 'whole'\n")
      const read = (id: string) =>
        checkpoints.materialize(id, (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8")))
      return {
        base: yield* read(Checkpoints.baseId),
        pinned: yield* read("cp-1-0"),
        live: readFileSync(join(root, "mod.py"), "utf8")
      }
    }))

    expect(seen).toEqual({
      base: "value = 'pristine'\n",
      pinned: "value = 'half'\n",
      live: "value = 'whole'\n"
    })
    expect(readFileSync(join(root, "mod.py"), "utf8")).toBe("value = 'whole'\n")
    expect(git(root, ["status", "--porcelain"])).toBe(" M mod.py\n")
  }, 60_000)

  it("refuses the reader path that would have read the live tree instead", async () => {
    // Measured rather than argued, because the escape is one `..` wide: the
    // relocated path a blind prefix produces resolves to the live file, so the
    // refusal is the only thing between a cell and a baseline of its own work.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

    const [refusal, wouldHaveRead] = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-1-0")
      writeFileSync(join(root, "mod.py"), "value = 'later still'\n")
      return yield* checkpoints.materialize("cp-1-0", (found) =>
        Effect.sync(() => {
          const blind = `${found.host}/../../mod.py`
          return [
            Checkpoints.relocate("read", { path: "../../mod.py" }, found),
            readFileSync(blind, "utf8")
          ] as const
        }))
    }))

    expect(refusal).toEqual({ _tag: "OutsideTree", path: "../../mod.py" })
    // What the refusal is worth: the path it declined resolves to the live tree,
    // which is the one tree a reading at a checkpoint must never come from.
    expect(wouldHaveRead).toBe("value = 'later still'\n")
  }, 60_000)

  it("keeps a handle resolving after a kill left the checkout standing", async () => {
    // A killed run can leave a checkout behind. A later call must use a new
    // path, since a standing checkout may also belong to a still-active call.
    const root = repository()
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")
    const scratch = join(root, Checkpoints.scratchDirectory, "cp-1-0")

    const read = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      const snapshot = yield* checkpoints.capture("cp-1-0")
      // The leftover, exactly as a killed run leaves it: the checkout and the
      // administrative entry that makes a second `add` fatal.
      git(root, ["worktree", "add", "--detach", "--force", scratch, snapshot.ref])
      expect(() => git(root, ["worktree", "add", "--detach", "--force", scratch, snapshot.ref])).toThrow()
      return yield* checkpoints.materialize(
        "cp-1-0",
        (found) => Effect.sync(() => readFileSync(join(found.host, "mod.py"), "utf8"))
      )
    }))

    expect(read).toBe("value = 'fixed'\n")
    expect(readFileSync(join(scratch, "mod.py"), "utf8")).toBe("value = 'fixed'\n")
    git(root, ["worktree", "remove", "--force", scratch])
    expect(git(root, ["worktree", "list"])).not.toContain(Checkpoints.scratchDirectory)
  }, 60_000)

  it(
    "gives the checkout its own .git that names the repository by a relative path, so a container can run git in it",
    async () => {
      // Written absolutely, a pointer names a path that exists on this machine
      // and nowhere inside the container, so `git` run at the checkpoint through
      // the mount answers "not a git repository" — and a suite that shells out to
      // git during collection fails for that and not for the code under test.
      const root = repository()
      writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

      const seen = await Effect.runPromise(Effect.gen(function*() {
        const checkpoints = yield* store(root, { cwd: "/testbed" })
        const snapshot = yield* checkpoints.capture("cp-1-0")
        return yield* checkpoints.materialize("cp-1-0", (found) =>
          Effect.sync(() => {
            // The container's git: no host config, run in the checkout itself.
            const inside = (args: ReadonlyArray<string>) =>
              execFileSync("git", args, {
                cwd: found.host,
                encoding: "utf8",
                env: { PATH: process.env.PATH ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" }
              })
            return {
              ref: snapshot.ref,
              alternates: readFileSync(join(found.host, ".git", "objects", "info", "alternates"), "utf8").trim(),
              head: inside(["rev-parse", "HEAD"]).trim(),
              status: inside(["status", "--porcelain"]),
              topLevel: realpathSync(inside(["rev-parse", "--show-toplevel"]).trim()),
              host: realpathSync(found.host)
            }
          }))
      }))

      expect(seen.alternates).toBe("../../../../.git/objects")
      expect(seen.alternates).not.toContain(root)
      expect(seen.head).toBe(seen.ref)
      expect(seen.status).toBe("")
      expect(seen.topLevel).toBe(seen.host)
    },
    60_000
  )

  it("leaves the repository format exactly as it found it, because an older git refuses the stamp", async () => {
    // Git 2.48+ records the first relative checkout in the repository itself:
    // `extensions.relativeWorktrees = true` and `core.repositoryformatversion`
    // raised to 1. Removing the worktree takes neither back, and a pre-2.48 git
    // opening a repository with an extension it does not know refuses the whole
    // repository. The benchmark testbeds run exactly such a git against this
    // directory through a bind mount — measured on the r97 wave, 15 of 45 runs
    // lost every in-container `git status`/`git diff` from the first
    // `{ at: ctx.base }` call onward. The store checks out through a shadow
    // repository and never writes this repository's format at all.
    const root = repository()
    const versionBefore = git(root, ["config", "--local", "--get", "core.repositoryformatversion"]).trim()
    const marker = (): string => {
      try {
        return git(root, ["config", "--local", "--get", "extensions.relativeWorktrees"]).trim()
      } catch {
        return "unset"
      }
    }

    const during = await Effect.runPromise(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-2-0")
      return yield* checkpoints.materialize("cp-2-0", () =>
        Effect.sync(() => ({
          // What an in-container git sees WHILE the checkpoint is checked out:
          // the call this checkout exists for runs in this window.
          marker: marker(),
          version: git(root, ["config", "--local", "--get", "core.repositoryformatversion"]).trim()
        })))
    }))

    expect(during.marker).toBe("unset")
    expect(during.version).toBe(versionBefore)
    // And after the checkout is gone, the same: nothing this store did to the
    // repository's format survives the call, on any git version.
    expect(marker()).toBe("unset")
    expect(git(root, ["config", "--local", "--get", "core.repositoryformatversion"]).trim()).toBe(versionBefore)
  }, 60_000)

  it("removes the checkout however the call ends", async () => {
    const root = repository()
    let scratch = ""

    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      yield* checkpoints.capture("cp-0-0")
      return yield* checkpoints.materialize("cp-0-0", (found) =>
        Effect.sync(() => {
          scratch = found.host
          expect(existsSync(join(found.host, "mod.py"))).toBe(true)
        }).pipe(Effect.andThen(Effect.fail("the call failed"))))
    })))

    expect(exit._tag).toBe("Failure")
    expect(existsSync(scratch)).toBe(false)
    expect(git(root, ["worktree", "list"])).not.toContain(Checkpoints.scratchDirectory)
  }, 60_000)

  it("never lets host git write the checkpoint through a checkout path the agent swapped for a symlink", async () => {
    const root = repository()
    const victim = realpathSync(mkdtempSync(join(tmpdir(), "flows-checkpoint-victim-")))
    writeFileSync(join(victim, "mod.py"), "victim\n")
    const scratch = join(root, Checkpoints.scratchDirectory)
    let raced = false
    // The agent writes the workspace through its bind mount. Just before host
    // git writes the tree, it points the checkout's name at a host directory.
    const racing = Effect.gen(function*() {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.makeNoop({
        spawn: (command) =>
          Effect.suspend(() => {
            const standard = command as ChildProcess.StandardCommand
            const tree = standard.args?.find((arg) => arg.startsWith("--work-tree="))?.slice("--work-tree=".length)
            if (standard.command === "git" && standard.args.includes("read-tree") && tree !== undefined) {
              mkdirSync(scratch, { recursive: true })
              const name = readdirSync(scratch).find((entry) => entry.startsWith("cp-race-")) ?? basename(tree)
              rmSync(join(scratch, name), { recursive: true, force: true })
              symlinkSync(victim, join(scratch, name))
              raced = true
            }
            return real.spawn(command)
          })
      })
    })

    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const spawner = yield* racing
        const checkpoints = yield* Checkpoints.makeGit({ root }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        yield* checkpoints.capture("cp-race")
        return yield* checkpoints.materialize("cp-race", () => Effect.void)
      }).pipe(Effect.provide(NodeServices.layer))
    ))

    expect(raced).toBe(true)
    expect(exit._tag).toBe("Failure")
    expect(readFileSync(join(victim, "mod.py"), "utf8")).toBe("victim\n")
    expect(readdirSync(victim)).toEqual(["mod.py"])
    expect(readdirSync(dirname(root)).filter((entry) => entry.startsWith(".smithers-checkout-"))).toEqual([])
  }, 60_000)

  it("refuses a checkout whose parent the agent swapped for a symlink out of the workspace", async () => {
    const root = repository()
    const victim = realpathSync(mkdtempSync(join(tmpdir(), "flows-checkpoint-victim-")))
    const scratch = join(root, Checkpoints.scratchDirectory)
    let raced = false
    let entered = false
    // Just before the harness measures the checkout's parent, the agent points
    // that parent at a host directory.
    const racing = Effect.gen(function*() {
      const real = yield* ChildProcessSpawner.ChildProcessSpawner
      return ChildProcessSpawner.makeNoop({
        spawn: (command) =>
          Effect.suspend(() => {
            const standard = command as ChildProcess.StandardCommand
            if (standard.command === "sh" && standard.args.some((arg) => arg.includes("stat -c %d")) && !raced) {
              rmSync(scratch, { recursive: true, force: true })
              symlinkSync(victim, scratch)
              raced = true
            }
            return real.spawn(command)
          })
      })
    })

    const exit = await Effect.runPromise(Effect.exit(
      Effect.gen(function*() {
        const spawner = yield* racing
        const checkpoints = yield* Checkpoints.makeGit({ root }).pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
        )
        yield* checkpoints.capture("cp-parent")
        return yield* checkpoints.materialize("cp-parent", () => Effect.sync(() => (entered = true)))
      }).pipe(Effect.provide(NodeServices.layer))
    ))

    expect(raced).toBe(true)
    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("outside the workspace")
    expect(entered).toBe(false)
    expect(readdirSync(victim)).toEqual([])
  }, 60_000)

  it(
    "stages under the host cache when the temporary directory is another filesystem and the root's parent is read-only",
    async () => {
      if (process.getuid?.() === 0) return
      const outer = realpathSync(mkdtempSync(join(tmpdir(), "flows-checkpoint-outer-")))
      const root = join(outer, "repo")
      mkdirSync(root)
      const initial = repository()
      rmSync(root, { recursive: true, force: true })
      execFileSync("mv", [initial, root])
      const cache = realpathSync(mkdtempSync(join(tmpdir(), "flows-checkpoint-cache-")))
      // A real second filesystem where the host has one (tmpfs /dev/shm on
      // Linux). Elsewhere the measurement is told the shadow lives on devfs,
      // which is the one fact a test cannot create here without root.
      const shm = ["/dev/shm", "/run/shm"].find((path) => {
        try {
          return statSync(path).dev !== statSync(root).dev && (accessSync(path, constants.W_OK), true)
        } catch {
          return false
        }
      })
      const saved = { TMPDIR: process.env.TMPDIR, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME }
      if (shm !== undefined) process.env.TMPDIR = shm
      process.env.XDG_CACHE_HOME = cache
      let seen = ""
      const elsewhere = Effect.gen(function*() {
        const real = yield* ChildProcessSpawner.ChildProcessSpawner
        return ChildProcessSpawner.makeNoop({
          spawn: (command) =>
            Effect.suspend(() => {
              const standard = command as ChildProcess.StandardCommand
              if (
                shm === undefined && standard.command === "sh" &&
                standard.args.some((arg) => arg.includes("stat -c %d"))
              ) {
                const args = [...standard.args]
                args[4] = "/dev"
                return real.spawn({ ...standard, args } as ChildProcess.StandardCommand)
              }
              return real.spawn(command)
            })
        })
      })
      chmodSync(outer, 0o555)
      try {
        const exit = await Effect.runPromise(Effect.exit(
          Effect.gen(function*() {
            const spawner = yield* elsewhere
            const checkpoints = yield* Checkpoints.makeGit({ root }).pipe(
              Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner)
            )
            yield* checkpoints.capture("cp-cache")
            return yield* checkpoints.materialize("cp-cache", (found) =>
              Effect.sync(() => {
                seen = readFileSync(join(found.host, "mod.py"), "utf8")
              }))
          }).pipe(Effect.provide(NodeServices.layer))
        ))
        expect(exit._tag, JSON.stringify(exit)).toBe("Success")
      } finally {
        chmodSync(outer, 0o755)
        process.env.TMPDIR = saved.TMPDIR
        if (saved.TMPDIR === undefined) delete process.env.TMPDIR
        process.env.XDG_CACHE_HOME = saved.XDG_CACHE_HOME
        if (saved.XDG_CACHE_HOME === undefined) delete process.env.XDG_CACHE_HOME
      }

      expect(seen).toBe("value = 'pristine'\n")
      expect(readdirSync(join(cache, "smithers"))).toEqual([])
      expect(readdirSync(outer)).toEqual(["repo"])
    },
    60_000
  )

  it("runs a real command against the pinned tree, through the container's own path", async () => {
    const root = repository("flows checkpoint's-")
    git(root, ["update-ref", TestRunner.captureBase, "HEAD"])
    writeFileSync(join(root, "mod.py"), "value = 'fixed'\n")

    const [pinnedOutput, liveOutput] = await Effect.runPromise(
      Effect.gen(function*() {
        const checkpoints = yield* store(root, { cwd: "/testbed" })
        const call = { mode: "unhermetic", command: "bash probe.sh", container: "double" } as const
        const atBase = yield* checkpoints.materialize(Checkpoints.baseId, (found) => {
          const relocated = Checkpoints.relocate("bash", call, found)
          expect(relocated._tag).toBe("Relocated")
          // The container's name for the scratch checkout, which is the workspace
          // path with the mount's prefix on it.
          expect(relocated._tag === "Relocated" && relocated.input).toMatchObject({
            cwd: `/testbed${found.host.slice(root.length)}`
          })
          return Bash.run(
            (relocated._tag === "Relocated" ? relocated.input : call) as Bash.Input
          )
        })
        const live = yield* Bash.run(call)
        expect(atBase.exitCode, atBase.stderr).toBe(0)
        expect(live.exitCode, live.stderr).toBe(0)
        return [atBase.stdout, live.stdout]
      }).pipe(Effect.provide(services(root)))
    )

    // One command, two trees, one frame. This is the whole shape the ruling
    // buys, running for real: the baseline reports the bytes the run opened on
    // while the edit stands in the working copy.
    expect(pinnedOutput?.trim()).toBe("value = 'pristine'")
    expect(liveOutput?.trim()).toBe("value = 'fixed'")
    expect(readFileSync(join(root, "mod.py"), "utf8")).toBe("value = 'fixed'\n")
  }, 60_000)

  it("refuses a checkpoint nothing ever pinned", async () => {
    const root = repository()
    const exit = await Effect.runPromise(Effect.exit(Effect.gen(function*() {
      const checkpoints = yield* store(root)
      return yield* checkpoints.materialize("cp-9-9", () => Effect.void)
    })))

    expect(exit._tag).toBe("Failure")
    expect(JSON.stringify(exit)).toContain("No checkpoint is stored under")
  }, 60_000)
})
