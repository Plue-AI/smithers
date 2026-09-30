/**
 * One table of inputs driven through BOTH shipped `Jj` layers.
 *
 * `NodeJj` states the requirement in its own header: the classification has one
 * definition because "the code is durable identity in journals, so the two
 * layers must agree". Until now each layer asserted its own codes in its own
 * suite, which cannot catch the two drifting apart — a run that snapshots
 * through the wasm layer and replays against the CLI layer needs the same
 * `code` for the same failure, or a branch on it takes a different arm.
 *
 * The vocabulary here is deliberately narrow: only failures both backends can
 * be made to produce on demand.
 */
import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import { execFileSync } from "node:child_process"
import * as fsModule from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import * as BrowserJj from "../src/browser/BrowserJj.ts"
import { isJjError, Jj, type JjErrorCode } from "../src/Jj.ts"
import * as NodeJj from "../src/node/NodeJj.ts"
import { budgeted } from "./budgeted.ts"
import { rootedSyncFs } from "./RootedSyncFs.ts"

const wasmPath = fileURLToPath(new URL("../wasm/flows_jj.wasm", import.meta.url))
const wasmBytes: Uint8Array | undefined = fsModule.existsSync(wasmPath)
  ? new Uint8Array(fsModule.readFileSync(wasmPath))
  : undefined

const jjInstalled = (() => {
  try {
    execFileSync("jj", ["--version"], { stdio: "ignore" })
    return true
  } catch {
    return false
  }
})()

/** Every failure both backends can be asked for, and the code both must give. */
const table: ReadonlyArray<readonly [string, (jj: Jj) => Effect.Effect<unknown, unknown>, JjErrorCode]> = [
  ["an empty operation revision", (jj) => jj.opRestore!(""), "invalid_ref"],
  ["a malformed operation revision", (jj) => jj.opRestore!("--help"), "invalid_ref"],
  ["an empty restore revision", (jj) => jj.restore(""), "invalid_ref"],
  ["an empty diff revision", (jj) => jj.diff("@", ""), "invalid_ref"],
  ["a revision that does not resolve", (jj) => jj.restore("nosuchchangeid"), "invalid_ref"],
  ["two revisions that do not resolve", (jj) => jj.diff("zzznotachange", "alsonotachange"), "invalid_ref"]
]

const codeOf = (jj: Jj, operation: (jj: Jj) => Effect.Effect<unknown, unknown>) =>
  Effect.map(Effect.flip(operation(jj)), (error) => {
    if (!isJjError(error)) throw new Error(`expected a JjError from an undecorated host layer, got ${String(error)}`)
    return error.code
  })

