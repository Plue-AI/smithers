/**
 * Inert shared manifest fields every package merges under its own declaration.
 *
 * A template is a value, never a target. The root PACKAGE.ts exports one, every
 * package declaration imports it, and {@link PackageJson.PackageJson} deep
 * merges the package over it. Nothing here reads the filesystem or spawns a
 * process, so importing a root PACKAGE.ts to read the template stays pure and
 * costs one module evaluation.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"
import * as ManifestJson from "./ManifestJson.ts"

/**
 * Runtime marker for a shared manifest template.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/PackageJsonTemplate") as never

/**
 * Shared manifest fields a package declaration merges under.
 *
 * `scripts` are literal command strings, not targets: a template is shared by
 * every package in the workspace and a target reference is package local. A
 * package that wants a script bound to one of its own targets declares it in
 * its own `scripts`, where the value is a target and the command is derived
 * from the label the workspace resolves.
 *
 * @category models
 * @since 0.1.0
 */
export interface Template {
  readonly [TypeId]: typeof TypeId
  readonly fields: Readonly<Record<string, unknown>>
}

/**
 * Options accepted by {@link make}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly license?: string | undefined
  readonly author?: string | undefined
  readonly engines?: Readonly<Record<string, string>> | undefined
  readonly scripts?: Readonly<Record<string, string>> | undefined
  readonly sideEffects?: boolean | ReadonlyArray<string> | undefined
  readonly type?: string | undefined
  /** Anything this interface does not model, shared exactly as declared. */
  readonly fields?: Readonly<Record<string, unknown>> | undefined
}

/**
 * The standard scripts every package in this workspace carries.
 *
 * They are literal commands rather than targets because they run the package's
 * own test runner directly, which is what a person expects `npm test` inside a
 * package directory to do, and because a template cannot name another
 * package's targets.
 *
 * @category constants
 * @since 0.1.0
 */
export const standardScripts: Readonly<Record<string, string>> = {
  test: "vitest run",
  "test:coverage": "vitest run --coverage"
}

/**
 * The dependency blocks a package manager owns.
 *
 * Nothing here generates them. `pnpm add` writes them, the lockfile pins them,
 * and a generator that rewrote a manifest without them would silently
 * uninstall the package. Declaring one is refused where it is declared rather
 * than dropped where it is rendered, so the mistake is reported against the
 * PACKAGE.ts line that made it.
 *
 * @category constants
 * @since 0.1.0
 */
export const managerOwnedFields: ReadonlyArray<string> = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "peerDependenciesMeta",
  "optionalDependencies",
  "bundledDependencies",
  "bundleDependencies",
  "overrides",
  "resolutions",
  "packageManager",
  "pnpm"
]

const managerOwned = new Set(managerOwnedFields)

const optionNames = new Set(["license", "author", "engines", "scripts", "sideEffects", "type", "fields"])
const modeledFields = new Set(["license", "author", "engines", "scripts", "sideEffects", "type"])
const invalidText = /[\u0000-\u001f\u007f]/

const text = (where: string, value: unknown, maximum: number): string => {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum ||
    !value.isWellFormed() ||
    invalidText.test(value)
  ) {
    throw new TypeError(`${where} must be a non-empty, well-formed string of at most ${maximum} characters`)
  }
  return value
}

const stringRecord = (where: string, value: unknown): Record<string, string> => {
  const copied = ManifestJson.cloneObject(value, where)
  const result = Object.create(null) as Record<string, string>
  for (const [key, member] of Object.entries(copied)) {
    text(`${where} key`, key, 256)
    result[key] = text(`${where}[${JSON.stringify(key)}]`, member, 16 * 1024)
  }
  return result
}

