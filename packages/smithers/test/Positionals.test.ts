/**
 * Every `smthrs` command either consumes each positional it receives or
 * refuses the invocation; none silently drops one (#2109).
 */
import { Cli as Incur, z } from "incur"
import { describe, expect, it } from "vitest"
import { makeCli } from "../src/Cli.ts"

type Entry = {
  readonly _alias?: true
  readonly _group?: true
  readonly commands?: ReadonlyMap<string, Entry>
  readonly args?: z.ZodObject<any>
  run?: (context: { readonly args: Record<string, unknown> }) => unknown
}

/** Every runnable command of an incur registry, by its path. */
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

const silent = { write: () => {}, isTTY: false, columns: undefined }

describe("surplus positionals", () => {
  const cli = makeCli({ environment: {}, stdout: silent, stderr: silent })
  const commands = leaves(Incur.toCommands.get(cli as never) as unknown as ReadonlyMap<string, Entry>)

  it("enumerates the unified command tree", () => {
    expect(commands.map(([path]) => path.join(" "))).toEqual(
      expect.arrayContaining(["clean", "doctor", "mcp add", "runs logs", "flow start", "tui"])
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
      const values = fields(entry).map((field) => field instanceof z.ZodEnum ? String(field.options[0]) : "value")
      await cli.serve([...path, ...values, "surplus", "--format", "json"], {
        env: {},
        stdout: (text) => {
          output += text
        },
        exit: (code) => {
          exitCode = code
        }
      })
      if (fields(entry).at(-1) instanceof z.ZodArray) {
        expect(Object.values(received[0] ?? {}).flat(), output).toContain("surplus")
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
