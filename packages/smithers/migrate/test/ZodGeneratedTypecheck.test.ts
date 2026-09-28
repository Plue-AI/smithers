import { expect, it } from "@effect/vitest"
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import * as ZodSchemaHints from "../src/ZodSchemaHints.ts"

it("typechecks generated defaults with their documented imports and exact decoded types", () => {
  // A real module beneath this package resolves its installed Effect and
  // TypeScript versions; no ambient declarations or erased runtime types.
  const packageRoot = fileURLToPath(new URL("../", import.meta.url))
  const directory = mkdtempSync(join(packageRoot, ".generated-schema-typecheck-"))
  try {
    const sources = [
      ["BooleanValue", "z.object({ value: z.boolean().default(false) })", "boolean"],
      ["NumberValue", "z.object({ value: z.number().default(0) })", "number"],
      ["NullableValue", "z.object({ value: z.string().nullable().default(null) })", "string | null"],
      ["CheckedNullableValue", "z.object({ value: z.string().min(5).nullable().default(null) })", "string | null"],
      ["ArrayValue", "z.object({ value: z.array(z.string()).default([]) })", "ReadonlyArray<string>"],
      ["LiteralValue", "z.object({ value: z.literal(1).default(1) })", "1"],
      ["BooleanLiteralValue", "z.object({ value: z.literal(true).default(true) })", "true"],
      ["EnumValue", "z.object({ value: z.enum([\"a\", \"b\"]).default(\"b\") })", "\"a\" | \"b\""],
      [
        "RecordValue",
        "z.object({ value: z.record(z.string(), z.number()).default({}) })",
        "Readonly<Record<string, number>>"
      ]
    ] as const
    const declarations = sources.map(([name, chain, type]) => {
      const text = ZodSchemaHints.print(chain)
      expect(text).toBeDefined()
      const field = ZodSchemaHints.printField(chain.slice("z.object({ value: ".length, -" })".length))
      expect(field).toBeDefined()
      return `const ${name} = ${text};\ntype ${name}Type = Assert<Equal<typeof ${name}.Type, { readonly value: ${type} }>>;\nconst ${name}Field = Schema.Struct({ value: ${field} });\ntype ${name}FieldType = Assert<Equal<typeof ${name}Field.Type, { readonly value: ${type} }>>;`
    })
    const source = [
      "import * as Effect from \"effect/Effect\";",
      "import * as Schema from \"effect/Schema\";",
      "import * as SchemaGetter from \"effect/SchemaGetter\";",
      "type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;",
      "type Assert<T extends true> = T;",
      ...declarations
    ].join("\n")
    writeFileSync(join(directory, "schemas.mts"), source)
    writeFileSync(
      join(directory, "tsconfig.json"),
      JSON.stringify({
        files: ["schemas.mts"],
        compilerOptions: {
          target: "ES2022",
          module: "NodeNext",
          moduleResolution: "NodeNext",
          strict: true,
          exactOptionalPropertyTypes: true,
          noUncheckedIndexedAccess: true,
          skipLibCheck: true,
          noEmit: true,
          types: []
        }
      })
    )
    const require = createRequire(import.meta.url)
    const compiler = join(dirname(require.resolve("typescript/package.json")), "bin", "tsc")
    const checked = spawnSync(process.execPath, [compiler, "-p", join(directory, "tsconfig.json")], {
      cwd: packageRoot,
      encoding: "utf8",
      timeout: 30_000,
      maxBuffer: 4 * 1024 * 1024
    })
    expect(checked.error).toBeUndefined()
    expect(checked.signal).toBeNull()
    expect({ status: checked.status, diagnostics: checked.stdout + checked.stderr }).toEqual({
      status: 0,
      diagnostics: ""
    })
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
})
