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
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { test } from "vitest"
import * as CodingFileSystem from "../../../../../flows/coding/filesystem.ts"

const installed = process.env.SMITHERS_COL10_INSTALLED === "1"
for (const available of [false, true]) {
  test.skipIf(available && !installed)(`C-COL-01 production dispatcher ${available ? "installed batch/delete/move" : "unavailable provider"}`, async (t) => {
    const root = await mkdtemp(join(available ? "/workspace/" : tmpdir(), "col10-"))
    t.onTestFinished(() => rm(root, { recursive: true, force: true }))
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
      const dispatch = (name: string, input: Cell.Call["input"]) => {
        const binding = bindings.find((entry) => entry.descriptor.name === name)
        assert.ok(binding)
        return binding.run(new Cell.Call({ flowName: name, input, capabilities: [],
          effects: { reads: [], writes: [], mode: "hermetic", onConflict: "serialize", tier: "sealed" },
          placement: Option.none(), identity: new Cell.CallIdentity({ session: "col10-acceptance",
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
        for (const [name, input] of [
          [Write.name, { path: a, content: "bad" }],
          [Edit.name, { path: a, oldString: "hello", newString: "bad" }],
          [ApplyPatch.name, patch(`*** Delete File: ${a}\n*** Add File: ${dest}\n+bad\n`)]
        ] as const) yield* expect(name, input, "failure", /provider unavailable/i)
        assert.equal(yield* fs.readFileString(a), "hello\n")
        assert.equal(yield* fs.exists(dest), false)
        return
      }
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
    }).pipe(Effect.provide(NodeServices.layer)))
  })
}
