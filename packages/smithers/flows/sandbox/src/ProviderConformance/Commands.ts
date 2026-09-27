/**
 * Defines the fixture commands a conformance run needs.
 *
 * @since 0.1.0
 */

import type * as Duration from "effect/Duration"

/**
 * The three commands a provider must be able to run for the conformance suite
 * to say anything about it.
 *
 * The suite cannot invent them. A provider that reaches a container knows
 * `sh -c 'echo hi'`; one that posts to a language runner knows something else
 * entirely. The adapter author supplies the three, and the suite states what
 * each has to do rather than what it has to be.
 *
 * @category models
 * @since 0.1.0
 */
export interface Commands {
  /** A command that writes {@link Commands.output} to stdout and exits 0. */
  readonly writes: string
  /** Exactly what `writes` puts on stdout, including any trailing newline. */
  readonly output: string
  /** A command that exits with {@link Commands.failureCode} and writes nothing. */
  readonly fails: string
  /** The nonzero status `fails` exits with. */
  readonly failureCode: number
  /** A command that keeps running until something stops it. */
  readonly runs: string
  /**
   * How long `runs` may take to stop after it is signalled, before the suite
   * calls the kill a no-op. Default {@link defaultStopsWithin}.
   */
  readonly stopsWithin?: Duration.Input | undefined
  /**
   * A command that exits zero while the work `runs` started is still alive,
   * and non-zero once it is gone.
   *
   * A signal that stops the wrapper shell and leaves its child running
   * satisfies every observation the suite can make through the process
   * handle, because the handle IS the wrapper. Only a second look at the
   * machine can tell the difference, and this is that look. It runs in the
   * same session after the signalled command's exit is observed; exit zero is
   * a violation. A command line that cannot match itself (`pgrep -f 'x[y]'`)
   * is the usual shape.
   */
  readonly survivor?: string | undefined
  /**
   * A command that copies its standard input to its standard output.
   *
   * Only ever run against a provider that declares `stdin`, and the only
   * thing that proves the declaration. `Provider.stdin` exists so a transport
   * that cannot deliver input refuses the command instead of dropping it, and
   * a suite that took the flag at its word would pass an adapter that sets it
   * and then ignores `RemoteOptions.stdin` — the exact silent input loss the
   * flag was added to close. Default {@link defaultCopiesStdin}, which any
   * mainstream userland ships; a machine without it names its own.
   */
  readonly copiesStdin?: string | undefined
  /**
   * Whether the three commands are shell lines rather than a single program
   * token. A rendered single token is POSIX-quoted whole, so a fixture like
   * `printf 'hi'` reaches a shell-running session as one garbled word; a
   * fixture that declares `shell` renders verbatim, which is what a session
   * whose contract is "a POSIX line" has to be handed. Default `false`, the
   * rendering every existing scripted fixture is keyed under.
   */
  readonly shell?: boolean | undefined
}

/**
 * How long a signalled command has to stop before the suite says it did not.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultStopsWithin: Duration.Input = "5 seconds"

/**
 * The command a stdin-declaring provider copies input with when the fixture
 * names none.
 *
 * @category models
 * @since 0.1.0
 */
export const defaultCopiesStdin = "cat"
