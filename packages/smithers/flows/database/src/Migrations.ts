/**
 * Composition of per-package SQL migration sets over one migrations table.
 *
 * Every storage package above `@smthrs/database` owns its own tables and
 * therefore its own migrations, but they all migrate ONE database and record
 * their progress in ONE `flows_migrations` table. Effect's `Migrator` keys a
 * migration by a numeric id, so two packages that both ship an `0001_initial`
 * would either collide or — worse, if they were merged as a plain record —
 * silently shadow one another.
 *
 * A {@link MigrationSet} closes that hole by making the namespace part of the
 * identity: the package's `namespace` prefixes every migration name and its
 * `idOffset` reserves a disjoint block of migration ids. {@link loader} rejects
 * duplicate namespaces, duplicate offsets, an offset that is not a multiple of
 * {@link idBlock}, a local id outside one block, and two keys in one set that
 * realize the same id — `0001_first` beside `01_second` — so a mis-declared
 * package fails the migration rather than skipping a table.
 *
 * Blocks reintroduce a second way to skip one, which the loader handles:
 * `Migrator` decides what to run from a single high-water mark, so a set whose
 * id lands at or below the highest id the database already applied would be
 * assumed done and never run. Appends to an already installed package block
 * run transactionally in the loader before the ordinary forward pass. Missing
 * earlier migrations and newly introduced lower blocks remain refusals; a
 * package cannot insert a migration before its own applied high-water mark.
 * Global id zero on a fresh database is also applied by the loader.
 *
 * {@link run} wraps the whole migrator pass in the same transient-lock retry
 * the durable writer uses, so concurrent processes migrating one database
 * serialize instead of failing on the peer's `BEGIN IMMEDIATE` lock.
 *
 * Derived contract: `docs/concepts/migration-ladder.md`.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Ref from "effect/Ref"
import * as Migrator from "effect/unstable/sql/Migrator"
import * as SqlClient from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as WriteRetry from "./internal/WriteRetry.ts"

/**
 * The single table every Smithers package records its applied migrations in.
 *
 * @category constants
 * @since 0.1.0
 */
export const table = "flows_migrations"

/**
 * One package's migrations, namespaced so they cannot collide with another
 * package's.
 *
 * `migrations` is keyed the way `Migrator.fromRecord` keys it — `<id>_<name>`,
 * with the id local to the package — and `idOffset` lifts those local ids into
 * the block this package owns. Offsets are spaced by {@link idBlock}.
 *
 * @category models
 * @since 0.1.0
 */
export interface MigrationSet {
  readonly namespace: string
  readonly idOffset: number
  readonly migrations: Readonly<Record<string, Effect.Effect<void, unknown, SqlClient.SqlClient>>>
  /**
   * Exact former names of semantically equivalent migrations, keyed by the
   * current migration key. Names omit the namespace prefix. Use only when the
   * owning package has verified the historical schema; changed behavior needs
   * a new migration id. Existing ledger rows are preserved, never renamed.
   */
  readonly previousNames?: Readonly<Record<string, ReadonlyArray<string>>>
}

/** A caller-owned migration set copied into an execution-stable plan. */
interface PlannedMigrationSet {
  readonly previousNames: ReadonlyArray<readonly [key: string, names: ReadonlyArray<string>]>
  readonly namespace: string
  readonly idOffset: number
  readonly migrations: ReadonlyArray<
    readonly [key: string, migration: Effect.Effect<void, unknown, SqlClient.SqlClient>]
  >
}

/** Captures both the set list and every record entry before execution starts. */
const snapshotMigrationSets = (sets: ReadonlyArray<MigrationSet>): ReadonlyArray<PlannedMigrationSet> =>
  Array.from(sets, (set) => ({
    idOffset: set.idOffset,
    migrations: Object.entries(set.migrations),
    namespace: set.namespace,
    previousNames: Object.entries(set.previousNames ?? {}).map(([key, names]) => [key, [...names]] as const)
  }))

