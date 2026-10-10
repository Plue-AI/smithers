import { describe, expect, it } from "@effect/vitest"
import { readFileSync } from "node:fs"

const read = (path: string): string => readFileSync(new URL(path, import.meta.url), "utf8")

describe("journal documentation contracts", () => {
  for (const guide of ["two-channels", "idempotency"]) {
    it(`${guide} distinguishes dedup lookup from cold allocation reads`, () => {
      const prose = read(`../docs/concepts/${guide}.md`).replace(/\s+/g, " ")
      expect(prose).not.toMatch(/issues no read|with no read at all/)
      expect(prose).toMatch(/warmed/)
      expect(prose).toContain("MAX(seq) + 1")
      expect(prose).toContain("MAX(source_seq) + 1")
    })
  }

  // Troubleshooting is the package's one home for each code's cause and fix.
  it("distinguishes compaction refusals from compacted read recovery", () => {
    const page = read("../docs/troubleshooting.md")
    const entry = (code: string): { readonly happened: string; readonly change: string } => {
      const section = page.split(`\n## ${code}\n`)[1]!.split("\n## ")[0]!.replace(/\s+/g, " ")
      const happened = section.split("**What happened.**")[1]!.split("**What to change.**")[0]!
      return { happened, change: section.split("**What to change.**")[1]! }
    }
    const reader = entry("reader_behind")
    expect(reader.happened).toMatch(/^ `compact` refused/)
    expect(reader.change).toMatch(/catch up.*(?:drop|clos).*(?:again|retry)/i)
    expect(reader.change).not.toContain("checkpointSeq")
    const checkpoint = entry("checkpoint_invalid")
    expect(checkpoint.happened).toMatch(/`checkpoint` was given a `seq` that names no committed entry/)
    expect(checkpoint.happened).toMatch(/`compact` found no checkpoint/)
    expect(checkpoint.happened).toMatch(/In the second case the failure carries the floor in `checkpointSeq`/)
    expect(checkpoint.change).not.toMatch(/resume/i)
    expect(entry("compacted").change).toMatch(/latestCheckpoint.*state.*afterSequence/)
  })

  it("lists every Service operation, including optional members", () => {
    const service = read("../src/Journal.ts").split("export interface Service {")[1]!.split("\n}")[0]!
    const members = [...service.matchAll(/^  readonly (\w+)(\?)?:/gm)]
      .map((match) => `${match[1]}${match[2] ?? ""}`)
    const reference = read("../docs/api.md")
    const operations = reference.split("### Operations\n")[1]!.split("\n\n`owner`")[0]!
    const documented = [...operations.matchAll(/^\| `(\w+\??)`\s*\|/gm)].map((match) => match[1])
    expect(documented.sort()).toEqual(members.sort())
    for (const text of [reference, read("../README.md")]) {
      for (const count of text.matchAll(/its (\d+) operations/g)) {
        expect(Number(count[1])).toBe(members.filter((member) => !member.endsWith("?")).length)
      }
    }
  })
})
