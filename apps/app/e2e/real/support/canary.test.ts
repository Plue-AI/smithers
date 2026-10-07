import { expect, test } from "bun:test"
import { readFileSync, readdirSync } from "node:fs"
import { CANARY_README, FIRST_TODO_PROMPT, FIRST_TODO_README } from "./canary"

test("reviewed canary source agrees with literal activation precondition", () => {
  const root = new URL("../fixtures/canary/", import.meta.url)
  expect(readFileSync(new URL("README.md", root), "utf8")).toBe(CANARY_README)
  expect(JSON.parse(readFileSync(new URL("package.json", root), "utf8")).scripts.test).toBe("node --test")
  expect(readdirSync(root)).not.toContain(".smithers")
  expect(FIRST_TODO_README).toBe(CANARY_README + "\nThe first Smithers TODO was merged.\n")
  expect(FIRST_TODO_PROMPT).toContain("Change no other file")
})
