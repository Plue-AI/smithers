/**
 * `BrowserJj` over the REAL `flows_jj.wasm` artifact — jj-lib compiled to
 * wasm32-wasip1 — running against a temp-directory-rooted `SyncFsLike`,
 * mirroring the `NodeJj` real-binary scenarios: snapshot/diff/status
 * roundtrip, restore, workspace lanes, and `invalid_ref` classification, plus
 * the browser-specific reload-survival property (a second instantiation over
 * the same tree sees the first's snapshots).
 *
 * The artifact is committed at `packages/smithers/flows/jj/wasm/flows_jj.wasm` and built by
 * `pnpm --filter @smthrs/jj run build:wasm` (delegating to
 * `crates/flows-jj/build-wasm.mjs`). When it is absent the suite skips —
 * loudly, so a missing artifact is never mistaken for passing coverage.
 */
import { afterAll, beforeAll, describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { Jj } from "../src/Jj.ts"
import { rootedSyncFs } from "./RootedSyncFs.ts"

const wasmPath = fileURLToPath(new URL("../wasm/flows_jj.wasm", import.meta.url))
const wasmBytes: Uint8Array | undefined = fsModule.existsSync(wasmPath)
  ? new Uint8Array(fsModule.readFileSync(wasmPath))
  : undefined

if (wasmBytes === undefined) {
  // eslint-disable-next-line no-console
  console.warn(
    "[BrowserJjContract] packages/smithers/flows/jj/wasm/flows_jj.wasm is not built — the real-artifact "
      + "contract suite is SKIPPED. Build it with `pnpm --filter @smthrs/jj run build:wasm` "
      + "(requires the rust wasm32-wasip1 toolchain and crates/flows-jj)."
  )
}

describe.skipIf(wasmBytes === undefined)("BrowserJj over flows_jj.wasm", () => {
  let host = ""
  let jj: Jj
  const timeout = 60_000

  const layer = () =>
    BrowserJj.layer({
      wasm: wasmBytes!,
      fs: rootedSyncFs(host),
      root: "/repo",
      onStderr: (text) => {
        // eslint-disable-next-line no-console
        console.error(`[flows_jj.wasm stderr] ${text}`)
      }
    })

  const write = (path: string, content: string) => fsModule.writeFileSync(join(host, "repo", path), content)
  const read = (path: string) => fsModule.readFileSync(join(host, "repo", path), "utf8")

  beforeAll(async () => {
    host = fsModule.mkdtempSync(join(tmpdir(), "flows-browser-jj-"))
    fsModule.mkdirSync(join(host, "repo"))
    // A vitest hook is a Promise boundary; @effect/vitest has no Effect hook.
    jj = await Effect.runPromise(Effect.provide(Jj, layer()))
  })

  afterAll(() => {
    fsModule.rmSync(host, { recursive: true, force: true })
  })

  it.effect("snapshots the working copy and diffs between snapshots", () =>
    Effect.gen(function*() {
      write("note.txt", "first\n")
      const { commitId: first } = yield* (jj.snapshot("first commit"))
      expect(first).toMatch(/^[a-z0-9]+$/)

      write("note.txt", "second\n")
      const { commitId: second } = yield* (jj.snapshot("second commit"))
      expect(second).not.toBe(first)

      const diff = yield* (jj.diff(first, second))
      expect(diff).toContain("diff --git")
      expect(diff).toContain("note.txt")
      expect(diff).toContain("+second")
      expect(diff).toContain("-first")

      const status = yield* (jj.status())
      expect(status.length).toBeGreaterThan(0)
    }), { timeout })

  it.effect("snapshots without a message when none is supplied", () =>
    Effect.gen(function*() {
      write("unnamed.txt", "x\n")
      const { changeId } = yield* (jj.snapshot())
      expect(changeId).toMatch(/^[a-z0-9]+$/)
    }), { timeout })

  it.effect("restores working-copy files from a snapshot", () =>
    Effect.gen(function*() {
      write("keep.txt", "keep\n")
      const { commitId: changeId } = yield* (jj.snapshot("before mutation"))
      write("keep.txt", "mutated\n")
      yield* (jj.restore(changeId))
      expect(read("keep.txt")).toBe("keep\n")
    }), { timeout })

  it.effect("adds and forgets a named workspace lane", () =>
    Effect.gen(function*() {
      yield* (jj.workspaceAdd("lane", "/lane1"))
      expect(fsModule.existsSync(join(host, "lane1"))).toBe(true)
      yield* (jj.workspaceForget("lane"))
    }), { timeout })

  it.effect("pins a new lane at an earlier change and materializes that tree", () =>
    Effect.gen(function*() {
      // The frozen ABI has no revision field on `workspaceAdd`, so the pin is a
      // second call. Reading the lane's own file back is what proves the pin
      // landed, mirroring the NodeJj real-binary case.
      write("pinned.txt", "first\n")
      const { commitId: changeId } = yield* (jj.snapshot("pinned base"))
      write("pinned.txt", "second\n")
      yield* (jj.snapshot("after base"))

      yield* (jj.workspaceAdd("pinned", "/lane2", changeId))

      expect(fsModule.readFileSync(join(host, "lane2", "pinned.txt"), "utf8")).toBe("first\n")
      yield* (jj.workspaceForget("pinned"))
    }), { timeout })

  it.effect("undoes the lane when the pin fails, and names workspaceAdd", () =>
    Effect.gen(function*() {
      const error = yield* (Effect.flip(jj.workspaceAdd("rollback", "/lane3", "nosuchchangeid")))

      expect(error).toMatchObject({
        code: "invalid_ref",
        module: "BrowserJj",
        method: "workspaceAdd",
        command: "jj workspace add"
      })
      expect(error.message).toContain("pinning the new lane failed")
      // The name is free again, which it would not be if the failed add had
      // left the lane registered in the repository.
      yield* (jj.workspaceAdd("rollback", "/lane4"))
      yield* (jj.workspaceForget("rollback"))
    }), { timeout })

  it.effect("classifies an unknown revision as invalid_ref", () =>
    Effect.gen(function*() {
      const error = yield* (Effect.flip(jj.restore("nosuchchangeid")))
      expect(error.code).toBe("invalid_ref")
      // Exactly one method prefix: the bridge prefixes, the crate must not —
      // "jj restore: jj restore: ..." was a real regression.
      expect(error.message).toMatch(/^jj restore: /)
      expect(error.message).not.toContain("jj restore: jj restore:")

      const diffError = yield* (Effect.flip(jj.diff("zzznotachange", "alsonotachange")))
      expect(diffError.code).toBe("invalid_ref")
    }), { timeout })

  it.effect(
    "survives a reload: a fresh instance over the same tree sees prior snapshots",
    () =>
      Effect.gen(function*() {
        write("durable.txt", "persisted\n")
        const { commitId: changeId } = yield* (jj.snapshot("durable state"))

        // a second, independent instantiation — the browser-refresh case
        const reloaded = yield* (Effect.provide(Jj, layer()))
        const status = yield* (reloaded.status())
        expect(status.length).toBeGreaterThan(0)

        write("durable.txt", "scribbled\n")
        yield* (reloaded.restore(changeId))
        expect(read("durable.txt")).toBe("persisted\n")
      }),
    { timeout }
  )
})

it.effect("sealed operations refuse missing repositories without creating them", () =>
  Effect.gen(function*() {
    const host = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-no-init-"))
    try {
      for (const exists of [false, true]) {
        const root = exists ? "/empty" : "/missing"
        if (exists) fsModule.mkdirSync(join(host, root))
        const jj = BrowserJj.make({ wasm: wasmBytes!, fs: rootedSyncFs(host), root })
        for (const operation of [jj.status(), jj.diff("@", "@"), jj.restore("@")]) {
          const error = yield* Effect.flip(operation)
          expect(error).toMatchObject({ code: "unknown" })
          expect(fsModule.existsSync(join(host, root))).toBe(exists)
          expect(fsModule.existsSync(join(host, root, ".jj"))).toBe(false)
        }
      }
    } finally {
      fsModule.rmSync(host, { recursive: true, force: true })
    }
  }), { timeout: 60_000 })
