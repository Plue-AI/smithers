/**
 * Every command either consumes each positional it receives or refuses the
 * invocation; none silently drops one (#2109).
 */
import { Cli as Incur, z } from "incur"
import * as Fs from "node:fs/promises"
import { createRequire } from "node:module"
import * as Os from "node:os"
import * as NodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"
import * as Positionals from "../src/Positionals.ts"
import { executionPresentation } from "./fixtures/presentation.ts"
import { serve } from "./helpers/ServeCli.ts"

let root: string

beforeAll(async () => {
  root = await Fs.realpath(await Fs.mkdtemp(NodePath.join(Os.tmpdir(), "smthrs-positionals-")))
})

afterAll(async () => {
  if (root !== undefined) await Fs.rm(root, { recursive: true, force: true })
})

type Entry = {
  readonly _alias?: true
  readonly _group?: true
  readonly commands?: ReadonlyMap<string, Entry>
  readonly args?: z.ZodObject<any>
  readonly options?: z.ZodObject<any>
  run?: (context: { readonly args: Record<string, unknown> }) => unknown
}

/** Every runnable command of an incur registry, by its space-separated path. */
const leaves = (commands: ReadonlyMap<string, Entry>, prefix: ReadonlyArray<string> = []) =>
  [...commands].flatMap(([name, entry]): Array<readonly [ReadonlyArray<string>, Entry]> => {
    if (entry._alias === true) return []
    if (entry._group === true) return leaves(entry.commands!, [...prefix, name])
    return [[[...prefix, name], entry]]
  })

const fields = (entry: Entry): Array<z.ZodType> =>
  Object.values(entry.args?.shape ?? {}).map((field) => {
    let inner = field as z.ZodType
    while ("innerType" in inner.def) inner = inner.def.innerType as z.ZodType
    return inner
  })

/** One valid token for a field, positional or option. */
const tokenFor = (field: z.ZodType): string => field instanceof z.ZodEnum ? String(field.options[0]) : "value"

/**
 * A valid flag for every option the command requires. `review` requires
 * `--policy-revision`; without it the call fails option validation, and the
 * case measures that refusal instead of what happens to the positional.
 */
const requiredOptions = (entry: Entry): Array<string> =>
  Object.entries(entry.options?.shape ?? {}).flatMap(([key, field]) => {
    const schema = field as z.ZodType
    if (schema.safeParse(undefined).success) return []
    const flag = `--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}`
    return schema instanceof z.ZodBoolean ? [flag] : [flag, tokenFor(schema)]
  })

/** One valid token per declared positional, then one surplus token. */
const argvFor = (path: ReadonlyArray<string>, entry: Entry): Array<string> => [
  ...path,
  ...fields(entry).map(tokenFor),
  "surplus",
  ...requiredOptions(entry)
]

const lastIsArray = (entry: Entry): boolean => fields(entry).at(-1) instanceof z.ZodArray

const silent = { write: () => {}, isTTY: false, columns: undefined }

describe("surplus positionals", () => {
  const cli = makeCli({ presentation: executionPresentation, stdout: silent, stderr: silent })
  const commands = leaves(Incur.toCommands.get(cli as never) as unknown as ReadonlyMap<string, Entry>)

  it("enumerates the whole command tree", () => {
    expect(commands.map(([path]) => path.join(" "))).toEqual(
      expect.arrayContaining(["show target", "cache prune", "targets", "clean", "affected", "graph", "build"])
    )
  })

  it.each(commands.map(([path, entry]) => [path.join(" "), path, entry] as const))(
    "%s refuses or consumes a surplus positional",
    async (_name, path, entry) => {
      const received: Array<Record<string, unknown>> = []
      entry.run = (context) => {
        received.push(context.args)
        return undefined
      }
      let output = ""
      let exitCode = 0
      const workspace = entry.options?.shape["workspace"] === undefined ? [] : ["--workspace", root]
      await cli.serve([...argvFor(path, entry), ...workspace, "--format", "json"], {
        stdout: (text) => {
          output += text
        },
        exit: (code) => {
          exitCode = code
        }
      })
      if (lastIsArray(entry)) {
        expect(exitCode, output).toBe(0)
        expect(Object.values(received[0] ?? {}).flat()).toContain("surplus")
      } else {
        expect(received).toEqual([])
        expect(exitCode).toBe(1)
        expect(JSON.parse(output)).toMatchObject({
          code: "UNEXPECTED_ARGUMENT",
          message: "Unexpected argument: surplus"
        })
      }
    }
  )
})

