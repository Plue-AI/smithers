import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as Profile from "./profile.ts"
import * as Suite from "./suite.ts"

const example = new URL("./example", import.meta.url).pathname

describe("profile", () => {
  test("composes the suite's flow.mdx: model, effort, name and skills from its frontmatter", () => {
    const suite = Suite.load(example)
    expect(suite.profile).toBe(join(example, "flows/assistant/flow.mdx"))
    const composed = Profile.compose({ org: suite.org, role: suite.role, profile: suite.profile })
    expect(composed.name).toBe("Assistant")
    expect(composed.seat).toBe("openai:gpt-6-astra")
    expect(composed.effort).toBe("low")
    expect(composed.skills).toEqual(["voice"])
    expect(composed.system[2]).toStartWith("# Role: Assistant (assistant)\n\n## Objective")
    expect(composed.system.at(-1)).toStartWith("# Skill: voice")
  })

  test("reads a comma-separated skills list in order, and names a listed skill that is missing", () => {
    const dir = mkdtempSync(join(tmpdir(), "character-profile-"))
    for (const skill of ["first", "second"]) {
      mkdirSync(join(dir, "Skills", skill), { recursive: true })
      writeFileSync(join(dir, "Skills", skill, "SKILL.md"), `---\nname: ${skill}\n---\n\n${skill} body\n`)
    }
    const profile = join(dir, "flow.mdx")
    writeFileSync(profile, "---\ndescription: d\nmodel: openai:gpt-6-sol\nmetadata:\n  name: Two\n  skills: \"second, first\"\n---\n\nCharter\n")
    const composed = Profile.compose({ org: dir, role: "two", profile })
    expect(composed.skills).toEqual(["second", "first"])
    expect(composed.seat).toBe("openai:gpt-6-sol")
    expect(composed.system.slice(-2)).toEqual(["# Skill: second\n\nsecond body", "# Skill: first\n\nfirst body"])

    writeFileSync(profile, "---\ndescription: d\nmetadata:\n  skills: absent\n---\n\nCharter\n")
    expect(() => Profile.compose({ org: dir, role: "two", profile })).toThrow("skill absent is listed")
  })

  test("a suite without a profile does not load", () => {
    const dir = mkdtempSync(join(tmpdir(), "character-suite-"))
    mkdirSync(join(dir, "cases"))
    writeFileSync(join(dir, "suite.yaml"), "name: s\nrole: r\norg: .\nworld: .\n")
    expect(() => Suite.load(dir)).toThrow("profile must name the role's flow.mdx")
  })
})
