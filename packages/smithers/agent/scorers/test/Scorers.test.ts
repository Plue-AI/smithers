import { ProviderError } from "@smthrs/sandbox/RemoteChildProcessSpawner"
import type { Session } from "@smthrs/sandbox/Sandbox"
import { Deferred, Effect, Exit, Fiber, Stream } from "effect"
import { describe, expect, it } from "vitest"
import * as Runner from "../src/Runner.ts"
import * as RunnerLive from "../src/RunnerLive.ts"
import * as Scorers from "../src/Scorers.ts"
import * as ScoreStore from "../src/ScoreStore.ts"

const input = (output: unknown, groundTruth?: unknown) => ({ input: null, output, groundTruth })
const diff = `diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -1,3 +1,4 @@
 keep
-old
+new
+extra
 keep
diff --git a/b.ts b/b.ts
--- a/b.ts
+++ /dev/null
@@ -1 +0,0 @@
-removed
diff --git a/a.ts b/a.ts
--- a/a.ts
+++ b/a.ts
@@ -10 +10 @@
-old-again
+new-again
`
describe("built-in scorers", () => {
  it("normalizes exact equality without changing words or case", async () => {
    const scorer = Scorers.exact()
    expect(await Effect.runPromise(scorer.score(input("  A\tB\n", "A B")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input(" ", "")))).toMatchObject({ score: 1 })
    expect(await Effect.runPromise(scorer.score(input("AB", "A B")))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(scorer.score(input("a b", "A B")))).toMatchObject({ score: 0 })
    expect(Exit.isFailure(await Effect.runPromiseExit(scorer.score(input(42, "42"))))).toBe(true)
    expect(await Effect.runPromise(Scorers.contains().score(input("prefix value suffix", "value")))).toEqual({
      score: 1
    })
    expect(await Effect.runPromise(Scorers.contains().score(input("VALUE", "value")))).toEqual({ score: 0 })
  })
  it("counts only hunk changes, deduplicates paths and includes deletions at cap boundaries", async () => {
    expect(await Effect.runPromise(Scorers.diffSize({ max: 6 }).score(input(diff)))).toMatchObject({
      score: 1,
      meta: { added: 3, removed: 3, files: 2, count: 6, max: 6 },
      reason: "3 added, 3 removed, 2 files; diffSize 6/6"
    })
    expect(await Effect.runPromise(Scorers.diffSize({ max: 5 }).score(input(diff)))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 2 }).score(input(diff)))).toMatchObject({
      score: 1,
      meta: { count: 2 }
    })
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 1 }).score(input(diff)))).toMatchObject({ score: 0 })
    expect(await Effect.runPromise(Scorers.diffSize({ max: 0 }).score(input("")))).toMatchObject({
      score: 1,
      meta: { count: 0 }
    })
  })
  it("does not confuse header-looking changed lines with file paths", async () => {
    const header = "--- a/name\n+++ b/name\n@@ -1 +1 @@\n--- old text\n+++ new text\n\\ No newline at end of file\n"
    expect(await Effect.runPromise(Scorers.diffSize({ max: 2 }).score(input(header)))).toMatchObject({
      meta: { added: 1, removed: 1, files: 1 }
    })
    const noNewline =
      "--- a/a\n+++ b/a\n@@ -1 +1 @@\n-old\n\\ No newline at end of file\n+new\n\\ No newline at end of file"
    expect(await Effect.runPromise(Scorers.diffSize({ max: 2 }).score(input(noNewline))))
      .toMatchObject({ score: 1, meta: { added: 1, removed: 1, files: 1 } })
    const quoted = "--- \"a/\\303\\251 file\"\n+++ \"b/\\303\\251 file\"\n@@ -0,0 +1 @@\n+new\n"
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 1 }).score(input(quoted)))).toMatchObject({ score: 1 })
  })
  it("refuses malformed/truncated/non-text diffs and invalid budgets", async () => {
    for (const value of ["not a diff", "@@ -1 +1 @@\n-x\n+y", "--- a/a\n+++ b/a\n@@ -2,2 +2 @@\n-x\n+y\n", 4]) {
      expect(Exit.isFailure(await Effect.runPromiseExit(Scorers.diffSize({ max: 1 }).score(input(value))))).toBe(true)
    }
    for (const max of [-1, 1.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => Scorers.diffSize({ max })).toThrow()
    }
    expect(Scorers.diffSize({ max: 1 }).scorerKey).not.toBe(Scorers.diffSize({ max: 2 }).scorerKey)
  })
  it("admits additions, empty hunks, timestamp headers and quoted paths without dropping changes", async () => {
    const fixtures = [
      ["--- /dev/null\n+++ b/new\n@@ -0,0 +1 @@\n+added\n", 1],
      ["--- a/file\t2026-09-30\n+++ b/file\t2026-09-30\n@@ -1,0 +1,0 @@\n", 0],
      ...["\\a", "\\b", "\\t", "\\n", "\\v", "\\f", "\\r", "\\\"", "\\\\"].map((escaped) =>
        [`--- "a/${escaped}name"\n+++ "b/${escaped}name"\n@@ -1 +1 @@\n-old\n+new\n`, 2] as const
      )
    ] as const
    for (const [output, count] of fixtures) {
      expect(await Effect.runPromise(Scorers.diffSize({ max: count }).score(input(output))))
        .toMatchObject({ score: 1, meta: { count, files: 1 } })
    }
    const unicode = ["😀", "🚀"].map((name) => `--- "a/${name} name"\n+++ "b/${name} name"\n@@ -1 +1 @@\n-old\n+new\n`)
      .join("")
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 2 }).score(input(unicode))))
      .toMatchObject({ score: 1, meta: { files: 2 } })
  })
  it("keeps metadata-only and mixed unsupported files inconclusive instead of passing a zero-file budget", async () => {
    const renamed = "diff --git a/old b/new\nsimilarity index 100%\nrename from old\nrename to new\n"
    const mode = "diff --git a/mode b/mode\nold mode 100644\nnew mode 100755\n"
    const copy = "diff --git a/old b/copy\nsimilarity index 100%\ncopy from old\ncopy to copy\n"
    for (
      const output of [renamed, mode, copy, renamed + diff, diff + mode, "old mode 100644\n", "diff --git a/a b/a\n"]
    ) {
      for (const scorer of [Scorers.touchedFiles({ max: 0 }), Scorers.diffSize({ max: 0 })]) {
        const failure = await Effect.runPromise(Effect.flip(scorer.score(input(output))))
        expect(failure.code).toBe("inconclusive")
      }
    }
    const metadata = "diff --git a/name b/name\nold mode 100644\nnew mode 100755\nindex abc..def 100755\n"
    const text = "--- a/name\n+++ b/name\n@@ -1 +1 @@\n-old\n+new\n"
    expect(await Effect.runPromise(Scorers.touchedFiles({ max: 0 }).score(input(metadata + text))))
      .toMatchObject({ score: 0, meta: { files: 1 } })
  })
  it("refuses malformed paths, unsupported binary output and impossible hunk counts", async () => {
    const fixtures = [
      "--- a/a\n+++ b/a\n@@ wrong @@\n",
      "--- a/a\n+++ b/a\n@@ -2,2 +1 @@\n-old\n+new",
      "--- a/a\n+++ b/a\n@@ -1 +1,2 @@\n-old\n+new",
      "--- a/a\n+++ b/a\n@@ -1,9007199254740992 +1 @@\n",
      "--- /dev/null\n+++ /dev/null\n",
      "+++ \"b/\\x\"\n",
      "+++ \"b/unclosed\n",
      "+++ \"b/\\377\"\n",
      "Binary files a/a and b/a differ\n",
      "--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n context\n",
      "--- a/a\n+++ b/a\n@@ -0,0 +1 @@\n-removed\n",
      "--- a/a\n+++ b/a\n@@ -1 +0,0 @@\n+added\n"
    ]
    for (const output of fixtures) {
      expect(Exit.isFailure(await Effect.runPromiseExit(Scorers.diffSize({ max: 10 }).score(input(output))))).toBe(true)
    }
  })
})

