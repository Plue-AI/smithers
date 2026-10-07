import { NodeServices } from "@effect/platform-node"
import { Deferred, Effect, Fiber, FileSystem, Path } from "effect"
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import * as FileMutation from "../src/internal/FileMutation.ts"
import * as LanguageServer from "../src/LanguageServer.ts"
import * as Read from "../src/Read.ts"
import { StdError } from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

// This deliberately substitutes only the provider seam to prove tool batching,
// ordering and refusal behavior against real files. It does not qualify guest
// exclusion, atomic disk writes or C-COL-01's real machine/HTTP boundaries.
const fixture = async <A>(body: (root: string) => Promise<A>): Promise<A> => {
  const root = await mkdtemp(join(tmpdir(), "std-versioned-"))
  try {
    for (const name of ["a", "b", "move", "delete"]) await writeFile(join(root, name), "original\n")
    return await body(root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

const guarded = (
  fs: FileSystem.FileSystem,
  policy: NonNullable<FileMutation.VersionedFileSystem[typeof FileMutation.Preconditions]>
): FileMutation.VersionedFileSystem => {
  const forbidden = () => Effect.die("tool bypassed the atomic provider")
  return {
    ...fs,
    [FileMutation.Preconditions]: policy,
    makeDirectory: forbidden,
    writeFile: forbidden,
    writeFileString: forbidden,
    remove: forbidden,
    rename: forbidden,
    chmod: forbidden,
    chown: forbidden
  }
}

const patch = (root: string) =>
  `*** Begin Patch
*** Add File: ${join(root, "new", "added")}
+added
*** Update File: ${join(root, "a")}
@@
-original
+updated
*** Update File: ${join(root, "move")}
*** Move to: ${join(root, "new", "moved")}
@@
-original
+moved
*** Delete File: ${join(root, "delete")}
*** End Patch`

describe("versioned standard mutations", () => {
  it("serializes host preparation and releases a cancelled waiter without leaking its permit", async () => {
    await fixture(async (root) => {
      await Effect.runPromise(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          const entered = yield* Deferred.make<void>()
          const release = yield* Deferred.make<void>()
          const waiting = yield* Deferred.make<void>()
          const prepared: Array<string | undefined> = []
          const versioned = guarded(fs, {
            record: () => Effect.void,
            validate: (_paths, session) =>
              session === "waiting" ? Deferred.succeed(waiting, undefined).pipe(Effect.asVoid) : Effect.void,
            prepare: (_paths, session) =>
              Effect.sync(() => {
                prepared.push(session)
                return {
                  read: () => Effect.die("write must not read its preimage"),
                  commit: (changes) =>
                    Effect.gen(function*() {
                      if (session === "first") {
                        yield* Deferred.succeed(entered, undefined)
                        yield* Deferred.await(release)
                      }
                      yield* fs.writeFile(changes[0]!.path, changes[0]!.content!).pipe(Effect.orDie)
                    })
                }
              })
          })
          const call = (session: string) =>
            Write.run({ path: join(root, "a"), content: session }).pipe(
              Effect.provideService(FileSystem.FileSystem, versioned),
              Effect.provideService(FileMutation.ReadSession, session)
            )
          const first = yield* Effect.forkChild(call("first"))
          yield* Deferred.await(entered)
          const second = yield* Effect.forkChild(call("waiting"))
          yield* Deferred.await(waiting)
          yield* Effect.yieldNow
          expect(prepared).toEqual(["first"])
          yield* Fiber.interrupt(second)
          yield* Deferred.succeed(release, undefined)
          yield* Fiber.join(first)
          yield* call("after")
          expect(prepared).toEqual(["first", "after"])
          expect(yield* fs.readFileString(join(root, "a"))).toBe("after")
        }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
      )
    })
  })

  it.each(["write", "edit", "patch"] as const)(
    "submits %s once and reports success only after settlement",
    async (kind) => {
      await fixture(async (root) => {
        await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            const entered = yield* Deferred.make<void>()
            const release = yield* Deferred.make<void>()
            const events: Array<string> = []
            const requests: Array<ReadonlyArray<FileMutation.Change>> = []
            let recorded = 0
            const versioned = guarded(fs, {
              record: () =>
                Effect.sync(() => {
                  recorded++
                }),
              validate: () => Effect.void,
              prepare: (paths, session) =>
                Effect.sync(() => {
                  expect(session).toBe("run-a")
                  expect(paths).toEqual(
                    kind === "patch"
                      ? [
                        join(root, "new", "added"),
                        join(root, "a"),
                        join(root, "move"),
                        join(root, "new", "moved"),
                        join(root, "delete")
                      ]
                      : [join(root, "a")]
                  )
                  events.push("prepared")
                  return {
                    read: () => Effect.succeed(new TextEncoder().encode("original\n")),
                    commit: (changes) =>
                      Effect.gen(function*() {
                        requests.push(changes)
                        yield* Deferred.succeed(entered, undefined)
                        yield* Deferred.await(release)
                        // A test provider writes the exact submitted bytes. The tool's
                        // raw filesystem mutations are separately trapped above.
                        yield* Effect.tryPromise({
                          try: async () => {
                            for (const change of changes) {
                              if (change.content === null) await rm(change.path)
                              else {
                                await mkdir(dirname(change.path), { recursive: true })
                                await writeFile(change.path, change.content)
                              }
                            }
                          },
                          catch: () => new StdError({ code: "command_failed", message: "fixture write failed" })
                        })
                        events.push("settled")
                      })
                  }
                })
            })
            const server = {
              ...LanguageServer.makeNoop(),
              sync: (path: string) =>
                Effect.sync(() => {
                  events.push("sync:" + path)
                }),
              close: (path: string) =>
                Effect.sync(() => {
                  events.push("close:" + path)
                })
            }
            const call: Effect.Effect<unknown, StdError, FileSystem.FileSystem | Path.Path> = kind === "write"
              ? Write.run({ path: join(root, "a"), content: "written\n" })
              : kind === "edit"
              ? Edit.run({ path: join(root, "a"), oldString: "original", newString: "edited" })
              : ApplyPatch.run({ input: patch(root) })
            const run = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
              effect.pipe(
                Effect.provideService(FileSystem.FileSystem, versioned),
                Effect.provideService(FileMutation.ReadSession, "run-a"),
                Effect.provideService(LanguageServer.LanguageServer, server)
              )
            yield* run(Read.run({ path: join(root, "a") }))
            const fiber = yield* Effect.forkChild(run(call))
            yield* Deferred.await(entered)
            expect(events).toEqual(["prepared"])
            expect(yield* fs.readFileString(join(root, "a"))).toBe("original\n")
            expect(yield* fs.exists(join(root, "new"))).toBe(false)
            expect(recorded).toBe(1)
            expect(requests).toHaveLength(1)
            expect(
              requests[0]!.map((change) => ({
                path: change.path,
                content: change.content === null ? null : new TextDecoder().decode(change.content)
              }))
            ).toEqual(
              kind === "patch" ?
                [
                  { path: join(root, "new", "added"), content: "added\n" },
                  { path: join(root, "a"), content: "updated\n" },
                  { path: join(root, "new", "moved"), content: "moved\n" },
                  { path: join(root, "move"), content: null },
                  { path: join(root, "delete"), content: null }
                ] :
                [{ path: join(root, "a"), content: kind === "write" ? "written\n" : "edited\n" }]
            )
            yield* Deferred.succeed(release, undefined)
            const result = yield* Fiber.join(fiber)
            expect(events.slice(0, 2)).toEqual(["prepared", "settled"])
            expect(recorded).toBe(1) // Only the provider may advance committed bases.
            if (kind === "patch") {
              expect(result).toMatchObject({
                added: [join(root, "new", "added")],
                modified: [join(root, "a"), join(root, "new", "moved")],
                deleted: [join(root, "delete")]
              })
            }
            expect(events.slice(2)).toEqual(
              kind === "patch" ?
                [
                  "sync:" + join(root, "new", "added"),
                  "sync:" + join(root, "a"),
                  "sync:" + join(root, "new", "moved"),
                  "close:" + join(root, "move"),
                  "close:" + join(root, "delete")
                ] :
                ["sync:" + join(root, "a")]
            )
          }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
        )
      })
    }
  )

  it.each(["missing", "prepare-refused", "read-refused", "commit-refused"] as const)(
    "keeps %s providers closed without creating parents or diagnostics",
    async (mode) => {
      await fixture(async (root) => {
        await Effect.runPromise(
          Effect.gen(function*() {
            const fs = yield* FileSystem.FileSystem
            let commits = 0
            let diagnostics = 0
            const stale = new StdError({
              code: "stale_read",
              message: "later destination changed",
              path: join(root, "delete"),
              base_digest: "old",
              current_digest: "new"
            })
            const versioned = guarded(fs, {
              record: () => Effect.die("mutation refreshed read history"),
              validate: () => Effect.void,
              ...(mode === "missing" ?
                {} :
                {
                  prepare: () =>
                    mode === "prepare-refused" ? Effect.fail(stale) : Effect.succeed({
                      read: () =>
                        mode === "read-refused"
                          ? Effect.fail(stale)
                          : Effect.succeed(new TextEncoder().encode("original\n")),
                      commit: () =>
                        Effect.sync(() => {
                          commits++
                        }).pipe(Effect.andThen(Effect.fail(stale)))
                    })
                })
            })
            const call = ApplyPatch.run({ input: patch(root) }).pipe(
              Effect.provideService(FileSystem.FileSystem, versioned),
              Effect.provideService(LanguageServer.LanguageServer, {
                ...LanguageServer.makeNoop(),
                sync: () =>
                  Effect.sync(() => {
                    diagnostics++
                  }),
                close: () =>
                  Effect.sync(() => {
                    diagnostics++
                  })
              })
            )
            const error = yield* Effect.flip(call)
            expect(error.code).toBe(mode === "missing" ? "provider_unavailable" : "stale_read")
            expect(commits).toBe(mode === "commit-refused" ? 1 : 0)
            expect(diagnostics).toBe(0)
          }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
        )
        expect((await readdir(root)).sort()).toEqual(["a", "b", "delete", "move"])
        for (const name of ["a", "b", "delete", "move"]) {
          expect(await readFile(join(root, name), "utf8")).toBe("original\n")
        }
      })
    }
  )
})

it.each(["edit", "patch"] as const)("%s computes from its captured base during an outside write", async (kind) => {
  await fixture(async (root) => {
    await Effect.runPromise(
      Effect.gen(function*() {
        const fs = yield* FileSystem.FileSystem
        const target = join(root, "a")
        let submitted: string | undefined
        const versioned = guarded(fs, {
          record: () => Effect.die("internal read refreshed the ledger"),
          validate: () => Effect.void,
          prepare: () =>
            Effect.gen(function*() {
              const snapshot = yield* fs.readFile(target).pipe(Effect.orDie)
              // An outside editor temporarily adds unrelated text after base capture.
              yield* fs.writeFileString(target, "original\ntransient outside text\n").pipe(Effect.orDie)
              return {
                read: (path) => {
                  expect(path).toBe(target)
                  return Effect.succeed(snapshot.slice())
                },
                commit: (changes: ReadonlyArray<FileMutation.Change>) =>
                  Effect.gen(function*() {
                    // The outside writer returns to the captured version before compare.
                    yield* fs.writeFile(target, snapshot).pipe(Effect.orDie)
                    expect(changes).toHaveLength(1)
                    submitted = new TextDecoder().decode(changes[0]!.content!)
                    yield* fs.writeFile(target, changes[0]!.content!).pipe(Effect.orDie)
                  })
              }
            })
        })
        const action = kind === "edit"
          ? Edit.run({ path: target, oldString: "original", newString: "mine" }).pipe(Effect.asVoid)
          : ApplyPatch.run({
            input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-original\n+mine\n*** End Patch`
          }).pipe(Effect.asVoid)
        yield* action.pipe(Effect.provideService(FileSystem.FileSystem, versioned))
        expect(submitted).toBe("mine\n")
        expect(yield* fs.readFileString(target)).toBe("mine\n")
      }).pipe(Effect.provide(NodeServices.layer), Effect.scoped)
    )
  })
})

// T-COL-10's daemon provider is substituted here. These assertions prove the
// public standard tools propagate its moved_off refusal without another writer;
// real cgroup dispatch and guest exclusion remain reference-host evidence.
it.each(["write", "edit", "patch"] as const)("moved_off refuses %s through the prepared provider without disk or diagnostics", async (tool) => {
  await fixture(async root => {
    await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      let commits = 0, diagnostics = 0
      const refusal = new StdError({ code: "moved_off", message: "Branch moved off its TODO" })
      const versioned = guarded(fs, {
        record: () => Effect.void, validate: () => Effect.void,
        prepare: () => Effect.succeed({
          read: () => Effect.succeed(new TextEncoder().encode("original\n")),
          commit: () => Effect.sync(() => { commits++ }).pipe(Effect.andThen(Effect.fail(refusal)))
        })
      })
      const action = tool === "write" ? Write.run({ path: join(root, "a"), content: "mine" }).pipe(Effect.asVoid)
        : tool === "edit" ? Edit.run({ path: join(root, "a"), oldString: "original", newString: "mine" }).pipe(Effect.asVoid)
        : ApplyPatch.run({ input: patch(root) }).pipe(Effect.asVoid)
      const error = yield* Effect.flip(action.pipe(
        Effect.provideService(FileSystem.FileSystem, versioned),
        Effect.provideService(LanguageServer.LanguageServer, { ...LanguageServer.makeNoop(), sync: () => Effect.sync(() => { diagnostics++ }), close: () => Effect.sync(() => { diagnostics++ }) })
      ))
      expect(error).toBe(refusal)
      expect(commits).toBe(1)
      expect(diagnostics).toBe(0)
    }).pipe(Effect.provide(NodeServices.layer), Effect.scoped))
    expect((await readdir(root)).sort()).toEqual(["a", "b", "delete", "move"])
    for (const name of ["a", "b", "delete", "move"]) expect(await readFile(join(root, name), "utf8")).toBe("original\n")
  })
})
