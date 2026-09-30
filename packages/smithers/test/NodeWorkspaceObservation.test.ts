import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as WorkspaceObservation from "@smthrs/agent/WorkspaceObservation"
import { Effect, Exit, FileSystem, Logger, Option, Scope } from "effect"
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeAll, describe, expect, it } from "vitest"
import { changes, host } from "../src/internal/NodeWorkspaceObservation.ts"

const roots: Array<string> = []
afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      chmodSync(join(root, "locked"), 0o755)
    } catch {
      // Only the permission case creates it.
    }
    rmSync(root, { recursive: true, force: true })
  }
})

const workspace = (): string => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "smithers-node-observation-")))
  roots.push(root)
  return root
}

const write = (root: string, relative: string, text: string): void => {
  mkdirSync(dirname(join(root, relative)), { recursive: true })
  writeFileSync(join(root, relative), text)
}

/** Every shape the walk has a rule for. */
const tree = (): string => {
  const root = workspace()
  write(root, "b.py", "two")
  write(root, "a.py", "one")
  write(root, "src/deep/c.ts", "three")
  write(root, "src/z.ts", "four")
  write(root, "node_modules/pkg/index.js", "derived")
  write(root, "module.pyc", "derived")
  mkdirSync(join(root, "empty"))
  symlinkSync(join(root, "a.py"), join(root, "link-to-file"))
  symlinkSync(join(root, "src"), join(root, "link-to-directory"))
  return root
}

const portable = (root: string, options?: WorkspaceObservation.Options) =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => WorkspaceObservation.observe(fs, root, options)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )

const native = (root: string, options?: WorkspaceObservation.Options) =>
  Effect.runPromise(WorkspaceObservation.observeHost(host, root, options))

describe("NodeWorkspaceObservation.host", () => {
  it("measures the same tree the portable FileSystem walk measures", async () => {
    const root = tree()

    const [expected, actual] = await Promise.all([portable(root), native(root)])

    expect(actual).toEqual(expected)
    expect(actual.paths).toBe(4)
    expect(actual.complete).toBe(true)
  })

  it("stops at the same prefix as the portable walk and says it is partial", async () => {
    const root = tree()

    const [expected, actual] = await Promise.all([portable(root, { maxPaths: 3 }), native(root, { maxPaths: 3 })])

    expect(actual).toEqual(expected)
    expect(actual.complete).toBe(false)
  })

  it("moves when a file's size changes", async () => {
    const root = tree()
    const before = await native(root)

    write(root, "src/deep/c.ts", "three, longer")

    expect((await native(root)).digest).not.toBe(before.digest)
  })

  it("skips workspace caches and worktrees", async () => {
    const root = workspace()
    write(root, "kept.ts", "one")
    const before = await native(root)
    for (const name of [".artifacts", ".backend-go-modcache", ".pnpm-store", ".worktrees", "worktrees"]) {
      write(root, `${name}/generated.ts`, "generated")
    }
    expect(await native(root)).toEqual(before)
  })

  it("reports a missing directory as NotFound, so the walk reads it as movement", async () => {
    const root = workspace()

    const exit = await Effect.runPromise(Effect.exit(host.entries(join(root, "gone"), () => true)))

    expect(Exit.isFailure(exit)).toBe(true)
    if (Exit.isFailure(exit)) {
      expect(JSON.stringify(exit.cause)).toContain("NotFound")
    }
  })

  it.skipIf(process.getuid?.() === 0)("reports an unreadable directory as incomplete coverage", async () => {
    const root = workspace()
    write(root, "kept.py", "visible")
    write(root, "locked/hidden.py", "unreadable")
    chmodSync(join(root, "locked"), 0o000)
    const diagnostics: Array<unknown> = []
    const capture = Logger.make((entry) => {
      diagnostics.push(entry.message)
    })

    const observation = await Effect.runPromise(
      WorkspaceObservation.observeHost(host, root).pipe(
        Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
      )
    )

    expect(observation.paths).toBe(1)
    expect(observation.complete).toBe(false)
    expect(diagnostics).toHaveLength(1)
    expect(JSON.stringify(diagnostics[0])).toContain("PermissionDenied")
  })
})

