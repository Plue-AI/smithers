/**
 * Effect logger layers used by flows.
 *
 * @since 0.1.0
 */

import * as Layer from "effect/Layer"
import * as Logger from "effect/Logger"
import type * as LogLevel from "effect/LogLevel"
import * as References from "effect/References"

/**
 * Options shared by the built-in logger layers.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  /**
   * Pins `References.MinimumLogLevel` for the whole application. Omitted, the
   * layer leaves that reference alone and Effect's own `Info` default applies.
   */
  readonly minimumLogLevel?: LogLevel.LogLevel | undefined
  /**
   * Keeps the ambient loggers alongside this one. Defaults to `false`, which
   * replaces the ambient logger set, matching Effect's own `Logger.layer`.
   */
  readonly mergeWithExisting?: boolean | undefined
}

/**
 * Installs the minimum-level reference only when the caller named a level, so
 * a layer that adds a sink does not pin the level an application chose
 * elsewhere. Effect's own default for the reference is already `Info`.
 */
const withMinimumLogLevel = (
  layer: Layer.Layer<never>,
  minimumLogLevel: LogLevel.LogLevel | undefined
): Layer.Layer<never> =>
  minimumLogLevel === undefined
    ? layer
    : Layer.merge(layer, Layer.succeed(References.MinimumLogLevel, minimumLogLevel))

const optionsWithDefaults = (options?: Options): {
  readonly minimumLogLevel: LogLevel.LogLevel | undefined
  readonly mergeWithExisting: boolean
} => ({
  minimumLogLevel: options?.minimumLogLevel,
  mergeWithExisting: options?.mergeWithExisting ?? false
})

/**
 * Provides a human-readable development logger.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerPrettyDev = (options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([Logger.consolePretty({ colors: "auto", mode: "auto" })], {
      mergeWithExisting: resolved.mergeWithExisting
    }),
    resolved.minimumLogLevel
  )
}

/**
 * Provides one structured JSON object per log line.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerStructuredJson = (options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([Logger.consoleJson], { mergeWithExisting: resolved.mergeWithExisting }),
    resolved.minimumLogLevel
  )
}

/**
 * Removes the active logger set while retaining Effect's minimum-level filter.
 *
 * @category layers
 * @since 0.1.0
 */
export const layerNoop = (options?: Pick<Options, "minimumLogLevel">): Layer.Layer<never> =>
  withMinimumLogLevel(
    Logger.layer([]),
    options?.minimumLogLevel ?? "None"
  )

/**
 * A logger layer that can be composed without requiring a runtime service.
 *
 * @category layers
 * @since 0.1.0
 */
export const layer = (logger: Logger.Logger<unknown, unknown>, options?: Options): Layer.Layer<never> => {
  const resolved = optionsWithDefaults(options)
  return withMinimumLogLevel(
    Logger.layer([logger], { mergeWithExisting: resolved.mergeWithExisting }),
    resolved.minimumLogLevel
  )
}
