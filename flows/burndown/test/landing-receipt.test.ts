import assert from "node:assert/strict"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import {
  hasPushedReceipt,
  hasVerifiedPushedReceipt,
  isPushedFailure,
  loadAcceptanceRecord
} from "../landing-receipt.ts"

const revision = "a".repeat(40)
const member = {
  key: "receipt-worker",
  repo: "smithersai/smithers",
  commits: [{ issue: 3116, commit: "b".repeat(40) }]
}
const acceptance = {
  context: {
    repo: member.repo,
    revision,
    commits: member.commits,
    issues: [{ issue: 3116, body: "Recover receipts" }],
    checks: "Recovery PASS"
  },
  receipt: {
    version: 1,
    repo: member.repo,
    revision,
    issues: [{
      issue: 3116,
      disposition: "complete",
      criteria: [{ criterion: "Recover receipts", evidence: ["Recovery PASS"] }],
      remaining: []
    }]
  }
}
const fact = { version: 2, phase: "landed", ...member, landed: [{ issue: 3116, sha: revision }] }
const verified = { ...fact, phase: "verified", acceptance }
function fixture(t: test.TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "landing-receipt-"))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    pushed: (value: unknown) => writeFileSync(join(dir, `${member.key}.pushed.json`), JSON.stringify(value)),
    standalone: (value: unknown) => writeFileSync(join(dir, `${member.key}.acceptance.json`), JSON.stringify(value))
  }
}

test("confirmed landing retains recovery privilege without authorizing issue completion", (t) => {
  const f = fixture(t)
  assert.equal(hasVerifiedPushedReceipt(member, f.dir), false)
  f.pushed(fact)
  assert.equal(hasPushedReceipt(member, f.dir), true)
  assert.equal(isPushedFailure(member, {}, f.dir), true)
  assert.equal(hasVerifiedPushedReceipt(member, f.dir), false)
  assert.throws(() => loadAcceptanceRecord(member, revision, f.dir))
  f.pushed(verified)
  assert.equal(hasVerifiedPushedReceipt(member, f.dir), true)
  assert.deepEqual(loadAcceptanceRecord(member, revision, f.dir), acceptance)
})

test("verified embedded acceptance survives a missing or stale standalone file", (t) => {
  const f = fixture(t)
  f.pushed(verified)
  assert.deepEqual(loadAcceptanceRecord(member, revision, f.dir), acceptance)
  f.standalone({ ...acceptance, context: { ...acceptance.context, revision: "c".repeat(40) } })
  assert.deepEqual(loadAcceptanceRecord(member, revision, f.dir), acceptance)
})

test("legacy v1 verified receipts retain exact member binding", (t) => {
  const f = fixture(t)
  f.pushed({ ...verified, version: 1, phase: undefined })
  assert.equal(hasVerifiedPushedReceipt(member, f.dir), true)
  assert.equal(hasPushedReceipt({ ...member, commits: [{ issue: 3116, commit: "c".repeat(40) }] }, f.dir), false)
})

test("missing, malformed and mismatched proof never bypass ownership", (t) => {
  const f = fixture(t)
  for (
    const invalid of [
      null,
      {},
      { ...fact, repo: "other/repo" },
      { ...fact, acceptance },
      { ...fact, key: "other" },
      { ...fact, landed: [] },
      { ...fact, landed: [{ issue: 3117, sha: revision }] },
      { ...fact, landed: [{ issue: 3116, sha: "invalid" }] },
      { ...verified, acceptance: { ...acceptance, context: { ...acceptance.context, commits: [] } } }
    ]
  ) {
    f.pushed(invalid)
    assert.equal(hasPushedReceipt(member, f.dir), false)
    assert.equal(isPushedFailure(member, {}, f.dir), false)
  }
})

test("standalone acceptance is bound to full member and revision, never proof of push", (t) => {
  const f = fixture(t)
  f.standalone(acceptance)
  assert.deepEqual(loadAcceptanceRecord(member, revision, f.dir), acceptance)
  assert.equal(isPushedFailure(member, {}, f.dir), false)
  assert.equal(isPushedFailure(member, { stdout: `LANDED 1 ${revision}` }, f.dir), true)
  assert.throws(() => loadAcceptanceRecord(member, "c".repeat(40), f.dir))
  f.standalone({ ...acceptance, context: { ...acceptance.context, commits: [] } })
  assert.throws(() => loadAcceptanceRecord(member, revision, f.dir))
})

test("bound remote confirmation output survives receipt writer and later provider failures", (t) => {
  const f = fixture(t)
  const stdout = `LANDING_CONFIRMED ${JSON.stringify(fact)}\nLANDED 1 ${revision}\n`
  assert.equal(isPushedFailure(member, { stdout }, f.dir), true)
  assert.equal(isPushedFailure({ ...member, repo: "other/repo" }, { stdout }, f.dir), false)
  assert.equal(isPushedFailure(member, { stdout: stdout + stdout }, f.dir), false)
  f.standalone(acceptance)
  assert.equal(isPushedFailure(member, { stdout: stdout + stdout + `PUSH_ACCEPTED ${revision}` }, f.dir), false)
})

test("retained READY original 64-character commits remain exactly bound", (t) => {
  const f = fixture(t)
  const original = { ...member, commits: [{ issue: 3116, commit: "b".repeat(64) }] }
  const record = { ...acceptance, context: { ...acceptance.context, commits: original.commits } }
  f.pushed({ ...verified, commits: original.commits, acceptance: record })
  assert.equal(hasVerifiedPushedReceipt(original, f.dir), true)
  assert.deepEqual(loadAcceptanceRecord(original, revision, f.dir), record)
  assert.equal(hasPushedReceipt(member, f.dir), false)
})

test("legacy PUSH_ACCEPTED recovery requires valid acceptance bound to the same member", (t) => {
  const f = fixture(t)
  const stdout = `PUSH_ACCEPTED ${revision}\n`
  assert.equal(isPushedFailure(member, { stdout }, f.dir), false)
  f.standalone(acceptance)
  assert.equal(isPushedFailure(member, { stdout }, f.dir), true)
  assert.equal(isPushedFailure(member, { stdout: stdout + stdout }, f.dir), false)
  assert.equal(
    isPushedFailure({ ...member, commits: [{ issue: 3116, commit: "c".repeat(40) }] }, { stdout }, f.dir),
    false
  )
  assert.equal(isPushedFailure(member, { stdout: 42 }, f.dir), false)
})

test("invalid embedded record falls back only to independently bound standalone acceptance", (t) => {
  const f = fixture(t)
  f.pushed({ ...verified, acceptance: { ...acceptance, context: { ...acceptance.context, revision: "c".repeat(40) } } })
  assert.equal(hasPushedReceipt(member, f.dir), false)
  f.standalone(acceptance)
  assert.deepEqual(loadAcceptanceRecord(member, revision, f.dir), acceptance)
})

test("historical LANDED output requires complete ordered mapping and exact reviewed final revision", (t) => {
  const f = fixture(t)
  f.standalone(acceptance)
  assert.equal(isPushedFailure(member, { stdout: `LANDED 1 ${revision}` }, f.dir), true)
  for (
    const stdout of [
      `LANDED 2 ${revision}`,
      `LANDED 1 ${"c".repeat(40)}`,
      `LANDED 1 ${revision}\nLANDED 1 ${revision}`,
      `LANDED 0 ${revision}`,
      "LANDED 1 invalid"
    ]
  ) {
    assert.equal(isPushedFailure(member, { stdout }, f.dir), false)
  }
})
