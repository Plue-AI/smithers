/**
 * A repository's own memory thresholds: `.smithers/memory-thresholds.json`.
 *
 * A host passes {@link load}'s result as `Memory.Options.thresholds`. An
 * absent file means the declared defaults (`MemoryCalibration.initial`); a
 * present file that does not decode fails typed and is never replaced by the
 * defaults, because a silently ignored fit is a silent regression.
 */
import * as MemoryCalibration from "@smthrs/agent/MemoryCalibration"
import { Fault } from "@smthrs/flow"
import { Effect, Schema } from "effect"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import { join } from "node:path"

/** The thresholds file, relative to the repository root. */
export const file = MemoryCalibration.file

/** The receipt of the fit that wrote {@link file}. */
export const receiptFile = ".smithers/memory-thresholds.receipt.json"

/** A thresholds file that exists but could not be read or decoded. */
export class ThresholdsInvalid extends Schema.TaggedError<ThresholdsInvalid>()("flows/memory/ThresholdsInvalid", {
  path: Schema.String,
  message: Schema.String
}) {}
// The thresholds file is edited by people; one that does not decode is theirs to fix.
Fault.register("flows/memory/ThresholdsInvalid", "user")

const decode = Schema.decodeUnknownEffect(MemoryCalibration.Thresholds)

/** Reads `root`'s thresholds; the declared defaults when the file is absent. */
export const load = (root: string): Effect.Effect<MemoryCalibration.Thresholds, ThresholdsInvalid> =>
  Effect.gen(function*() {
    const path = join(root, file)
    const text = yield* Effect.tryPromise({
      try: () => readFile(path, "utf8"),
      catch: (cause) => cause
    }).pipe(
      Effect.catch((cause) =>
        (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? Effect.succeed(undefined)
          : Effect.fail(new ThresholdsInvalid({ path, message: String(cause) }))
      )
    )
    if (text === undefined) return MemoryCalibration.initial
    const json = yield* Effect.try({
      try: () => JSON.parse(text) as unknown,
      catch: (cause) => new ThresholdsInvalid({ path, message: `not JSON: ${String(cause)}` })
    })
    return yield* decode(json).pipe(Effect.mapError((error) => new ThresholdsInvalid({ path, message: error.message })))
  })

const sorted = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(sorted)
    : value !== null && typeof value === "object"
    ? Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, sorted((value as Record<string, unknown>)[key])])
    )
    : value

/** Deterministic JSON: sorted keys, two-space indent, trailing newline. */
export const stable = (value: unknown): string => `${JSON.stringify(sorted(value), null, 2)}\n`

/** Writes `thresholds` and the fit's `receipt` under `root`. */
export const write = (root: string, thresholds: MemoryCalibration.Thresholds, receipt: unknown) =>
  Effect.tryPromise({
    try: async () => {
      await mkdir(join(root, ".smithers"), { recursive: true })
      await writeFile(join(root, file), stable(thresholds))
      await writeFile(join(root, receiptFile), stable(receipt))
    },
    catch: (cause) => new ThresholdsInvalid({ path: join(root, file), message: `write failed: ${String(cause)}` })
  })
