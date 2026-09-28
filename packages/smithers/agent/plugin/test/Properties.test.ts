import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import * as Config from "../src/Config.ts"
import type { FlowsPlugin } from "../src/index.ts"
import * as Resolve from "../src/Resolve.ts"

type JsonValue = null | boolean | number | string | ReadonlyArray<JsonValue> | JsonRecord
interface JsonRecord {
  readonly [key: string]: JsonValue
}

const mulberry32 = (initial: number): () => number => {
  let seed = initial
  return () => {
    let value = seed += 0x6d2b79f5
    value = Math.imul(value ^ value >>> 15, value | 1)
    value ^= value + Math.imul(value ^ value >>> 7, value | 61)
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296
  }
}

const integer = (random: () => number, exclusiveMaximum: number): number => Math.floor(random() * exclusiveMaximum)

const randomValue = (random: () => number, depth: number): JsonValue => {
  const choice = integer(random, depth === 0 ? 4 : 7)
  if (choice === 0) return null
  if (choice === 1) return random() < 0.5
  if (choice === 2) return integer(random, 41) - 20
  if (choice === 3) return `value-${integer(random, 20)}`
  if (choice === 4) {
    return Array.from({ length: integer(random, 4) }, () => randomValue(random, depth - 1))
  }
  return randomRecord(random, depth - 1)
}

const randomRecord = (random: () => number, depth: number): JsonRecord => {
  const output: Record<string, JsonValue> = {}
  const members = integer(random, 5)
  for (let index = 0; index < members; index++) output[`key${index}`] = randomValue(random, depth)
  return output
}

const isRecord = (value: JsonValue): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value)

const oracleMerge = (base: JsonRecord, patch: JsonRecord): JsonRecord => {
  const output: Record<string, JsonValue> = { ...base }
  for (const [key, next] of Object.entries(patch)) {
    const previous = output[key]
    output[key] = previous !== undefined && isRecord(previous) && isRecord(next)
      ? oracleMerge(previous, next)
      : next
  }
  return output
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect)

describe("deterministic plugin properties", () => {
  it("matches an independent recursive Config.merge oracle over strict JSON records", () => {
    const random = mulberry32(0x51_17_c0_de)
    for (let index = 0; index < 300; index++) {
      const base = randomRecord(random, 3)
      const patch = randomRecord(random, 3)
      expect(Config.merge(base, patch)).toEqual(oracleMerge(base, patch))
    }
  })

  it("orders handlers by per-hook order, then enforce, then original index", async () => {
    const random = mulberry32(0x0d_e2_1e_55)
    const enforceValues = [undefined, "pre", "post"] as const
    const hookOrderValues = [undefined, "pre", "post"] as const
    const rank = (value: "pre" | "post" | undefined): number => value === "pre" ? 0 : value === "post" ? 2 : 1

    for (let caseIndex = 0; caseIndex < 160; caseIndex++) {
      const generated = Array.from({ length: 2 + integer(random, 11) }, (_, originalIndex) => {
        const enforce = enforceValues[integer(random, enforceValues.length)]
        const order = hookOrderValues[integer(random, hookOrderValues.length)]
        const name = `property-${caseIndex}-${originalIndex}`
        const handler = () => Effect.void
        const plugin: FlowsPlugin = {
          name,
          ...(enforce === undefined ? {} : { enforce }),
          hooks: {
            configResolved: order === undefined ? handler : { order, handler }
          }
        }
        return { plugin, name, enforce, order, originalIndex }
      })
      const resolved = await run(Resolve.resolve(generated.map(({ plugin }) => plugin)))
      // The oracle mirrors Vite: the per-hook `order` partitions first and the
      // enforce-sorted plugin list breaks ties inside each partition.
      const expected = [...generated]
        .sort((left, right) =>
          rank(left.order) - rank(right.order) ||
          rank(left.enforce) - rank(right.enforce) ||
          left.originalIndex - right.originalIndex
        )
        .map(({ name }) => name)
      expect(resolved.handlers.get("configResolved")?.map(({ plugin }) => plugin)).toEqual(expected)
    }
  })
})
