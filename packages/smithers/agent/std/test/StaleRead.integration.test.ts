/** Production coding/edit-atom std bindings. No supplied mutation provider.
 * Run the installed matrix inside a broker-registered guest coding session:
 * SMITHERS_COL10_INSTALLED=1 pnpm exec vitest run test/StaleRead.integration.test.ts
 * The ordinary Linux run proves unavailable-provider refusal only.
 */
import { NodeServices } from "@effect/platform-node"
import * as StandardFlows from "@smthrs/agent/StandardFlows"
import * as Cell from "@smthrs/harness/Cell"
import * as ApplyPatch from "@smthrs/std/ApplyPatch"
import * as Edit from "@smthrs/std/Edit"
import * as Read from "@smthrs/std/Read"
import * as Write from "@smthrs/std/Write"
import { Context, Effect, FileSystem, Option, Path } from "effect"
import { ChildProcessSpawner } from "effect/unstable/process"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import * as CodingFileSystem from "../../../../../flows/coding/filesystem.ts"

const installed = process.env.SMITHERS_COL10_INSTALLED === "1"
for (const available of [false, true]) {
  test.skipIf(available && !installed)(`C-COL-01 production dispatcher ${available ? "installed batch/delete/move" : "unavailable provider"}`, async (t) => {
    const root = await mkdtemp(join(available ? "/workspace/" : tmpdir(), "col10-"))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    if (available) assert.notEqual(process.getuid?.(), 0, "Installed acceptance must run as the registered unprivileged coding session")
    await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      // Fixed guest root chooses the shipped authenticated daemon adapter.
      // A temp host root deliberately has no provider and cannot write.
      const coding = CodingFileSystem.make({ repositoryPath: available ? "/workspace" : root }, fs, spawner, available ? "/workspace" : root)
      const bindings = yield* StandardFlows.filesystem(
        Context.make(FileSystem.FileSystem, coding).pipe(Context.add(Path.Path, path))
      ).bindings()
      let ordinal = 0
      const dispatch = (name: string, input: Cell.Call["input"], session = "col10-acceptance") => {
        const binding = bindings.find((entry) => entry.descriptor.name === name)
        assert.ok(binding)
        return binding.run(new Cell.Call({ flowName: name, input, capabilities: [],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(), identity: new Cell.CallIdentity({ session,
            frame: 0, cell: "coding/edit-atom", ordinal: ordinal++, declaration: "col10", layers: [] }) }))
      }
      const a = join(root, "a"), b = join(root, "b"), dest = join(root, "dest")
      const patch = (body: string) => ({ input: `*** Begin Patch\n${body}*** End Patch` })
      const expect = (name: string, input: Cell.Call["input"], outcome: "success" | "failure", message?: RegExp) =>
        dispatch(name, input).pipe(Effect.tap((result) => Effect.sync(() => {
          assert.equal(result.outcome, outcome, result.message ?? "")
          if (message) assert.match(result.message!, message)
        })))
      // Outside writer bytes are literal fixtures, independent of production hashes.
      yield* Effect.promise(() => writeFile(a, "hello\n"))
      yield* expect(Read.name, { path: a, limit: 1 }, "success")
      if (!available) {
        yield* Effect.promise(() => writeFile(b, "world\n"))
        yield* expect(Read.name, { path: b }, "success")
        for (const [name, input] of [
          [Write.name, { path: a, content: "bad" }],
          [Edit.name, { path: a, oldString: "hello", newString: "bad" }],
          [ApplyPatch.name, patch(`*** Delete File: ${a}\n*** Add File: ${dest}\n+bad\n`)],
          [ApplyPatch.name, patch(`*** Update File: ${a}\n*** Move to: ${dest}\n@@\n-hello\n+bad\n`)],
          [ApplyPatch.name, patch(`*** Update File: ${a}\n@@\n-hello\n+bad\n*** Delete File: ${b}\n`)],
          [ApplyPatch.name, patch(`*** Add File: ${dest}\n`)],
          [ApplyPatch.name, patch(`*** Delete File: ${a}\n`)],
          [Write.name, { path: dest, content: "bad" }]
        ] as const) yield* expect(name, input, "failure", /provider unavailable/i)
        assert.equal(yield* fs.readFileString(a), "hello\n")
        assert.equal(yield* fs.readFileString(b), "world\n")
        assert.equal(yield* fs.exists(dest), false)
        return
      }
      // Moving to an absent destination must guard source removal as part of
      // the same batch, then retain own-write authority at the new path.
      const moveSource = join(root, "move-source"), moveTarget = join(root, "move-target")
      yield* Effect.promise(() => writeFile(moveSource, "hello\n"))
      yield* expect(Read.name, { path: moveSource }, "success")
      yield* expect(ApplyPatch.name, patch(`*** Update File: ${moveSource}\n*** Move to: ${moveTarget}\n@@\n-hello\n+world\n`), "success")
      assert.equal(yield* fs.exists(moveSource), false)
      assert.equal(yield* fs.readFileString(moveTarget), "world\n")
      yield* expect(Edit.name, { path: moveTarget, oldString: "world", newString: "hello" }, "success")
      // A recreated source cannot inherit the deleted source's authority.
      yield* Effect.promise(() => writeFile(moveSource, "world\n"))
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${moveTarget}\n*** Add File: ${moveSource}\n+bad\n`), "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(moveSource), "world\n")
      assert.equal(yield* fs.readFileString(moveTarget), "hello\n")
      // Empty content is a present file, not the deletion sentinel. A subsequent
      // own-write deletion works without an artificial model-facing read.
      const empty = join(root, "empty")
      yield* expect(ApplyPatch.name, patch(`*** Add File: ${empty}\n`), "success")
      assert.equal(yield* fs.exists(empty), true)
      assert.equal(yield* fs.readFileString(empty), "")
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${empty}\n`), "success")
      assert.equal(yield* fs.exists(empty), false)
      // Pagination must retain the digest of the undisplayed tail. Reading in
      // another run must neither authorize our write nor refresh our stale base.
      const paged = join(root, "paged")
      yield* Effect.promise(() => writeFile(paged, "hello\nworld\n"))
      yield* expect(Read.name, { path: paged, limit: 1 }, "success")
      yield* Effect.promise(() => writeFile(paged, "hello\nchanged tail\n"))
      const otherRead = yield* dispatch(Read.name, { path: paged }, "col10-other-run")
      assert.equal(otherRead.outcome, "success")
      yield* expect(Write.name, { path: paged, content: "bad" }, "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(paged), "hello\nchanged tail\n")
      yield* expect(Read.name, { path: paged, limit: 1 }, "success")
      yield* expect(Edit.name, { path: paged, oldString: "changed tail", newString: "world" }, "success")
      assert.equal(yield* fs.readFileString(paged), "hello\nworld\n")
      const unreadRun = yield* dispatch(Write.name, { path: paged, content: "bad" }, "col10-unread-run")
      assert.equal(unreadRun.outcome, "failure")
      assert.match(unreadRun.message!, /Re-read/)
      assert.equal(yield* fs.readFileString(paged), "hello\nworld\n")
      // A later stale add refuses the complete batch without consuming our own
      // successful edit's read authority for the earlier deletion.
      const createdOutside = join(root, "created-outside")
      yield* Effect.promise(() => writeFile(createdOutside, "world\n"))
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${paged}\n*** Add File: ${createdOutside}\n+bad\n`), "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(paged), "hello\nworld\n")
      assert.equal(yield* fs.readFileString(createdOutside), "world\n")
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${paged}\n`), "success")
      assert.equal(yield* fs.exists(paged), false)
      // Unread existing sources refuse at every mutation door, including delete.
      yield* Effect.promise(() => writeFile(b, "world\n"))
      for (const [name, input] of [
        [Write.name, { path: b, content: "bad" }],
        [Edit.name, { path: b, oldString: "world", newString: "bad" }],
        [ApplyPatch.name, patch(`*** Delete File: ${b}\n`)],
        [ApplyPatch.name, patch(`*** Update File: ${b}\n@@\n-world\n+bad\n`)]
      ] as const) yield* expect(name, input, "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(b), "world\n")
      yield* expect(Read.name, { path: b }, "success")
      yield* expect(Write.name, { path: b, content: "world\n" }, "success")
      yield* expect(Edit.name, { path: b, oldString: "world", newString: "hello" }, "success")
      yield* Effect.promise(() => writeFile(a, "world\n"))
      for (const [name, input] of [
        [Write.name, { path: a, content: "bad" }],
        [Edit.name, { path: a, oldString: "hello", newString: "bad" }],
        [ApplyPatch.name, patch(`*** Update File: ${b}\n@@\n-hello\n+bad\n*** Delete File: ${a}\n`)]
      ] as const) yield* expect(name, input, "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(a), "world\n")
      assert.equal(yield* fs.readFileString(b), "hello\n")
      // A changed move source and a changed deletion source refuse independently.
      yield* expect(ApplyPatch.name, patch(`*** Update File: ${a}\n*** Move to: ${dest}\n@@\n-hello\n+bad\n`), "failure", /Re-read/)
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${a}\n`), "failure", /Re-read/)
      assert.equal(yield* fs.exists(dest), false)
      yield* expect(Read.name, { path: a }, "success")
      const move = patch(`*** Update File: ${a}\n*** Move to: ${dest}\n@@\n-world\n+hello\n`)
      // Unread existing destination, then read but externally changed destination.
      yield* Effect.promise(() => writeFile(dest, "world\n"))
      yield* expect(ApplyPatch.name, move, "failure", /Re-read/)
      yield* expect(Read.name, { path: dest }, "success")
      yield* Effect.promise(() => writeFile(dest, "hello\n"))
      yield* expect(ApplyPatch.name, move, "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(a), "world\n")
      assert.equal(yield* fs.readFileString(dest), "hello\n")
      yield* expect(Read.name, { path: dest }, "success")
      yield* expect(ApplyPatch.name, move, "success")
      assert.equal(yield* fs.exists(a), false)
      assert.equal(yield* fs.readFileString(dest), "hello\n")
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${b}\n*** Add File: ${a}\n+world\n`), "success")
      assert.equal(yield* fs.exists(b), false)
      assert.equal(yield* fs.readFileString(a), "world\n")
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${dest}\n`), "success")
      assert.equal(yield* fs.exists(dest), false)
      // A formerly absent destination is created outside Smithers. The earlier
      // deletion must remain unapplied; refusing the patch cannot advance bases.
      yield* Effect.promise(() => writeFile(dest, "world\n"))
      yield* expect(ApplyPatch.name, patch(`*** Delete File: ${a}\n*** Add File: ${dest}\n+bad\n`), "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(a), "world\n")
      assert.equal(yield* fs.readFileString(dest), "world\n")
      // Successful multi-file update/add uses one batch, with own-write authority.
      yield* expect(ApplyPatch.name, patch(`*** Update File: ${a}\n@@\n-world\n+hello\n*** Add File: ${b}\n+world\n`), "success")
      assert.equal(yield* fs.readFileString(a), "hello\n")
      assert.equal(yield* fs.readFileString(b), "world\n")
      // Real I/O failure after the first file. A third, untouched existing file
      // distinguishes ledger invalidation from merely detecting changed bytes.
      const locked = join(root, "locked"), blocked = join(locked, "new")
      yield* Effect.promise(() => mkdir(locked))
      t.onTestFinished(async () => {
        await chmod(locked, 0o700).catch(() => {})
        await rm(root, { recursive: true, force: true })
      })
      yield* Effect.promise(() => chmod(locked, 0o555))
      yield* expect(ApplyPatch.name, patch(`*** Update File: ${a}\n@@\n-hello\n+world\n*** Add File: ${blocked}\n+hello\n*** Update File: ${b}\n@@\n-world\n+hello\n`), "failure", /Patch stopped after 1 files; re-read all affected paths/)
      assert.equal(yield* fs.readFileString(a), "world\n")
      assert.equal(yield* fs.exists(blocked), false)
      assert.equal(yield* fs.readFileString(b), "world\n")
      for (const target of [a, b]) {
        yield* expect(Write.name, { path: target, content: "bad" }, "failure", /Re-read/)
        assert.equal(yield* fs.readFileString(target), "world\n")
      }
      yield* expect(Read.name, { path: a }, "success")
      yield* expect(Read.name, { path: b }, "success")
      yield* expect(Edit.name, { path: b, oldString: "world", newString: "hello" }, "success")
      assert.equal(yield* fs.readFileString(b), "hello\n")
      // A singleton I/O failure has no batch-prefix receipt. Even if the file
      // still has its old bytes, restoring directory permissions must not let
      // the old read authorize a retry after unknown settlement.
      const singleton = join(locked, "existing")
      yield* Effect.promise(() => chmod(locked, 0o700))
      yield* Effect.promise(() => writeFile(singleton, "hello\n"))
      yield* expect(Read.name, { path: singleton }, "success")
      yield* Effect.promise(() => chmod(locked, 0o555))
      yield* expect(Write.name, { path: singleton, content: "world\n" }, "failure")
      assert.equal(yield* fs.readFileString(singleton), "hello\n")
      yield* Effect.promise(() => chmod(locked, 0o700))
      yield* expect(Write.name, { path: singleton, content: "world\n" }, "failure", /Re-read/)
      assert.equal(yield* fs.readFileString(singleton), "hello\n")
      yield* expect(Read.name, { path: singleton }, "success")
      yield* expect(Write.name, { path: singleton, content: "world\n" }, "success")
      assert.equal(yield* fs.readFileString(singleton), "world\n")
      // Confinement at the same production tool door. This is supplemental;
      // it does not claim root-input or fresh/retained-machine qualification.
      const outside = yield* Effect.promise(() => mkdtemp(join(tmpdir(), "col10-outside-")))
      t.onTestFinished(() => rm(outside, { recursive: true, force: true }))
      const outsideFile = join(outside, "protected")
      yield* Effect.promise(() => writeFile(outsideFile, "outside remains\n"))
      const linked = join(root, "linked")
      yield* Effect.promise(() => symlink(outsideFile, linked))
      yield* expect(Read.name, { path: linked }, "success")
      yield* expect(Write.name, { path: linked, content: "bad" }, "failure")
      yield* expect(Write.name, { path: outsideFile, content: "bad" }, "failure")
      assert.equal(yield* Effect.promise(() => readFile(outsideFile, "utf8")), "outside remains\n")
      // A new host has no read authority even with the same session string.
      const resumed = CodingFileSystem.make({ repositoryPath: "/workspace" }, fs, spawner, "/workspace")
      const resumedBindings = yield* StandardFlows.filesystem(
        Context.make(FileSystem.FileSystem, resumed).pipe(Context.add(Path.Path, path))
      ).bindings()
      const write = resumedBindings.find((entry) => entry.descriptor.name === Write.name)!
      const result = yield* write.run(new Cell.Call({ flowName: Write.name, input: { path: a, content: "bad" }, capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(), identity: new Cell.CallIdentity({ session: "col10-acceptance", frame: 1,
          cell: "coding/edit-atom", ordinal: 0, declaration: "col10", layers: [] }) }))
      assert.equal(result.outcome, "failure")
      assert.match(result.message!, /Re-read/)
      assert.equal(yield* Effect.promise(() => readFile(a, "utf8")), "world\n")
      const resumedRead = resumedBindings.find((entry) => entry.descriptor.name === Read.name)!
      const resumedCall = (flowName: string, input: Cell.Call["input"]) => new Cell.Call({
        flowName, input, capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(), identity: new Cell.CallIdentity({ session: "col10-acceptance", frame: 1,
          cell: "coding/edit-atom", ordinal: ++ordinal, declaration: "col10", layers: [] })
      })
      assert.equal((yield* resumedRead.run(resumedCall(Read.name, { path: a }))).outcome, "success")
      assert.equal((yield* write.run(resumedCall(Write.name, { path: a, content: "hello\n" }))).outcome, "success")
      assert.equal(yield* Effect.promise(() => readFile(a, "utf8")), "hello\n")
    }).pipe(Effect.provide(NodeServices.layer)))
  }, 120_000)
}

// Exercise the actual child-process adapter when the main-installed client is
// absent. No injected spawner, filesystem or provider can manufacture settlement.
// Installed hosts run the guest matrix above instead of this missing-client case.
test.skipIf(existsSync("/opt/smithers/bin/smithers-machined"))(
  "C-COL-01 production dispatcher loses authority after missing installed client",
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "col10-missing-client-"))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
    const a = join(root, "a"), b = join(root, "b"), dest = join(root, "dest")
    await writeFile(a, "hello\n")
    await writeFile(b, "world\n")
    await Effect.runPromise(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner
      const path = yield* Path.Path
      const coding = CodingFileSystem.make({ repositoryPath: root }, fs, spawner, "/workspace")
      const bindings = yield* StandardFlows.filesystem(
        Context.make(FileSystem.FileSystem, coding).pipe(Context.add(Path.Path, path))
      ).bindings()
      let ordinal = 0
      const dispatch = (name: string, input: Cell.Call["input"]) => bindings.find(
        (entry) => entry.descriptor.name === name
      )!.run(new Cell.Call({ flowName: name, input, capabilities: [],
        effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
        placement: Option.none(), identity: new Cell.CallIdentity({ session: "missing-client",
          frame: 0, cell: "coding/edit-atom", ordinal: ordinal++, declaration: "col10", layers: [] })
      }))
      for (const [name, input, affected] of [
        [Write.name, { path: a, content: "bad" }, [a]],
        [Edit.name, { path: a, oldString: "hello", newString: "bad" }, [a]],
        [ApplyPatch.name, { input: `*** Begin Patch\n*** Update File: ${a}\n@@\n-hello\n+bad\n*** Delete File: ${b}\n*** End Patch` }, [a, b]],
        [ApplyPatch.name, { input: `*** Begin Patch\n*** Update File: ${a}\n*** Move to: ${dest}\n@@\n-hello\n+bad\n*** End Patch` }, [a]]
      ] as const) {
        for (const target of affected) assert.equal((yield* dispatch(Read.name, { path: target })).outcome, "success")
        const refused = yield* dispatch(name, input)
        assert.equal(refused.outcome, "failure")
        assert.match(refused.message!, /provider unavailable/i)
        for (const target of affected) {
          const retry = yield* dispatch(Write.name, { path: target, content: "bad" })
          assert.equal(retry.outcome, "failure")
          assert.match(retry.message!, /Re-read/, "unknown settlement requires fresh reads of every affected existing path")
        }
        assert.equal(yield* fs.readFileString(a), "hello\n")
        assert.equal(yield* fs.readFileString(b), "world\n")
        assert.equal(yield* fs.exists(dest), false)
      }
    }).pipe(Effect.provide(NodeServices.layer)))
  }, 120_000
)