describe("Positionals.surplus", () => {
  // `withoutBuiltins` copies the built-in flags incur's `extractBuiltinFlags`
  // strips (dist/Cli.js). Re-check that list, and `Parser.parse` assigning
  // positionals, before moving this pin.
  it("is pinned to the incur whose built-in flags it copies", async () => {
    const entry = createRequire(import.meta.url).resolve("incur")
    const manifest = JSON.parse(await Fs.readFile(NodePath.join(entry, "../../package.json"), "utf8"))
    expect(manifest).toMatchObject({ name: "incur", version: "0.5.1" })
  })

  it("leaves a stdio MCP server's argv to incur", () => {
    const cli = makeCli({ presentation: executionPresentation })
    expect(Positionals.surplus(cli, ["graph", "//a", "//b"], ["graph"])).toEqual(["//b"])
    expect(Positionals.surplus(cli, ["--mcp", "graph", "//a", "//b"], ["graph"])).toBeUndefined()
  })

  it("ignores built-in switches and their values without losing surplus command words", () => {
    const cli = makeCli({ presentation: executionPresentation })
    for (
      const argv of [
        ["--json", "graph", "//a", "//b"],
        ["graph", "//a", "--full-output", "//b"],
        ["--llms", "graph", "//a", "//b"],
        ["--llms-full", "graph", "//a", "//b"],
        ["--help", "graph", "//a", "//b"],
        ["-h", "graph", "//a", "//b"],
        ["--update", "graph", "//a", "//b"],
        ["--incur-update-check", "graph", "//a", "//b"],
        ["--schema", "graph", "//a", "//b"],
        ["--token-count", "graph", "//a", "//b"],
        ["--format", "json", "graph", "//a", "//b"],
        ["graph", "//a", "--filter-output", "payload", "//b"],
        ["--token-limit", "100", "graph", "//a", "//b"],
        ["graph", "//a", "--token-offset", "4", "//b"]
      ]
    ) {
      expect(Positionals.surplus(cli, argv, ["graph"]), argv.join(" ")).toEqual(["//b"])
    }
    expect(Positionals.surplus(cli, ["graph", "//a", "//b", "--version"], ["graph"]))
      .toEqual(["//b"])
    expect(Positionals.surplus(cli, ["graph", "//a", "//b", "--version", "--json"], ["graph"]))
      .toEqual(["//b"])
  })

  it("resolves aliases and nested commands and leaves unknown commands to incur", () => {
    const cli = makeCli({ presentation: executionPresentation })
    expect(Positionals.surplus(cli, ["gitHooks", "extra"], ["gitHooks"])).toEqual(["extra"])
    expect(Positionals.surplus(cli, ["show", "target", "//:good", "extra"], ["show", "target"]))
      .toEqual(["extra"])
    expect(Positionals.surplus(cli, ["show", "extra"], ["show"])).toBeUndefined()
    expect(Positionals.surplus(cli, ["missing", "extra"], ["missing"])).toBeUndefined()
  })

  it("excludes global option values before counting command arguments", () => {
    const cli = makeCli({ presentation: executionPresentation })
    const globals = z.object({ audience: z.enum(["human", "agent"]), silent: z.boolean().default(false) })
    expect(Positionals.surplus(
      cli,
      ["--audience", "agent", "graph", "//a", "--silent", "//b"],
      ["graph"],
      globals
    )).toEqual(["//b"])
  })
})

describe("Positionals.unconsumed", () => {
  const command = {
    args: z.object({ label: z.string() }),
    options: z.object({ verb: z.enum(["build", "test"]), plan: z.boolean().default(false) }),
    alias: { verb: "v" }
  }

  it("counts option values and switches as consumed", () => {
    expect(Positionals.unconsumed(command, ["//a", "--verb", "test", "--plan"])).toEqual([])
    expect(Positionals.unconsumed(command, ["-v", "build", "//a", "//b"])).toEqual(["//b"])
  })

  it("finds a surplus positional beside an invalid option", () => {
    expect(Positionals.unconsumed(command, ["//a", "//b", "--verb", "deploy"])).toEqual(["//b"])
  })

  it("leaves tokens that do not parse to incur", () => {
    expect(Positionals.unconsumed(command, ["//a", "//b", "--unknown"])).toBeUndefined()
  })

  it("treats an optional trailing array as consuming every remaining positional", () => {
    const many = { args: z.object({ patterns: z.array(z.string()).optional() }) }
    expect(Positionals.unconsumed(many, ["//a", "//b", "//c"])).toEqual([])
    expect(Positionals.unconsumed({ args: z.object({}) }, ["//a", "//b"])).toEqual(["//a", "//b"])
    expect(Positionals.unconsumed({ args: z.object({}) }, [])).toEqual([])
  })

  it("retains a count option's flag shape while checking for extra positionals", () => {
    const counted = {
      args: z.object({ label: z.string() }),
      options: z.object({ verbosity: z.number().meta({ count: true }) }),
      alias: { verbosity: "v" }
    }
    expect(Positionals.unconsumed(counted, ["//a", "//b", "-v", "-v"])).toEqual(["//b"])
  })
})

describe("the served CLI", () => {
  it("refuses a surplus pattern before reading the workspace", async () => {
    const { exitCode, output } = await serve(root, ["graph", "//a/...", "//b/..."])
    expect(exitCode).toBe(1)
    expect(output).toContain("UNEXPECTED_ARGUMENT")
    expect(output).not.toContain("WORKSPACE")
  })

  it("parses global flags ahead of the command", async () => {
    const { exitCode, output } = await serve(root, ["--silent", "info", "extra"])
    expect(exitCode).toBe(1)
    expect(output).toContain("Unexpected argument: extra")
  })
})

describe("HTTP command requests", () => {
  it("accepts named parameters without a served argv and runs the guarded command once", async () => {
    let calls = 0
    const cli = Positionals.guard(
      Incur.create("probe").command("ping", {
        options: z.object({ value: z.string() }),
        run: (context) => {
          calls++
          return { echoed: context.options.value }
        }
      })
    )
    const response = await cli.fetch(new Request("http://localhost/ping?value=hello"))
    expect(response.status).toBe(200)
    expect(await response.json()).toMatchObject({ ok: true, data: { echoed: "hello" } })
    expect(calls).toBe(1)
  })
})
