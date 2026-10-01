/**
 * A provider wrapper that makes each session's workdir a git repository, the
 * precondition `SandboxedFlow`'s `captureWork` states. On acquire it writes
 * `seed` into the workdir and commits it, unless the workdir already holds a
 * repository, which is what a reattached session looks like.
 */
import type { Sandbox } from "@smthrs/sandbox"
import * as Effect from "effect/Effect"
import * as Stream from "effect/Stream"

const commit = `[ -d .git ] && exit 0
git init -q &&
git add -A . &&
git -c user.name=Sandbox -c user.email=sandbox@example.test -c commit.gpgsign=false \\
  commit -q --allow-empty -m base`

export const repository = (
  base: Sandbox.Provider,
  seed: Readonly<Record<string, string>> = {}
): Sandbox.Provider => ({
  acquire: (key) =>
    Effect.gen(function*() {
      const session = yield* base.acquire(key)
      for (const [path, text] of Object.entries(seed)) {
        yield* session.writeFile(`${session.workdir}/${path}`, new TextEncoder().encode(text))
      }
      yield* Effect.scoped(Effect.gen(function*() {
        const process = yield* session.spawn(commit, { cwd: session.workdir })
        const [, stderr, code] = yield* Effect.all(
          [Stream.runDrain(process.stdout), Stream.mkString(Stream.decodeText(process.stderr)), process.exitCode],
          { concurrency: "unbounded" }
        )
        if (code !== 0) return yield* Effect.die(`git could not seed ${session.workdir}: ${stderr}`)
      }))
      return session
    })
})

/** The work as `Changed`, or a test failure naming what it was instead. */
export const changed = (work: Sandbox.Work | null): Sandbox.Changed => {
  if (work?._tag !== "Changed") throw new Error(`expected Changed work, got ${JSON.stringify(work)}`)
  return work
}

/** The paths a patch touches, in the patch's order, each named once. */
export const patchedPaths = (patch: string): ReadonlyArray<string> =>
  [...patch.matchAll(/^diff --git a\/(.+) b\/\1$/gm)].map((match) => match[1]!)
