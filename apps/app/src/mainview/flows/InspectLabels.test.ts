import { describe, expect, test } from "bun:test"
import { generateActionRenderings } from "../../../../../scripts/catalog-mvp"

describe("Appendix C rendering generation", () => {
  test("only retained action rows supply labels; bookkeeping stays distinct", () => {
    const rows = [
      "| `coding/edit-atom` | action | source.ts:1 | edit | Machine | Keep | Edited the files |",
      '| `agent/run` | flow | source.ts:2 | turn | Machine | Keep | Inspect: "Worked a turn" |',
      "| `<seal-step>` | action | source.ts:3 | seal | Machine | Keep | - |",
      "| `<cell-call:flow>` | action | source.ts:4 | tool | Machine | Keep | Each tool call renders per B.3 |",
      "| `removed` | action | source.ts:5 | old | Machine | Cut | - |",
      "| `later` | action | source.ts:6 | next | Machine | Defer §14 | - |"
    ].join("\n")
    expect(generateActionRenderings(rows)).toEqual({
      "coding/edit-atom": "Edited the files", "agent/run": "Worked a turn", "<seal-step>": null
    })
    expect(() => generateActionRenderings(rows + "\n" + rows.split("\n")[0])).toThrow("Duplicate Inspect rendering")
  })
})
