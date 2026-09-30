/** Retained workspace bytes keep the project's approved locator identity.
 * @since 1.0.0
 */

import { Registry } from "@smthrs/registry"
import * as Descriptor from "@smthrs/registry/Descriptor"
import { RegistryError } from "@smthrs/registry/RegistryError"
import { Effect, Layer, Option } from "effect"
import { isAbsolute, relative, resolve } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"

/** Private composition: relocation changes loading, never executable identity.
 * @since 1.0.0
 * @private
 */
export const layer = (
  registry: Layer.Layer<Registry.Registry>,
  identityRoot: string,
  workspaceRoot: string
): Layer.Layer<Registry.Registry> => {
  const identity = resolve(identityRoot)
  const workspace = resolve(workspaceRoot)
  if (identity === workspace) return registry
  const locator = (value: string): string => {
    const file = value.startsWith("file:")
    const path = file ? fileURLToPath(value) : value
    const suffix = relative(workspace, path)
    if (isAbsolute(suffix) || suffix === ".." || suffix.startsWith("../")) return value
    const target = resolve(identity, suffix)
    return file ? pathToFileURL(target).href : target
  }
  const project = (value: Descriptor.FlowDescriptor): Descriptor.FlowDescriptor =>
    Object.freeze(
      new Descriptor.FlowDescriptor({
        ...value,
        path: locator(value.path),
        body: value.body._tag === "Markdown"
          ? new Descriptor.BodyRefMarkdown({
            ...value.body,
            path: locator(value.body.path),
            baseDirectory: locator(value.body.baseDirectory)
          })
          : new Descriptor.BodyRefModule({ ...value.body, path: locator(value.body.path) }),
        input: value.input._tag === "Module"
          ? new Descriptor.SchemaRefModule({ ...value.input, path: locator(value.input.path) })
          : value.input,
        output: value.output._tag === "Module"
          ? new Descriptor.SchemaRefModule({ ...value.output, path: locator(value.output.path) })
          : value.output,
        provenance: Object.freeze({ ...value.provenance, root: locator(value.provenance.root) })
      })
    )
  const owned = (value: Descriptor.FlowDescriptor) => {
    const entry = project(value)
    Object.freeze(entry.body)
    Object.freeze(entry.input)
    Object.freeze(entry.output)
    return entry
  }
  return Layer.effect(
    Registry.Registry,
    Effect.gen(function*() {
      const physical = yield* Registry.Registry
      return Registry.Registry.of({
        ...physical,
        list: () => physical.list().pipe(Effect.map((entries) => entries.map(owned))),
        visible: () => physical.visible().pipe(Effect.map((entries) => entries.map(owned))),
        get: (name) => physical.get(name).pipe(Effect.map(owned)),
        getOption: (name) => physical.getOption(name).pipe(Effect.map(Option.map(owned))),
        loadBody: (name, expected) =>
          Effect.gen(function*() {
            const entry = yield* physical.get(name)
            // The underlying registry enforces the same reviewed digest, over
            // its physical locators. A wrong identity must still be refused there.
            const digest = Descriptor.executionDigest(project(entry))
            if (expected !== undefined && expected !== digest) {
              return yield* new RegistryError({
                code: "execution_changed",
                method: "loadBody",
                path: project(entry).body.path,
                message: `Flow "${name}" does not match its approved project identity`
              })
            }
            return yield* physical.loadBody(name, Descriptor.executionDigest(entry))
          })
      })
    })
  ).pipe(Layer.provide(registry))
}