describe("NodeWorkspaceObservation.changes", () => {
  // The feed's answers wait on the host's change delivery, which on a loaded
  // macOS host has taken seconds.
  const patient = { timeout: 60_000 }

  /** A feed over `root` and the scope that owns its watch. */
  const feedOver = async (root: string, options?: WorkspaceObservation.Options) => {
    const scope = await Effect.runPromise(Scope.make())
    const feed = await Effect.runPromise(Scope.provide(changes(root, options), scope))
    return {
      feed,
      settled: () => Effect.runPromise(feed.settled),
      close: () => Effect.runPromise(Scope.close(scope, Exit.void))
    }
  }

  const checkout = (): string => {
    const root = workspace()
    write(root, ".git/HEAD", "ref: refs/heads/main")
    write(root, "src/main.ts", "one")
    write(root, "README.md", "readme")
    return root
  }

  const count = (answer: Option.Option<number>): number => Option.getOrThrow(answer)

  // Whether this host delivers change events at all. macOS routes them through
  // one system daemon, which a host under heavy file churn can starve for many
  // seconds; the feed then never vouches and every measurement walks, which the
  // cases that do not need a live feed cover. The cases that do need one skip,
  // and say so, rather than pass on a host that could not run them.
  let live = false
  beforeAll(async () => {
    const probe = await feedOver(checkout())
    live = Option.isSome(await probe.settled())
    await probe.close()
  }, 30_000)
  const needsLiveFeed = (context: { skip: (note?: string) => void }) => {
    if (!live) context.skip("this host delivered no change event within the fence timeout")
  }

  it("settles on the same count while nothing moves", patient, async (context) => {
    needsLiveFeed(context)
    const { settled, close } = await feedOver(checkout())
    const first = count(await settled())
    expect(count(await settled())).toBe(first)
    expect(count(await settled())).toBe(first)
    await close()
  })

  it.for<{ readonly name: string; readonly change: (root: string) => void }>([
    { name: "rewrites a file", change: (root) => write(root, "src/main.ts", "two!") },
    { name: "creates a file in a new directory", change: (root) => write(root, "src/new/deep/file.ts", "n") },
    { name: "deletes a file", change: (root) => rmSync(join(root, "README.md")) },
    { name: "renames a file", change: (root) => renameSync(join(root, "README.md"), join(root, "READ.md")) }
  ])("counts a command that $name just before the call", patient, async ({ change }, context) => {
    needsLiveFeed(context)
    const root = checkout()
    const { settled, close } = await feedOver(root)
    const before = count(await settled())
    change(root)
    // No pause: the fence alone must make the change count.
    expect(count(await settled())).toBeGreaterThan(before)
    await close()
  })

  it("does not count changes under skipped paths", patient, async (context) => {
    needsLiveFeed(context)
    const root = checkout()
    mkdirSync(join(root, "out/run"), { recursive: true })
    const { settled, close } = await feedOver(root, { excludePaths: ["out/run"] })
    const before = count(await settled())
    write(root, ".git/index", "i")
    write(root, "node_modules/pkg/index.js", "derived")
    write(root, "src/module.pyc", "derived")
    write(root, "out/run/log.txt", "excluded")
    expect(count(await settled())).toBe(before)
    await close()
  })

  it("serves an unmoved tree without walking it, and walks a moved one", async (context) => {
    needsLiveFeed(context)
    const root = checkout()
    for (let index = 0; index < 2_000; index++) write(root, `src/gen/${index % 40}/f${index}.ts`, "x")
    const { feed, settled, close } = await feedOver(root)
    // Let the events of building the tree drain, so they do not read as moves.
    await settled()
    // A walk slower than any fence this host delivers, so the race is the feed's
    // to win whenever the tree is unmoved.
    let walks = 0
    const slowWalk = WorkspaceObservation.observeHost(host, root).pipe(
      Effect.tap(() => Effect.sleep("20 seconds")),
      Effect.tap(() =>
        Effect.sync(() => {
          walks++
        })
      )
    )
    const observe = () => Effect.runPromise(WorkspaceObservation.cached(slowWalk, feed))
    const first = await observe()
    for (let frame = 0; frame < 5; frame++) expect((await observe()).digest).toBe(first.digest)
    expect(walks).toBe(1)
    write(root, "src/main.ts", "moved")
    const moved = await observe()
    expect(walks).toBe(2)
    expect(moved.digest).not.toBe(first.digest)
    expect(moved).toEqual(await native(root))
    await close()
  }, 120_000)

  it("leaves no fence behind and stops vouching once its scope closes", patient, async () => {
    const root = checkout()
    const { feed, settled, close } = await feedOver(root)
    // A fence still in flight when the scope closes.
    const inflight = settled()
    await close()
    await inflight
    expect(readdirSync(join(root, ".git"))).toEqual(["HEAD"])
    expect(await settled()).toEqual(Option.none())
    expect(await Effect.runPromise(feed.delivered)).toEqual(Option.none())
  })

  it("cannot vouch for a root with no skipped directory to fence in, or no root at all", async () => {
    const root = workspace()
    write(root, "a.ts", "a")
    const bare = await feedOver(root)
    expect(await bare.settled()).toEqual(Option.none())
    expect(await Effect.runPromise(bare.feed.delivered)).toEqual(Option.none())
    await bare.close()
    const missing = await feedOver(join(root, "missing"))
    expect(await missing.settled()).toEqual(Option.none())
    await missing.close()
  })

  it("cannot settle once its fence cannot be written", patient, async () => {
    const root = checkout()
    const { feed, settled, close } = await feedOver(root)
    rmSync(join(root, ".git"), { recursive: true, force: true, maxRetries: 5 })
    expect(await settled()).toEqual(Option.none())
    expect(Option.isSome(await Effect.runPromise(feed.delivered))).toBe(true)
    await close()
  })
})
