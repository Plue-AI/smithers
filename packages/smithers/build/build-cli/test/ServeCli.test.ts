import * as Path from "node:path"
import { afterEach, expect, it } from "vitest"
import { serve } from "./helpers/ServeCli.ts"

const original = process.env["PATH"]
afterEach(() => {
  process.env["PATH"] = original
})

it("anchors the relative PATH entry `pnpm exec` prepends, as the CLI entry does", async () => {
  process.env["PATH"] = `./node_modules/.bin${Path.delimiter}${original ?? ""}`
  await serve(process.cwd(), ["--help"])
  const entries = (process.env["PATH"] ?? "").split(Path.delimiter)
  expect(entries[0]).toBe(Path.resolve(process.cwd(), "node_modules/.bin"))
  expect(entries.every((entry) => Path.isAbsolute(entry))).toBe(true)
})
