import { NodeServices } from "@effect/platform-node"
import { Cause, Effect, Exit, FileSystem, Option, Path } from "effect"
import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as ApplyPatch from "../src/ApplyPatch.ts"
import * as Edit from "../src/Edit.ts"
import type { StdError } from "../src/StdError.ts"
import * as Write from "../src/Write.ts"

const patch = (path: string) =>
  ApplyPatch.run({ input: `*** Begin Patch\n*** Update File: ${path}\n@@\n-beta\n+BETA\n*** End Patch` })
const failureOf = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isFailure(exit) ? Option.getOrUndefined(Cause.findErrorOption(exit.cause)) : undefined
const run = (effect: Effect.Effect<unknown, StdError, FileSystem.FileSystem | Path.Path>) =>
  Effect.runPromiseExit(effect.pipe(Effect.provide(NodeServices.layer)))
const writer = (path: string, kind: string, pause = false) => {
  const child = spawn(process.execPath, [
    fileURLToPath(new URL("./fixtures/mutation-process.ts", import.meta.url)),
    path,
    kind,
    ...(pause ? ["pause"] : [])
  ], { stdio: ["ignore", "ignore", "pipe", "ipc"] })
  let stderr = ""
  child.stderr!.on("data", (chunk) => {
    stderr += String(chunk)
  })
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  const event = (name: string) =>
    new Promise<{ ok: boolean; code?: string }>((resolve, reject) => {
      child.on("message", (value) => {
        const message = value as { event: string; ok: boolean; code?: string }
        if (message.event === name) resolve(message)
      })
      child.once("error", reject)
      child.once("exit", () => reject(new Error(`Writer exited before ${name}: ${stderr}`)))
    })
  return { child, exited, ready: pause ? event("read") : Promise.resolve(), result: event("result") }
}

describe("mutation exclusion through independent hosts", () => {
  it.each(["different anchor", "same anchor", "line expect", "patch", "write", "symlink"])(
    "refuses an overlapping %s and revalidates after release",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "std-mutation-hosts-"))
      const path = join(root, "file.txt")
      const alias = join(root, "alias.txt")
      writeFileSync(path, "alpha\nbeta\n")
      symlinkSync(path, alias)
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let read!: () => void
      const reading = new Promise<void>((resolve) => {
        read = resolve
      })
      const first = Effect.runPromiseExit(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* Edit.run({ path, oldString: "alpha", newString: "ALPHA" }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFile: (file) =>
                fs.readFile(file).pipe(Effect.tap(() =>
                  Effect.promise(() => {
                    read()
                    return gate
                  })
                ))
            })
          )
        }).pipe(Effect.provide(NodeServices.layer))
      )
      try {
        await reading
        const next = kind === "patch" ?
          patch(path)
          : kind === "write" ?
          Write.run({ path, content: "whole file\n" })
          : kind === "line expect" ?
          Edit.run({ path, startLine: 1, endLine: 1, expect: "alpha", newString: "another" })
          : Edit.run({
            path: kind === "symlink" ? alias : path,
            oldString: kind === "same anchor" ? "alpha" : "beta",
            newString: "BETA"
          })
        const blocked = await run(next)
        expect(failureOf(blocked)).toMatchObject({ code: "no_match" })
        expect(failureOf(blocked)?.message).toContain("Concurrent mutation")
        expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n")
        release()
        expect(Exit.isSuccess(await first)).toBe(true)
        const retried = await run(next)
        if (kind === "same anchor" || kind === "line expect") {
          expect(failureOf(retried)).toMatchObject({ code: "no_match" })
          expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta\n")
        } else {
          expect(Exit.isSuccess(retried)).toBe(true)
          expect(readFileSync(path, "utf8")).toBe(kind === "write" ? "whole file\n" : "ALPHA\nBETA\n")
        }
        expect(readdirSync(root).sort()).toEqual(["alias.txt", "file.txt"])
      } finally {
        release()
        await first
        rmSync(root, { recursive: true, force: true })
      }
    }
  )

  it.each(["second", "patch"])("excludes a separate Node process running %s", async (kind) => {
    const root = mkdtempSync(join(tmpdir(), "std-mutation-process-"))
    const path = join(root, "file.txt")
    writeFileSync(path, "alpha\nbeta\n")
    const first = writer(path, "first", true)
    try {
      await first.ready
      const second = writer(path, kind)
      expect(await second.result).toMatchObject({ ok: false, code: "no_match" })
      await second.exited
      expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n")
      first.child.send("release")
      expect(await first.result).toMatchObject({ ok: true })
      await first.exited
      expect(
        Exit.isSuccess(
          await run(kind === "patch" ? patch(path) : Edit.run({ path, oldString: "beta", newString: "BETA" }))
        )
      ).toBe(true)
      expect(readFileSync(path, "utf8")).toBe("ALPHA\nBETA\n")
      expect(readdirSync(root)).toEqual(["file.txt"])
    } finally {
      first.child.kill()
      await first.exited
      rmSync(root, { recursive: true, force: true })
    }
  })

  it("refuses an orphaned process lock without stealing it", async () => {
    const root = mkdtempSync(join(tmpdir(), "std-mutation-orphan-"))
    const path = join(root, "file.txt")
    writeFileSync(path, "alpha\nbeta\n")
    const first = writer(path, "first", true)
    const failed = first.result.catch(() => undefined)
    try {
      await first.ready
      first.child.kill("SIGKILL")
      await first.exited
      await failed
      const locks = readdirSync(root)
      expect(locks.filter((entry) => entry.endsWith(".lock"))).toHaveLength(1)
      expect(failureOf(await run(Edit.run({ path, oldString: "beta", newString: "BETA" })))).toMatchObject({
        code: "no_match"
      })
      expect(readdirSync(root)).toEqual(locks)
      expect(readFileSync(path, "utf8")).toBe("alpha\nbeta\n")
    } finally {
      first.child.kill()
      await first.exited
      rmSync(root, { recursive: true, force: true })
    }
  })
})

