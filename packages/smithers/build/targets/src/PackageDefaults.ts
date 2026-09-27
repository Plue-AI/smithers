/**
 * Workspace default-target declarations and target synthesis.
 *
 * @since 0.1.0
 */

import * as Effect from "effect/Effect"
import * as Schema from "effect/Schema"
import { minimatch } from "minimatch"
import * as NodeUtil from "node:util/types"
import * as Input from "./Input.ts"
import * as PackageJson from "./PackageJson.ts"
import * as Target from "./Target.ts"

/**
 * Runtime marker for a workspace default-target declaration.
 *
 * @category type ids
 * @since 0.1.0
 */
export const TypeId: unique symbol = Symbol.for("smithers-build/PackageDefaults") as never

/**
 * A macro the planner may apply to a directory without its own PACKAGE.ts file.
 *
 * The declared `attrs` value is passed as the macro's argument. Every target
 * in the returned record becomes a synthesized named export.
 *
 * @category models
 * @since 0.1.0
 */
export type Macro = (attrs: never) => object

/**
 * A pure declaration of targets the planner synthesizes for directories
 * without their own PACKAGE.ts file.
 *
 * The planner matches `directories` against workspace directories that contain
 * the `marker` file and lack the `unless` file, then applies the macro to
 * every match. Declare workspace-wide defaults in the root PACKAGE.ts file; the
 * planner loads it before it synthesizes anything.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageDefaults {
  readonly [TypeId]: typeof TypeId
  readonly directories: Input.Glob
  readonly marker: string
  readonly unless: string
  readonly macro: Macro
  readonly attrs: Readonly<Record<string, unknown>>
}

/**
 * Options accepted by {@link PackageDefaults}.
 *
 * @category models
 * @since 0.1.0
 */
export interface Options {
  readonly directories: string | Input.Glob
  /** @default "package.json" */
  readonly marker?: string | undefined
  /** @default "PACKAGE.ts" */
  readonly unless?: string | undefined
  readonly macro: Macro
  /** @default {} */
  readonly attrs?: Readonly<Record<string, unknown>> | undefined
}

const Marker = Schema.NonEmptyString.pipe(
  Schema.withConstructorDefault(Effect.succeed("package.json"))
)

const Unless = Schema.NonEmptyString.pipe(
  Schema.withConstructorDefault(Effect.succeed("PACKAGE.ts"))
)

const DefaultAttrs = Schema.Record(Schema.String, Schema.Unknown).pipe(
  Schema.withConstructorDefault(Effect.succeed<Record<string, unknown>>({}))
)

const Defaults = Schema.Struct({
  marker: Marker,
  unless: Unless,
  attrs: DefaultAttrs
})

/**
 * Creates a pure workspace default-target declaration.
 *
 * @category constructors
 * @since 0.1.0
 */
export const make = (options: Options): PackageDefaults => {
  const defaults = Defaults.make({
    ...(options.marker === undefined ? {} : { marker: options.marker }),
    ...(options.unless === undefined ? {} : { unless: options.unless }),
    ...(options.attrs === undefined ? {} : { attrs: options.attrs })
  })
  return {
    [TypeId]: TypeId,
    directories: typeof options.directories === "string" ? Input.glob(options.directories) : options.directories,
    marker: defaults.marker,
    unless: defaults.unless,
    macro: options.macro,
    attrs: defaults.attrs
  }
}

/**
 * Declares pure workspace defaults using the PACKAGE.ts calling convention.
 *
 * A string `directories` value is lifted to {@link Input.glob}. Construction
 * validates the declaration and performs no I/O.
 *
 * @example
 * ```ts
 * import { Smithers } from "@smthrs/targets"
 *
 * export const packageDefaults = Smithers.PackageDefaults({
 *   directories: "packages/*",
 *   macro: (attrs: { cwd: string }) => ({
 *     test: Smithers.Vitest({
 *       tests: [Smithers.glob("test/*.test.ts")],
 *       sources: [Smithers.glob("src/**")],
 *       deps: [],
 *       config: null,
 *       environment: "node",
 *       passWithNoTests: false,
 *       cwd: attrs.cwd
 *     })
 *   })
 * })
 * ```
 *
 * @category constructors
 * @since 0.1.0
 */
export const PackageDefaults = (options: Options): PackageDefaults => make(options)

const missing: unique symbol = Symbol("missing default-target property")

/** Reads an own data property without invoking an accessor. */
const own = (value: object, key: PropertyKey): unknown | typeof missing => {
  const descriptor = Object.getOwnPropertyDescriptor(value, key)
  return descriptor !== undefined && "value" in descriptor ? descriptor.value : missing
}