/** Copies a template options bag without invoking accessors or accepting typos. */
const copyOptions = (options: Options): Record<string, ManifestJson.Value> => {
  if (typeof options !== "object" || options === null || Array.isArray(options) || NodeUtil.isProxy(options)) {
    throw new TypeError("PackageJsonTemplate options must be a plain object")
  }
  const prototype = Object.getPrototypeOf(options)
  if (prototype !== Object.prototype && prototype !== null) {
    throw new TypeError("PackageJsonTemplate options must be a plain object")
  }
  if (Object.getOwnPropertySymbols(options).length > 0) {
    throw new TypeError("PackageJsonTemplate options must not carry symbol-keyed properties")
  }
  const copied = Object.create(null) as Record<string, ManifestJson.Value>
  for (const key of Object.getOwnPropertyNames(options)) {
    if (!optionNames.has(key)) {
      throw new TypeError(`PackageJsonTemplate received an unknown option ${JSON.stringify(key)}`)
    }
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) {
      throw new TypeError(`PackageJsonTemplate option ${JSON.stringify(key)} is an accessor or non-enumerable property`)
    }
    if (descriptor.value !== undefined) {
      copied[key] = ManifestJson.cloneValue(descriptor.value, `PackageJsonTemplate option ${JSON.stringify(key)}`)
    }
  }
  return copied
}

/**
 * Refuses a declared field the package manager owns.
 *
 * @category validation
 * @since 0.1.0
 */
export const assertNotManagerOwned = (where: string, fields: Readonly<Record<string, unknown>>): void => {
  for (const key of Object.keys(fields)) {
    if (managerOwned.has(key)) {
      throw new Error(
        `${where} declares ${JSON.stringify(key)}, which the package manager owns; ` +
          `install it with the package manager instead`
      )
    }
  }
}

/**
 * Creates a pure shared-manifest template.
 *
 * Only the options that are given are carried, so an absent option contributes
 * nothing rather than an explicit `undefined` a package would then have to
 * override. A dependency block is refused; see {@link managerOwnedFields}.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const template = Smithers.PackageJsonTemplate.make({
 *   license: "MIT",
 *   author: "flows",
 *   engines: { node: ">=26.4.0" },
 *   scripts: Smithers.PackageJsonTemplate.standardScripts
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options = {}): Template => {
  const safe = copyOptions(options)
  const fields: Record<string, unknown> = {}
  if (safe["type"] !== undefined) {
    if (safe["type"] !== "module" && safe["type"] !== "commonjs") {
      throw new TypeError("PackageJsonTemplate type must be \"module\" or \"commonjs\"")
    }
    fields["type"] = safe["type"]
  }
  if (safe["license"] !== undefined) fields["license"] = text("PackageJsonTemplate license", safe["license"], 256)
  if (safe["author"] !== undefined) fields["author"] = text("PackageJsonTemplate author", safe["author"], 1024)
  if (safe["sideEffects"] !== undefined) {
    if (typeof safe["sideEffects"] === "boolean") {
      fields["sideEffects"] = safe["sideEffects"]
    } else if (Array.isArray(safe["sideEffects"])) {
      fields["sideEffects"] = safe["sideEffects"].map((member, index) =>
        text(`PackageJsonTemplate sideEffects[${index}]`, member, 4096)
      )
    } else {
      throw new TypeError("PackageJsonTemplate sideEffects must be a boolean or an array of strings")
    }
  }
  if (safe["engines"] !== undefined) fields["engines"] = stringRecord("PackageJsonTemplate engines", safe["engines"])
  if (safe["scripts"] !== undefined) fields["scripts"] = stringRecord("PackageJsonTemplate scripts", safe["scripts"])
  if (safe["fields"] !== undefined) {
    const declared = ManifestJson.cloneObject(safe["fields"], "PackageJsonTemplate fields")
    assertNotManagerOwned("PackageJsonTemplate", declared)
    for (const key of Object.keys(declared)) {
      if (modeledFields.has(key)) {
        throw new Error(`PackageJsonTemplate fields declares modeled field ${JSON.stringify(key)} twice`)
      }
    }
    Object.assign(fields, declared)
  }
  assertNotManagerOwned("PackageJsonTemplate", fields)
  return { [TypeId]: TypeId, fields: ManifestJson.cloneObject(fields, "PackageJsonTemplate") }
}

/**
 * Checks whether a value is a shared-manifest template.
 *
 * @category guards
 * @since 0.1.0
 */
export const isTemplate = (value: unknown): value is Template => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  return Object.getOwnPropertyDescriptor(value, TypeId)?.value === TypeId
}
