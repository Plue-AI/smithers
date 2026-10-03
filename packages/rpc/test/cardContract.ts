import { describe, expect, test } from "vitest"
import { z } from "zod"

type JsonSchema = z.core.JSONSchema.JSONSchema
type Path = readonly (string | number)[]
type ObjectLocation = { path: Path; required: readonly string[]; properties: Record<string, JsonSchema | boolean> }
type EnumLocation = { path: Path; values: readonly unknown[] }

/** JSON Schema is the public inventory; no private Zod internals or copied field tables. */
const inventory = (schema: z.ZodType): JsonSchema => z.toJSONSchema(schema, { io: "input" })
const at = (value: unknown, path: Path): unknown =>
  path.reduce<unknown>(
    (owner, key) => (owner as Record<string | number, unknown>)[key],
    value
  )
const display = (path: Path): string => path.map(String).join(".") || "<root>"

// Runtime projections strip unknown fields. Only the contract checker closes
// declared objects; arbitrary flow values and record keys stay open.
const closeObjects = (schema: JsonSchema): JsonSchema => {
  const result = structuredClone(schema)
  const visit = (value: unknown): void => {
    if (value === null || typeof value !== "object") return
    if (Array.isArray(value)) {
      value.forEach(visit)
      return
    }
    const node = value as JsonSchema
    if (node.type === "object" && node.properties) node.additionalProperties = false
    Object.values(node).forEach(visit)
  }
  visit(result)
  return result
}
const resolve = (node: JsonSchema, root: JsonSchema): JsonSchema => {
  if (!node.$ref) return node
  if (node.$ref === "#") return root
  if (!node.$ref.startsWith("#/")) throw new Error(`Unsupported contract reference: ${node.$ref}`)
  const path = node.$ref.slice(2).split("/").map((key) => key.replace(/~1/g, "/").replace(/~0/g, "~"))
  return resolve(at(root, path) as JsonSchema, root)
}
// Give subschemas the same root for local references, including recursive "#".
const validator = (node: JsonSchema, root: JsonSchema): z.ZodType => {
  const relocate = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(relocate)
    if (value === null || typeof value !== "object") return value
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        key === "$ref" && typeof item === "string" && item.startsWith("#")
          ? `#/$defs/contract_root${item.slice(1)}` :
          relocate(item)
      ])
    )
  }
  return z.fromJSONSchema({
    ...relocate(node) as JsonSchema,
    $defs: { contract_root: relocate(root) as JsonSchema }
  })
}
const locations = (root: JsonSchema, fixture: unknown): { objects: ObjectLocation[]; enums: EnumLocation[] } => {
  const objects: ObjectLocation[] = []
  const enums: EnumLocation[] = []
  const validators = new Map<JsonSchema, z.ZodType>()
  const matches = (node: JsonSchema, value: unknown): boolean => {
    let compiled = validators.get(node)
    if (!compiled) {
      compiled = validator(node, root)
      validators.set(node, compiled)
    }
    return compiled.safeParse(value).success
  }
  const visit = (raw: JsonSchema | boolean, value: unknown, path: Path): void => {
    if (typeof raw === "boolean") return
    const node = resolve(raw, root)
    const branches = node.anyOf ?? node.oneOf
    if (branches) {
      for (const branch of branches) if (matches(branch, value)) visit(branch, value, path)
      return
    }
    for (const branch of node.allOf ?? []) visit(branch, value, path)
    if (node.enum) enums.push({ path, values: node.enum })
    else if (Object.hasOwn(node, "const")) enums.push({ path, values: [node.const] })
    if (Array.isArray(value) && node.items && typeof node.items === "object" && !Array.isArray(node.items)) {
      value.forEach((item, index) => visit(node.items as JsonSchema, item, [...path, index]))
    } else if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      if (node.properties) {
        objects.push({ path, required: node.required ?? [], properties: node.properties })
        for (const [key, child] of Object.entries(node.properties)) {
          if (Object.hasOwn(value, key)) visit(child, (value as Record<string, unknown>)[key], [...path, key])
        }
      } else if (typeof node.additionalProperties === "object") {
        for (const [key, item] of Object.entries(value)) visit(node.additionalProperties, item, [...path, key])
      }
    }
  }
  visit(root, fixture, [])
  return { objects, enums }
}

/** Exercises fixtures and mutations using the public JSON Schema inventory. */
export const cardContract = (name: string, schema: z.ZodType, fixtures: Readonly<Record<string, unknown>>): void => {
  const json = inventory(schema)
  const contract = z.fromJSONSchema(closeObjects(json))
  describe(`${name} card projection`, () => {
    test("publishes fixtures by state", () => {
      expect(Object.keys(fixtures).length).toBeGreaterThan(0)
    })
    for (const [state, fixture] of Object.entries(fixtures)) {
      const { objects, enums } = locations(json, fixture)
      test(`parses the ${state} fixture without losing fields`, () => {
        expect(schema.parse(fixture)).toEqual(fixture)
        expect(contract.parse(fixture)).toEqual(fixture)
      })
      test(`rejects unknown enum values throughout the ${state} fixture`, () => {
        for (const { path, values } of enums) {
          expect(values).toContain(at(fixture, path))
          const changed = structuredClone(fixture)
          const owner = at(changed, path.slice(0, -1)) as Record<string | number, unknown>
          owner[path.at(-1)!] = "unknown-contract-value"
          expect(schema.safeParse(changed).success, `${name}.${display(path)}`).toBe(false)
        }
      })
      test(`enforces required fields throughout the ${state} fixture`, () => {
        for (const { path, required } of objects) {
          for (const key of required) {
            const changed = structuredClone(fixture)
            delete (at(changed, path) as Record<string, unknown>)[key]
            expect(schema.safeParse(changed).success, `${name}.${display([...path, key])}`).toBe(false)
          }
        }
      })
      test(`accepts omission of optional fields throughout the ${state} fixture`, () => {
        for (const { path, required, properties } of objects) {
          for (const key of Object.keys(properties).filter((field) => !required.includes(field))) {
            const changed = structuredClone(fixture)
            delete (at(changed, path) as Record<string, unknown>)[key]
            expect(schema.safeParse(changed).success, `${name}.${display([...path, key])}`).toBe(true)
          }
        }
      })
      test(`rejects unknown contract fields throughout the ${state} fixture`, () => {
        for (const { path } of objects) {
          const changed = structuredClone(fixture)
          const object = at(changed, path) as Record<string, unknown>
          object.__unexpected_contract_field = "rejected"
          expect(contract.safeParse(changed).success, `${name}.${display(path)}`).toBe(false)
          expect(schema.parse(changed)).toEqual(fixture)
        }
      })
    }
  })
}
