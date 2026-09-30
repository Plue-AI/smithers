/**
 * The README's export table, pinned to the modules it describes.
 *
 * The table drifted from the source four rows at a time: `GatewayServer` grew
 * `rpcPaths`, `protectedPaths`, `defaultMaxRequestBodyBytes`, `IngressOptions`,
 * and `carriesRpcRequest` without gaining a mention, the `Sync` re-export
 * listed 6 of the 17 modules it exposes, and the hosting example imported a
 * binding the module never had. A published table nobody checks is a published
 * table that is wrong, so this diffs it against what the modules actually
 * export.
 *
 * Type-only exports cannot be read back at runtime, so each module's row is
 * checked as a superset of its runtime keys and its own declared type names,
 * read out of the source with the same shape the docs generator uses.
 */
import * as Fs from "node:fs"
import * as Path from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import * as Diagnosis from "../src/Diagnosis.ts"
import * as GatewayError from "../src/GatewayError.ts"
import * as GatewayProjection from "../src/GatewayProjection.ts"
import * as GatewayRpcs from "../src/GatewayRpcs.ts"
import * as GatewaySchema from "../src/GatewaySchema.ts"
import * as GatewayServer from "../src/GatewayServer.ts"
import * as NodeGateway from "../src/node/NodeGateway.ts"
import * as Projections from "../src/Projections.ts"
import * as RunHistory from "../src/RunHistory.ts"
import * as RuntimeBridge from "../src/RuntimeBridge.ts"

const packageRoot = Path.join(Path.dirname(fileURLToPath(import.meta.url)), "..")

/** Every `export type|interface` name a module declares, from its source. */
const declaredTypes = (file: string): ReadonlyArray<string> =>
  [...Fs.readFileSync(Path.join(packageRoot, "src", file), "utf8").matchAll(/^export (?:type|interface) (\w+)/gm)]
    .map((match) => match[1] as string)

/** The export list the README records for one module row. */
const documented = (module: string): ReadonlyArray<string> => {
  const readme = Fs.readFileSync(Path.join(packageRoot, "README.md"), "utf8")
  const row = readme.split("\n").find((line) => line.startsWith(`| \`${module}\``))
  if (row === undefined) throw new Error(`README has no row for ${module}`)
  return (row.split("|")[2] ?? "").split(",").map((cell) => cell.trim().replaceAll("`", "")).filter((cell) =>
    cell.length > 0
  )
}

const modules = [
  ["GatewayError", GatewayError, declaredTypes("GatewayError.ts")],
  ["GatewaySchema", GatewaySchema, declaredTypes("GatewaySchema.ts")],
  ["Diagnosis", Diagnosis, declaredTypes("Diagnosis.ts")],
  ["GatewayProjection", GatewayProjection, declaredTypes("GatewayProjection.ts")],
  ["GatewayRpcs", GatewayRpcs, declaredTypes("GatewayRpcs.ts")],
  ["GatewayServer", GatewayServer, declaredTypes("GatewayServer.ts")],
  ["Projections", Projections, declaredTypes("Projections.ts")],
  ["RunHistory", RunHistory, declaredTypes("RunHistory.ts")],
  ["RuntimeBridge", RuntimeBridge, declaredTypes("RuntimeBridge.ts")],
  ["node/NodeGateway", NodeGateway, declaredTypes("node/NodeGateway.ts")]
] as const

describe("the README export table", () => {
  it.each(modules.map(([name]) => name))("lists every export of %s and invents none", (name) => {
    const entry = modules.find(([module]) => module === name)
    if (entry === undefined) throw new Error(`no module named ${name}`)
    const [, module, types] = entry
    const actual = [...new Set([...Object.keys(module), ...types])].sort()
    const listed = [...documented(name)].sort()
    expect(listed).toEqual(actual)
  })

  it("lists the modules the Sync re-export exposes", () => {
    // The row names namespaces rather than their exports, because `Sync` is
    // `@smthrs/sync` whole and that package documents its own surface.
    expect(documented("Sync")).toEqual([
      "RunCatalog",
      "SyncClient",
      "SyncError",
      "SyncProtocol",
      "SyncRpcs",
      "SyncServer"
    ])
  })

  it("shows an import that resolves", () => {
    const readme = Fs.readFileSync(Path.join(packageRoot, "README.md"), "utf8")
    // `node/NodeGateway` exports no binding of its own name, so the example
    // has to import the namespace. It did not, and did not compile.
    expect(readme).toContain(`import * as NodeGateway from "@smthrs/gateway/node/NodeGateway"`)
    expect(readme).not.toContain(`import { NodeGateway }`)
  })

  it("links nothing by a repository-relative path", () => {
    const readme = Fs.readFileSync(Path.join(packageRoot, "README.md"), "utf8")
    // The README is rendered on npmjs.com, where `../../scripts/test-pins.md`
    // is a 404.
    expect(
      [...readme.matchAll(/\]\(([^)]+)\)/g)].map((match) => match[1]).filter((href) => href?.startsWith(".") === true)
    ).toEqual([])
  })
})
