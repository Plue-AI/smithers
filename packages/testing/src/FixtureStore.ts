/**
 * Where a cached model reads and records its fixture.
 *
 * The store is the only part of the record-and-replay loop that touches a
 * host: `layerFile` is Node-only, `layerMemory` runs anywhere.
 *
 * @since 0.0.0
 */

import { Context, Effect, Exit, Layer, Option, Ref, SynchronizedRef } from "effect"
import { randomUUID } from "node:crypto"
import { constants } from "node:fs"
import { appendFile, lstat, mkdir, open, readFile, rename, rm, rmdir, writeFile } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { decode, type Fixture, type RecordedCall } from "./Fixture.ts"
import { maximumDepth, snapshot } from "./internal/Structural.ts"

/**
 * Loads and records a recorded-model fixture.
 *
 * Neither method has an error channel. A fixture that cannot be read or decoded
 * is a broken test setup, not an outcome the code under test can handle, so it
 * is a defect; a fixture that does not exist yet is `None`, which is what a
 * first recording run sees.
 *
 * @category services
 * @since 0.0.0
 */
export interface FixtureStore {
  readonly load: () => Effect.Effect<Option.Option<Fixture>>
  readonly append: (call: RecordedCall) => Effect.Effect<void>
}

/**
 * The {@link FixtureStore} service tag.
 *
 * @category services
 * @since 0.0.0
 */
export const FixtureStore: Context.Service<FixtureStore, FixtureStore> = Context.Service(
  "flows/testing/FixtureStore"
)

/**
 * Builds a {@link FixtureStore} from an implementation of its two methods.
 *
 * @category constructors
 * @since 0.0.0
 */
export const make = (implementation: FixtureStore): FixtureStore => FixtureStore.of(implementation)

const plainRecord = (value: unknown): value is Record<PropertyKey, unknown> => {
  if (typeof value !== "object" || value === null) return false
  const prototype: unknown = Object.getPrototypeOf(value)
  return prototype === Object.prototype || prototype === null
}

/**
 * Freezes the arrays and plain records `snapshot` just built, and nothing else.
 *
 * `snapshot` recreates exactly the array and plain-record spine and passes any
 * other value through by reference, so this walk freezes only values the store
 * owns: freezing a passed-through class instance would freeze the caller's. It
 * stops at `snapshot`'s own depth boundary for the same reason, and because a
 * walk without one is the unbounded recursion the encoder was just given a cap
 * to avoid.
 */
const owned = <A>(value: A, seen: Set<object>, depth: number): A => {
  if (depth >= maximumDepth) return value
  if (Array.isArray(value)) {
    if (seen.has(value)) return value
    seen.add(value)
    for (const item of value) owned(item, seen, depth + 1)
    return Object.freeze(value)
  }
  if (!plainRecord(value)) return value
  if (seen.has(value)) return value
  seen.add(value)
  for (const key of Reflect.ownKeys(value)) owned(value[key], seen, depth + 1)
  return Object.freeze(value)
}

/**
 * The store's own immutable copy of a recorded call.
 *
 * Both boundaries used to alias the caller's values: `append` copied the calls
 * array and nothing inside it, and `load` handed those same references back.
 * A harness that reused one event object across turns, or that rewrote a tool
 * schema after the call was recorded, retroactively rewrote what the fixture
 * had already recorded, and `makeFile` then wrote the rewritten value to disk
 * on the next flush.
 *
 * The copy is frozen rather than re-copied on every `load`, because
 * `Fixture.index` memoizes its digest index on fixture identity: handing back
 * a fresh copy per load would rebuild that index on every model call.
 */
const recorded = <A>(value: A): A => owned(snapshot(value), new Set<object>(), 0)

const appended = (current: Option.Option<Fixture>, call: RecordedCall): Fixture =>
  Object.freeze({
    calls: Object.freeze([
      ...Option.match(current, { onNone: () => [], onSome: (fixture) => fixture.calls }),
      recorded(call)
    ])
  })

