/**
 * The measurement the loop's mutation accounting is built on.
 *
 * These cases fix what a measurement covers and what it deliberately does not:
 * a shell write moves it, a test run that only fills caches does not, and a
 * path that vanishes mid-walk is left out rather than failing the frame. The
 * controller only ever compares two measurements for equality, so the whole
 * contract is "the digest moves exactly when the tree the run is judged on
 * moves".
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as EngineLike from "@smthrs/harness/EngineLike"
import { Effect, FileSystem, Layer, Logger, Option, PlatformError } from "effect"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, normalize } from "node:path"
import { describe, expect, it } from "vitest"
import * as WorkspaceObservation from "../src/WorkspaceObservation.ts"

const workspace = (): string => mkdtempSync(join(tmpdir(), "flows-observation-"))

const write = (root: string, path: string, content: string): void => {
  const full = join(root, path)
  mkdirSync(join(full, ".."), { recursive: true })
  writeFileSync(full, content)
}

const measured = (
  root: string,
  options: WorkspaceObservation.Options = {}
): Promise<EngineLike.Observation> =>
  Effect.runPromise(
    Effect.flatMap(FileSystem.FileSystem, (fs) => WorkspaceObservation.observe(fs, root, options)).pipe(
      Effect.provide(NodeFileSystem.layer)
    )
  )

describe("WorkspaceObservation", () => {
  it("prunes a 60k-file artifact tree before visiting its entries", async () => {
    const visits: Array<string> = []
    const host: WorkspaceObservation.Host = {
      entries: (directory, keep) =>
        Effect.sync(() => {
          visits.push(directory)
          if (directory === "/workspace") {
            return [
              { name: ".artifacts", measured: { _tag: "Directory" as const } },
              { name: "src", measured: { _tag: "Directory" as const } }
            ].filter((entry) => keep(entry.name))
          }
          if (directory === "/workspace/src") {
            return [{ name: "main.ts", measured: { _tag: "File" as const, size: 1, modified: 0 } }]
          }
          return Array.from({ length: 60_000 }, (_, index) => ({
            name: `artifact-${index}`,
            measured: { _tag: "File" as const, size: 1, modified: 0 }
          }))
        })
    }
    const observation = await Effect.runPromise(WorkspaceObservation.observeHost(host, "/workspace"))
    expect(visits).toEqual(["/workspace", "/workspace/src"])
    expect(observation).toMatchObject({ paths: 1, complete: true })
  })
  it("moves when a tracked file is rewritten by anything at all", async () => {
    const root = workspace()
    write(root, "src/python.py", "the fix")
    const before = await measured(root)

    // Exactly what SWE-bench wave 5's frame 9 did: a shell redirect put the
    // base revision back over the file, no flow declared a write, and every
    // control in the harness saw an idle frame.
    write(root, "src/python.py", "the base revision, which is longer")
    const after = await measured(root)

    expect(before.paths).toBe(1)
    expect(after.digest).not.toBe(before.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("reports the same measurement for a tree nothing touched", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "nested/b.py", "two")

    expect((await measured(root)).digest).toBe((await measured(root)).digest)
    expect((await measured(root)).paths).toBe(2)
    rmSync(root, { recursive: true, force: true })
  })

  it("ignores the caches and compiled output a test run leaves behind", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    const before = await measured(root)

    // A `pytest` invocation writes bytecode caches beside the sources and an
    // in-place build drops shared objects next to them. Counting either would
    // report every probe as an edit, which satisfies the read-only cap forever
    // — the same blindness inverted.
    write(root, "__pycache__/a.cpython-39.pyc", "bytecode")
    write(root, ".pytest_cache/v/cache/lastfailed", "{}")
    write(root, "a.cpython-39-x86_64-linux-gnu.so", "compiled")
    write(root, ".git/index", "git state")

    expect((await measured(root)).digest).toBe(before.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("counts a file under a directory the caller did not exclude", async () => {
    const root = workspace()
    write(root, "build/artifact.txt", "kept")

    // The pruning is a declared policy, not a guess about what matters: a host
    // whose derived artifacts differ names its own list, and everything else
    // is measured.
    expect((await measured(root, { prune: [], ignoreSuffixes: [] })).paths).toBe(1)
    expect((await measured(root, { prune: ["build"] })).paths).toBe(0)
    rmSync(root, { recursive: true, force: true })
  })

  it("omits exact runtime paths without hiding similarly named project files", async () => {
    const root = workspace()
    const options = { excludePaths: ["runtime/sessions", "runtime/tui.log"] }
    try {
      write(root, "runtime/sessions-source/kept.ts", "one")
      write(root, "source/runtime/sessions/kept.ts", "two")
      write(root, "runtime/tui.log.ts", "three")
      const before = await measured(root, options)
      expect(before.paths).toBe(3)
      write(root, "runtime/sessions/worker/events.jsonl", "journal")
      write(root, "runtime/tui.log", "diagnostic")
      expect(await measured(root, options)).toEqual(before)
      write(root, "source/runtime/sessions/kept.ts", "changed source")
      expect((await measured(root, options)).digest).not.toBe(before.digest)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("stops at the path bound and reports the measurement as partial", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "b.py", "two")
    write(root, "c.py", "three")

    const bounded = await measured(root, { maxPaths: 2 })
    expect(bounded.paths).toBe(2)
    // A prefix chosen by sort order is not the workspace. Saying so is what
    // keeps the controller from reading `c.py` holding still — or the whole
    // rest of a large checkout — as a run that stopped working. This
    // repository is already past the shipped bound.
    expect(bounded.complete).toBe(false)
    write(root, "a.py", "one, edited")
    expect((await measured(root, { maxPaths: 2 })).digest).not.toBe(bounded.digest)
    rmSync(root, { recursive: true, force: true })
  })

  it("reports a walk that covered everything as complete, bound or no bound", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "b.py", "two")

    // Exactly at the bound with nothing left to visit is a whole measurement:
    // the walk never turned back.
    expect((await measured(root, { maxPaths: 2 })).complete).toBe(true)
    expect((await measured(root)).complete).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("stops descending once the bound is reached", async () => {
    const root = workspace()
    write(root, "a/one.py", "one")
    write(root, "b/two.py", "two")

    const bounded = await measured(root, { maxPaths: 1 })
    expect(bounded.paths).toBe(1)
    expect(bounded.complete).toBe(false)
    rmSync(root, { recursive: true, force: true })
  })

  it("measures an empty root as an empty tree rather than failing", async () => {
    const root = workspace()
    const empty = await measured(`${root}/`)

    expect(empty.paths).toBe(0)
    // A root that is not there at all is the same answer: the walk contributes
    // nothing and the next measurement reports whatever appears.
    const absent = await measured(join(root, "absent"))
    expect(absent.digest).toBe(empty.digest)
    expect(absent.complete).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it("leaves out a path that disappeared between listing and measuring", async () => {
    const root = workspace()
    write(root, "kept.py", "one")
    write(root, "vanishing.py", "two")

    // A run's own background process can remove a file mid-walk. The tree
    // moved; that is a fact for the next measurement to report, not a reason
    // to fail the frame.
    const fs = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
        ...found,
        stat: (path) =>
          `${path}`.endsWith("vanishing.py")
            ? found.stat(join(root, "gone.py"))
            : found.stat(path)
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )
    const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))

    expect(observation.paths).toBe(1)
    expect(observation.complete).toBe(true)
    rmSync(root, { recursive: true, force: true })
  })

  it.each(
    [
      ["readDirectory", "", "PermissionDenied", "EACCES"],
      ["readDirectory", "nested", "PermissionDenied", "EACCES"],
      ["readDirectory", "nested", "Unknown", "EIO"],
      ["stat", "nested/hidden.py", "PermissionDenied", "EACCES"],
      ["stat", "nested/hidden.py", "Unknown", "EIO"]
    ] as const
  )("reports incomplete coverage for %s %s failing with %s (%s)", async (method, relative, tag, code) => {
    const root = workspace()
    try {
      write(root, "nested/hidden.py", "unreadable")
      write(root, "kept.py", "visible")
      const failedPath = relative === "" ? root : join(root, relative)
      const failure = PlatformError.systemError({
        _tag: tag,
        module: "FileSystem",
        method,
        pathOrDescriptor: failedPath,
        description: code
      })
      const calls: Array<string> = []
      let refusedPath: string | undefined
      const fs = await Effect.runPromise(
        Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
          ...found,
          readDirectory: (path) => {
            calls.push(`readDirectory ${normalize(path)}`)
            if (method === "readDirectory" && normalize(path) === failedPath) {
              refusedPath = path
              return Effect.fail(failure)
            }
            return found.readDirectory(path)
          },
          stat: (path) => {
            calls.push(`stat ${normalize(path)}`)
            if (method === "stat" && normalize(path) === failedPath) {
              refusedPath = path
              return Effect.fail(failure)
            }
            return found.stat(path)
          }
        })).pipe(Effect.provide(NodeFileSystem.layer))
      )
      const diagnostics: Array<unknown> = []
      const capture = Logger.make((entry) => {
        diagnostics.push(entry.message)
      })
      const observation = await Effect.runPromise(
        WorkspaceObservation.observe(fs, root).pipe(
          Effect.provide(Logger.layer([capture], { mergeWithExisting: false }))
        )
      )

      expect(calls).toContain(`${method} ${failedPath}`)
      expect(observation.paths).toBe(relative === "" ? 0 : 1)
      expect(observation.complete).toBe(false)
      expect(diagnostics).toEqual([
        [`Workspace observation could not ${method} ${refusedPath}`, failure]
      ])
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("leaves out a directory that disappeared before listing it", async () => {
    const root = workspace()
    try {
      write(root, "nested/vanishing.py", "gone")
      write(root, "kept.py", "visible")
      const fs = await Effect.runPromise(
        Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
          ...found,
          readDirectory: (path) =>
            normalize(path) === join(root, "nested")
              ? found.readDirectory(join(root, "gone"))
              : found.readDirectory(path)
        })).pipe(Effect.provide(NodeFileSystem.layer))
      )
      const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))
      expect(observation.paths).toBe(1)
      expect(observation.complete).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("keeps a file whose host reports no modification time, and skips what is neither file nor directory", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "socket", "not really")

    // Two host answers a real filesystem can give and a temporary directory
    // cannot be made to give: an entry that is neither a file nor a directory,
    // and a file whose modification time is unavailable. The first contributes
    // nothing; the second still contributes its path and size, so a rewrite
    // that changes the length is still seen.
    const fs = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem => ({
        ...found,
        stat: (path) =>
          Effect.map(found.stat(path), (info) =>
            `${path}`.endsWith("socket")
              ? { ...info, type: "SymbolicLink" as const }
              : { ...info, mtime: Option.none() })
      })).pipe(Effect.provide(NodeFileSystem.layer))
    )

    const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))
    expect(observation.paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("never leaves the root through a symlink, and never measures one", async () => {
    const root = workspace()
    const outside = workspace()
    write(root, "keep.py", "one")
    write(outside, "secret.py", "not this run's tree")
    symlinkSync(join(outside, "secret.py"), join(root, "linked.py"))
    symlinkSync(outside, join(root, "linked"))
    // A link back to the root is a cycle. The host `FileSystem` this observer
    // runs on resolves symlinks in `stat`, so refusing them is what keeps the
    // walk finite and inside the tree the host named.
    symlinkSync(root, join(root, "loop"))

    const before = await measured(root)
    expect(before.paths).toBe(1)

    write(outside, "secret.py", "changed, and none of the run's business")
    expect((await measured(root)).digest).toBe(before.digest)

    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("refuses a link at any depth, by any spelling, to anywhere", async () => {
    const root = workspace()
    const outside = workspace()
    write(root, "keep.py", "one")
    write(root, "a/b/keep.py", "two")
    write(outside, "secret.py", "not this run's tree")
    write(outside, "deep/nested/other.py", "nor this")

    // The check is per entry, wherever the entry is, so the escapes worth
    // pinning are the ones a top-level-only check would miss: a link nested
    // two directories down, a relative one that climbs out with `..`, one that
    // points at nothing, one that points at itself, and one that points at the
    // filesystem root. `stat` follows every one of them.
    symlinkSync(outside, join(root, "a/b/deep-link"))
    symlinkSync(join("..", "..", "..", outside.split("/").at(-1)!, "secret.py"), join(root, "a/b/relative.py"))
    symlinkSync(join(outside, "gone.py"), join(root, "dangling.py"))
    symlinkSync(join(root, "itself"), join(root, "itself"))
    symlinkSync("/", join(root, "everything"))

    const measurement = await measured(root)
    expect(measurement.paths).toBe(2)
    expect(measurement.complete).toBe(true)

    // A walk that followed `everything` would still be running, or would have
    // stopped at `maxPaths` with `complete: false`. Both halves are the claim.
    write(outside, "deep/nested/other.py", "changed, outside the tree")
    expect((await measured(root)).digest).toBe(measurement.digest)

    rmSync(root, { recursive: true, force: true })
    rmSync(outside, { recursive: true, force: true })
  })

  it("reads metadata under the root and does nothing else to the tree", async () => {
    const root = workspace()
    write(root, "src/a.py", "one")
    write(root, "src/nested/b.py", "two")

    // The measurement runs on the host filesystem rather than the kernel's
    // guarded one, and this is the argument for that: it lists, it reads
    // metadata, and it touches nothing but paths under the root it was given.
    // A walk that opened a file or resolved a path the tree did not hand it
    // would need the kernel back.
    const calls: Array<string> = []
    const fs = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, (found): FileSystem.FileSystem =>
        new Proxy(found, {
          get: (target, property, receiver) => {
            const value = Reflect.get(target, property, receiver)
            if (typeof value !== "function") return value
            return (...args: Array<unknown>) => {
              calls.push(`${String(property)} ${String(args[0])}`)
              return value.apply(target, args)
            }
          }
        })).pipe(Effect.provide(NodeFileSystem.layer))
    )

    const observation = await Effect.runPromise(WorkspaceObservation.observe(fs, root))

    expect(observation.paths).toBe(2)
    expect([...new Set(calls.map((call) => call.split(" ")[0]))].sort()).toEqual([
      "readDirectory",
      "readLink",
      "stat"
    ])
    expect(calls.filter((call) => !call.endsWith(root) && !call.includes(`${root}/`))).toEqual([])
    rmSync(root, { recursive: true, force: true })
  })

  it("counts only files, never the directories holding them", async () => {
    const root = workspace()
    write(root, "one/two/three.py", "leaf")

    expect((await measured(root)).paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })

  it("provides an observer over the host filesystem, and a failing one for a host with none", async () => {
    const root = workspace()
    write(root, "a.py", "one")

    const observed = await Effect.runPromise(
      Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
        Effect.provide(WorkspaceObservation.layer(root).pipe(Layer.provide(NodeFileSystem.layer)))
      )
    )
    expect(observed.paths).toBe(1)

    const refused = await Effect.runPromise(
      Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
        Effect.provide(WorkspaceObservation.layerNoop),
        Effect.result
      )
    )
    expect(refused._tag).toBe("Failure")
    rmSync(root, { recursive: true, force: true })
  })

  it("measures through any host, whatever order the host lists a directory in", async () => {
    const root = workspace()
    write(root, "a.py", "one")
    write(root, "src/b.py", "two")
    write(root, "src/c.py", "three")
    const portable = await Effect.runPromise(
      Effect.map(FileSystem.FileSystem, WorkspaceObservation.fileSystemHost).pipe(Effect.provide(NodeFileSystem.layer))
    )
    // A host is free to answer in its own order; a Node listing is not sorted.
    const reversed: WorkspaceObservation.Host = {
      entries: (directory, keep) => Effect.map(portable.entries(directory, keep), (entries) => [...entries].reverse())
    }

    const observation = await Effect.runPromise(
      Effect.flatMap(WorkspaceObservation.Observer, (observer) => observer.observe).pipe(
        Effect.provide(WorkspaceObservation.layerHost(reversed, root))
      )
    )

    expect(observation).toEqual(await measured(root))
    expect(observation.paths).toBe(3)
    rmSync(root, { recursive: true, force: true })
  })

  it("builds an observer from a filesystem the caller already holds", async () => {
    const root = workspace()
    write(root, "a.py", "one")

    const observation = await Effect.runPromise(
      Effect.flatMap(
        FileSystem.FileSystem,
        (fs) => WorkspaceObservation.make(fs, root).observe
      ).pipe(Effect.provide(NodeFileSystem.layer))
    )

    expect(observation.paths).toBe(1)
    rmSync(root, { recursive: true, force: true })
  })
})

describe("WorkspaceObservation.cached", () => {
  const observation = (digest: string, complete = true) => new EngineLike.Observation({ digest, paths: 1, complete })

  /** A walk that counts the walks it finished and answers the next queued measurement. */
  const counting = (answers: ReadonlyArray<EngineLike.Observation>, during: () => void = () => {}) => {
    let walks = 0
    const measure = Effect.sync(() => {
      during()
      return answers[Math.min(walks++, answers.length - 1)]!
    })
    return { measure, walks: () => walks }
  }

  /** A change feed whose delivered and settled counts the test sets. */
  const feed = (initial: Option.Option<number>) => {
    const state = { delivered: initial, settled: initial }
    const changes: WorkspaceObservation.Changes = {
      delivered: Effect.sync(() => state.delivered),
      settled: Effect.sync(() => state.settled)
    }
    return { changes, state }
  }

  it("walks once across frames that changed nothing", async () => {
    const walk = counting([observation("a")])
    const { changes } = feed(Option.some(0))
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    // Forty frames, opened and closed: 80 measurements.
    const all = await Effect.runPromise(Effect.forEach(Array.from({ length: 80 }), () => observe))
    expect(walk.walks()).toBe(1)
    expect(new Set(all.map((each) => each.digest))).toEqual(new Set(["a"]))
  })

  it("walks again once the settled count moves, and serves the new answer", async () => {
    const walk = counting([observation("a"), observation("b")])
    const { changes, state } = feed(Option.some(0))
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    expect((await Effect.runPromise(observe)).digest).toBe("a")
    // A change delivered only once the feed settles: the walk answers.
    state.settled = Option.some(1)
    expect((await Effect.runPromise(observe)).digest).toBe("b")
    expect(walk.walks()).toBe(2)
  })

  it("keeps a walk under the count delivered before it, so a late delivery walks again", async () => {
    const walk = counting([observation("a"), observation("b")])
    const { changes, state } = feed(Option.some(0))
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    await Effect.runPromise(observe)
    state.delivered = Option.some(1)
    state.settled = Option.some(1)
    // Kept under 0; the feed now says 1.
    expect((await Effect.runPromise(observe)).digest).toBe("b")
    expect((await Effect.runPromise(observe)).digest).toBe("b")
    expect(walk.walks()).toBe(2)
  })

  it("walks every time a feed cannot vouch for the tree", async () => {
    const walk = counting([observation("a")])
    const { changes, state } = feed(Option.none())
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    await Effect.runPromise(Effect.all([observe, observe, observe]))
    expect(walk.walks()).toBe(3)
    // A vouched walk, then a lapse in either count: each lapse walks.
    state.delivered = Option.some(5)
    state.settled = Option.some(5)
    await Effect.runPromise(observe)
    state.settled = Option.none()
    await Effect.runPromise(observe)
    state.settled = Option.some(5)
    state.delivered = Option.none()
    await Effect.runPromise(observe)
    // The unvouched walk forgot the kept measurement.
    state.delivered = Option.some(5)
    await Effect.runPromise(observe)
    expect(walk.walks()).toBe(7)
  })

  it("never serves a partial measurement again", async () => {
    const walk = counting([observation("prefix", false)])
    const { changes } = feed(Option.some(0))
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    await Effect.runPromise(Effect.all([observe, observe]))
    expect(walk.walks()).toBe(2)
  })

  it("reads the count before walking, so a change during the walk is walked again", async () => {
    const { changes, state } = feed(Option.some(0))
    const walk = counting([observation("walk-1"), observation("walk-2")], () => {
      // Something writes while the walk is under way, and the feed counts it.
      state.delivered = Option.map(state.delivered, (count) => count + 1)
      state.settled = state.delivered
    })
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    expect((await Effect.runPromise(observe)).digest).toBe("walk-1")
    expect((await Effect.runPromise(observe)).digest).toBe("walk-2")
    expect(walk.walks()).toBe(2)
  })

  it("lets the walk answer while the feed is slower than the walk", async () => {
    const walk = counting([observation("a"), observation("b")])
    const changes: WorkspaceObservation.Changes = {
      delivered: Effect.succeed(Option.some(0)),
      settled: Effect.never
    }
    const observe = WorkspaceObservation.cached(walk.measure, changes)
    await Effect.runPromise(observe)
    expect((await Effect.runPromise(observe)).digest).toBe("b")
  })

  it("stops the walk once the settled feed vouches for the kept measurement", async () => {
    let started = 0
    let finished = 0
    const measure = Effect.gen(function*() {
      started++
      if (started > 1) yield* Effect.never
      finished++
      return observation("a")
    })
    const { changes } = feed(Option.some(0))
    const observe = WorkspaceObservation.cached(measure, changes)
    await Effect.runPromise(observe)
    // A walk that would never end: the kept measurement answers, and the walk,
    // if it began at all, is stopped.
    expect((await Effect.runPromise(observe)).digest).toBe("a")
    expect(finished).toBe(1)
    expect(started).toBeLessThanOrEqual(2)
  })
})
