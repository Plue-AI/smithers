import * as Dialect from "@smthrs/database/Dialect"
/**
 * Pins the backup/restore contract of `DisasterRecovery`: a hot backup is a
 * verified, manifest-described snapshot; a restore refuses anything that no
 * longer hashes to that manifest; and the fence step invalidates every
 * persisted ownership fence the snapshot carried.
 *
 * The restore drill — a live engine, a mid-action backup, and a resumed run
 * on the restored store — lives in `RestoreDrill.test.ts`. This suite covers
 * the file and manifest edges with hand-tampered backups.
 */
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { describe, expect, it } from "@effect/vitest"
import { DurableWriter } from "@smthrs/database"
import * as DatabaseMigrations from "@smthrs/database/Migrations"
import * as NodeDatabase from "@smthrs/database/node/NodeDatabase"
import * as TestDatabase from "@smthrs/database/test/TestDatabase"
import * as SqlConsensus from "@smthrs/journal/SqlConsensus"
import * as RunStore from "@smthrs/run-store/RunStore"
import * as Cause from "effect/Cause"
import type * as Crypto from "effect/Crypto"
import * as Effect from "effect/Effect"
import * as Exit from "effect/Exit"
import type * as FileSystem from "effect/FileSystem"
import * as Layer from "effect/Layer"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import { appendFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, normalize, sep } from "node:path"
import * as DisasterRecovery from "../src/DisasterRecovery.ts"
import * as Migrations from "../src/Migrations.ts"
import * as TestStores from "../src/test/TestStores.ts"
import { sha256, withCrypto } from "./Sha256.ts"

const root = () => mkdtempSync(join(tmpdir(), "flows-dr-"))

type Environment =
  | DurableWriter.DurableWriter
  | SqlClient.SqlClient
  | FileSystem.FileSystem
  | Crypto.Crypto

/** The migrated in-memory database plus the real host filesystem. */
const environment = Layer.mergeAll(TestStores.databaseAt(":memory:"), NodeFileSystem.layer)

const run = <A, E>(effect: Effect.Effect<A, E, Environment>) => withCrypto(Effect.provide(effect, environment))

const restoredDatabase = (databaseFile: string) =>
  Layer.provideMerge(DurableWriter.layer(), NodeDatabase.layer({ filename: databaseFile }))

const snapshotDatabase = (databaseFile: string) => NodeDatabase.layer({ filename: databaseFile })

const backup = (
  options: Omit<DisasterRecovery.BackupOptions, "snapshotDatabaseLayer">
) => DisasterRecovery.backup({ ...options, snapshotDatabaseLayer: snapshotDatabase })

const invalidFileSizeLimits: ReadonlyArray<readonly [string, number]> = [
  ["fractional", 1.5],
  ["NaN", Number.NaN],
  ["infinite", Number.POSITIVE_INFINITY],
  ["negative", -1],
  ["unsafe", Number.MAX_SAFE_INTEGER + 1]
]

/** Plants a blob at its content address inside a store objects directory. */
const plantBlob = (objectsDirectory: string, bytes: string): string => {
  const digest = sha256(bytes)
  mkdirSync(join(objectsDirectory, digest.slice(0, 2)), { recursive: true })
  writeFileSync(join(objectsDirectory, digest.slice(0, 2), digest), bytes)
  return digest
}

const failure = <A>(
  exit: Exit.Exit<A, DisasterRecovery.DisasterRecoveryError>
): DisasterRecovery.DisasterRecoveryError => {
  if (!Exit.isFailure(exit)) throw new Error("expected the operation to fail")
  return Cause.squash(exit.cause) as DisasterRecovery.DisasterRecoveryError
}

