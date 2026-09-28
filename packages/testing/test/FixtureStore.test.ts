import { describe, expect, it } from "@effect/vitest"
import { Cause, Effect, Exit, Option } from "effect"
import { spawn } from "node:child_process"
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import * as fs from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, vi } from "vitest"
import type { RecordedCall } from "../src/Fixture.ts"
import * as FixtureStore from "../src/FixtureStore.ts"

vi.mock("node:fs/promises", async (original) => ({ ...await original<typeof import("node:fs/promises")>() }))
afterEach(() => vi.restoreAllMocks())

const call: RecordedCall = {
  model: "test:model",
  request: { modelId: "test:model", system: [], messages: [], tools: [], params: {} },
  events: [{ type: "settle", stopReason: "stop" }]
}

const withFile = <A, E>(use: (path: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "testing-file-store-"))),
    (directory) => use(join(directory, "fixture.json")),
    (directory) => Effect.sync(() => rmSync(directory, { recursive: true, force: true }))
  )

describe("FixtureStore file persistence", () => {
  it.effect("refuses to append through a symlinked journal", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const victim = `${path}.victim`
        // Empty, so reading it back through the link is a valid empty journal
        // and only the append itself can touch it.
        writeFileSync(victim, "")
        const store = yield* FixtureStore.makeFile(path)
        symlinkSync(victim, `${path}.journal`)
        const exit = yield* Effect.exit(store.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
        expect(readFileSync(victim, "utf8")).toBe("")
      })
    ))

  it.effect("refuses to read or truncate through a symlinked journal", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const victim = `${path}.victim`
        writeFileSync(victim, "partial record")
        symlinkSync(victim, `${path}.journal`)
        const exit = yield* Effect.exit(FixtureStore.makeFile(path))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
        expect(readFileSync(victim, "utf8")).toBe("partial record")
      })
    ))

  it.effect("preserves the previous complete fixture while recording", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const store = yield* FixtureStore.makeFile(path)
        yield* store.append(call)
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
      })
    ))

  it.effect("rejects a competing store instead of silently clobbering calls", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const first = yield* FixtureStore.makeFile(path)
        const second = yield* FixtureStore.makeFile(path)
        yield* first.append(call)
        const exit = yield* Effect.exit(second.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(path)
      })
    ))

  it.effect("persists only one new call per append", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        const appends = vi.spyOn(fs, "appendFile")
        const rewrites = vi.spyOn(fs, "writeFile")
        yield* store.append(call)
        const first = readFileSync(`${path}.journal`, "utf8")
        for (let index = 0; index < 8; index++) yield* store.append(call)
        const journal = readFileSync(`${path}.journal`, "utf8")
        expect(journal.startsWith(first)).toBe(true)
        expect(journal.split("\n").filter(Boolean)).toHaveLength(9)
        expect(Buffer.byteLength(journal)).toBe(9 * Buffer.byteLength(first))
        expect(appends).toHaveBeenCalledTimes(9)
        expect(appends.mock.calls.reduce((bytes, args) => bytes + Buffer.byteLength(String(args[1])), 0))
          .toBe(Buffer.byteLength(journal))
        expect(rewrites).not.toHaveBeenCalled()
      })
    ))

  for (const [name, contents] of [["JSON", "{\"calls\": ["], ["schema", "{\"calls\":[{\"model\":7}]}"]]) {
    it.effect(`names the file and retains the cause of invalid ${name}`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          writeFileSync(path, contents!)
          const exit = yield* Effect.exit(FixtureStore.makeFile(path))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) {
            const defect = Cause.squash(exit.cause)
            expect(String(defect)).toContain(path)
            expect(defect).toHaveProperty("cause")
          }
        })
      ))
  }
})

