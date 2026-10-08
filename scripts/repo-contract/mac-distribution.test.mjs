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
test("retired lifecycle scripts are absent and no active consumer runs them", () => {
  // T-INS-07 ported their guards to the backend; `smthrs host` owns the lifecycle.
  for (const name of ["backup.sh", "restore.sh", "upgrade.sh", "lib.sh", "distribution_test.go"]) assert.equal(existsSync(`${root}/distribution/${name}`), false, name)
  const patterns = ["distribution/" + "lib.sh", "distribution/" + "backup.sh", "distribution/" + "restore.sh", "distribution/" + "upgrade.sh", "SMITHERS_" + "BACKUP_ROOT", "SMITHERS_LIB" + "="]
  const result = spawnSync("rg", ["-n", "-F", ...patterns.flatMap(pattern => ["-e", pattern]), ".github", "scripts", "apps", "packages", "distribution", "--glob", "!*.lock"], { cwd: root, encoding: "utf8" })
  assert.equal(result.status, 1, result.stdout + result.stderr)
})
test("the surviving build test and command executor remain", () => {
  assert.ok(existsSync(`${root}/distribution/backend_build_test.go`))
  assert.ok(existsSync(`${root}/apps/app/scripts/mode-matrix/command-execution.ts`))
})