/**
 * Builds a store that keeps the fixture in memory.
 *
 * `load` reports `None` until the first call is recorded, so an empty memory
 * store behaves exactly like a file that does not exist yet.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeMemory = (initial?: Fixture): Effect.Effect<FixtureStore> =>
  Effect.gen(function*() {
    const state = yield* Ref.make(Option.map(Option.fromUndefinedOr(initial), recorded))
    return make({
      load: () => Ref.get(state),
      append: (call) => Ref.update(state, (current) => Option.some(appended(current, call)))
    })
  })

/**
 * Provides {@link makeMemory}.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerMemory = (initial?: Fixture): Layer.Layer<FixtureStore> =>
  Layer.effect(FixtureStore)(makeMemory(initial))

const fileError = (path: string, cause: unknown): Error =>
  new Error(`Fixture file ${path}: ${String(cause)}`, { cause })

const io = <A>(path: string, run: () => Promise<A>): Effect.Effect<A> =>
  Effect.tryPromise({ try: run, catch: (cause) => fileError(path, cause) }).pipe(Effect.orDie)

// The journal sits beside a committed fixture, so a contributor could commit a
// symlink there and aim a recording run's appends and truncation at any file
// the test user can write. Every journal open refuses to follow a final
// symlink (ELOOP), which the store reports as a path-naming defect. Windows has
// no O_NOFOLLOW; there `| undefined` adds no bit. O_NOFOLLOW covers only the
// last component, so `refuseSymlinkedDirs` covers the directories above it.
const journalRead = constants.O_RDONLY | constants.O_NOFOLLOW
const journalAppend = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW
const journalTruncate = constants.O_WRONLY | constants.O_NOFOLLOW

// A committed directory symlink on the fixture path (`test/fixtures -> ~/notes`)
// would carry the journal, the staging file, and the published rename into the
// link's target. Every directory between the working directory and the fixture
// is checked with lstat before the store creates or opens anything; a path
// outside the working directory has no trusted root and is not checked.
const refuseSymlinkedDirs = async (path: string): Promise<void> => {
  const root = process.cwd()
  const rel = relative(root, dirname(path))
  if (rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return
  let current = root
  for (const part of rel.split(sep)) {
    current = join(current, part)
    const stat = await lstat(current).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined
      throw cause
    })
    if (stat === undefined) return
    if (stat.isSymbolicLink()) throw new Error(`refusing to record through symbolic link ${current}`)
  }
}

const truncateJournal = async (path: string, length: number): Promise<void> => {
  const handle = await open(path, journalTruncate)
  try {
    await handle.truncate(length)
  } finally {
    await handle.close()
  }
}

const readOptional = (path: string, flag: number = constants.O_RDONLY): Effect.Effect<string | undefined> =>
  io(path, () =>
    readFile(path, { encoding: "utf8", flag }).catch((cause: NodeJS.ErrnoException) => {
      if (cause.code === "ENOENT") return undefined
      throw cause
    }))

const parse = (path: string, text: string): Effect.Effect<unknown> =>
  Effect.try({ try: () => JSON.parse(text) as unknown, catch: (cause) => fileError(path, cause) }).pipe(Effect.orDie)

const decodeFile = (path: string, value: unknown): Effect.Effect<Fixture> =>
  decode(value).pipe(Effect.mapError((cause) => fileError(path, cause)), Effect.orDie)

// Called only while holding the path lock. A rename may have published JSON
// before a killed writer removed its journal, so skip already-published indexes.
const readFixture = (path: string): Effect.Effect<Option.Option<Fixture>> =>
  Effect.gen(function*() {
    const text = yield* readOptional(path)
    const initial = text === undefined ? undefined : yield* decodeFile(path, yield* parse(path, text))
    const calls = [...(initial?.calls ?? [])]
    const journalPath = `${path}.journal`
    const journal = yield* readOptional(journalPath, journalRead)
    if (journal !== undefined) {
      const end = journal.lastIndexOf("\n") + 1
      const complete = journal.slice(0, end)
      let previous: number | undefined
      for (const line of complete.split("\n").slice(0, -1)) {
        const value = yield* parse(journalPath, line)
        const entry = value as { index?: unknown; call?: unknown } | null
        const index = entry?.index
        if (
          typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index > calls.length ||
          (previous !== undefined && index !== previous + 1)
        ) {
          return yield* Effect.die(fileError(journalPath, new Error("Invalid journal call index")))
        }
        const decoded = yield* decodeFile(journalPath, { calls: [entry!.call] })
        if (index === calls.length) calls.push(decoded.calls[0]!)
        previous = index
      }
      // A killed append can leave a partial final record, including a partial
      // UTF-8 sequence. Only the complete newline-terminated prefix survives.
      if (end !== journal.length) {
        yield* io(journalPath, () => truncateJournal(journalPath, Buffer.byteLength(complete)))
      }
    }
    return initial === undefined && calls.length === 0
      ? Option.none()
      : Option.some(recorded({ calls }))
  })

const writeFixture = (path: string, fixture: Fixture): Effect.Effect<void> =>
  Effect.gen(function*() {
    const staging = `${path}.${randomUUID()}.tmp`
    yield* io(path, async () => {
      try {
        await writeFile(staging, `${JSON.stringify(fixture, undefined, 2)}\n`, { flag: "wx" })
        await rename(staging, path)
      } finally {
        await rm(staging, { force: true })
      }
      await rm(`${path}.journal`, { force: true })
    })
  })

/**
 * Builds a store over a JSON file and an append-only journal. Node only.
 *
 * Each append asynchronously persists only the new call. Call `flush` to
 * atomically publish the complete JSON and release the path's writer lock.
 * `layerFile` does this on scope close. One store may record at a path until
 * it flushes; competing stores fail with a path-naming defect. After a killed
 * process, remove the abandoned `.lock` directory before reopening. Completed
 * journal lines are recovered, and an incomplete last line is discarded.
 *
 * @category constructors
 * @since 0.0.0
 */
