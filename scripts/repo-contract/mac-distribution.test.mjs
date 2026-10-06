import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync } from "node:fs"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
const root = fileURLToPath(new URL("../../", import.meta.url))
const removed = ["distribution/" + "Dockerfile", ...["entrypoint.sh", "publish-image.sh", "publish-image.test.mjs", "test-image.sh"].map(name => `distribution/${name}`),
  "apps/app/scripts/mode-matrix/" + "docker-web-" + "selfhost.ts", "apps/app/scripts/mode-matrix/" + "docker-web-" + "selfhost.test.ts"]
test("removed image files are absent", () => {
  for (const file of removed) assert.equal(existsSync(`${root}/${file}`), false, file)
})
test("active consumers contain no deleted image or launcher references", () => {
  const patterns = ["distribution/" + "Dockerfile", "ghcr.io/smithersai/" + "smithers", "docker-web-" + "selfhost", "SMITHERS_MODE_MATRIX_" + "IMAGE"]
  const result = spawnSync("rg", ["-n", "-F", ...patterns.flatMap(pattern => ["-e", pattern]), ".github", "scripts", "apps", "packages", "distribution", "PACKAGE.ts", ".smithers/target-index.json", "--glob", "!*.lock"], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 1, result.stdout + result.stderr)
})
test("lifecycle port sources and surviving command executor remain", () => {
  for (const name of ["backup.sh", "restore.sh", "upgrade.sh", "lib.sh", "distribution_test.go", "backend_build_test.go"]) assert.ok(existsSync(`${root}/distribution/${name}`), name)
  assert.ok(existsSync(`${root}/apps/app/scripts/mode-matrix/command-execution.ts`))
})
