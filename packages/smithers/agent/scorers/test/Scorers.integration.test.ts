import { NodeChildProcessSpawner, NodeFileSystem } from "@effect/platform-node"
import * as ProcessLedger from "@smthrs/kernel/ProcessLedger"
import * as ProcessReaper from "@smthrs/platform-node/ProcessReaper"
import * as DirectorySandbox from "@smthrs/sandbox/DirectorySandbox"
import { Effect, Exit, FileSystem, Layer, Path } from "effect"
import type { Scope } from "effect/Scope"
import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { execFileSync } from "node:child_process"
import { describe, expect, it } from "vitest"
import * as Scorers from "../src/Scorers.ts"

const platform = Layer.provideMerge(
  ProcessReaper.layerSpawner({ graceMs: 80 }).pipe(
    Layer.provide(ProcessLedger.layerMemory({ hostId: "scorer-integration", ownerPid: process.pid }))
  ),
  Layer.provideMerge(NodeChildProcessSpawner.layer, Layer.merge(NodeFileSystem.layer, Path.layer))
)
const local = <A>(
  body: (sandbox: ReturnType<typeof DirectorySandbox.make>) => Effect.Effect<A, unknown, FileSystem.FileSystem | Scope>
) =>
  Effect.runPromise(
    Effect.scoped(Effect.gen(function*() {
      const fs = yield* FileSystem.FileSystem, spawner = yield* ChildProcessSpawner
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "smithers-scorers-" })
      return yield* body(DirectorySandbox.make({ fs, spawner, root }))
    })).pipe(Effect.provide(platform))
  )

describe("built-in scorer real dependency boundaries", () => {
  it("grades actual zero/nonzero commands in the acquired sandbox and drains pipe-sized output", async () => {
    await local((provider) =>
      Effect.gen(function*() {
        const sandbox = yield* provider.acquire("exit-verdicts")
        yield* sandbox.writeFile(`${sandbox.workdir}/input`, new TextEncoder().encode("ready"))
        const zero = Scorers.testsPass({
          sandbox,
          command: "test \"$(cat input)\" = ready && head -c 131072 /dev/zero && head -c 131072 /dev/zero >&2"
        })
        expect(yield* zero.score({ input: null, output: null })).toMatchObject({ score: 1, meta: { exitCode: 0 } })
        expect(yield* Scorers.testsPass({ sandbox, command: "exit 1" }).score({ input: null, output: null }))
          .toMatchObject({ score: 0, meta: { exitCode: 1 } })
        const fs = yield* FileSystem.FileSystem
        yield* fs.remove(sandbox.workdir, { recursive: true })
        const failed = yield* Effect.exit(
          Scorers.testsPass({ sandbox, command: "true" }).score({ input: null, output: null })
        )
        expect(Exit.isFailure(failed)).toBe(true)
      })
    )
  })
  it("timeout ends the actual owned process before returning inconclusive", async () => {
    await local((provider) =>
      Effect.gen(function*() {
        const sandbox = yield* provider.acquire("timeout")
        const scorer = Scorers.testsPass({ sandbox, command: "echo $$ > owned-pid; exec sleep 30", timeoutMs: 300 })
        expect(Exit.isFailure(yield* Effect.exit(scorer.score({ input: null, output: null })))).toBe(true)
        const pid = Number(new TextDecoder().decode(yield* sandbox.readFile(`${sandbox.workdir}/owned-pid`)))
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true)
        expect(() => process.kill(pid, 0)).toThrow()
      })
    )
  })
  it("grades real git unified output independently of hand-written diff fixtures", async () => {
    await local((provider) =>
      Effect.gen(function*() {
        const sandbox = yield* provider.acquire("diff")
        yield* sandbox.writeFile(`${sandbox.workdir}/before`, new TextEncoder().encode("same\nremoved\n"))
        yield* sandbox.writeFile(`${sandbox.workdir}/after`, new TextEncoder().encode("same\nadded\nsecond\n"))
        let diff = ""
        try {
          execFileSync("git", ["diff", "--no-index", "--no-ext-diff", "before", "after"], {
            cwd: sandbox.workdir,
            encoding: "utf8"
          })
        } catch (error) {
          const result = error as { status?: number; stdout?: string }
          expect(result.status).toBe(1)
          diff = result.stdout!
        }
        expect(diff).toContain("@@")
        const output = { input: null, output: diff }
        expect(yield* Scorers.diffSize({ max: 3 }).score(output))
          .toMatchObject({ score: 1, meta: { added: 2, removed: 1, files: 1 } })
        expect(yield* Scorers.diffSize({ max: 2 }).score(output)).toMatchObject({ score: 0 })
        expect(yield* Scorers.touchedFiles({ max: 1 }).score(output)).toMatchObject({ score: 1 })
      })
    )
  })
  it("refuses real Git rename, copy and mode-only changes without mistaking them for an unchanged tree", async () => {
    await local((provider) =>
      Effect.gen(function*() {
        const sandbox = yield* provider.acquire("metadata-diffs")
        const git = (...args: string[]) => execFileSync("git", args, { cwd: sandbox.workdir, encoding: "utf8" })
        git("init", "-q")
        git("config", "user.name", "Scorer fixture")
        git("config", "user.email", "scorer@example.test")
        git("config", "core.filemode", "true")
        const content = new TextEncoder().encode("unchanged content\n")
        yield* sandbox.writeFile(`${sandbox.workdir}/original`, content)
        git("add", "original")
        git("commit", "-qm", "baseline")
        const untouched = git("diff", "--no-ext-diff")
        expect(untouched).toBe("")
        expect(yield* Scorers.touchedFiles({ max: 0 }).score({ input: null, output: untouched }))
          .toMatchObject({ score: 1, meta: { files: 0 } })
        const refuse = (output: string) =>
          Effect.gen(function*() {
            expect(output).not.toContain("@@")
            expect(output).not.toContain("--- ")
            for (const scorer of [Scorers.touchedFiles({ max: 0 }), Scorers.diffSize({ max: 0 })]) {
              expect(yield* Effect.flip(scorer.score({ input: null, output })))
                .toMatchObject({ code: "inconclusive" })
            }
          })
        git("mv", "original", "renamed")
        const rename = git("diff", "--cached", "--no-ext-diff", "--find-renames=100%")
        expect(rename).toContain("rename from original")
        expect(rename).toContain("rename to renamed")
        yield* refuse(rename)
        git("reset", "--hard", "HEAD")
        yield* sandbox.writeFile(`${sandbox.workdir}/copy`, content)
        git("add", "copy")
        const copy = git("diff", "--cached", "--no-ext-diff", "--find-copies=100%", "--find-copies-harder")
        expect(copy).toContain("copy from original")
        expect(copy).toContain("copy to copy")
        yield* refuse(copy)
        git("reset", "--hard", "HEAD")
        execFileSync("chmod", ["+x", "original"], { cwd: sandbox.workdir })
        const mode = git("diff", "--no-ext-diff")
        expect(mode).toContain("old mode 100644")
        expect(mode).toContain("new mode 100755")
        yield* refuse(mode)
      })
    )
  })
})