/**
 * The spacing between the migration id blocks packages reserve with
 * `MigrationSet.idOffset`. A package may ship this many migrations before it
 * would run into its neighbour, and {@link loader} fails loudly if one ever
 * does.
 *
 * @category constants
 * @since 0.1.0
 */
export const idBlock = 1000

/**
 * Ids are unique by the time this runs — {@link loader} rejects collisions
 * first — so plain subtraction is a total order, not a partial one.
 *
 * @private
 */
const migrationOrder = (left: Migrator.ResolvedMigration, right: Migrator.ResolvedMigration) => left[0] - right[0]

/** The loader we construct always loads an Effect with only SQL requirements. @private */
type PendingMigration = readonly [
  id: number,
  name: string,
  load: Effect.Effect<Effect.Effect<void, unknown, SqlClient.SqlClient>>
]

/** @private */
const fail = (message: string) => new Migrator.MigrationError({ kind: "BadState", message })

/** @private */
const migrationId = (value: unknown): Effect.Effect<number, Migrator.MigrationError> => {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
    return Effect.succeed(value)
  }
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) {
    return Effect.succeed(Number(value))
  }
  return Effect.fail(fail(`${table} contains an invalid migration_id: ${String(value)}`))
}

/**
 * The migration ids the database has already recorded.
 *
 * {@link loader} runs inside the migrator's transaction, after it has ensured
 * the table exists, so this read is safe there. Called on its own against a
 * database that was never migrated it fails as a `BadState`, which is what a
 * caller wiring the loader by hand wants to hear.
 *
 * @private
 */
const appliedIds = Effect.gen(function*() {
  const sql = yield* SqlClient.SqlClient
  const rows = yield* sql<{
    readonly migration_id: unknown
    readonly name: string
  }>`SELECT migration_id, name FROM ${sql(table)}`.withoutTransform.pipe(
    Effect.mapError((cause) =>
      new Migrator.MigrationError({ kind: "BadState", cause, message: `Could not read ${table}` })
    )
  )
  return new Map(
    yield* Effect.forEach(rows, (row) => Effect.map(migrationId(row.migration_id), (id) => [id, row.name] as const))
  )
})

/**
 * The migration with global id zero, which `Migrator` can never run: it
 * treats a fresh database as having high-water mark zero, so id zero always
 * sits at or below the mark. The loader applies it itself instead.
 *
 * @private
 */
interface ZeroMigration {
  readonly name: string
  readonly migration: Effect.Effect<void, unknown, SqlClient.SqlClient>
}

/**
 * Applies the id-zero migration and records it in the migrations table.
 *
 * The loader runs inside the migrator's transaction, so this application
 * commits and rolls back with the rest of the run. Failures follow the
 * migrator's own convention for a failed migration: they die with a `Failed`
 * `MigrationError` that keeps the cause, so a transient lock conflict stays
 * classifiable by {@link run}'s retry while a real failure surfaces loudly.
 *
 * @private
 */
const applyZero = (zero: ZeroMigration) =>
  Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    yield* zero.migration
    yield* sql`INSERT INTO ${sql(table)} ${sql.insert([{ migration_id: 0, name: zero.name }])}`.withoutTransform
  }).pipe(
    Effect.catch((cause) =>
      Effect.die(new Migrator.MigrationError({ cause, kind: "Failed", message: `Migration "0_${zero.name}" failed` }))
    )
  )

/**
 * Rejects a set whose migration would be silently skipped.
 *
 * `Migrator` records applied migrations but decides what to run from a single
 * high-water mark: anything with an id at or below the highest applied id is
 * assumed done. Namespaced id blocks make that assumption false — a database
 * migrated with only the `2000` block would treat the `0` and `1000` blocks as
 * already applied and never create their tables. Valid forward additions to
 * an installed block have already run in `finish`; anything still missing
 * here is an earlier hole or an entirely new lower block. The composition
 * fails instead of returning a migration the global cursor would drop.
 *
 * @private
 */
