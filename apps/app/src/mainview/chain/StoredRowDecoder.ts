import { Data } from "effect"
import type { StandardSchemaV1 } from "@standard-schema/spec"

export class StorageDecoderError extends Data.TaggedError("StorageDecoderError")<{
  readonly reason: "non-json" | "unstable"
  readonly message: string
}> {
  constructor(reason: "non-json" | "unstable") {
    super({
      reason,
      message: reason === "non-json"
        ? "The storage decoder returned a non-JSON value. Opening was refused; original state was preserved."
        : "The storage decoder does not produce a stable stored value. Opening was refused; use an explicit versioned migration."
    })
  }
}

/** JSON.stringify alone silently drops fields and converts non-finite numbers. */
const canonicalJson = (value: unknown, ancestors = new Set<object>()): unknown => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value
  if (typeof value === "number" && Number.isFinite(value)) return value
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new StorageDecoderError("non-json")
  ancestors.add(value)
  try {
    const array = Array.isArray(value)
    if (!array && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
      throw new StorageDecoderError("non-json")
    }
    const keys = Reflect.ownKeys(value)
    if (array && keys.length !== value.length + 1) throw new StorageDecoderError("non-json")
    const entries: Array<[string, unknown]> = []
    for (const key of keys) {
      if (array && key === "length") continue
      const descriptor = Object.getOwnPropertyDescriptor(value, key)!
      if (typeof key !== "string" || !descriptor.enumerable || !("value" in descriptor)) {
        throw new StorageDecoderError("non-json")
      }
      entries.push([key, canonicalJson(descriptor.value, ancestors)])
    }
    if (array) {
      // Holes and extra properties cannot survive a JSON round trip.
      if (entries.some(([key], index) => key !== String(index))) throw new StorageDecoderError("non-json")
      return entries.map(([, item]) => item)
    }
    return Object.fromEntries(entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0))
  } finally {
    ancestors.delete(value)
  }
}

/**
 * Persisted schemas are pure, JSON-closed, idempotent normalizers, not one-shot
 * migrations. Validate changed output on a fresh JSON copy before committing
 * it so reload cannot apply a transform again or lose non-JSON values.
 */
export const decodeStoredRow = async (
  schema: StandardSchemaV1,
  input: unknown
): Promise<
  | { readonly valid: false }
  | { readonly valid: true; readonly data: unknown; readonly encoded: string; readonly changed: boolean }
> => {
  // Capture before calling user code, including validators that mutate input.
  const before = JSON.stringify(canonicalJson(input))
  const decoded = await schema["~standard"].validate(input)
  if (decoded.issues !== undefined) return { valid: false }
  const after = JSON.stringify(canonicalJson(decoded.value))
  const encoded = JSON.stringify(decoded.value)
  const changed = before !== after
  if (changed) {
    const repeated = await schema["~standard"].validate(JSON.parse(encoded))
    if (repeated.issues !== undefined || JSON.stringify(canonicalJson(repeated.value)) !== after) {
      throw new StorageDecoderError("unstable")
    }
  }
  return { valid: true, data: JSON.parse(encoded), encoded, changed }
}
