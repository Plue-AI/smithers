const { test } = require("node:test")
const assert = require("node:assert/strict")
const { readFileSync } = require("node:fs")

test("repository has its reviewed title", () => {
  assert.ok(readFileSync("README.md", "utf8").startsWith("# Smithers MVP canary\n"))
})
