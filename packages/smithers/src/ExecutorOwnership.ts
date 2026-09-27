/**
 * Whether this CLI process owns the executor that settles accepted runs.
 *
 * @since 0.1.0
 */

import { Context, Layer } from "effect"

/**
 * Whether this process holds the executor that drives accepted runs to
 * settlement.
 *
 * Read it to decide whether a verb may wait for a run to finish. A local
 * composition that built a driving `NodeControl.layerExecutor` answers `true`
 * and can honestly await settlement; a `--remote` client, a control-only test
 * composition, and a host composed to observe runs and drive none
 * (`Application.Config.startsRuns` is `false`) answer `false`, because the run
 * is another process's to drive and waiting here would hang on work this
 * process never performs.
 *
 * The default is `false` so a composition that forgets to declare ownership
 * refuses to wait rather than waiting forever.
 *
 * @category references
 * @since 0.1.0
 */
export const ExecutorOwnership: Context.Reference<boolean> = Context.Reference<boolean>(
  "/cli/ExecutorOwnership",
  { defaultValue: () => false }
)

/**
 * Declares, for one command scope, whether this process drives accepted runs.
 *
 * `Application.layer` supplies it from what it actually built, so the fact and
 * the composition cannot disagree. Provide it directly only in a test that
 * needs the opposite answer from the layer it is exercising.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (ownsExecutor: boolean): Layer.Layer<never> => Layer.succeed(ExecutorOwnership, ownsExecutor)
