import test from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
const script = fileURLToPath(new URL("./check-deployment-branches.mjs", import.meta.url))
const fixture = (t, files = {}) => {
  const root = mkdtempSync(join(tmpdir(), "deployment-branches-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const path of ["packages/backend", "apps/app/src", "docs/api/openapi"]) mkdirSync(join(root, path), { recursive: true })
  for (const [path, text] of Object.entries({ "docs/api/openapi.yaml": "paths: {}\n", ...files })) {
    mkdirSync(join(root, path, ".."), { recursive: true }); writeFileSync(join(root, path), text)
  }
  return root
}
const run = (root) => spawnSync(process.execPath, [script, root], { encoding: "utf8" })
const mode = "if config.IsSingleOwner(cfg.Auth) {}\n"
test("CLI accepts limits and ignores test files and comments", (t) => {
  const files = {
    "packages/backend/internal/compose/main.go": mode.repeat(141) + "// config.IsSingleOwner(cfg.Auth)\n/* topology.hosted() */\n",
    "packages/backend/new_test.go": mode.repeat(200),
    "apps/app/src/check.ts": 'bootstrap.host === "cloud";\n'.repeat(8) + 'bootstrap.capabilities.includes("install");\n'.repeat(8),
    "apps/app/src/check.test.ts": 'host === "cloud";\n'.repeat(99)
  }
  for (let i = 0; i < 8; i++) files[`packages/backend/internal/services/import${i}.go`] = 'import "github.com/smithersai/smithers/microsandbox"\n'
  const result = run(fixture(t, files)); assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { errors: [], go: 141, imports: 8, app: 16 })
})
for (const [name, files, diagnostic] of [
  ["Go overflow counts two checks on one line", { "packages/backend/internal/compose/main.go": mode.repeat(140) + "config.IsSingleOwner(a) || config.IsMultitenant(b)" }, "142 exceeds 141"],
  ["raw mode check in new Go file", { "packages/backend/internal/new.go": 'if cfg.Auth.Mode == "selfhost" {}' }, "15-file allowlist"],
  ["new Go file", { "packages/backend/internal/new.go": "topology.hosted()" }, "15-file allowlist"],
  ["ninth service import", Object.fromEntries(Array.from({ length: 9 }, (_, i) => [`packages/backend/internal/services/${i}.go`, 'import msb "example/microsandbox"'])), "9 exceeds 8"],
  ["app overflow", { "apps/app/src/check.tsx": 'bootstrap.host === "cloud";'.repeat(17) }, "17 exceeds 16"],
  ["new product operation restriction", { "docs/api/openapi/new.yaml": "paths:\n  /todos/new:\n    post:\n      x-composition: install\n" }, "gains x-composition"],
  ["new product path restriction in bundle", { "docs/api/openapi.yaml": "paths:\n  /new:\n    x-composition: plue\n" }, "gains x-composition"]
]) test(`CLI refuses ${name}`, (t) => {
  const result = run(fixture(t, files)); assert.equal(result.status, 1, result.stderr); assert.ok(result.stdout.includes(diagnostic), result.stdout)
})
test("existing restrictions may shrink; operator restrictions remain allowed", (t) => {
  const row = JSON.parse(readFileSync(new URL("./deployment-composition-baseline.json", import.meta.url)))[0]
  const [path, method] = row.split("#")
  const restriction = method === "path" ? "    x-composition: install" : `    ${method}:\n      x-composition: install`
  assert.equal(run(fixture(t, { "docs/api/openapi/sample.yaml": `paths:\n  ${path}:\n${restriction}\n  /api/admin/new:\n    get:\n      x-composition: plue\n` })).status, 0)
  assert.equal(run(fixture(t)).status, 0)
})
test("missing inputs fail closed", (t) => {
  const root = fixture(t); rmSync(join(root, "packages/backend"), { recursive: true })
  assert.equal(run(root).status, 2)
})
test("repository passes the CLI gate", () => {
  const result = run(fileURLToPath(new URL("..", import.meta.url)))
  assert.equal(result.status, 0, result.stdout + result.stderr)
})