const rejectSkipped = (
  resolved: ReadonlyArray<Migrator.ResolvedMigration>,
  applied: ReadonlySet<number>
): Effect.Effect<ReadonlyArray<Migrator.ResolvedMigration>, Migrator.MigrationError> => {
  const highWater = Math.max(0, ...applied)
  for (const [id, name] of resolved) {
    if (id <= highWater && !applied.has(id)) {
      return Effect.fail(fail(
        `Migration ${id}_${name} would be skipped: the database has already applied migration id ${highWater}, ` +
          `and this is not a forward append in a declared, installed package block. Compose each installed ` +
          `package's recorded migrations when appending to its block; introduce new packages above ${highWater}.`
      ))
    }
  }
  return Effect.succeed(resolved)
}

/**
 * Applies id zero on a fresh database and forward additions inside installed
 * blocks that the global cursor would skip. Every application and its ledger
 * row share the migrator transaction. Earlier holes and new lower blocks are
 * still refused rather than guessed safe.
 *
 * @private
 */
const finish = (
  resolved: ReadonlyArray<PendingMigration>,
  zero: ZeroMigration | undefined,
  previousNames: ReadonlyMap<number, ReadonlySet<string>>,
  onLoaderApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
) =>
  Effect.gen(function*() {
    const recorded = yield* appliedIds
    const applied = new Set(recorded.keys())
    for (const [id, name] of resolved) {
      const recordedName = recorded.get(id)
      if (recordedName !== undefined && recordedName !== name && !previousNames.get(id)?.has(recordedName)) {
        return yield* Effect.fail(
          fail(`Migration ${id} was recorded as ${recorded.get(id)}, but this package declares ${name}`)
        )
      }
    }
    if (applied.size === 0 && zero !== undefined) {
      yield* applyZero(zero)
      yield* onLoaderApplied([0, zero.name])
      applied.add(0)
    }
    const highWater = Math.max(0, ...applied)
    const knownBlocks = new Set(resolved.filter(([id]) => applied.has(id)).map(([id]) => Math.floor(id / idBlock)))
    const installed = new Map<number, number>()
    for (const id of applied) {
      const block = Math.floor(id / idBlock)
      installed.set(block, Math.max(installed.get(block) ?? -1, id))
    }
    // Pending work must prove block ownership before either the loader or
    // the upstream migrator applies it, including above the global cursor.
    for (const [id, name] of resolved) {
      const block = Math.floor(id / idBlock)
      if (!applied.has(id) && installed.has(block) && !knownBlocks.has(block)) {
        return yield* Effect.fail(fail(
          `Migration ${id}_${name} cannot append to installed block ${block * idBlock} ` +
            `without declaring a matching recorded migration`
        ))
      }
    }
    // An existing package may append within its reserved block after another
    // package has advanced the database's global cursor. Run only such forward
    // additions here; retain rejectSkipped for holes and new lower blocks.
    for (const [id, name, load] of resolved) {
      const block = Math.floor(id / idBlock)
      const previous = installed.get(block)
      if (id > highWater || applied.has(id) || previous === undefined || id <= previous) continue
      const sql = yield* SqlClient.SqlClient
      const migration = yield* load
      yield* Effect.gen(function*() {
        yield* migration
        yield* sql`INSERT INTO ${sql(table)} ${sql.insert([{ migration_id: id, name }])}`.withoutTransform
      }).pipe(Effect.catch((cause) =>
        Effect.die(new Migrator.MigrationError({ cause, kind: "Failed", message: `Migration "${id}_${name}" failed` }))
      ))
      applied.add(id)
      installed.set(block, id)
      yield* onLoaderApplied([id, name])
    }
    return yield* rejectSkipped(resolved, applied)
  })

