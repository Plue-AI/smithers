// C-PRC-02: real local checkouts, production gate and pinned sqlc. No DB.
import { spawnSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { join, resolve } from "node:path"
import assert from "node:assert/strict"
const root = resolve(import.meta.dirname, "..")
export const fixtureEnv = { ...process.env, PATH: `${join(root,".backend-sqlc")}:${process.env.PATH}` }
if (existsSync(join(root,".backend-go-modcache"))) fixtureEnv.GOMODCACHE = join(root,".backend-go-modcache")
for (const key of Object.keys(fixtureEnv)) {
  if (/token|secret|password|credential|database_url|ssh_auth_sock/i.test(key) || key === "SMITHERS_REQUIRE_DATABASE_TESTS") delete fixtureEnv[key]
}
export function command(cwd, bin, args, env = fixtureEnv) {
  return spawnSync(bin, args, { cwd, encoding: "utf8", env })
}
export function ok(cwd, bin, args, env) {
  const r = command(cwd, bin, args, env)
  assert.equal(r.status, 0, r.stdout + r.stderr)
  return r.stdout.trim()
}
export function schemaFixture(directory) {
  const product = join(directory, "packages/backend/db/product")
  mkdirSync(join(product, "migrations"), { recursive: true })
  mkdirSync(join(product, "queries"))
  for (const f of ["migration_gate_test.go", "migration_registry_test.go"]) copyFileSync(join(root, "packages/backend/db/product", f), join(product, f))
  let migration = readFileSync(join(root, "packages/backend/db/product/migrate.go"), "utf8")
  migration = migration.replace(/var migrationRegistry = \[\]migrationSpec\{[\s\S]*?\n\}/, 'var migrationRegistry = []migrationSpec{\n {BaselineVersion, "migrations/0001_base.sql"},\n}')
  writeFileSync(join(product, "migrate.go"), migration)
  copyFileSync(join(root, "go.mod"), join(directory, "go.mod"))
  copyFileSync(join(root, "go.sum"), join(directory, "go.sum"))
  writeFileSync(join(product, "migrations/0001_base.sql"), "CREATE TABLE base (id bigint PRIMARY KEY);\n")
  writeFileSync(join(directory, "packages/backend/db/ownership.csv"), "table,target_owner,status\nbase,product,installed\n")
  writeFileSync(join(product, "queries/base.sql"), "-- name: Base :many\nSELECT id FROM base;\n")
  writeFileSync(join(product, "sqlc.yaml"), 'version: "2"\nsql:\n - engine: postgresql\n   schema: migrations\n   queries: queries\n   gen:\n    go:\n     package: db\n     out: ../../internal/db\n')
}
export function checkout(directory, vcs) {
  ok(directory, "git", ["init", "-b", "main"])
  ok(directory, "git", ["config", "user.name", "Migration fixture"])
  ok(directory, "git", ["config", "user.email", "fixture@example.test"])
  ok(directory, "git", ["add", "."])
  ok(directory, "git", ["commit", "-m", "fixture baseline"])
  ok(directory, "git", ["remote", "add", "origin", directory])
  ok(directory, "git", ["fetch", "origin"])
  if (vcs === "jj") {
    ok(directory, "jj", ["git", "init", "--colocate"])
    ok(directory, "jj", ["config", "set", "--repo", "user.name", "Migration fixture"])
    ok(directory, "jj", ["config", "set", "--repo", "user.email", "fixture@example.test"])
  }
}
export function pending(directory, name = "0999_widget.sql") {
  const product = join(directory, "packages/backend/db/product")
  writeFileSync(join(product, "migrations", name), "-- Ticket: T-FIX-01\nCREATE TABLE widget (id bigint PRIMARY KEY);\n")
  const path = join(product, "migrate.go")
  writeFileSync(path, readFileSync(path, "utf8").replace(' {BaselineVersion, "migrations/0001_base.sql"},', ` {BaselineVersion, "migrations/0001_base.sql"},\n {${Number(name.slice(0, 4))}, "migrations/${name}"},`))
  writeFileSync(join(directory, "packages/backend/db/ownership.csv"), "table,target_owner,status\nbase,product,installed\nwidget,product,planned:T-FIX-01 owner:smithers-8a\n")
}

export function recordEvidence(name, data) {
  const directory=process.env.SMITHERS_CHECK_EVIDENCE
  if (!directory) return
  mkdirSync(directory,{recursive:true})
  writeFileSync(join(directory,name.replaceAll(/[^A-Za-z0-9_-]/g,"_")+".json"), JSON.stringify(data,null,2)+"\n")
}
