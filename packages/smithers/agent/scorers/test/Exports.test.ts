import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { Scorers } from "../src/index.ts"
import * as Builtins from "../src/Scorers.ts"

const packageRoot = fileURLToPath(new URL("../", import.meta.url))

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

// `index.ts` is a barrel, so every namespace names a sibling module.
const namespaces = (): ReadonlyArray<readonly [string, string]> =>
  [...read("../src/index.ts").matchAll(/export \* as (\w+) from "\.\/(\w+)\.ts"/g)]
    .map(([, namespace, file]) => [namespace!, file!] as const)

// Migration step modules are applied through the root `Migrations` namespace;
// the step bodies themselves are sealed implementation detail.
describe("package exports", () => {
  it("exports all built-in scorers through the root namespace and public subpath", () => {
    expect(Scorers).toBe(Builtins)
    expect(Object.keys(Scorers).sort()).toEqual([
      "contains",
      "diffSize",
      "exact",
      "rubric",
      "testsPass",
      "touchedFiles"
    ])
    const manifest = JSON.parse(read("../package.json"))
    expect(manifest.exports["./Scorers"]).toBe("./src/Scorers.ts")
    expect(manifest.publishConfig.exports["./Scorers"]).toEqual({
      import: { types: "./dist/esm/Scorers.d.ts", default: "./dist/esm/Scorers.js" },
      require: { types: "./dist/cjs/Scorers.d.ts", default: "./dist/cjs/Scorers.js" }
    })
  })
  // `index.ts` carries no implementation: it names sibling modules and nothing
  // else. A re-export with a path segment puts a concept in a directory's
  // `index.ts` instead of its own named file, and every reader of the barrel
  // then has to follow a path to find it.
  it("re-exports every namespace from a bare sibling module", () => {
    const specifiers = [...read("../src/index.ts").matchAll(/export \* as \w+ from "\.\/([^"]+)"/g)]
      .map(([, specifier]) => specifier!)
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter((specifier) => !/^[A-Za-z0-9_$]+\.ts$/.test(specifier))).toEqual([])
  })

  it("keeps migration implementations private in development and published exports", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8")
    ) as {
      readonly exports: Readonly<Record<string, unknown>>
      readonly publishConfig: { readonly exports: Readonly<Record<string, unknown>> }
    }
    expect(manifest.exports["./migrations/*"]).toBeNull()
    expect(manifest.publishConfig.exports["./migrations/*"]).toBeNull()

    const specifier = "@smthrs/scorers/migrations/0001_scores"
    execFileSync(process.execPath, [
      "--input-type=module",
      "--eval",
      `await import(${JSON.stringify(specifier)}).then(
        () => process.exitCode = 2,
        (error) => process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      )`
    ], { cwd: packageRoot })
    execFileSync(process.execPath, [
      "--eval",
      `try {
        require(${JSON.stringify(specifier)})
        process.exitCode = 2
      } catch (error) {
        process.exitCode = error?.code === "ERR_PACKAGE_PATH_NOT_EXPORTED" ? 0 : 3
      }`
    ], { cwd: packageRoot })
  })

  // A `Context.Service` class is already the public constructor: `Class.of`
  // takes a service value and returns it typed. A second
  // `make = (service: Service): Service => Class.of(service)` forwards its only
  // argument, validates nothing, and supplies no default, so it buys a second
  // name to learn and a second row to document for no behavior. Construct
  // through the class instead. `makeNoop` is not this shape: it takes no
  // service and supplies an implementation.
  it("exports no constructor that only forwards to its context service class", () => {
    const forwarding = /export const (\w+) = \((\w+): Service\): Service =>\s*\w+\.of\(\2\)/g
    const offenders: Array<string> = []
    for (const [namespace, file] of namespaces()) {
      for (const [, name] of read(`../src/${file}.ts`).matchAll(forwarding)) {
        offenders.push(`${namespace}.${name!}`)
      }
    }
    expect(offenders).toEqual([])
  })
})
