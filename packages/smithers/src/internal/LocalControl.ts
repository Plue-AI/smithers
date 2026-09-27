/** Private shared local control graph. Native hosts supply the existing engine and executor.
 * @since 1.0.0
 */

import type { Control, ControlExecutor } from "@smthrs/control"
import { ControlLive, ControlRuntime } from "@smthrs/control"
import { Journal } from "@smthrs/journal"
import { NotificationQueue } from "@smthrs/notifications"
import type { Registry } from "@smthrs/registry"
import { Effect, Layer } from "effect"
import type { Engine } from "../Application.ts"
import * as ExecutorOwnership from "../ExecutorOwnership.ts"

/** Private host policy over the same durable queue and runtime.
 * @since 1.0.0
 * @private
 */
export type NotificationDecorator = (
  queue: NotificationQueue.Service,
  control: ControlRuntime.Service,
  journal: Journal.Service
) => NotificationQueue.Service

/** Composes local control with its owned executor and durable notification queue.
 * @since 1.0.0
 * @private
 */
export const layer = (
  registry: Layer.Layer<Registry.Registry>,
  engine: Engine,
  executor:
    | Layer.Layer<
      ControlExecutor.ControlExecutor,
      never,
      ControlRuntime.ControlRuntime | Journal.Journal | NotificationQueue.NotificationQueue | Registry.Registry
    >
    | undefined,
  decorateNotifications?: NotificationDecorator,
  /**
   * Whether the supplied executor drives runs, as opposed to only observing
   * them. An observing executor holds the port so a listing still reads the
   * engine, but `launch` and `resumeRun` refuse, so nothing in this process
   * will ever settle an accepted run and no verb may wait for one.
   */
  drivesRuns = true
): Layer.Layer<Control.Control> => {
  const queue = NotificationQueue.layer.pipe(Layer.provide(engine.journal))
  const notifications = decorateNotifications === undefined ? queue : Layer.effect(
    NotificationQueue.NotificationQueue,
    Effect.gen(function*() {
      return decorateNotifications(
        yield* NotificationQueue.NotificationQueue,
        yield* ControlRuntime.ControlRuntime,
        yield* Journal.Journal
      )
    })
  ).pipe(Layer.provide([queue, engine.runtime, engine.journal]))
  return Layer.merge(
    (executor === undefined ? ControlLive.layer : ControlLive.layer.pipe(Layer.provide(executor))).pipe(
      Layer.provide([
        engine.runtime,
        engine.journal,
        // The real queue, over the same journal the control plane writes to.
        // `layerNoop` dropped every notification on the floor.
        notifications,
        registry
      ])
    ),
    ExecutorOwnership.layer(executor !== undefined && drivesRuns)
  )
}
