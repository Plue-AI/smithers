/**
 * Structural validation of a permission-error payload at a trust boundary.
 *
 * @since 0.1.0
 */

import { isRecord } from "@smthrs/canonical/Record"
import { Schema } from "effect"
import { Action, EffectTier, maxResourceLength } from "./Capability.ts"
import { GrantStoreError } from "./GrantStoreError.ts"
import { GrantStoreErrorCode } from "./GrantStoreErrorCode.ts"
import { isPlainObject } from "./internal/isPlainObject.ts"
import type { PermissionErrorPayload } from "./PermissionErrorPayload.ts"

const isAction = Schema.is(Action)
const isEffectTier = Schema.is(EffectTier)
// Inspect descriptors rather than feeding unknown containers to Schema.Json,
// whose property reads can execute user getters. Track the active path to
// reject cycles while allowing repeated references to already checked data.
const isPermissionMeta = (input: unknown): boolean => {
  if (!isPlainObject(input)) return false
  const active = new WeakSet<object>()
  const checked = new WeakSet<object>()
  const stack: Array<{ readonly value: unknown; readonly exit?: boolean }> = [{ value: input }]
  while (stack.length > 0) {
    const { value, exit } = stack.pop()!
    if (value === null || typeof value === "string" || typeof value === "boolean") continue
    if (typeof value === "number" && Number.isFinite(value)) continue
    if (typeof value !== "object" || value === null) return false
    if (exit) {
      active.delete(value)
      checked.add(value)
      continue
    }
    if (active.has(value)) return false
    if (checked.has(value)) continue
    const array = Array.isArray(value)
    if (array ? Object.getPrototypeOf(value) !== Array.prototype : !isPlainObject(value)) return false
    const descriptors = Object.getOwnPropertyDescriptors(value)
    let elements = 0
    for (const key of Reflect.ownKeys(descriptors)) {
      const descriptor = descriptors[key as string]!
      if (typeof key !== "string" || !("value" in descriptor)) return false
      if (array) {
        if (key === "length") continue
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || String(index) !== key || index >= value.length) return false
        elements++
      }
    }
    if (array && elements !== value.length) return false
    active.add(value)
    stack.push({ value, exit: true })
    for (const key of Object.keys(descriptors)) {
      if (!array || key !== "length") stack.push({ value: descriptors[key]!.value })
    }
  }
  return true
}
const grantStoreErrorCodes: ReadonlySet<string> = new Set(GrantStoreErrorCode.literals)
const missing = Symbol("missing")
const accessorOrInherited = Symbol("accessorOrInherited")
const ownData = (input: Readonly<Record<PropertyKey, unknown>>, key: PropertyKey): unknown => {
  const descriptor = Object.getOwnPropertyDescriptor(input, key)
  if (descriptor === undefined) return key in input ? accessorOrInherited : missing
  return "value" in descriptor ? descriptor.value : accessorOrInherited
}
const isGrantStoreError = Schema.is(GrantStoreError)
const isGrantStoreMessage = (input: Readonly<Record<PropertyKey, unknown>>): boolean => {
  const message = ownData(input, "message")
  if (message === missing || message === undefined || typeof message === "string") return true
  if (Object.hasOwn(input, "message")) return false
  // Effect errors with no explicit message inherit Error's empty data field.
  // Use schema identity for dual-package instances, after checking descriptors.
  let prototype = Object.getPrototypeOf(input)
  while (prototype !== null) {
    const descriptor = Object.getOwnPropertyDescriptor(prototype, "message")
    if (descriptor !== undefined) {
      return "value" in descriptor && descriptor.value === "" && isGrantStoreError(input)
    }
    prototype = Object.getPrototypeOf(prototype)
  }
  return false
}
const hasOnlyEnumerableFields = (
  input: Readonly<Record<PropertyKey, unknown>>,
  allowed: ReadonlySet<string>
): boolean => Object.keys(input).every((key) => allowed.has(key))
const requiredFields = new Set(["_tag", "code", "requestId", "runId", "capability", "tier", "meta"])
const deniedFields = new Set(["_tag", "code", "capability", "reason"])
const grantStoreFields = new Set(["_tag", "code", "message", "cause"])
const capabilityFields = new Set(["action", "resource"])
const isCapability = (input: unknown): boolean =>
  isRecord(input) &&
  hasOnlyEnumerableFields(input, capabilityFields) &&
  typeof ownData(input, "resource") === "string" &&
  (ownData(input, "resource") as string).length <= maxResourceLength &&
  isAction(ownData(input, "action"))

/**
 * Refines an unknown value to data-only permission fields, not a yieldable
 * error instance. Own accessors and inherited fields are rejected; metadata
 * is checked through descriptors at every depth. This establishes structure,
 * not the producer or request identity. Use the package-root decodePermissionError to construct
 * an error instance after validation.
 *
 * @category refinements
 * @since 0.1.0
 * @slop
 */
export const isPermissionError = (input: unknown): input is PermissionErrorPayload => {
  if (!isRecord(input)) {
    return false
  }
  switch (ownData(input, "_tag")) {
    case "@smthrs/capability/PermissionRequired":
      return hasOnlyEnumerableFields(input, requiredFields) &&
        ownData(input, "code") === "permission_required" &&
        typeof ownData(input, "requestId") === "string" &&
        (ownData(input, "runId") === missing ||
          ownData(input, "runId") === undefined ||
          typeof ownData(input, "runId") === "string") &&
        isEffectTier(ownData(input, "tier")) &&
        isCapability(ownData(input, "capability")) &&
        isPermissionMeta(ownData(input, "meta"))
    case "@smthrs/capability/PermissionDenied":
      return hasOnlyEnumerableFields(input, deniedFields) &&
        ownData(input, "code") === "permission_denied" &&
        typeof ownData(input, "reason") === "string" &&
        isCapability(ownData(input, "capability"))
    case "@smthrs/capability/GrantStoreError":
      return hasOnlyEnumerableFields(input, grantStoreFields) &&
        ownData(input, "cause") !== accessorOrInherited &&
        typeof ownData(input, "code") === "string" &&
        grantStoreErrorCodes.has(ownData(input, "code") as string) &&
        isGrantStoreMessage(input)
    default:
      return false
  }
}