export const makeFile = (path: string): Effect.Effect<
  FixtureStore & {
    readonly flush: () => Effect.Effect<void>
  }
> =>
  Effect.gen(function*() {
    path = resolve(path)
    const lockPath = `${path}.lock`
    let locked = false
    const acquire = io(path, async () => {
      await refuseSymlinkedDirs(path)
      await mkdir(dirname(path), { recursive: true })
      await mkdir(lockPath)
      locked = true
    })
    const release = Effect.suspend(() =>
      locked
        ? io(path, async () => {
          await rmdir(lockPath)
          locked = false
        })
        : Effect.void
    )
    const initial = yield* Effect.acquireUseRelease(acquire, () => readFixture(path), () => release)
    const state = yield* SynchronizedRef.make(initial)
    const current = (value: Option.Option<Fixture>) =>
      locked
        ? Effect.succeed(value)
        : acquire.pipe(Effect.andThen(readFixture(path)))
    return {
      ...make({
        load: () => SynchronizedRef.get(state),
        append: (call) =>
          SynchronizedRef.updateEffect(state, (value) =>
            Effect.gen(function*() {
              const next = appended(yield* current(value), call)
              const index = next.calls.length - 1
              const journalPath = `${path}.journal`
              yield* io(journalPath, () =>
                appendFile(
                  journalPath,
                  `${JSON.stringify({ index, call: next.calls[index] })}\n`,
                  { flag: journalAppend }
                ))
              return Option.some(next)
            }).pipe(Effect.onExit((exit) => Exit.isFailure(exit) ? release : Effect.void))).pipe(Effect.uninterruptible)
      }),
      flush: () =>
        SynchronizedRef.updateEffect(state, (value) =>
          Effect.gen(function*() {
            const latest = yield* current(value)
            if (Option.isSome(latest) && (yield* readOptional(`${path}.journal`, journalRead)) !== undefined) {
              yield* writeFixture(path, latest.value)
            }
            return latest
          }).pipe(Effect.ensuring(release))).pipe(Effect.uninterruptible)
    }
  }).pipe(Effect.uninterruptible)

/**
 * Provides {@link makeFile}, flushing the JSON fixture on scope close.
 *
 * @category layers
 * @since 0.0.0
 */
export const layerFile = (path: string): Layer.Layer<FixtureStore> =>
  Layer.effect(FixtureStore)(Effect.acquireRelease(makeFile(path), (store) => store.flush()))
