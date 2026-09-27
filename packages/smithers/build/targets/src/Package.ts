/**
 * The `S.Package({ targets })` constructor: the one export a PACKAGE.ts
 * module makes public, and the only source of target labels.
 *
 * A Package value is the target map itself — `import { Package as src }`
 * followed by `src.srcs` reads a target property directly — plus a
 * non-enumerable, immutable metadata marker. Omission from the map is the
 * entire privacy mechanism, and every listed target is public. The optional
 * `defaultVisibility` states that same rule explicitly; `"public"` is the
 * only value the map semantics can honour, so any other one is refused
 * rather than silently ignored.
 *
 * @since 0.1.0
 */

import * as NodeUtil from "node:util/types"
import { Filegroup } from "./Filegroup.ts"
import * as Input from "./Input.ts"
import * as Owners from "./Owners.ts"
import * as Target from "./Target.ts"

/**
 * Runtime marker shared by source and installed copies of this package.
 *
 * @category type ids
 * @since 0.1.0
 */
export const PackageTypeId: unique symbol = Symbol.for("smithers-build/Package") as never

/**
 * The ABI stamp carried by every Package value.
 *
 * @category constants
 * @since 0.1.0
 */
export const abi = "@smthrs/targets/Package/v1" as const

/**
 * The immutable metadata a Package value carries under its marker symbol.
 *
 * @category models
 * @since 0.1.0
 */
export interface PackageMetadata {
  readonly abi: typeof abi
  /** The map keys, sorted by UTF-16 code unit. */
  readonly keys: ReadonlyArray<string>
  /** The declared default visibility, when the package stated one. */
  readonly defaultVisibility?: "public"
  /** The validated ownership declaration, when the package stated one. */
  readonly owners?: Owners.Declaration
}

/**
 * A validated Package value: the target properties plus the marker.
 *
 * @category models
 * @since 0.1.0
 */
export type PackageValue<
  T extends Readonly<Record<string, Target.AnyTarget>> = Readonly<Record<string, Target.AnyTarget>>
> =
  & Readonly<T>
  & { readonly [PackageTypeId]: PackageMetadata }

/**
 * The grammar every target-map key must satisfy.
 *
 * @category constants
 * @since 0.1.0
 */
export const targetKeyPattern = /^[A-Za-z_][A-Za-z0-9._-]*$/

const byCodeUnit = (left: string, right: string): number => left < right ? -1 : left > right ? 1 : 0

/** One value a Package map accepts before wrapping. */
type MapValue = Target.AnyTarget | Input.File | Input.Glob

const isWrappableInput = (value: unknown): value is Input.File | Input.Glob =>
  Input.isDeclared(value) && ((value as { readonly _tag: string })._tag === "File" ||
    (value as { readonly _tag: string })._tag === "Glob")

/**
 * Constructs a Package value from an explicit target map.
 *
 * Own enumerable string data properties are copied from a plain, non-Proxy
 * map; every key must satisfy {@link targetKeyPattern}; every value must be
 * a target — or a declared file/glob input, which is wrapped in a
 * {@link Filegroup} so the map key still labels exactly one target. The
 * result is frozen, immutable, and carries {@link PackageMetadata} under a
 * non-enumerable `Symbol.for` marker.
 *
 * @category constructors
 * @since 0.1.0
 */