describe("testsPass sandbox boundary", () => {
  it("keeps invalid exit codes and failed output transport inconclusive", async () => {
    for (const exitCode of [-1, Number.NaN, 1.5, Infinity]) {
      const sandbox = {
        spawn: () => Effect.succeed({ exitCode: Effect.succeed(exitCode), stdout: Stream.empty, stderr: Stream.empty })
      }
      expect(
        Exit.isFailure(await Effect.runPromiseExit(Scorers.testsPass({ command: "test", sandbox }).score(input(null))))
      ).toBe(true)
    }
    const failure = new ProviderError({ code: "unavailable", message: "lost output transport" })
    for (const channel of ["stdout", "stderr"] as const) {
      const sandbox = {
        spawn: () =>
          Effect.succeed({
            exitCode: Effect.succeed(0),
            stdout: Stream.empty,
            stderr: Stream.empty,
            [channel]: Stream.fail(failure)
          })
      }
      expect(
        Exit.isFailure(await Effect.runPromiseExit(Scorers.testsPass({ command: "test", sandbox }).score(input(null))))
      ).toBe(true)
    }
  })
  it("executes the exact declared command, drains both streams and distinguishes exit zero from exit one", async () => {
    const calls: string[] = []
    for (const exitCode of [0, 1]) {
      const drained: string[] = []
      const sandbox: Pick<Session, "spawn"> = {
        spawn: (command, options) => {
          calls.push(command)
          expect(options).toEqual({})
          return Effect.succeed({
            exitCode: Effect.succeed(exitCode),
            stdout: Stream.fromEffect(Effect.sync(() => {
              drained.push("stdout")
              return new Uint8Array()
            })),
            stderr: Stream.fromEffect(Effect.sync(() => {
              drained.push("stderr")
              return new Uint8Array()
            }))
          })
        }
      }
      expect(await Effect.runPromise(Scorers.testsPass({ command: "pnpm test", sandbox }).score(input(null))))
        .toEqual({ score: exitCode === 0 ? 1 : 0, reason: `Command exited ${exitCode}`, meta: { exitCode } })
      expect(drained.sort()).toEqual(["stderr", "stdout"])
    }
    expect(calls).toEqual(["pnpm test", "pnpm test"])
  })
  it("retains launch failures as inconclusive observations through the public runner", async () => {
    const scorer = Scorers.testsPass({
      command: "test",
      sandbox: {
        spawn: () => Effect.fail(new ProviderError({ code: "unavailable", message: "launch unavailable" }))
      }
    })
    const observations = await Effect.runPromise(
      Effect.gen(function*() {
        const runner = yield* Runner.Runner
        return yield* runner.runBatch([{
          identity: "launch-failure",
          observation: { targetStepKey: "run", scorerKey: scorer.scorerKey },
          score: scorer.score(input(null)),
          at: 1
        }])
      }).pipe(Effect.provide(RunnerLive.layer()), Effect.provide(ScoreStore.layerNoop))
    )
    expect(observations).toMatchObject([{
      kind: "inconclusive",
      code: "inconclusive",
      reason: expect.stringContaining("could not complete")
    }])
  })
  it("releases a hung command on timeout and fiber cancellation", async () => {
    for (const cancel of [false, true]) {
      let released = false
      const started = await Effect.runPromise(Deferred.make<void>())
      const scorer = Scorers.testsPass({
        command: "hang",
        timeoutMs: cancel ? 60_000 : 20,
        sandbox: {
          spawn: () =>
            Effect.gen(function*() {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  released = true
                })
              )
              yield* Deferred.succeed(started, undefined)
              return { stdout: Stream.empty, stderr: Stream.empty, exitCode: Effect.never }
            })
        }
      })
      const exit = await Effect.runPromise(Effect.gen(function*() {
        const fiber = yield* Effect.forkChild(scorer.score(input(null)))
        yield* Deferred.await(started)
        if (cancel) yield* Fiber.interrupt(fiber)
        return yield* Fiber.await(fiber)
      }))
      expect(Exit.isFailure(exit)).toBe(true)
      expect(released).toBe(true)
    }
  })
  it("refuses invalid commands/deadlines and keys command changes", () => {
    const sandbox = { spawn: () => Effect.never }
    for (const command of ["", " "]) expect(() => Scorers.testsPass({ command, sandbox })).toThrow()
    for (const timeoutMs of [0, -1, 1.5, Infinity]) {
      expect(() => Scorers.testsPass({ command: "test", sandbox, timeoutMs })).toThrow()
    }
    expect(Scorers.testsPass({ command: "a", sandbox }).scorerKey).not.toBe(
      Scorers.testsPass({ command: "b", sandbox }).scorerKey
    )
  })
})