/** Whether an object has only ordinary enumerable data fields. */
const isDataRecord = (value: unknown): value is Readonly<Record<string, unknown>> => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return false
  if (Object.getOwnPropertySymbols(value).length > 0) return false
  return Object.getOwnPropertyNames(value).every((name) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, name)
    return descriptor !== undefined && "value" in descriptor && descriptor.enumerable === true
  })
}

/** Whether a value is a dense, accessor-free array of strings. */
const isStringArray = (value: unknown): value is ReadonlyArray<string> => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value) || !Array.isArray(value)) return false
  const length = own(value, "length")
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return false
  for (let index = 0; index < length; index += 1) {
    if (typeof own(value, String(index)) !== "string") return false
  }
  return true
}

/**
 * Checks whether a PACKAGE.ts export is a default-target declaration.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackageDefaults = (value: unknown): value is PackageDefaults => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  const directories = own(value, "directories")
  if (typeof directories !== "object" || directories === null || NodeUtil.isProxy(directories)) return false
  return own(value, TypeId) === TypeId &&
    own(directories, "_tag") === "Glob" &&
    typeof own(directories, "pattern") === "string" &&
    isStringArray(own(directories, "exclude")) &&
    typeof own(value, "marker") === "string" &&
    typeof own(value, "unless") === "string" &&
    typeof own(value, "macro") === "function" &&
    isDataRecord(own(value, "attrs"))
}

/**
 * Checks whether one workspace directory matches a declaration's glob.
 *
 * `declaringPackage` is the package path of the PACKAGE.ts file that exported
 * the declaration; the glob and its excludes resolve relative to it.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const matches = (
  target: PackageDefaults,
  declaringPackage: string,
  directory: string
): boolean => {
  // A scaffold killed mid-write leaves `.smthrs-scaffold-<uuid>.tmp` holding a
  // package.json; it is never a package, whatever the glob admits.
  if (directory.split("/").some((segment) => /^\.smthrs-scaffold-.*\.tmp$/.test(segment))) return false
  const pattern = Input.resolvePath(declaringPackage, target.directories.pattern)
  if (!minimatch(directory, pattern, { dot: true })) return false
  return !target.directories.exclude.some((exclude) =>
    minimatch(directory, Input.resolvePath(declaringPackage, exclude), { dot: true })
  )
}

/**
 * What one macro application produced: its named targets and its named package
 * manifest declarations.
 *
 * A manifest declaration is not a target yet. Its scripts name targets whose
 * labels only the workspace index knows, so the index resolves them and expands
 * the declaration itself. Returning both from one macro application matters:
 * running the macro twice would produce two sets of distinct target objects,
 * and target object identity is what the index maps back to a label.
 *
 * @category models
 * @since 0.1.0
 */
export interface Expansion {
  readonly targets: ReadonlyArray<readonly [string, Target.AnyTarget]>
  readonly declarations: ReadonlyArray<readonly [string, PackageJson.Declaration]>
}

/**
 * Applies the declaration's macro once and sorts what it produced.
 *
 * The macro receives the declared attrs over a `cwd` default naming the
 * synthesized directory, so a macro that runs tools runs them inside the
 * package it was synthesized for; declared attrs still win. Names are sorted
 * by UTF-16 code unit so synthesized labels are deterministic on every host;
 * `localeCompare` answers differently under different locales and ICU
 * versions, which would order two machines' synthesized targets differently.
 * Every other property of the macro result is ignored.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const expand = (target: PackageDefaults, directory: string): Expansion => {
  const produced = (target.macro as (attrs: Readonly<Record<string, unknown>>) => object)({
    cwd: directory,
    ...target.attrs
  })
  if (!isDataRecord(produced)) {
    throw new TypeError(`default target for //${directory} must return a plain record of declarations`)
  }
  const targets: Array<readonly [string, Target.AnyTarget]> = []
  const declarations: Array<readonly [string, PackageJson.Declaration]> = []
  for (
    const [name, value] of Object.entries(produced).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
  ) {
    if (Target.isTarget(value)) targets.push([name, value])
    else if (PackageJson.isDeclaration(value)) declarations.push([name, value])
  }
  if (targets.length === 0 && declarations.length === 0) {
    throw new Error(`default target synthesized no targets for //${directory}`)
  }
  return { targets, declarations }
}

/**
 * Applies the declaration's macro and collects the targets it returns.
 *
 * @category synthesis
 * @since 0.1.0
 */
export const synthesize = (
  target: PackageDefaults,
  directory: string
): ReadonlyArray<readonly [string, Target.AnyTarget]> => expand(target, directory).targets