describe("backup", () => {
  for (const [name, maxFileSizeBytes] of invalidFileSizeLimits) {
    it.effect(`rejects a ${name} maxFileSizeBytes as invalid options`, () =>
      Effect.gen(function*() {
        const exit = yield* run(
          backup({
            directory: join(root(), "backup"),
            maxFileSizeBytes
          }).pipe(Effect.exit)
        )
        const error = failure(exit)
        expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
        expect(error).toMatchObject({ code: "invalid_options", method: "backup" })
      }))
  }

  it.effect("admits zero and the largest safe integer as file-size options", () =>
    Effect.gen(function*() {
      const zeroExit = yield* run(
        backup({ directory: join(root(), "backup"), maxFileSizeBytes: 0 }).pipe(Effect.exit)
      )
      expect(failure(zeroExit).code).toBe("io")

      const manifest = yield* run(
        backup({ directory: join(root(), "backup"), maxFileSizeBytes: Number.MAX_SAFE_INTEGER })
      )
      expect(manifest.formatVersion).toBe(1)
    }))

  it.effect("leaves the backup directory empty after a failed capture, so a retry can reuse it", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      plantBlob(objects, "retry-artifact")
      const backupDirectory = join(base, "backup")
      const exit = yield* run(
        backup({ directory: backupDirectory, objectsDirectory: objects, maxFileSizeBytes: 0 }).pipe(Effect.exit)
      )
      expect(failure(exit).code).toBe("io")
      expect(readdirSync(backupDirectory)).toEqual([])

      const manifest = yield* run(backup({ directory: backupDirectory, objectsDirectory: objects }))
      expect(manifest.artifacts).toHaveLength(1)
    }))

  it.effect("captures the database, the artifact blobs, and a manifest written last", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const backupDirectory = join(base, "backup")
      const digestOne = plantBlob(objects, "artifact-one")
      const digestTwo = plantBlob(objects, "artifact-two")
      // Not part of the store's address space: a scratch file, a stray file,
      // and a blob parked under the wrong fanout prefix.
      writeFileSync(join(objects, digestOne.slice(0, 2), `${digestOne}.tmp-abc-0`), "scratch")
      writeFileSync(join(objects, "junk.txt"), "junk")
      const wrongPrefix = digestOne.slice(0, 2) === "ff" ? "00" : "ff"
      mkdirSync(join(objects, wrongPrefix), { recursive: true })
      writeFileSync(join(objects, wrongPrefix, digestOne), "artifact-one")

      const manifest = yield* run(
        backup({ directory: backupDirectory, objectsDirectory: objects })
      )

      expect(manifest.formatVersion).toBe(1)
      expect(manifest.database.file).toBe(DisasterRecovery.databaseFileName)
      expect(manifest.database.migrations.length).toBeGreaterThan(0)
      const databaseBytes = readFileSync(join(backupDirectory, DisasterRecovery.databaseFileName))
      expect(sha256(databaseBytes)).toBe(manifest.database.sha256)
      expect(manifest.database.sizeBytes).toBe(databaseBytes.length)
      expect(manifest.artifacts.map((entry) => entry.digest)).toEqual([digestOne, digestTwo].sort())
      for (const entry of manifest.artifacts) {
        const copied = readFileSync(
          join(backupDirectory, DisasterRecovery.objectsDirectoryName, entry.digest.slice(0, 2), entry.digest)
        )
        expect(sha256(copied)).toBe(entry.digest)
        expect(copied.length).toBe(entry.sizeBytes)
      }
      const written = JSON.parse(
        readFileSync(join(backupDirectory, DisasterRecovery.manifestFileName), "utf8")
      ) as DisasterRecovery.BackupManifest
      expect(written).toEqual(manifest)

      const verified = yield* run(DisasterRecovery.verify(backupDirectory))
      expect(verified).toEqual(manifest)
    }))

  it.effect("refuses an encoded manifest above the shared file-size ceiling", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const backupDirectory = join(base, "backup")
      const result = yield* withCrypto(
        Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`CREATE TABLE flows_migrations (migration_id INTEGER PRIMARY KEY, name TEXT NOT NULL)`
          yield* sql`CREATE TABLE flows_step_cache (meta_json TEXT NOT NULL)`
          yield* sql`CREATE TABLE flows_attempts (meta_json TEXT NOT NULL, checkpoint_json TEXT)`

          const baseline = yield* backup({ directory: join(base, "baseline") })
          const maxFileSizeBytes = baseline.database.sizeBytes + 4_096
          const artifactCount = Math.ceil(maxFileSizeBytes / 64) + 1
          for (let index = 0; index < artifactCount; index++) {
            plantBlob(objects, `manifest-entry-${index}`)
          }
          const exit = yield* backup({
            directory: backupDirectory,
            objectsDirectory: objects,
            maxFileSizeBytes
          }).pipe(Effect.exit)
          return { exit, maxFileSizeBytes }
        }).pipe(Effect.provide(Layer.mergeAll(TestDatabase.sqliteLayer, NodeFileSystem.layer)))
      )
      const error = failure(result.exit)
      expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
      expect(error).toMatchObject({ code: "io", method: "backup" })
      expect(error.message).toContain(DisasterRecovery.manifestFileName)
      expect(error.message).toContain(`${result.maxFileSizeBytes}-byte file limit`)
      expect(() => readFileSync(join(backupDirectory, DisasterRecovery.manifestFileName))).toThrow()
    }))

  it.effect("accepts a pre-created empty directory and no artifact tier at all", () =>
    Effect.gen(function*() {
      const backupDirectory = join(root(), "backup")
      mkdirSync(backupDirectory, { recursive: true })
      const manifest = yield* run(backup({ directory: backupDirectory }))
      expect(manifest.artifacts).toEqual([])
    }))

  it.effect("records no blobs when the objects directory does not exist yet", () =>
    Effect.gen(function*() {
      const base = root()
      const manifest = yield* run(
        backup({
          directory: join(base, "backup"),
          objectsDirectory: join(base, "never-created")
        })
      )
      expect(manifest.artifacts).toEqual([])
    }))

  it.effect("refuses a target directory that already holds anything", () =>
    Effect.gen(function*() {
      const backupDirectory = join(root(), "backup")
      mkdirSync(backupDirectory, { recursive: true })
      writeFileSync(join(backupDirectory, "existing.txt"), "occupied")
      const exit = yield* run(backup({ directory: backupDirectory }).pipe(Effect.exit))
      expect(failure(exit).code).toBe("not_empty")
    }))

  it.effect("refuses to capture a blob whose bytes no longer hash to its address", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const digest = plantBlob(objects, "honest-bytes")
      writeFileSync(join(objects, digest.slice(0, 2), digest), "tampered-bytes")
      const exit = yield* run(
        backup({ directory: join(base, "backup"), objectsDirectory: objects }).pipe(Effect.exit)
      )
      expect(failure(exit).code).toBe("artifact_corruption")
    }))

  it.effect("refuses success when the frozen database references an absent artifact", () =>
    Effect.gen(function*() {
      const base = root()
      const missing = sha256("referenced-but-absent")
      const exit = yield* run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES (
            'backup-root', '{}', ${
          JSON.stringify({
            boundary: {
              declaredOutputs: {
                outputs: [{ path: "out/result.bin", digest: missing, sizeBytes: 1 }]
              },
              diffIdentity: "backup-root"
            }
          })
        }, 0, 'backup-run', 0
          )
        `
        return yield* backup({
          directory: join(base, "backup"),
          objectsDirectory: join(base, "objects")
        }).pipe(Effect.exit)
      }))

      expect(failure(exit).code).toBe("snapshot_incomplete")
      expect(failure(exit).cause).toEqual({ missing: [missing] })
      expect(() => readFileSync(join(base, "backup", DisasterRecovery.manifestFileName))).toThrow()
    }))

  it.effect("refuses success without an objects directory when the frozen database references a blob", () =>
    Effect.gen(function*() {
      const base = root()
      const missing = sha256("referenced-without-a-tier")
      const exit = yield* run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO flows_step_cache (
            key_digest, result_json, meta_json, created_at_ms, recorded_run_id, recorded_event_seq
          ) VALUES (
            'tierless-root', '{}', ${
          JSON.stringify({
            boundary: {
              declaredOutputs: {
                outputs: [{ path: "out/result.bin", digest: missing, sizeBytes: 1 }]
              },
              diffIdentity: "tierless-root"
            }
          })
        }, 0, 'tierless-run', 0
          )
        `
        return yield* backup({ directory: join(base, "backup") }).pipe(Effect.exit)
      }))

      expect(failure(exit).code).toBe("snapshot_incomplete")
      expect(failure(exit).cause).toEqual({ missing: [missing] })
      expect(() => readFileSync(join(base, "backup", DisasterRecovery.manifestFileName))).toThrow()
    }))

  it.effect("freezes artifact roots held only by attempt metadata and checkpoints", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const metadataDigest = plantBlob(objects, "attempt-metadata-root")
      const checkpointDigest = plantBlob(objects, "attempt-checkpoint-root")
      const manifest = yield* run(Effect.gen(function*() {
        const sql = yield* SqlClient.SqlClient
        yield* sql`
          INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
          VALUES ('backup-attempt-roots', 'pending', 0, '{}')
        `
        yield* sql`INSERT INTO flows_attempts ${
          sql.insert({
            run_id: "backup-attempt-roots",
            step_key_digest: "attempt-roots",
            attempt: 0,
            state: "running",
            started_at_ms: 0,
            checkpoint_json: JSON.stringify({ retainedArtifacts: [checkpointDigest] }),
            meta_json: JSON.stringify({
              boundary: {
                declaredOutputs: {
                  outputs: [{ path: "out/result.bin", digest: metadataDigest, sizeBytes: 1 }]
                },
                diffIdentity: "attempt-root"
              }
            })
          })
        }`
        return yield* backup({
          directory: join(base, "backup"),
          objectsDirectory: objects
        })
      }))

      expect(manifest.artifacts.map((entry) => entry.digest)).toEqual(
        [checkpointDigest, metadataDigest].sort()
      )
    }))

  it.effect("fails closed on malformed frozen attempt metadata or checkpoints", () =>
    Effect.gen(function*() {
      for (const column of ["meta_json", "checkpoint_json"] as const) {
        const base = root()
        const exit = yield* run(Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO flows_runs (run_id, status, created_at_ms, state_json)
            VALUES ('backup-corrupt-root', 'pending', 0, '{}')
          `
          yield* sql`INSERT INTO flows_attempts ${
            sql.insert({
              run_id: "backup-corrupt-root",
              step_key_digest: "corrupt-root",
              attempt: 0,
              state: "running",
              started_at_ms: 0,
              checkpoint_json: "{}",
              meta_json: "{}"
            })
          }`
          yield* TestDatabase.checks(sql, false)
          yield* sql.unsafe(
            `UPDATE flows_attempts SET ${column} = '{' WHERE run_id = 'backup-corrupt-root'`
          )
          return yield* backup({ directory: join(base, "backup") }).pipe(Effect.exit)
        }))
        expect(failure(exit).code).toBe("snapshot_incomplete")
      }
    }))

  it.effect("surfaces the host filesystem's refusal as the io code", () =>
    Effect.gen(function*() {
      const base = root()
      // A regular file where the objects directory should be: `exists` reports
      // it, listing it fails.
      const notADirectory = join(base, "objects")
      writeFileSync(notADirectory, "a file, not a directory")
      const exit = yield* run(
        backup({ directory: join(base, "backup"), objectsDirectory: notADirectory }).pipe(
          Effect.exit
        )
      )
      expect(failure(exit).code).toBe("io")
    }))

  it.effect("surfaces the database's refusal as the sql code", () =>
    Effect.gen(function*() {
      // An unmigrated database has no flows_migrations table to record.
      const exit = yield* withCrypto(
        backup({ directory: join(root(), "backup") }).pipe(
          Effect.exit,
          Effect.provide(Layer.mergeAll(TestDatabase.sqliteLayer, NodeFileSystem.layer))
        )
      )
      expect(failure(exit).code).toBe("sql")
    }))
})

describe("verify", () => {
  const captured = () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const digest = plantBlob(objects, "verified-artifact")
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(
        backup({ directory: backupDirectory, objectsDirectory: objects })
      )
      return { base, backupDirectory, manifest, digest }
    })

  for (const [name, maxFileSizeBytes] of invalidFileSizeLimits) {
    it.effect(`rejects a ${name} maxFileSizeBytes as invalid options`, () =>
      Effect.gen(function*() {
        const exit = yield* run(
          DisasterRecovery.verify(root(), { maxFileSizeBytes }).pipe(Effect.exit)
        )
        const error = failure(exit)
        expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
        expect(error).toMatchObject({ code: "invalid_options", method: "verify" })
      }))
  }

  it.effect("admits zero and the largest safe integer as file-size options", () =>
    Effect.gen(function*() {
      const { backupDirectory, manifest } = yield* captured()
      const zeroExit = yield* run(
        DisasterRecovery.verify(backupDirectory, { maxFileSizeBytes: 0 }).pipe(Effect.exit)
      )
      expect(failure(zeroExit).code).toBe("io")
      expect(
        yield* run(
          DisasterRecovery.verify(backupDirectory, { maxFileSizeBytes: Number.MAX_SAFE_INTEGER })
        )
      ).toEqual(manifest)
    }))

  it.effect("refuses a directory with no manifest", () =>
    Effect.gen(function*() {
      const empty = root()
      const exit = yield* run(DisasterRecovery.verify(empty).pipe(Effect.exit))
      expect(failure(exit).code).toBe("missing_file")
    }))

  it.effect("refuses a file above the configured size ceiling and admits the boundary", () =>
    Effect.gen(function*() {
      const { backupDirectory, manifest } = yield* captured()
      const limit = manifest.database.sizeBytes

      expect(yield* run(DisasterRecovery.verify(backupDirectory, { maxFileSizeBytes: limit }))).toEqual(manifest)
      const exit = yield* run(
        DisasterRecovery.verify(backupDirectory, { maxFileSizeBytes: limit - 1 }).pipe(Effect.exit)
      )
      const error = failure(exit)
      expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
      expect(error.code).toBe("io")
      const file = join(backupDirectory, DisasterRecovery.databaseFileName).split(sep).join("/")
      expect(error.message.split(sep).join("/")).toContain(file)
      expect(error.message).toContain(`${limit} bytes`)
      expect(error.message).toContain(`${limit - 1}`)
    }))

  it.effect("refuses a manifest that does not decode", () =>
    Effect.gen(function*() {
      const { backupDirectory } = yield* captured()
      writeFileSync(join(backupDirectory, DisasterRecovery.manifestFileName), "{\"formatVersion\": 2}")
      const exit = yield* run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
      expect(failure(exit).code).toBe("invalid_manifest")
    }))

  it.effect("rejects a manifest database path before it can escape the backup directory", () =>
    Effect.gen(function*() {
      const { backupDirectory, manifest } = yield* captured()
      writeFileSync(
        join(backupDirectory, DisasterRecovery.manifestFileName),
        JSON.stringify({ ...manifest, database: { ...manifest.database, file: "../outside.sqlite3" } })
      )
      const exit = yield* run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
      expect(failure(exit).code).toBe("invalid_manifest")
    }))

  it.effect("refuses a database snapshot that rotted in storage", () =>
    Effect.gen(function*() {
      const { backupDirectory } = yield* captured()
      appendFileSync(join(backupDirectory, DisasterRecovery.databaseFileName), "rot")
      const exit = yield* run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
      expect(failure(exit).code).toBe("digest_mismatch")
    }))

  it.effect("refuses a backup whose database file vanished", () =>
    Effect.gen(function*() {
      const { backupDirectory } = yield* captured()
      rmSync(join(backupDirectory, DisasterRecovery.databaseFileName))
      const exit = yield* run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
      expect(failure(exit).code).toBe("missing_file")
    }))

  it.effect("refuses a backup missing a listed artifact blob", () =>
    Effect.gen(function*() {
      const { backupDirectory, digest } = yield* captured()
      rmSync(join(backupDirectory, DisasterRecovery.objectsDirectoryName, digest.slice(0, 2), digest))
      const exit = yield* run(DisasterRecovery.verify(backupDirectory).pipe(Effect.exit))
      expect(failure(exit).code).toBe("missing_file")
    }))
})

describe("restore", () => {
  for (const [name, maxFileSizeBytes] of invalidFileSizeLimits) {
    it.effect(`rejects a ${name} maxFileSizeBytes as invalid options`, () =>
      Effect.gen(function*() {
        const base = root()
        const exit = yield* run(
          DisasterRecovery.restore({
            backupDirectory: base,
            targetDirectory: join(base, "restored"),
            maxFileSizeBytes
          }).pipe(Effect.exit)
        )
        const error = failure(exit)
        expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
        expect(error).toMatchObject({ code: "invalid_options", method: "restore" })
      }))
  }

  it.effect("admits zero and the largest safe integer as file-size options", () =>
    Effect.gen(function*() {
      const base = root()
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(backup({ directory: backupDirectory }))
      const zeroExit = yield* run(
        DisasterRecovery.restore({
          backupDirectory,
          targetDirectory: join(base, "zero"),
          maxFileSizeBytes: 0
        }).pipe(Effect.exit)
      )
      expect(failure(zeroExit).code).toBe("io")

      const restored = yield* run(DisasterRecovery.restore({
        backupDirectory,
        targetDirectory: join(base, "large"),
        maxFileSizeBytes: Number.MAX_SAFE_INTEGER
      }))
      expect(restored.manifest).toEqual(manifest)
    }))

  it.effect("restoreAndFence preserves invalid file-size option failures", () =>
    Effect.gen(function*() {
      const base = root()
      const exit = yield* run(
        DisasterRecovery.restoreAndFence({
          backupDirectory: base,
          targetDirectory: join(base, "restored"),
          maxFileSizeBytes: Number.NaN,
          databaseLayer: restoredDatabase
        }).pipe(Effect.exit)
      )
      expect(failure(exit)).toMatchObject({ code: "invalid_options", method: "restore" })
    }))

  it.effect("refuses a file above the configured size ceiling and restores at the boundary", () =>
    Effect.gen(function*() {
      const base = root()
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(backup({ directory: backupDirectory }))
      const limit = manifest.database.sizeBytes

      const restored = yield* run(DisasterRecovery.restore({
        backupDirectory,
        targetDirectory: join(base, "at-limit"),
        maxFileSizeBytes: limit
      }))
      expect(restored.manifest).toEqual(manifest)

      const exit = yield* run(
        DisasterRecovery.restore({
          backupDirectory,
          targetDirectory: join(base, "above-limit"),
          maxFileSizeBytes: limit - 1
        }).pipe(Effect.exit)
      )
      const error = failure(exit)
      expect(error).toBeInstanceOf(DisasterRecovery.DisasterRecoveryError)
      expect(error.code).toBe("io")
    }))

  it.effect("lands the verified store, the blobs, and the restored marker", () =>
    Effect.gen(function*() {
      const base = root()
      const objects = join(base, "objects")
      const digest = plantBlob(objects, "restored-artifact")
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(
        backup({ directory: backupDirectory, objectsDirectory: objects })
      )

      const target = join(base, "restored")
      const restored = yield* run(DisasterRecovery.restore({ backupDirectory, targetDirectory: target }))

      expect(normalize(restored.databaseFile)).toBe(join(target, DisasterRecovery.databaseFileName))
      expect(normalize(restored.objectsDirectory)).toBe(join(target, DisasterRecovery.objectsDirectoryName))
      expect(restored.manifest).toEqual(manifest)
      expect(sha256(readFileSync(restored.databaseFile))).toBe(manifest.database.sha256)
      expect(sha256(readFileSync(join(restored.objectsDirectory, digest.slice(0, 2), digest)))).toBe(digest)
      const marker = JSON.parse(
        readFileSync(join(target, DisasterRecovery.restoredMarkerFileName), "utf8")
      ) as { backupCreatedAtMs: number; databaseSha256: string }
      expect(marker.backupCreatedAtMs).toBe(manifest.createdAtMs)
      expect(marker.databaseSha256).toBe(manifest.database.sha256)
    }))

  it.effect("refuses a target directory that already holds anything", () =>
    Effect.gen(function*() {
      const base = root()
      const backupDirectory = join(base, "backup")
      yield* run(backup({ directory: backupDirectory }))
      const target = join(base, "restored")
      mkdirSync(target, { recursive: true })
      writeFileSync(join(target, "existing.txt"), "occupied")
      const exit = yield* run(
        DisasterRecovery.restore({ backupDirectory, targetDirectory: target }).pipe(Effect.exit)
      )
      expect(failure(exit).code).toBe("not_empty")
    }))

  it.effect("offers a one-shot restore-and-fence API over a supplied database layer", () =>
    Effect.gen(function*() {
      const base = root()
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(backup({ directory: backupDirectory }))
      const restored = yield* run(
        DisasterRecovery.restoreAndFence({
          backupDirectory,
          targetDirectory: join(base, "restored"),
          databaseLayer: restoredDatabase
        })
      )

      expect(restored.manifest).toEqual(manifest)
      expect(restored.fence).toEqual({ clearedClaims: 0, suspendedRuns: 0 })
      const marker = JSON.parse(
        readFileSync(join(base, "restored", DisasterRecovery.restoredMarkerFileName), "utf8")
      ) as { databaseSha256: string }
      expect(marker.databaseSha256).toBe(manifest.database.sha256)
    }))
})

describe("fence", () => {
  const restoredStore = () =>
    Effect.gen(function*() {
      const base = root()
      const backupDirectory = join(base, "backup")
      const manifest = yield* run(backup({ directory: backupDirectory }))
      const restored = yield* run(
        DisasterRecovery.restore({ backupDirectory, targetDirectory: join(base, "restored") })
      )
      return { manifest, restored }
    })

  it.effect("admits the exact schema and reports an unfenced empty store", () =>
    Effect.gen(function*() {
      const { manifest, restored } = yield* restoredStore()
      const summary = yield* withCrypto(
        DisasterRecovery.fence(manifest).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))
      )
      expect(summary).toEqual({ clearedClaims: 0, suspendedRuns: 0 })
    }))

  it.effect("parks restored running rows as released so the recovery sweep can reach them", () =>
    Effect.gen(function*() {
      const { manifest, restored } = yield* restoredStore()
      const result = yield* Effect.gen(function*() {
        const sql = yield* Effect.service(SqlClient.SqlClient)
        yield* sql`
          INSERT INTO flows_runs (
            run_id, status, created_at_ms, started_at_ms,
            owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json
          ) VALUES (
            'restored-running', 'running', 0, 0,
            'dead-host', 7, 'old-fence', 10, '{}'
          )
        `
        const summary = yield* DisasterRecovery.fence(manifest)
        const rows = yield* sql<{
          readonly status: string
          readonly waiting_reason: string | null
          readonly owner_host_id: string | null
        }>`
          SELECT status, waiting_reason, owner_host_id
          FROM flows_runs WHERE run_id = 'restored-running'
        `
        return { row: rows[0], summary }
      }).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))

      expect(result.summary).toEqual({ clearedClaims: 0, suspendedRuns: 1 })
      expect(result.row).toEqual({
        status: "suspended",
        waiting_reason: "released",
        owner_host_id: null
      })
    }))

  const upgrades: ReadonlyArray<readonly [string, ReadonlyArray<number>]> = [
    ["the same migration set", []],
    ["a global suffix in the plan block", [4003]],
    ["engine-store 3010 below the installed plan block", [3010]],
    ["engine-store 3009 below the installed plan block", [3009, 3010]],
    ["engine-store 3008 below the installed plan block", [3008, 3009, 3010]],
    ["engine-store 3007 below the installed plan block", [3007, 3008, 3009, 3010]],
    ["engine-store 3006 below the installed plan block", [3006, 3007, 3008, 3009, 3010]],
    ["the previous engine and run-store migration sets", [1003, 1004, 3006, 3007, 3008, 3009, 3010]]
  ]
  for (const [name, omitted] of upgrades) {
    it.effect(`restores, fences, and resumes with ${name}`, () =>
      Effect.gen(function*() {
        const base = root()
        const backupDirectory = join(base, "backup")
        const oldOwner = { hostId: "backup-host", pid: 7, nonce: "old-fence" }
        const newOwner = { hostId: "restore-host", pid: 8, nonce: "new-fence" }
        const previous = Migrations.sets.map((set) => ({
          ...set,
          migrations: Object.fromEntries(
            Object.entries(set.migrations).filter(([key]) =>
              !omitted.includes(set.idOffset + Number(key.split("_")[0]))
            )
          )
        }))
        const manifest = yield* withCrypto(
          Effect.gen(function*() {
            const sql = yield* SqlClient.SqlClient
            yield* sql`
              INSERT INTO flows_runs (
                run_id, status, created_at_ms, started_at_ms,
                owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json,
                claim_host_id, claim_pid, claim_nonce, claimed_at_ms
              ) VALUES (
                'upgrade-run', 'running', 0, 0,
                ${oldOwner.hostId}, ${oldOwner.pid}, ${oldOwner.nonce}, 10, '{}',
                'stale-claimant', 9, 'stale-claim', 10
              )
            `
            return yield* backup({ directory: backupDirectory })
          }).pipe(Effect.provide(Layer.mergeAll(
            Layer.provideMerge(Layer.effectDiscard(DatabaseMigrations.run(previous)), TestDatabase.sqliteLayer),
            NodeFileSystem.layer
          )))
        )
        const historicalIds = manifest.database.migrations.map((migration) => migration.migrationId)
        expect(historicalIds).toContain(3005)
        expect(historicalIds).toContain(4002)
        for (const id of omitted) expect(historicalIds).not.toContain(id)
        if (omitted.includes(3006)) expect(historicalIds).toContain(4003)

        // Restore the actual old snapshot. Opening through the current layer
        // applies the missing migrations before restoreAndFence checks it.
        const restored = yield* withCrypto(
          DisasterRecovery.restoreAndFence({
            backupDirectory,
            targetDirectory: join(base, "restored"),
            databaseLayer: TestStores.databaseAt
          }).pipe(Effect.provide(NodeFileSystem.layer))
        )
        expect(restored.manifest).toEqual(manifest)
        expect(restored.fence).toEqual({ clearedClaims: 1, suspendedRuns: 1 })

        yield* Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          const applied = yield* sql<{ readonly migration_id: number }>`
            SELECT migration_id FROM flows_migrations ORDER BY migration_id
          `
          expect(applied.map((row) => row.migration_id)).toEqual([...historicalIds, ...omitted].sort((a, b) => a - b))
          // This column is installed by 3006, proving the schema changed too.
          const columns = yield* Dialect.columns(sql, "flows_runs")
          expect(columns.map((column) => column.name)).toContain("execution_parent_id")
          const indexes = yield* sql<{ readonly name: string }>`
            SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'flows_runs_pending_cancel_idx'
          `
          expect(indexes).toHaveLength(1)
          const runs = yield* RunStore.make.pipe(Effect.provide(SqlConsensus.layer))
          const row = yield* runs.get("upgrade-run")
          expect(row).toMatchObject({ status: "suspended", owner: null, heartbeatAtMs: null, claim: null })
          expect(yield* runs.heartbeat("upgrade-run", oldOwner, 20)).toEqual({ _tag: "FenceLost" })
          expect(
            yield* runs.claimAndOwn(
              "upgrade-run",
              {
                status: row.status,
                owner: row.owner,
                heartbeatAtMs: row.heartbeatAtMs
              },
              newOwner,
              20
            )
          ).toEqual({ _tag: "Activated" })
          expect(yield* runs.transitionOwned("upgrade-run", newOwner, "completed")).toEqual({ _tag: "Transitioned" })
          expect((yield* runs.get("upgrade-run")).status).toBe("completed")
        }).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))
      }))
  }

  for (const change of ["missing", "renamed"] as const) {
    it.effect(`refuses a ${change} historical lower-block entry before clearing ownership`, () =>
      Effect.gen(function*() {
        const { manifest, restored } = yield* restoredStore()
        yield* Effect.gen(function*() {
          const sql = yield* SqlClient.SqlClient
          yield* sql`
            INSERT INTO flows_runs (
              run_id, status, created_at_ms, owner_host_id, owner_pid, owner_nonce, heartbeat_at_ms, state_json,
              claim_host_id, claim_pid, claim_nonce, claimed_at_ms
            ) VALUES ('owned-run', 'running', 0, 'owner', 7, 'fence', 10, '{}', 'claimant', 8, 'claim', 10)
          `
          const before = yield* sql`SELECT * FROM flows_runs WHERE run_id = 'owned-run'`
          // An additional migration cannot compensate for lost or renamed history.
          yield* sql`INSERT INTO flows_migrations (migration_id, name) VALUES (3011, 'engine-store_future')`
          if (change === "missing") {
            yield* sql`DELETE FROM flows_migrations WHERE migration_id = 3005`
          } else {
            yield* sql`UPDATE flows_migrations SET name = 'engine-store_replaced' WHERE migration_id = 3005`
          }
          const exit = yield* DisasterRecovery.fence(manifest).pipe(Effect.exit)
          expect(failure(exit)).toMatchObject({ code: "schema_mismatch", method: "fence" })
          expect(yield* sql`SELECT * FROM flows_runs WHERE run_id = 'owned-run'`).toEqual(before)
        }).pipe(Effect.provide(restoredDatabase(restored.databaseFile)))
      }))
  }

  it.effect("refuses a manifest recording migrations the database never applied", () =>
    Effect.gen(function*() {
      const { manifest, restored } = yield* restoredStore()
      const longer = {
        ...manifest,
        database: {
          ...manifest.database,
          migrations: [...manifest.database.migrations, { migrationId: 99_999, name: "future_change" }]
        }
      }
      const exit = yield* withCrypto(
        DisasterRecovery.fence(longer).pipe(
          Effect.exit,
          Effect.provide(restoredDatabase(restored.databaseFile))
        )
      )
      expect(failure(exit).code).toBe("schema_mismatch")
    }))

  it.effect("refuses a database whose applied ladder diverges from the manifest", () =>
    Effect.gen(function*() {
      const { manifest, restored } = yield* restoredStore()
      const diverged = {
        ...manifest,
        database: {
          ...manifest.database,
          migrations: manifest.database.migrations.map((migration, index) =>
            index === 0 ? { ...migration, name: "someone_elses_ladder" } : migration
          )
        }
      }
      const exit = yield* withCrypto(
        DisasterRecovery.fence(diverged).pipe(
          Effect.exit,
          Effect.provide(restoredDatabase(restored.databaseFile))
        )
      )
      expect(failure(exit).code).toBe("schema_mismatch")
    }))
})
