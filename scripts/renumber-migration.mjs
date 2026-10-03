#!/usr/bin/env node
// Landing only: verify main facts before any write; SQL is data, never executed.
import { spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative, resolve } from "node:path"

if (process.getuid?.() === 0 || process.geteuid?.() === 0) throw new Error("Migration generation must run as an unprivileged machine user")
if (process.argv.length !== 3) throw new Error("Usage: node scripts/renumber-migration.mjs <file>")
let root = realpathSync(process.cwd())
while (!existsSync(join(root, ".jj")) && !existsSync(join(root, ".git"))) {
  const parent = dirname(root)
  if (parent === root) throw new Error("Cannot establish origin/main: no checkout")
  root = parent
}
const run = (bin, args, capture = true) => {
  const result = spawnSync(bin, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit" })
  if (result.error || result.status !== 0) throw new Error(`${bin} ${args.join(" ")} failed: ${result.error ?? result.stderr ?? result.status}`)
  return result.stdout?.trim() ?? ""
}
const product = "packages/backend/db/product"
const directory = `${product}/migrations`
const file = relative(root, realpathSync(resolve(process.argv[2]))).replaceAll("\\", "/")
const name = file.slice(directory.length + 1)
if (file !== `${directory}/${name}` || !/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.test(name)) throw new Error("Expected a product migration file")
const jj = existsSync(join(root, ".jj"))
const revisionName = jj ? "main@origin" : "refs/remotes/origin/main"
// A missing/unreadable remote revision is a refusal, never evidence of absence.
const revision = run(jj ? "jj" : "git", jj ? ["log", "-r", revisionName, "--no-graph", "-T", "commit_id"] : ["show-ref", "--verify", "--hash", revisionName])
if (!/^[0-9a-f]{40}$/.test(revision)) throw new Error("Cannot establish origin/main commit")
const landed = run(jj ? "jj" : "git", jj ? ["file", "list", "-r", revision, directory] : ["ls-tree", "-r", "--name-only", revision, "--", directory]).split("\n").filter(Boolean)
if (landed.includes(file)) throw new Error(`Refusing to renumber landed migration ${file}`)
for (const path of landed) {
  const original = spawnSync(jj ? "jj" : "git", jj ? ["file", "show", "-r", revision, path] : ["show", `${revision}:${path}`], { cwd: root })
  if (original.status !== 0 || !existsSync(join(root, path)) || !readFileSync(join(root, path)).equals(original.stdout)) throw new Error(`Landed migration changed: ${path}`)
}
const others = readdirSync(join(root, directory)).filter(path => path !== name)
if (others.some(path => !/^\d{4}_[a-z0-9]+(?:_[a-z0-9]+)*\.sql$/.test(path))) throw new Error("Invalid migration inventory")
const numbers = others.map(path => Number(path.slice(0, 4))).sort((a, b) => a - b)
if (numbers.some((n, i) => n !== i + 1)) throw new Error("Remaining migration inventory is not dense and unique")
const number = numbers.length + 1
if (number > 9999) throw new Error("Migration number exhausted")
const newName = `${String(number).padStart(4, "0")}${name.slice(4)}`
const registryPath = join(root, product, "migrate.go")
const registry = readFileSync(registryPath, "utf8")
const escaped = name.replaceAll(".", "\\.")
const entry = new RegExp(`\\{\\s*\\d+\\s*,\\s*"migrations/${escaped}"\\s*\\},`, "g")
if ([...registry.matchAll(entry)].length !== 1) throw new Error("Expected exactly one unlanded registry entry")
const updated = registry.replace(entry, "").replace(/(var migrationRegistry = \[\]migrationSpec\{[\s\S]*?)(\n\})/, `$1\n\t{${number}, "migrations/${newName}"},$2`)
if (updated === registry) throw new Error("Cannot locate migration registry")
const csvPath = join(root, "packages/backend/db/ownership.csv")
const manifest = readFileSync(csvPath, "utf8")
const ticket = /^-- Ticket: (T-[A-Z0-9]+-[0-9]+[a-z]?)\s*$/m.exec(readFileSync(join(root, file), "utf8"))?.[1]
// §21.3: one ticket's reservations land together. The gate checks ticket
// ownership before conversion and installed-schema parity after conversion.
// RFC 4180 fields, including quoted statuses, commas, escaped quotes and CRLF.
const rows = []
let row = [], field = "", quoted = false
for (let i = 0; i < manifest.length; i++) {
  const c = manifest[i]
  if (c === '"') {
    if (quoted && manifest[i + 1] === '"') { field += '"'; i++ }
    else quoted = !quoted
  } else if (!quoted && (c === "," || c === "\n")) {
    row.push(field.replace(/\r$/, "")); field = ""
    if (c === "\n") { rows.push(row); row = [] }
  } else field += c
}
if (quoted) throw new Error("Unterminated CSV field")
if (field || row.length) { row.push(field); rows.push(row) }
for (const r of rows) {
  if (ticket && r[2]?.startsWith(`planned:${ticket} owner:`)) r[2] = r[2].replace("planned:", "installed:")
}
const converted = rows.map(r => r.map(f => /[",\r\n]/.test(f) ? `"${f.replaceAll('"', '\"\"')}"` : f).join(",")).join("\n") + "\n"
// Validate the pinned tool before generating from branch SQL/config.
const sqlc = existsSync(join(root,".backend-sqlc/sqlc")) ? join(root,".backend-sqlc/sqlc") : "sqlc"
try {
  if (run(sqlc, ["version"]) !== "v1.30.0") throw new Error("version mismatch")
} catch (cause) { throw new Error("sqlc v1.30.0 is required; build //:backendSQLC", { cause }) }
// Roll back every affected tree, including new sqlc files, on any refusal.
const backup = mkdtempSync(join(tmpdir(), "migration-rollback-"))
const paths = [product, "packages/backend/db/ownership.csv", "packages/backend/internal/db"]
const present = paths.map(p => existsSync(join(root,p)))
for (let i = 0; i < paths.length; i++) if (present[i]) cpSync(join(root,paths[i]),join(backup,String(i)),{recursive:true})
try {
  if (newName !== name) renameSync(join(root, file), join(root, directory, newName))
  writeFileSync(registryPath, updated)
  run("gofmt", ["-w", `${product}/migrate.go`], false)
  const gate = ["test", "-run", "TestMigrationGate|TestMigrationRegistry", "./packages/backend/db/product/"]
  run("go", gate, false)
  writeFileSync(csvPath, converted)
  run(sqlc, ["generate", "-f", `${product}/sqlc.yaml`], false)
  run("go", gate, false)
  console.log(`${directory}/${newName}`)
} catch (error) {
  for (let i = 0; i < paths.length; i++) {
    rmSync(join(root,paths[i]),{recursive:true,force:true})
    if (present[i]) cpSync(join(backup,String(i)),join(root,paths[i]),{recursive:true})
  }
  throw error
} finally { rmSync(backup,{recursive:true,force:true}) }