/** @private */
const loaderFromPlan = (
  sets: ReadonlyArray<PlannedMigrationSet>,
  onLoaderApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
): Migrator.Loader<SqlClient.SqlClient> =>
  Effect.suspend(() => {
    const namespaces = new Set<string>()
    const offsets = new Set<number>()
    const ids = new Map<number, string>()
    const resolved: Array<PendingMigration> = []
    const previousNames = new Map<number, ReadonlySet<string>>()
    let zero: ZeroMigration | undefined

    for (const set of sets) {
      if (namespaces.has(set.namespace)) {
        return Effect.fail(fail(`Duplicate migration namespace: ${set.namespace}`))
      }
      namespaces.add(set.namespace)
      // A negative offset can still produce a positive migration id, and a
      // fractional one forwards a fractional id to the database, so both are
      // bad migration state the loader rejects rather than shapes SQL later
      // chokes on.
      if (!Number.isInteger(set.idOffset) || set.idOffset < 0) {
        return Effect.fail(fail(
          `Invalid migration id offset ${set.idOffset} for namespace ${set.namespace}: ` +
            `an id offset must be a non-negative integer`
        ))
      }
      if (!Number.isSafeInteger(set.idOffset)) {
        return Effect.fail(fail(
          `Invalid migration id offset ${set.idOffset} for namespace ${set.namespace}: ` +
            `an id offset must be a safe integer in the range 0..${Number.MAX_SAFE_INTEGER}`
        ))
      }
      if (set.idOffset % idBlock !== 0) {
        return Effect.fail(fail(
          `Invalid migration id offset ${set.idOffset} for namespace ${set.namespace}: ` +
            `an id offset must be a multiple of idBlock (${idBlock})`
        ))
      }
      if (offsets.has(set.idOffset)) {
        return Effect.fail(fail(`Duplicate migration id offset ${set.idOffset} for namespace ${set.namespace}`))
      }
      offsets.add(set.idOffset)

      const migrationKeys = new Set(set.migrations.map(([key]) => key))
      for (const [key, names] of set.previousNames) {
        if (!migrationKeys.has(key) || names.some((name) => name.trim() === "" || name !== name.trim())) {
          return Effect.fail(fail(`Invalid previous migration names for "${key}" in namespace ${set.namespace}`))
        }
      }
      const namesByKey = new Map(set.previousNames)
      for (const [key, migration] of set.migrations) {
        const match = key.match(/^(\d+)_(.+)$/)
        if (match === null) {
          return Effect.fail(fail(`Malformed migration key "${key}" in namespace ${set.namespace}`))
        }
        const localId = Number(match[1])
        if (!Number.isSafeInteger(localId) || localId < 0 || localId >= idBlock) {
          return Effect.fail(fail(
            `Local migration id ${match[1]} for key "${key}" in namespace ${set.namespace} is outside the block ` +
              `range 0..${idBlock - 1} and would claim a neighbouring package's block`
          ))
        }
        const id = set.idOffset + localId
        if (!Number.isSafeInteger(id)) {
          return Effect.fail(fail(
            `Migration id ${id} for key "${key}" in namespace ${set.namespace} is outside the safe integer range ` +
              `0..${Number.MAX_SAFE_INTEGER}`
          ))
        }
        // Both claimants are named by key as well as namespace, because the
        // only collision the rules above still allow is two keys inside ONE
        // set: distinct offsets that are multiples of `idBlock`, with every
        // local id below `idBlock`, put two namespaces in disjoint ranges. A
        // set that writes both `0001_first` and `01_second` realizes id
        // `offset + 1` twice, and naming the namespace alone would report that
        // as a package colliding with itself.
        const claimant = `${set.namespace} "${key}"`
        const owner = ids.get(id)
        if (owner !== undefined) {
          return Effect.fail(fail(`Migration id ${id} is claimed twice: ${owner} and ${claimant}`))
        }
        ids.set(id, claimant)
        const oldNames = namesByKey.get(key)
        if (oldNames !== undefined) {
          previousNames.set(id, new Set(oldNames.map((name) => `${set.namespace}_${name}`)))
        }
        if (id === 0) {
          zero = { migration, name: `${set.namespace}_${match[2]}` }
        }
        resolved.push([id, `${set.namespace}_${match[2]}`, Effect.succeed(migration)])
      }
    }

    return finish(resolved.sort(migrationOrder), zero, previousNames, onLoaderApplied)
  })