describe("patch mutation admission", () => {
  it.each(["add", "delete", "move source", "move destination"])(
    "refuses a contended %s before changing any file",
    async (kind) => {
      const root = mkdtempSync(join(tmpdir(), "std-patch-locks-"))
      const target = join(root, "target.txt")
      const other = join(root, "other.txt")
      writeFileSync(target, "alpha\nbeta\n")
      writeFileSync(other, "alpha\nbeta\n")
      let release!: () => void
      const gate = new Promise<void>((resolve) => {
        release = resolve
      })
      let ready!: () => void
      const reading = new Promise<void>((resolve) => {
        ready = resolve
      })
      const first = Effect.runPromiseExit(
        Effect.gen(function*() {
          const fs = yield* FileSystem.FileSystem
          return yield* Edit.run({ path: target, oldString: "alpha", newString: "ALPHA" }).pipe(
            Effect.provideService(FileSystem.FileSystem, {
              ...fs,
              readFile: (file) =>
                fs.readFile(file).pipe(Effect.tap(() =>
                  Effect.promise(() => {
                    ready()
                    return gate
                  })
                ))
            })
          )
        }).pipe(Effect.provide(NodeServices.layer))
      )
      try {
        await reading
        const body = kind === "add" ?
          `*** Add File: ${target}\n+replacement`
          : kind === "delete" ?
          `*** Delete File: ${target}`
          : `*** Update File: ${kind === "move source" ? target : other}\n*** Move to: ${
            kind === "move source" ? other : target
          }\n@@\n-beta\n+BETA`
        const result = await run(ApplyPatch.run({ input: `*** Begin Patch\n${body}\n*** End Patch` }))
        expect(failureOf(result)).toMatchObject({ code: "no_match" })
        expect(readFileSync(target, "utf8")).toBe("alpha\nbeta\n")
        expect(readFileSync(other, "utf8")).toBe("alpha\nbeta\n")
        // Only the active edit's lock remains, including when patch admission
        // acquired its other path first and then had to release that lock.
        expect(readdirSync(root).filter((entry) => entry.endsWith(".lock"))).toHaveLength(1)
        release()
        expect(Exit.isSuccess(await first)).toBe(true)
        expect(readdirSync(root).sort()).toEqual(["other.txt", "target.txt"])
      } finally {
        release()
        await first
        rmSync(root, { recursive: true, force: true })
      }
    }
  )
})

it("excludes differently cased spellings through real hosts", async () => {
  const root = mkdtempSync(join(tmpdir(), "std-case-lock-"))
  const lower = join(root, "file.txt")
  const upper = join(root, "FILE.TXT")
  writeFileSync(lower, "alpha\nbeta\n")
  // On case-sensitive hosts these are distinct files but deliberately share
  // a lock. On default APFS this exercises two spellings of the same file.
  if (!existsSync(upper)) writeFileSync(upper, "alpha\nbeta\n")
  const first = writer(lower, "first", true)
  try {
    await first.ready
    expect(failureOf(await run(Edit.run({ path: upper, oldString: "beta", newString: "BETA" })))).toMatchObject({
      code: "no_match"
    })
    expect(readFileSync(lower, "utf8")).toBe("alpha\nbeta\n")
    first.child.send("release")
    expect(await first.result).toMatchObject({ ok: true })
    await first.exited
    expect(readFileSync(lower, "utf8")).toBe("ALPHA\nbeta\n")
    expect(readdirSync(root).filter((entry) => entry.endsWith(".lock"))).toEqual([])
  } finally {
    first.child.kill()
    await first.exited
    rmSync(root, { recursive: true, force: true })
  }
})

it.skipIf(process.platform === "win32")("creates and edits POSIX names containing a literal backslash", async () => {
  const root = mkdtempSync(join(tmpdir(), "std-path-lock-"))
  try {
    const path = join(root, "literal\\name.txt")
    expect(Exit.isSuccess(await run(Write.run({ path, content: "alpha\nbeta\n" })))).toBe(true)
    expect(Exit.isSuccess(await run(Edit.run({ path, oldString: "alpha", newString: "ALPHA" })))).toBe(true)
    expect(readFileSync(path, "utf8")).toBe("ALPHA\nbeta\n")
    expect(readdirSync(root)).toEqual(["literal\\name.txt"])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})