describe("FixtureStore flush and recovery", () => {
  it.effect("leaves a replay-only fixture untouched at scope close", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const writes = vi.spyOn(fs, "writeFile")
        yield* Effect.gen(function*() {
          const store = yield* FixtureStore.FixtureStore
          expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
        }).pipe(Effect.provide(FixtureStore.layerFile(path)))
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(writes).not.toHaveBeenCalled()
      })
    ))

  it.effect("atomically publishes JSON, removes its journal and permits another writer", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const first = yield* FixtureStore.makeFile(path)
        const second = yield* FixtureStore.makeFile(path)
        const rename = fs.rename
        vi.spyOn(fs, "rename").mockImplementationOnce(async (staging, destination) => {
          expect(readFileSync(path, "utf8")).toBe(previous)
          expect(JSON.parse(readFileSync(staging, "utf8")).calls).toHaveLength(2)
          await rename(staging, destination)
        })
        // Windows refuses replacement while this reader is open. POSIX also
        // proves the old descriptor keeps observing the original inode.
        const handle = process.platform === "win32" ? undefined : openSync(path, "r")
        try {
          yield* first.append(call)
          yield* first.flush()
          if (handle !== undefined) expect(readFileSync(handle, "utf8")).toBe(previous)
        } finally {
          if (handle !== undefined) closeSync(handle)
        }
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
        expect(existsSync(`${path}.journal`)).toBe(false)
        expect(existsSync(`${path}.lock`)).toBe(false)
        yield* second.append(call)
        yield* second.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(3)
        yield* first.append(call)
        yield* first.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(4)
      })
    ))

  it.effect("flushes its layer even when the consumer fails", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const exit = yield* Effect.exit(
          Effect.gen(function*() {
            const store = yield* FixtureStore.FixtureStore
            yield* store.append(call)
            return yield* Effect.fail("test failed")
          }).pipe(Effect.provide(FixtureStore.layerFile(path)))
        )
        expect(Exit.isFailure(exit)).toBe(true)
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(1)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("does not create an empty fixture when flushing an unused store", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        yield* store.flush()
        expect(existsSync(path)).toBe(false)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("recovers completed calls and discards a partial UTF-8 final record", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const line = `${JSON.stringify({ index: 0, call })}\n`
        writeFileSync(
          `${path}.journal`,
          Buffer.concat([Buffer.from(line + "{\"index\":1,\"text\":\""), Buffer.from([0xe2, 0x82])])
        )
        const store = yield* FixtureStore.makeFile(path)
        expect(readFileSync(`${path}.journal`, "utf8")).toBe(line)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(1)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  it.effect("does not duplicate records when publication preceded journal cleanup", () =>
    withFile((path) =>
      Effect.gen(function*() {
        writeFileSync(path, JSON.stringify({ calls: [call] }))
        writeFileSync(`${path}.journal`, [0, 1].map((index) => JSON.stringify({ index, call })).join("\n") + "\n")
        const store = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  it.effect("releases the lock after a failed append and repairs its partial record before retry", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const store = yield* FixtureStore.makeFile(path)
        vi.spyOn(fs, "appendFile").mockImplementationOnce(async () => {
          writeFileSync(`${path}.journal`, "{\"index\":")
          throw new Error("disk full")
        })
        const exit = yield* Effect.exit(store.append(call))
        expect(Exit.isFailure(exit)).toBe(true)
        expect(existsSync(`${path}.lock`)).toBe(false)
        expect(Option.isNone(yield* store.load())).toBe(true)
        yield* store.append(call)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(1)
      })
    ))

  it.effect("preserves JSON and the recoverable journal when publication fails", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        const store = yield* FixtureStore.makeFile(path)
        yield* store.append(call)
        vi.spyOn(fs, "rename").mockRejectedValueOnce(new Error("rename denied"))
        const exit = yield* Effect.exit(store.flush())
        expect(Exit.isFailure(exit)).toBe(true)
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(existsSync(`${path}.lock`)).toBe(false)
        const recovered = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* recovered.load()).calls).toHaveLength(2)
        yield* recovered.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))

  for (
    const contents of [
      "null",
      "{\"index\":-1}",
      "{\"index\":0.5}",
      "{\"index\":1}",
      "{\"index\":0,\"call\":{}}",
      `${JSON.stringify({ index: 0, call })}\n${JSON.stringify({ index: 0, call })}`,
      "{broken"
    ]
  ) {
    it.effect(`rejects a corrupt complete journal record: ${contents}`, () =>
      withFile((path) =>
        Effect.gen(function*() {
          writeFileSync(`${path}.journal`, contents + "\n")
          const exit = yield* Effect.exit(FixtureStore.makeFile(path))
          expect(Exit.isFailure(exit)).toBe(true)
          if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(`${path}.journal`)
          expect(existsSync(`${path}.lock`)).toBe(false)
        })
      ))
  }

  it.effect("names filesystem read failures and releases its lock", () =>
    withFile((path) =>
      Effect.gen(function*() {
        mkdirSync(path)
        const exit = yield* Effect.exit(FixtureStore.makeFile(path))
        expect(Exit.isFailure(exit)).toBe(true)
        if (Exit.isFailure(exit)) expect(String(Cause.squash(exit.cause))).toContain(path)
        expect(existsSync(`${path}.lock`)).toBe(false)
      })
    ))

  it.effect("keeps the old JSON after SIGKILL during a staged write and recovers the call", () =>
    withFile((path) =>
      Effect.gen(function*() {
        const previous = JSON.stringify({ calls: [call] })
        writeFileSync(path, previous)
        // Patch only this subprocess's async writer, then kill it after half the
        // temporary document reaches disk. The production store controls the
        // journal, lock, staging path and rename ordering.
        const script = `
        import fs from "node:fs/promises";
        import { syncBuiltinESMExports } from "node:module";
        const write = fs.writeFile;
        fs.writeFile = async (path, data, options) => {
          if (String(path).endsWith(".tmp")) {
            await write(path, String(data).slice(0, String(data).length / 2), options);
            process.send("staged");
            await new Promise(() => {});
          }
          return write(path, data, options);
        };
        syncBuiltinESMExports();
        const { Effect } = await import(${JSON.stringify(import.meta.resolve("effect"))});
        const { makeFile } = await import(${JSON.stringify(new URL("../src/FixtureStore.ts", import.meta.url).href)});
        await Effect.runPromise(Effect.gen(function*() {
          const store = yield* makeFile(${JSON.stringify(path)});
          yield* store.append(${JSON.stringify(call)});
          yield* store.flush();
        }));
      `
        const result = yield* Effect.promise(() =>
          new Promise<{ code: number | null; signal: string | null; stderr: string; staged: boolean }>(
            (resolve, reject) => {
              const child = spawn(
                process.execPath,
                ["--experimental-strip-types", "--input-type=module", "-e", script],
                {
                  stdio: ["ignore", "ignore", "pipe", "ipc"],
                  timeout: 20_000
                }
              )
              let stderr = ""
              let staged = false
              child.on("message", (message) => {
                if (message !== "staged") return
                staged = true
                // The parent observes its own kill on Windows too; a child
                // killing itself only reports a generic exit code there.
                child.kill("SIGKILL")
              })
              child.stderr!.on("data", (data) => {
                stderr += data
              })
              child.on("error", reject)
              child.on("close", (code, signal) => resolve({ code, signal, stderr, staged }))
            }
          )
        )
        expect(result, result.stderr).toMatchObject({ code: null, signal: "SIGKILL", staged: true })
        expect(readFileSync(path, "utf8")).toBe(previous)
        expect(existsSync(`${path}.lock`)).toBe(true)
        rmSync(`${path}.lock`, { recursive: true })
        const store = yield* FixtureStore.makeFile(path)
        expect(Option.getOrThrow(yield* store.load()).calls).toHaveLength(2)
        yield* store.flush()
        expect(JSON.parse(readFileSync(path, "utf8")).calls).toHaveLength(2)
      })
    ))
})
