import { describe, expect, it } from "@effect/vitest"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as PlatformError from "effect/PlatformError"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Options from "../../src/flow/Options.ts"
import { hashTree, nodeLayer } from "../fixtures/helpers.ts"

describe("layout admission IO failures are typed, read-only and retryable", () => {
  for (
    const stage of [
      "root-stat",
      "root-realpath",
      "report-ancestor-stat",
      "report-ancestor-realpath",
      "flows-ancestor-stat",
      "flows-ancestor-realpath",
      "report-stat",
      "report-list"
    ] as const
  ) {
    for (const reason of ["PermissionDenied", "Unknown"] as const) {
      it.effect(`${stage} reports ${reason} without touching the project`, () =>
        Effect.gen(function*() {
          const root = mkdtempSync(join(tmpdir(), "migrate-layout-io-"))
          try {
            const report = join(root, "audit")
            const flows = join(root, "flows")
            mkdirSync(report)
            mkdirSync(flows)
            writeFileSync(join(report, "report.md"), "previous migration report\n")
            writeFileSync(join(flows, "keep.txt"), "operator source\n")
            const before = hashTree(root)
            const fs = yield* FileSystem.FileSystem
            const method = stage.endsWith("realpath") ? "realPath" : stage === "report-list" ? "readDirectory" : "stat"
            const failure = PlatformError.systemError({ _tag: reason, module: "FileSystem", method })
            let injected = 0
            let reportStats = 0
            const io: FileSystem.FileSystem = {
              ...fs,
              stat: (path) => {
                if (path === report) reportStats++
                if (
                  (stage === "root-stat" && path === root) ||
                  (stage === "report-ancestor-stat" && path === report && reportStats === 1) ||
                  (stage === "flows-ancestor-stat" && path === flows) ||
                  (stage === "report-stat" && path === report && reportStats === 2)
                ) {
                  injected++
                  return Effect.fail(failure)
                }
                return fs.stat(path)
              },
              realPath: (path) => {
                if (
                  (stage === "root-realpath" && path === root) ||
                  (stage === "report-ancestor-realpath" && path === report) ||
                  (stage === "flows-ancestor-realpath" && path === flows)
                ) {
                  injected++
                  return Effect.fail(failure)
                }
                return fs.realPath(path)
              },
              readDirectory: (path) => {
                if (stage === "report-list" && path === report) {
                  injected++
                  return Effect.fail(failure)
                }
                return fs.readDirectory(path)
              }
            }
            const options: Options.MigrateOptions = { root, mode: "plan", reportDir: "audit" }
            const refused = yield* Effect.flip(
              Options.validateLayout(options).pipe(Effect.provideService(FileSystem.FileSystem, io))
            )
            const message = stage === "root-stat"
              ? `could not inspect the project root "${root}"`
              : stage === "root-realpath"
              ? `could not resolve the project root "${root}"`
              : stage === "report-stat"
              ? `could not inspect the report directory "${report}"`
              : stage === "report-list"
              ? `could not list the report directory "${report}"`
              : stage.endsWith("stat")
              ? `could not inspect "${stage.startsWith("flows") ? flows : report}"`
              : `could not resolve "${stage.startsWith("flows") ? flows : report}"`
            expect(refused.code).toBe("io")
            expect(refused.message).toBe(message)
            expect(refused.details).toBe(String(failure))
            expect(injected).toBe(1)
            expect(hashTree(root)).toEqual(before)
            yield* Options.validateLayout(options)
            expect(hashTree(root)).toEqual(before)
          } finally {
            rmSync(root, { recursive: true, force: true })
          }
        }).pipe(Effect.provide(nodeLayer)))
    }
  }
})