describe.skipIf(!jjInstalled || wasmBytes === undefined)("Jj layer parity", () => {
  const timeout = 60_000

  it.effect("accepts the same opaque snapshot messages on the CLI and wasm layers", () =>
    Effect.gen(function*() {
      const repository = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-messages-node-"))
      const browserHost = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-messages-wasm-"))
      fsModule.mkdirSync(join(browserHost, "repo"))
      try {
        execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
        const node = yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(repository)))
        const browser = yield* Effect.provide(
          Jj,
          BrowserJj.layer({
            wasm: wasmBytes!,
            fs: rootedSyncFs(browserHost),
            root: "/repo"
          })
        )
        for (const message of ["-leading", "--help", "", "a \"quoted\" $message\nwith café"]) {
          const saved = yield* node.snapshot(message)
          const browserSaved = yield* browser.snapshot(message)
          expect(saved.commitId).toMatch(/^[0-9a-f]{40}$/)
          expect(browserSaved.commitId).toMatch(/^[0-9a-f]{128}$/)
          expect(saved.changeId).toMatch(/^[k-z]{12}$/)
          expect(browserSaved.changeId).toMatch(/^[k-z]{12}$/)
          // The CLI layers keep the label in the journal, never in the repository.
          expect(execFileSync("jj", ["log", "-r", saved.commitId, "--no-graph", "-T", "description"], {
            cwd: repository,
            encoding: "utf8"
          })).toBe("")
          yield* node.restore(saved.commitId)
          yield* browser.restore(browserSaved.commitId)
        }
      } finally {
        fsModule.rmSync(repository, { recursive: true, force: true })
        fsModule.rmSync(browserHost, { recursive: true, force: true })
      }
    }), { timeout })

  it.effect(
    "snapshots preserve @ and operation restore rolls back only an unchanged workspace graph",
    () =>
      Effect.gen(function*() {
        const repository = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-operation-node-"))
        const browserHost = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-operation-wasm-"))
        fsModule.mkdirSync(join(browserHost, "repo"))
        try {
          execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
          const node = yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(repository)))
          const browserOptions = { wasm: wasmBytes!, fs: rootedSyncFs(browserHost), root: "/repo" }
          const browser = yield* Effect.provide(Jj, BrowserJj.layer(browserOptions))
          for (
            const [label, jj, files, lane] of [
              ["node", node, repository, join(repository, "..", "operation-lane-" + repository.split("/").at(-1))],
              ["wasm", browser, join(browserHost, "repo"), "/lane"]
            ] as const
          ) {
            fsModule.writeFileSync(join(files, "keep.txt"), "before\n")
            const before = yield* jj.snapshot("--help")
            expect(before.operationId).toMatch(/^[0-9a-f]+$/)
            expect(yield* jj.snapshot("opaque label")).toEqual(before)
            yield* jj.workspaceAdd("other", lane, before.commitId)
            fsModule.writeFileSync(join(files, "keep.txt"), "after\n")
            fsModule.writeFileSync(join(files, "added.txt"), "new\n")
            const after = yield* jj.snapshot()
            expect(after.changeId, label).toBe(before.changeId)
            expect(after.commitId, label).not.toBe(before.commitId)
            expect(after.operationId, label).not.toBe(before.operationId)
            expect(yield* codeOf(jj, (value) => value.opRestore!(before.operationId!))).toBe("conflict")
            expect(fsModule.readFileSync(join(files, "keep.txt"), "utf8")).toBe("after\n")
            yield* jj.workspaceForget("other")
            yield* jj.opRestore!(before.operationId!)
            expect(fsModule.readFileSync(join(files, "keep.txt"), "utf8")).toBe("before\n")
            expect(fsModule.existsSync(join(files, "added.txt"))).toBe(false)
            const restored = yield* jj.snapshot()
            expect(restored.commitId, label).toBe(before.commitId)
            expect(restored.changeId, label).toBe(before.changeId)
            expect(restored.operationId, label).not.toBe(before.operationId)
            if (label === "node") fsModule.rmSync(lane, { recursive: true, force: true })
          }
          const reloaded = yield* Effect.provide(Jj, BrowserJj.layer(browserOptions))
          expect((yield* reloaded.snapshot()).changeId).toBe((yield* browser.snapshot()).changeId)
          expect(fsModule.readFileSync(join(browserHost, "repo/keep.txt"), "utf8")).toBe("before\n")
        } finally {
          fsModule.rmSync(repository, { recursive: true, force: true })
          fsModule.rmSync(browserHost, { recursive: true, force: true })
        }
      }),
    { timeout }
  )

  it.effect("classifies the same failures identically on the CLI and wasm layers", () =>
    Effect.gen(function*() {
      const repository = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-parity-node-"))
      const browserHost = fsModule.mkdtempSync(join(tmpdir(), "flows-jj-parity-wasm-"))
      fsModule.mkdirSync(join(browserHost, "repo"))
      try {
        execFileSync("jj", ["git", "init", repository], { stdio: "ignore" })
        const node = yield* Effect.provide(Jj, budgeted(NodeJj.layerAt(repository)))
        const browser = yield* Effect.provide(
          Jj,
          BrowserJj.layer({ wasm: wasmBytes!, fs: rootedSyncFs(browserHost), root: "/repo" })
        )
        // The wasm backend needs a repository before it can be asked about a
        // revision, and creating it through the contract is the point.
        fsModule.writeFileSync(join(browserHost, "repo", "seed.txt"), "seed\n")
        yield* browser.snapshot("seed")

        for (const [label, operation, expected] of table) {
          expect([label, yield* codeOf(node, operation)]).toEqual([label, expected])
          expect([label, yield* codeOf(browser, operation)]).toEqual([label, expected])
        }
      } finally {
        fsModule.rmSync(repository, { recursive: true, force: true })
        fsModule.rmSync(browserHost, { recursive: true, force: true })
      }
    }), { timeout })
})