/** @private */
const loaderWith = (
  sets: ReadonlyArray<MigrationSet>,
  onLoaderApplied: (entry: readonly [id: number, name: string]) => Effect.Effect<void>
): Migrator.Loader<SqlClient.SqlClient> => loaderFromPlan(snapshotMigrationSets(sets), onLoaderApplied)

/**
 * Builds a `Migrator` loader from namespaced package migration sets, resolved
 * into one list ordered by migration id rather than by the order the sets were
 * given.
 *
 * On a fresh database the loader applies a global id-zero migration itself,
 * inside the migrator's transaction, because the migrator's high-water mark
 * starts at zero and would silently skip it. A caller wiring the loader into
 * its own `Migrator` therefore gets id zero applied. Forward additions to
 * installed lower blocks also run in this transaction. The upstream migrator's
 * completed list omits these loader-applied migrations; {@link run} reports
 * every migration applied in the successful transaction.
 * The set list and each migration record are snapshotted when this function is
 * called, so later caller mutation cannot change a loader already returned.
 *
 * @category loaders
 * @since 0.1.0
 */
export const loader = (sets: ReadonlyArray<MigrationSet>): Migrator.Loader<SqlClient.SqlClient> =>
  loaderWith(sets, () => Effect.void)

/**
 * Runs every migration in the given sets that has not been applied yet.
 *
 * The whole migrator pass — `BEGIN IMMEDIATE`, the loader, and the pending
 * migrations — retries on the transient lock vocabulary `WriteRetry`
 * recognises, so two connections migrating one SQLite file serialize: the
 * loser of the write-lock race replays after the winner commits and finds
 * the migrations applied, instead of surfacing `SQLITE_BUSY` or applying
 * them twice.
 *
 * @category migrations
 * @since 0.1.0
 */
export const run = (
  sets: ReadonlyArray<MigrationSet>
): Effect.Effect<
  ReadonlyArray<readonly [id: number, name: string]>,
  Migrator.MigrationError | SqlError,
  SqlClient.SqlClient
> => {
  const plan = snapshotMigrationSets(sets)
  return Effect.gen(function*() {
    const sql = yield* SqlClient.SqlClient
    // Effect's PostgreSQL migrator probes before creating its ledger. Serialize
    // that first creation as well as the migration pass on a fresh schema.
    yield* sql.onDialectOrElse({
      pg: () =>
        sql.withTransaction(sql`CREATE TABLE IF NOT EXISTS ${sql(table)} (
        migration_id INTEGER PRIMARY KEY, created_at TIMESTAMPTZ NOT NULL DEFAULT now(), name TEXT NOT NULL
      )`),
      orElse: () => Effect.void
    })
    const loaderApplied = yield* Ref.make<ReadonlyArray<readonly [id: number, name: string]>>([])
    const completed = yield* WriteRetry.withWriteRetry(
      Migrator.make({})({
        // Reset before each attempt: a retry that finds a peer already applied
        // a lower-block append must not report rolled-back applications.
        loader: Ref.set(loaderApplied, []).pipe(
          Effect.andThen(loaderFromPlan(plan, (entry) => Ref.update(loaderApplied, (entries) => [...entries, entry])))
        ),
        table
      })
    )
    const appliedByLoader = yield* Ref.get(loaderApplied)
    return [...appliedByLoader, ...completed]
  })
}

/**
 * Layer that runs the given migration sets before exposing the database to
 * durable services.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (
  sets: ReadonlyArray<MigrationSet>
): Layer.Layer<never, Migrator.MigrationError | SqlError, SqlClient.SqlClient> => Layer.effectDiscard(run(sets))
