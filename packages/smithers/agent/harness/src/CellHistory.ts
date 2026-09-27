/**
 * The source of every cell the current turn executed.
 *
 * The controller runs one cell per frame and, once the realm has evaluated it,
 * keeps only what the cell printed. A model that wants to turn the script it
 * just ran into a saved flow needs the script itself back, so this is the one
 * place the run keeps it: the controller appends each cell as it executes, and
 * `flows/show-script` reads the list.
 *
 * The service is optional. A host that offers no way to save a flow binds
 * nothing and the controller records nothing; {@link layerNoop} states the same
 * answer explicitly.
 *
 * @since 0.1.0
 */

import { Context, Effect, Layer } from "effect"

/**
 * One cell the current turn executed.
 *
 * @category models
 * @since 0.1.0
 */
export interface ExecutedCell {
  /** Zero-based execution order within this turn. */
  readonly ordinal: number
  /** The cell's JavaScript, as it ran. */
  readonly source: string
}

/**
 * Records and reports the current turn's executed cells.
 *
 * @category models
 * @since 0.1.0
 */
export interface Service {
  /** Records the source of one cell the controller is executing. */
  readonly record: (source: string) => Effect.Effect<void>
  /** Every cell this turn executed, oldest first. */
  readonly cells: () => Effect.Effect<ReadonlyArray<ExecutedCell>>
}

/**
 * Service tag for the current turn's executed cells.
 *
 * @category services
 * @since 0.1.0
 */
export class CellHistory extends Context.Service<CellHistory, Service>()("@smthrs/harness/CellHistory") {}

/**
 * Constructs a history that records what the controller executes.
 *
 * Ordinals are the append order rather than the frame number: a frame that
 * produced no usable cell executed nothing, and a gap in the script would tell
 * the model a cell ran that never did. `cells` answers with a copy, so a list
 * a caller is already reading does not grow underneath it.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make: Effect.Effect<Service> = Effect.sync(() => {
  const recorded: Array<ExecutedCell> = []
  return CellHistory.of({
    record: (source) =>
      Effect.sync(() => {
        recorded.push({ ordinal: recorded.length, source })
      }),
    cells: () => Effect.sync(() => [...recorded])
  })
})

/**
 * Constructs a history over a fixed cell list.
 *
 * For a host that recorded the turn its own way and reports it rather than
 * replaying it into {@link make}. What it is told is dropped: the list it was
 * built over is the whole history.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeCells = (cells: ReadonlyArray<ExecutedCell>): Service =>
  CellHistory.of({
    record: () => Effect.void,
    cells: () => Effect.succeed(cells)
  })

/**
 * Constructs a history that records nothing, optionally overriding operations.
 *
 * @category constructors
 * @since 0.1.0
 */
export const makeNoop = (overrides: Partial<Service> = {}): Service =>
  CellHistory.of({
    record: () => Effect.void,
    cells: () => Effect.succeed([]),
    ...overrides
  })

/**
 * Provides a history that records what the controller executes.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer: Layer.Layer<CellHistory> = Layer.effect(CellHistory)(make)

/**
 * Provides a history over a fixed cell list.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerCells = (cells: ReadonlyArray<ExecutedCell>): Layer.Layer<CellHistory> =>
  Layer.succeed(CellHistory)(makeCells(cells))

/**
 * Provides a history that records nothing.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (overrides: Partial<Service> = {}): Layer.Layer<CellHistory> =>
  Layer.succeed(CellHistory)(makeNoop(overrides))
