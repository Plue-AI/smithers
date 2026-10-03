import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { test } from "node:test"
import { checkout, command, fixtureEnv, ok, pending, recordEvidence, schemaFixture } from "./migration-fixture.mjs"
const commit = resolve(import.meta.dirname, "commit.mjs")
const renumber = resolve(import.meta.dirname, "renumber-migration.mjs")
// Only publication is intercepted. All local VCS, Go tests, gofmt and sqlc
// commands execute their real dependencies. Fixtures carry no credentials.
for (const vcs of ["git", "jj"]) {
 for (const defect of ["clean", "duplicate", "gap"]) {
  test(`${vcs}: production push gate ${defect}`, () => {
   const dir = mkdtempSync(join(tmpdir(), "migration-push-"))
   const tools = mkdtempSync(join(tmpdir(), "migration-tools-"))
   try {
    schemaFixture(dir)
    mkdirSync(join(dir, "scripts"))
    copyFileSync(resolve(import.meta.dirname, "check-tracked-hygiene.mjs"), join(dir, "scripts/check-tracked-hygiene.mjs"))
    checkout(dir, vcs)
    const log = join(tools, "commands.jsonl")
    const uidLog = join(tools, "uids.jsonl")
    for (const bin of ["git", "jj", "go", "gofmt", "sqlc"]) {
     const real = spawnSync("/bin/sh", ["-c", `command -v ${bin}`], { encoding: "utf8", env: fixtureEnv }).stdout.trim()
     assert.ok(real, `${bin} required${bin === "sqlc" ? " (v1.30.0; run //:backendSQLC)" : ""}`)
     writeFileSync(join(tools, bin), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);\nappendFileSync(${JSON.stringify(uidLog)}, JSON.stringify({command:${JSON.stringify(bin)},uid:process.getuid(),euid:process.geteuid()})+'\\n');\nappendFileSync(${JSON.stringify(log)}, JSON.stringify([${JSON.stringify(bin)},...args])+'\\n');\nif (${JSON.stringify(bin)}==='git' && args[0]==='push' || ${JSON.stringify(bin)}==='jj' && args[0]==='git' && args[1]==='push') process.exit(0);\nconst r=spawnSync(${JSON.stringify(real)},args,{stdio:'inherit'});\nprocess.exit(r.status??1);\n`, { mode: 0o755 })
    }
    for (const bin of ["postgres", "psql", "initdb", "pg_ctl"]) {
      writeFileSync(join(tools,bin), `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nappendFileSync(${JSON.stringify(log)},JSON.stringify([${JSON.stringify(bin)}])+'\\n');\nprocess.exit(99);\n`,{mode:0o755})
    }
    const env = { ...fixtureEnv, PATH: `${tools}:${fixtureEnv.PATH}`, SMITHERS_POSTGRES_TEST_BIN: tools }
    for (const key of ["DATABASE_URL", "SMITHERS_TEST_DATABASE_URL", "SMITHERS_REQUIRE_DATABASE_TESTS"]) delete env[key]
    if (defect === "clean") {
     pending(dir)
     ok(dir, process.execPath, [renumber, "packages/backend/db/product/migrations/0999_widget.sql"], env)
    } else {
     pending(dir, defect === "gap" ? "0003_widget.sql" : "0001_widget.sql")
    }
    const result = command(dir, process.execPath, [commit, "--push", "-m", "fixture landing"], env)
    const commands = readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line))
    const uids=readFileSync(uidLog,"utf8").trim().split("\n").map(line=>JSON.parse(line))
    assert.ok(uids.every(record=>record.uid!==0 && record.euid!==0))
    recordEvidence(`${vcs}-push-${defect}`,{uids,
      result,commands,
      migrations:readFileSync(join(dir,"packages/backend/db/product/migrate.go"),"utf8"),
      ownership:readFileSync(join(dir,"packages/backend/db/ownership.csv"),"utf8"),
    })
    assert.ok(commands.every(c=>!["postgres","psql","initdb","pg_ctl"].includes(c[0])),"PostgreSQL is unavailable to the gate")
    const pushes = commands.filter(c => c[0] === "git" && c[1] === "push" || c[0] === "jj" && c[1] === "git" && c[2] === "push")
    const selected = ["go", "test", "-run", "TestMigrationGate|TestMigrationRegistry", "./packages/backend/db/product/"]
    const gates = commands.map((c, i) => JSON.stringify(c) === JSON.stringify(selected) ? i : -1).filter(i => i >= 0)
    // Literal command-order oracle: C-PRC-02 steps 4 and 6 / §21.3.
    if (defect === "clean") {
     assert.equal(result.status, 0, result.stdout + result.stderr)
     assert.equal(pushes.length, 1)
     assert.equal(gates.length, 3)
     const generation = commands.findIndex(c => c[0] === "sqlc" && c[1] === "generate")
     assert.ok(gates[0] < generation && generation < gates[1] && gates[1] < gates[2])
     assert.ok(gates[2] < commands.indexOf(pushes[0]))
    } else {
     assert.notEqual(result.status, 0)
     assert.equal(pushes.length, 0)
     assert.equal(gates.length, 1)
     assert.match(result.stdout + result.stderr, defect === "gap" ? /gap: no migration numbered 0002/ : /duplicate migration number 0001/)
    }
   } finally {
    rmSync(dir, { recursive: true, force: true }); rmSync(tools, { recursive: true, force: true })
   }
  })
 }
}