export const Package = <const T extends Readonly<Record<string, MapValue>>>(options: {
  readonly targets: T
  readonly defaultVisibility?: "public"
  readonly owners?: Owners.Options | Owners.Declaration | undefined
}): PackageValue<{ readonly [K in keyof T]: T[K] extends Target.AnyTarget ? T[K] : Target.AnyTarget }> => {
  if (typeof options !== "object" || options === null || NodeUtil.isProxy(options)) {
    throw new TypeError("Package options must be a plain object")
  }
  for (const key of Object.getOwnPropertyNames(options)) {
    if (key !== "targets" && key !== "defaultVisibility" && key !== "owners") {
      throw new TypeError(`Package received unknown option ${JSON.stringify(key)}`)
    }
  }
  const defaultVisibility = options.defaultVisibility
  if (defaultVisibility !== undefined && defaultVisibility !== "public") {
    throw new TypeError(
      `Package defaultVisibility must be "public": omission from the target map is the only privacy mechanism, ` +
        `so ${JSON.stringify(defaultVisibility)} cannot be honoured`
    )
  }
  const owners = options.owners === undefined ? undefined : Owners.declare(options.owners)
  const map: unknown = options.targets
  if (
    typeof map !== "object" || map === null || NodeUtil.isProxy(map) ||
    (Object.getPrototypeOf(map) !== Object.prototype && Object.getPrototypeOf(map) !== null)
  ) {
    throw new TypeError("Package targets must be a plain object map")
  }
  if (Object.getOwnPropertySymbols(map).length > 0) {
    throw new TypeError("Package targets must not contain symbol keys")
  }
  const result = Object.create(null) as Record<string, Target.AnyTarget>
  const keys: Array<string> = []
  for (const key of Object.getOwnPropertyNames(map)) {
    const descriptor = Object.getOwnPropertyDescriptor(map, key)
    if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) continue
    if (!targetKeyPattern.test(key)) {
      throw new Error(`Package target key does not satisfy [A-Za-z_][A-Za-z0-9._-]*: ${JSON.stringify(key)}`)
    }
    const value = descriptor.value
    let target: Target.AnyTarget
    if (Target.isTarget(value)) {
      target = value
    } else if (isWrappableInput(value)) {
      // A declared file or glob listed directly in a Package map — the Force
      // prototype lists `schema = S.file("schema.graphql")` — labels a fresh
      // Filegroup carrying that one input, so one map key still names exactly
      // one target and the file's content still keys every consumer.
      target = Filegroup({ srcs: [value] })
    } else {
      throw new TypeError(
        `Package target ${JSON.stringify(key)} is not a target or a declared file input`
      )
    }
    Object.defineProperty(result, key, {
      configurable: false,
      enumerable: true,
      value: target,
      writable: false
    })
    keys.push(key)
  }
  keys.sort(byCodeUnit)
  const metadata: PackageMetadata = Object.freeze({
    abi,
    keys: Object.freeze(keys),
    ...(defaultVisibility === undefined ? {} : { defaultVisibility }),
    ...(owners === undefined ? {} : { owners })
  })
  Object.defineProperty(result, PackageTypeId, {
    configurable: false,
    enumerable: false,
    value: metadata,
    writable: false
  })
  return Object.freeze(result) as never
}

/**
 * Checks whether a value is a validated Package value.
 *
 * The marker descriptor must be a non-enumerable, non-configurable,
 * non-writable data property whose metadata carries the current ABI, so a
 * forged enumerable copy or a Proxy is refused.
 *
 * @category guards
 * @since 0.1.0
 */
export const isPackage = (value: unknown): value is PackageValue => {
  if (typeof value !== "object" || value === null || NodeUtil.isProxy(value)) return false
  let descriptor: PropertyDescriptor | undefined
  try {
    descriptor = Object.getOwnPropertyDescriptor(value, PackageTypeId)
  } catch {
    return false
  }
  if (
    descriptor === undefined || !("value" in descriptor) ||
    descriptor.enumerable !== false || descriptor.configurable !== false || descriptor.writable !== false
  ) return false
  const metadata = descriptor.value as { readonly abi?: unknown; readonly keys?: unknown }
  return typeof metadata === "object" && metadata !== null && metadata.abi === abi &&
    Array.isArray(metadata.keys) && metadata.keys.every((key) => typeof key === "string")
}

/**
 * Reads the metadata marker attached by {@link Package}.
 *
 * @category accessors
 * @since 0.1.0
 */
export const metadata = (value: PackageValue): PackageMetadata => {
  if (!isPackage(value)) throw new TypeError("value is not a well-formed Package")
  return Object.getOwnPropertyDescriptor(value, PackageTypeId)!.value as PackageMetadata
}
