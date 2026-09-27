import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import { Effect } from "effect"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, expect, test } from "vitest"
import * as Profile from "../src/internal/RoleProfile.ts"
import * as NodeControl from "../src/NodeControl.ts"

const run = <A, E>(effect: Effect.Effect<A, E, import("effect/FileSystem").FileSystem>) =>
  Effect.runPromise(effect.pipe(Effect.provide(NodeFileSystem.layer)))
const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))
const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "role-profile-"))
  roots.push(root)
  mkdirSync(join(root, "Org/Skills/voice"), { recursive: true })
  mkdirSync(join(root, "flows/assistant"), { recursive: true })
  writeFileSync(join(root, "Org/Common Operating Instructions.md"), "Shared rules")
  writeFileSync(join(root, "Org/Skills/voice/SKILL.md"), "---\nname: voice\n---\nSpeak plainly")
  const profile = join(root, "flows/assistant/flow.mdx")
  writeFileSync(
    profile,
    "---\ndescription: Assistant\nmodel: openai:gpt-6-astra\nmetadata:\n  name: Assistant\n  skills: voice\n---\nCharter"
  )
  return { root, profile }
}
// The character evals compose through the same RoleProfile.compose
// (evals/agent/character/profile.ts), so matching it here is matching them.
test("production uses the shared eval composition and its exact digest", async () => {
  const { root } = fixture()
  const expected = Profile.compose({
    org: join(root, "Org"),
    role: "assistant",
    body: "Charter",
    meta: { description: "Assistant", model: "openai:gpt-6-astra", metadata: { name: "Assistant", skills: "voice" } }
  })
  const actual = await run(Profile.forRun(
    root,
    {
      name: "assistant",
      frontmatter: { metadata: { name: "Assistant", skills: "voice" }, model: "openai:gpt-6-astra" }
    },
    "Charter",
    ["fs:read:Org/Common Operating Instructions.md", "fs:read:Org/Skills/**"]
  ))
  expect(actual).toEqual(expected.system)
  expect(actual.at(-1)).toBe("# Skill: voice\n\nSpeak plainly")
})
test("ordinary prompt flows keep their existing teaching", async () => {
  expect(await run(Profile.forRun("/unused", { name: "hello", frontmatter: {} }, "Say hello", []))).toEqual([])
})
test("refuses missing grants and skill traversal before composing", async () => {
  const { root } = fixture()
  const descriptor = { name: "assistant", frontmatter: { metadata: { skills: "voice" } } }
  await expect(run(Profile.forRun(root, descriptor, "Charter", ["fs:read:Org/Common Operating Instructions.md"])))
    .rejects.toThrow("not granted")
  await expect(
    run(
      Profile.forRun(root, { ...descriptor, frontmatter: { metadata: { skills: "../../private" } } }, "Charter", [
        "fs:read:Org/Common Operating Instructions.md",
        "fs:read:**"
      ])
    )
  ).rejects.toThrow("skill name")
})
test("refuses a granted file whose symlink escapes the checkout", async () => {
  const { root } = fixture()
  const other = fixture()
  const skill = join(root, "Org/Skills/voice/SKILL.md")
  rmSync(skill)
  symlinkSync(other.profile, skill)
  await expect(
    run(
      Profile.forRun(root, { name: "assistant", frontmatter: { metadata: { skills: "voice" } } }, "Charter", [
        "fs:read:Org/Common Operating Instructions.md",
        "fs:read:Org/Skills/**"
      ])
    )
  ).rejects.toThrow("outside")
})

test("the native guarded filesystem can read the declared profile", async () => {
  const { root } = fixture()
  const instructions = await Effect.runPromise(
    Profile.forRun(
      root,
      {
        name: "assistant",
        frontmatter: { metadata: { name: "Assistant", skills: "voice" } }
      },
      "Charter",
      ["fs:read:Org/Common Operating Instructions.md", "fs:read:Org/Skills/**"]
    ).pipe(
      Effect.provide(NodeControl.layerGuardedPlatform(root))
    )
  )
  expect(instructions).toContain("Shared rules")
  expect(instructions.at(-1)).toBe("# Skill: voice\n\nSpeak plainly")
})

test("a routine with shared instructions and no skills uses the same composition", async () => {
  const { root } = fixture()
  const instructions = await run(Profile.forRun(
    root,
    {
      name: "digest",
      frontmatter: { metadata: { name: "Daily digest" } }
    },
    "Summarize",
    ["fs:read:Org/Common Operating Instructions.md"]
  ))
  expect(instructions).toContain("Shared rules")
  expect(instructions.at(-1)).toBe("# Role: Daily digest (digest)\n\nSummarize")
})
