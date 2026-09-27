/**
 * Cache identity admission for a resolved plugin list.
 *
 * @private
 * @since 1.0.0-rc.0
 */

import { Action } from "@smthrs/flow"
import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import type { FlowsPlugin } from "../Plugin.ts"
import { PluginError } from "../PluginError.ts"
import * as Boundary from "./Boundary.ts"

const escapePluginIdentityPart = (value: string): string =>
  // Percent must be escaped first so literal escape-looking text remains distinct from the `@` escape added next.
  value.replaceAll("%", "%25").replaceAll("@", "%40")

/**
 * Admits a caller cache environment and prepends one escaped `name@version`
 * identity per plugin, in resolved order. An absent input stays absent.
 *
 * @private
 * @since 1.0.0-rc.0
 */
export const snapshotCacheEnvironment = <H>(
  input: unknown,
  plugins: ReadonlyArray<FlowsPlugin<H>>
): Effect.Effect<Action.CacheEnvironment | undefined, PluginError> => {
  if (input === undefined) return Effect.succeed(undefined)
  const pluginIdentities: Array<string> = []
  for (const plugin of plugins) {
    if (plugin.version === undefined) {
      return Effect.fail(
        new PluginError({
          code: "cache_environment_invalid",
          message: `cache environment requires a version for plugin "${plugin.name}"`,
          path: "$.version",
          plugin: plugin.name
        })
      )
    }
    pluginIdentities.push(`${escapePluginIdentityPart(plugin.name)}@${escapePluginIdentityPart(plugin.version)}`)
  }
  const admitted = Boundary.record(input)
  if (!admitted.ok) {
    return Effect.fail(
      new PluginError({
        code: "cache_environment_invalid",
        message: `cache environment ${admitted.complaint}`,
        path: `$options.cacheEnvironment${admitted.path.slice(1)}`
      })
    )
  }
  return Schema.decodeUnknownEffect(Action.CacheEnvironment)(admitted.value).pipe(
    Effect.mapError(() =>
      new PluginError({
        code: "cache_environment_invalid",
        message: "cache environment does not match the complete cache identity schema",
        path: "$options.cacheEnvironment"
      })
    ),
    Effect.map((environment) => {
      const capabilities: Record<string, ReadonlyArray<string>> = {}
      for (const name of Object.keys(environment.capabilities)) {
        Object.defineProperty(capabilities, name, {
          value: Object.freeze([...environment.capabilities[name]!]),
          enumerable: true
        })
      }
      return Object.freeze({
        layers: Object.freeze([...pluginIdentities, ...environment.layers]),
        capabilities: Object.freeze(capabilities)
      })
    })
  )
}
