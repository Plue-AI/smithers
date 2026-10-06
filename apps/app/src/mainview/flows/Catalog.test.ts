import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import appendixA from "./fixtures/AppendixA.json"
import { generateCatalog, generateSkill } from "../../../../../scripts/catalog-mvp"
import { lintText } from "../cards/productWords"
import { disclosedToAgent, visible } from "./registry"

const rows = generateCatalog()
describe("C-CAT-01 literal Appendix A contract", () => {
  test("each shipped surface is declared exactly once with its reviewed actor policy", () => {
    expect(rows.filter(row => row.visibility === "core" || row.visibility === "advanced").map(row => row.name).sort())
      .toEqual(appendixA.map(row => row.name).sort())
    for (const expected of appendixA) {
      const actual = rows.filter(row => row.name === expected.name)
      expect(actual).toHaveLength(1)
      expect(actual[0]).toMatchObject({ slash: expected.slash, cli: expected.cli, visibility: expected.visibility,
        actors: expected.actors, minimumRole: expected.minimumRole, agent: expected.agent })
    }
  })
  test("catalog regeneration is byte-for-byte stable", () => {
    expect(readFileSync(new URL("../../../../../catalog.mvp.json", import.meta.url), "utf8"))
      .toBe(JSON.stringify({ version: 1, operations: rows }, null, 2) + "\n")
  })
  test("hidden entries cannot opt into model disclosure", () => {
    expect(disclosedToAgent({ summary: "Hidden", visibility: "hidden", discloseToAgent: true, agent: "run" })).toBe(false)
    expect(disclosedToAgent({ summary: "Person", visibility: "in-card", agent: "never" })).toBe(false)
    expect(disclosedToAgent({ summary: "Control", visibility: "in-card", agent: "confirm", actors: ["person", "app_agent"] })).toBe(true)
    expect(visible([{ name: "control", summary: "Control", visibility: "in-card" }, { name: "read", summary: "Read", visibility: "core", hidden: true }]).map(row => row.name)).toEqual(["read"])
  })
})
describe("C-CAT-03 generated Smithers skill", () => {
  test("the committed Commands section is generated and uses product words", () => {
    const skill = readFileSync(new URL("../../../../../packages/smithers/skills/smithers/SKILL.md", import.meta.url), "utf8")
    expect("## Commands\n" + skill.split("## Commands\n")[1]).toBe(generateSkill(rows))
    for (const row of rows.filter(row => row.cli !== null)) expect(lintText(row.summary)).toEqual([])
    expect(generateSkill(rows)).not.toContain("smthrs settings")
    expect(generateSkill(rows)).not.toContain("smthrs members")
    expect(generateSkill(rows)).not.toContain("smthrs secrets")
    expect(generateSkill(rows)).toContain("smthrs search")
    expect(generateSkill(rows)).toContain("smthrs github")
    expect(generateSkill(rows)).toContain("smthrs merge` — confirm; waits for the person's confirmation")
  })
})
