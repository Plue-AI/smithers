/**
 * Branded, inert workspace toolchain declarations.
 *
 * @since 0.1.0
 */

/* eslint-disable jsdoc/require-description, jsdoc/no-restricted-syntax */
/** Runtime marker shared by every workspace toolchain declaration. */
export const TypeId: unique symbol = Symbol.for("smithers-build/WorkspaceToolchain") as never

/** */
export interface Declaration<Tag extends string = string> {
  readonly [TypeId]: typeof TypeId
  readonly _tag: Tag
}

/** */
export const declare = <A extends { readonly _tag: string }>(value: A): A & Declaration<A["_tag"]> => {
  const result = { ...value } as A & Declaration<A["_tag"]>
  Object.defineProperty(result, TypeId, {
    configurable: false,
    enumerable: false,
    value: TypeId,
    writable: false
  })
  return Object.freeze(result)
}

/** */
export const isDeclaration = (value: unknown): value is Declaration =>
  typeof value === "object" && value !== null && Object.getOwnPropertyDescriptor(value, TypeId)?.value === TypeId
