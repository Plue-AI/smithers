import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { filesForTests, pattern, runFiles } from "./backend-compose-tests.mjs"

const fixture = t => {
  const root = mkdtempSync(join(tmpdir(), "compose-runner-test-"))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  return root
}

test("compiled tests, examples and fuzz seeds run exactly once, with unknown names refused", t => {
  const root = fixture(t)
  writeFileSync(join(root, "a_test.go"), "func TestA(t *testing.T) {}\nfunc ExampleA() {}\nfunc FuzzA(f *testing.F) {}\nfunc TestMain(m *testing.M) {}\n")
  writeFileSync(join(root, "b_test.go"), "func TestB(t *testing.T) {}\n".repeat(10))
  const names = ["TestA", "ExampleA", "FuzzA", "TestB"]
  const groups = filesForTests(root, names)
  assert.equal(groups[0].file, "b_test.go")
  assert.deepEqual(groups.flatMap(group => group.names).sort(), names.sort())
  assert.equal(pattern(["TestA", "TestB"]), "^(TestA|TestB)$")
  assert.throws(() => filesForTests(root, ["TestUnmapped"]), /no source file/)
})

test("concurrent file workers isolate scratch, ports and keys, drain after failures, and report failure", async t => {
  const root = fixture(t)
  const binary = join(root, "fixture")
  writeFileSync(binary, `#!/usr/bin/env node
const fs = require('fs'); const path = require('path');
const name = process.argv.find(arg => arg.startsWith('-test.run='));
fs.appendFileSync(path.join(${JSON.stringify(root)}, 'events'), JSON.stringify({name, event:'start'})+'\\n');
fs.writeFileSync(path.join(${JSON.stringify(root)}, name), JSON.stringify({tmp:process.env.TMPDIR, ssh:process.env.SMITHERS_SSH_HOST_KEY_DIR, addr:process.env.SMITHERS_SSH_ADDR, timeout:process.argv[3]}));
setTimeout(() => { fs.appendFileSync(path.join(${JSON.stringify(root)}, 'events'), JSON.stringify({name,event:'end'})+'\\n'); console.log('evidence '+name); process.exit(name.includes('Fail') ? 1 : 0) }, 200);
`, { mode: 0o755 })
  const names = ["TestA", "TestFail", "ExampleB", "FuzzC", "TestD"]
  const groups = names.map(name => ({ file: name, names: [name] }))
  const reports = []
  const results = await runFiles(groups, { binary, cwd: root, workers: 2, report: line => reports.push(line) })
  assert.equal(results.length, names.length)
  assert.equal(results.filter(result => result.code !== 0).length, 1)
  assert.match(reports.join("\n"), /evidence.*TestFail/)
  const events = readFileSync(join(root, "events"), "utf8").trim().split("\n").map(line => JSON.parse(line))
  let active = 0, peak = 0
  for (const event of events) { active += event.event === "start" ? 1 : -1; peak = Math.max(active, peak); assert.ok(active >= 0 && active <= 2) }
  assert.equal(active, 0)
  assert.equal(peak, 2, "workers must overlap")
  const receipts = names.map(name => JSON.parse(readFileSync(join(root, `-test.run=${pattern([name])}`), "utf8")))
  assert.equal(new Set(receipts.map(row => row.tmp)).size, names.length)
  for (const row of receipts) {
    assert.equal(row.addr, "127.0.0.1:0")
    assert.equal(row.ssh, join(row.tmp, "ssh"))
    assert.equal(row.timeout, "-test.timeout=40m")
  }
  await assert.rejects(runFiles(groups, { binary, cwd: root, workers: 0 }), /1..4/)
})
