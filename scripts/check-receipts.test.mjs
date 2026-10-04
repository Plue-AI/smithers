import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { expectedCommand, reverifyCi, unpackResults, validMapping, verifyCiRun, zeroTests } from './check-evidence.mjs'
import { fixture } from './fixtures/check-receipts.mjs'
import { run as claimRun } from './issue-claim.mjs'

const digest = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`

test('target receipts preserve observed fields; all close variants close exactly once', () => {
  const f = fixture()
  try {
    const before = Date.now(); const paths = ['C-FIX-01','C-FIX-02'].map(id => {
      const result = f.recorded(id); assert.equal(result.status, 0, result.stdout + result.stderr)
      return JSON.parse(result.stdout).receipt
    }); const after = Date.now()
    const r = JSON.parse(readFileSync(join(f.root, paths[0])))
    assert.deepEqual(Object.keys(r).sort(), ['version','check','commit','layer','command','exit','started','ended','log_digest'].sort())
    assert.equal(r.version, 1); assert.equal(r.commit, f.sha); assert.match(r.commit, /^[a-f0-9]{40}$/)
    assert.equal(r.check, 'C-FIX-01'); assert.equal(r.layer, 'integration'); assert.deepEqual(r.command, ['smthrs-ci','//fixture:canary']); assert.equal(r.exit, 0); assert.ok(Number.isInteger(r.exit)); assert.match(r.log_digest, /^sha256:[a-f0-9]{64}$/)
    assert.equal(r.log_digest, digest(readFileSync(join(f.root, paths[0], '..', 'log.txt'))))
    for (const time of [r.started, r.ended]) { assert.match(time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); assert.ok(Date.parse(time) >= before && Date.parse(time) <= after) }
    assert.ok(r.started <= r.ended)
    for (const flags of [[], ['--release'], ['--force'], ['--release','--force'], ['--reason','completed','--note','verified']]) assert.equal(f.close(paths, flags).code, 0)
    assert.equal(f.writes.filter(a => a.includes('PATCH')).length, 1)
  } finally { f.cleanup() }
})

test('invalid evidence refuses every variant before any remote write', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    const original = readFileSync(join(f.root, paths[0]), 'utf8')
    const refused = (receipts, reason, flags = [], landed = f.sha) => {
      for (const variant of [flags, [...flags,'--release'], [...flags,'--force'], [...flags,'--release','--force']]) {
      const out = f.close(receipts, variant, landed)
      assert.equal(out.code, 2); assert.equal(out.out.action, 'evidence-refused'); assert.ok(out.out.checks.some(c => c.reason === reason), JSON.stringify(out)); assert.equal(f.writes.length, 0)
      }
    }
    for (const flags of [[], ['--release'], ['--force'], ['--release','--force']]) {
      refused([], 'missing', flags); refused(paths.slice(0,1), 'coverage', flags)
      refused(paths, 'commit', flags, null); refused(paths, 'commit', flags, 'abc'); refused(paths, 'commit', [...flags, '--note', f.sha], null)
    }
    f.put('second', 'x'); f.git('add','second'); f.git('commit','-m','not landed'); refused(paths,'commit',[],f.git('rev-parse','HEAD'))
    for (const [field, value, reason] of [['version',2,'failed'],['exit',1,'failed'],['exit','0','failed'],['commit','0'.repeat(40),'commit'],['started','yesterday','failed'],['ended','2020-01-01T00:00:00.000Z','failed'],['layer',null,'failed'],['command',[],'coverage'],['log_digest','sha256:no','digest']]) {
      f.put(paths[0], JSON.stringify({ ...JSON.parse(original), [field]: value })); refused(paths,reason); assert.equal(f.close(paths).out.checks[0].receipt, paths[0])
    }
    f.put(paths[0], original); f.put(join(paths[0],'..','log.txt'),'altered'); refused(paths,'digest')
    f.put(paths[0], JSON.stringify({ ...JSON.parse(original), check: 'C-INVENT-01' })); refused(paths,'coverage')
  } finally { f.cleanup() }
})

test('receipt, log and parent symlinks, traversal and escapes are refused', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    const refusal = (path) => { const out = f.close([path, paths[1]]); assert.equal(out.code,2); assert.equal(out.out.action,'evidence-refused'); assert.equal(f.writes.length,0) }
    refusal(paths[0].replace('receipt.json','../receipt.json'))
    f.put('outside.json',readFileSync(join(f.root,paths[0]))); refusal(join(f.root,'outside.json'))
    symlinkSync(join(f.root,paths[0]), join(f.root,'.artifacts/checks/link.json')); refusal('.artifacts/checks/link.json')
    symlinkSync(join(f.root,paths[0],'..'), join(f.root,'.artifacts/checks/parent')); refusal('.artifacts/checks/parent/receipt.json')
    const log = join(f.root,paths[0],'..','log.txt'); rmSync(log); symlinkSync(join(f.root,'outside.json'),log); refusal(paths[0])
    rmSync(join(f.root,'.artifacts/checks'),{recursive:true}); symlinkSync(join(f.root,'home'),join(f.root,'.artifacts/checks')); refusal(paths[0])
  } finally { f.cleanup() }
})

test('runner refuses absent, unwritten, unparsable and mismatched Automation before CI reads', () => {
  const f = fixture()
  try {
    for (const declaration of ['Automation: unavailable · Runs in: CI','Automation: `smthrs test //fixture:canary` (to write) · Runs in: CI','Automation: prose PASS · Runs in: CI','Automation: `smthrs test //fixture:canary` · Runs in: reference host']) {
      f.put('.specs/engineering/checks/C-FIX-01.md', `Layer: integration\n${declaration}\n`); f.commit()
      const result = f.runner(); assert.equal(result.status,2); assert.equal(JSON.parse(result.stdout).action,'check-refused'); assert.equal(JSON.parse(result.stdout).receipt,undefined)
    }
    assert.equal(f.runner('C-ABS-01').status,2)
  } finally { f.cleanup() }
})
test('malformed JSON values and missing receipt arguments refuse without throwing or writing', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    for (const text of ['null','[]','false','{','{}']) {
      f.put(paths[0],text)
      assert.equal(f.close(paths).code,2)
      assert.equal(f.writes.length,0)
    }
    assert.equal(f.close([],['--receipt']).code,2)
  } finally { f.cleanup() }
})

test('each close variant consumes complete coverage and releases only when requested', () => {
  for (const flags of [[], ['--release'], ['--force'], ['--release','--force']]) {
    const f = fixture()
    try {
      const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
      assert.equal(f.close(paths, flags).code,0)
      assert.equal(f.writes.filter(a => a.includes('PATCH')).length,1)
      assert.equal(f.writes.filter(a => a.includes('DELETE')).length,flags.includes('--release') ? 1 : 0)
      assert.equal(f.writes.length,flags.includes('--release') ? 3 : 2)
    } finally { f.cleanup() }
  }
})

test('caller-invented check IDs and omitted check fields cannot cover ticket checks', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    const receipt = JSON.parse(readFileSync(join(f.root,paths[0])))
    delete receipt.check; f.put(paths[0],JSON.stringify(receipt))
    const out = f.close(paths,['--checks','C-INVENT-01'])
    assert.equal(out.code,2); assert.ok(out.out.checks.some(c => c.reason === 'coverage')); assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})

// The executable CLI must refuse before even starting a publication proxy.
test('CLI invalid close variants exit 2 without proxy startup or remote writes', () => {
  const f = fixture()
  try {
    for (const flags of [[], ['--release'], ['--force'], ['--release','--force']]) {
      const out = spawnSync(process.execPath,[new URL('./issue-claim.mjs',import.meta.url).pathname,'comment','o/r#7','--body','Complete','--close',...flags],{cwd:f.root,encoding:'utf8',env:{PATH:process.env.PATH,HOME:join(f.root,'home'),ISSUE_CLAIM_APP_CONFIG:join(f.root,'absent'),SMITHERS_GITHUB_PROXY:'http://127.0.0.1:1'}})
      assert.equal(out.status,2,out.stderr); assert.equal(JSON.parse(out.stdout).action,'evidence-refused'); assert.equal(out.stderr,''); assert.equal(f.writes.length,0)
    }
  } finally { f.cleanup() }
})

test('held claims retain action refused, distinct from evidence refusal', () => {
  const f = fixture()
  try {
    const out = f.invoke(['claim','o/r#7','--by','rival'])
    assert.equal(out.code,2); assert.equal(out.out.action,'refused'); assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})

test('coverage comes from the ticket Issue field, with exact repository and issue identity', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    f.put('.specs/engineering/tickets/T-OTHER-01.md','Issue: https://github.com/o/r/issues/70\nSee https://github.com/o/r/issues/7\n## Acceptance\n- C-INVENT-01\n')
    assert.equal(f.close(paths).code,0)
  } finally { f.cleanup() }
})


test('journey check IDs retain numeric stages in runner and ticket-derived coverage', () => {
  const f = fixture()
  try {
    f.put('.specs/engineering/tickets/T-FIX-01.md','Issue: https://github.com/o/r/issues/7\n## Acceptance\n- C-J1-01\n- C-FIX-02\n')
    f.put('.specs/engineering/checks/C-J1-01.md','Layer: integration\nAutomation: `smthrs test //fixture:canary` · Runs in: CI\n')
    f.put('scripts/check-commands.json',JSON.stringify({version:1,activation:{mappingsApprovedBy:'smithers-22',coverageAcceptedBy:'smithers-8a'},checks:Object.fromEntries(['C-FIX-01','C-J1-01','C-FIX-02'].map(id=>[id,{approvedBy:'smithers-22',automation:'smthrs test //fixture:canary',runsIn:'CI',host:'CI',target:'//fixture:canary'}]))}))
    f.commit(); assert.equal(f.close(['C-J1-01','C-FIX-02'].map(f.evidence)).code,0)
  } finally { f.cleanup() }
})

// Expected committed input and coverage policy: T-PRC-03 Goal / spec §21.4a.
test('dirty mapping and ticket edits cannot forge committed receipt command or coverage', () => {
  const f = fixture()
  try {
    const receipt = f.evidence('C-FIX-01')
    const original = JSON.parse(readFileSync(join(f.root,receipt)))
    const mappings = JSON.parse(readFileSync(join(f.root,'scripts/check-commands.json')))
    mappings.checks['C-FIX-01'].target = '//fixture:dirty'
    f.put('scripts/check-commands.json',JSON.stringify(mappings))
    f.put(receipt,JSON.stringify({...original,command:['smthrs-ci','//fixture:dirty']}))
    const paths = [receipt,f.evidence('C-FIX-02')]
    assert.deepEqual(f.close(paths).out.checks,[{check:'C-FIX-01',receipt,reason:'coverage'}])
    f.put(receipt,JSON.stringify(original))
    f.put('.specs/engineering/tickets/T-FIX-01.md','Issue: https://github.com/o/r/issues/7\n## Acceptance\n- C-FIX-01\n')
    assert.deepEqual(f.close([receipt]).out.checks,[{check:'C-FIX-02',reason:'coverage'}])
    assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})
test('suffixed committed tickets retain complete acceptance coverage', () => {
  const f = fixture()
  try {
    f.git('mv','.specs/engineering/tickets/T-FIX-01.md','.specs/engineering/tickets/T-FIX-01a.md'); f.commit()
    assert.equal(f.close(['C-FIX-01','C-FIX-02'].map(f.evidence)).code,0)
  } finally { f.cleanup() }
})

test('manual and pending-owner checks refuse closure as missing', () => {
  for (const status of ['manual','pending-owner']) {
    const f = fixture()
    try {
      const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
      const mappings = JSON.parse(readFileSync(join(f.root,'scripts/check-commands.json')))
      mappings.checks['C-FIX-02'] = {status,reason:'owner evidence pending',ticket:'T-FIX-01'}
      f.put('scripts/check-commands.json',JSON.stringify(mappings)); f.commit()
      assert.deepEqual(f.close(paths).out.checks,[{check:'C-FIX-02',reason:'missing'}]); assert.equal(f.writes.length,0)
    } finally { f.cleanup() }
  }
})

test('unparsable receipts are attributed to their path without guessing a check', () => {
  const f = fixture()
  try {
    const good = f.evidence('C-FIX-01'); f.put('.artifacts/checks/garbage.json','{')
    const out = f.close(['.artifacts/checks/garbage.json',good])
    assert.deepEqual(out.out.checks,[{check:'receipt',receipt:'.artifacts/checks/garbage.json',reason:'digest'},{check:'C-FIX-02',reason:'coverage'}])
    assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})


// Product, 20:07: non-completion reasons require a note; replacements require a link.
test('non-completion reasons close once with their literal state reason', () => {
  for (const [reason,state] of [['not-planned','not_planned'],['duplicate','duplicate'],['superseded','not_planned']]) {
    const f = fixture()
    try {
      for (let i=0;i<2;i++) { const out=f.close([],['--reason',reason,'--note','o/r#8'],null); assert.equal(out.code,0); assert.equal(out.out.reason,reason) }
      const writes=f.writes.filter(a=>a.includes('PATCH')); assert.equal(writes.length,1); assert.ok(writes[0].includes(`state_reason=${state}`))
    } finally { f.cleanup() }
  }
})
test('invalid reasons and notes refuse before writes; explicit completed requires evidence', () => {
  for (const flags of [['--reason','unknown','--note','o/r#8'],['--reason','not-planned'],['--reason','completed'],['--reason','superseded','--note',' '],['--reason','duplicate','--note','text'],['--reason','superseded','--note','text'],['--reason','completed','--note','done']]) {
    const f=fixture(); try { assert.equal(f.close([],flags,null).code,2); assert.equal(f.writes.length,0) } finally { f.cleanup() }
  }
})
test('inventory covers every check exactly once and executable mappings require approval, target and host', () => {
  const root=new URL('../',import.meta.url)
  const mappings=JSON.parse(readFileSync(new URL('scripts/check-commands.json',root)))
  const files = `C-ACC-01 C-ACC-02 C-ACC-03 C-ACC-04 C-AGT-01 C-AGT-02 C-APP-01 C-APP-02 C-APP-03 C-APP-04 C-APP-05 C-CAT-01 C-CAT-02 C-CAT-03 C-COL-01 C-COL-02 C-COL-03 C-COL-04 C-COL-05 C-CUT-01 C-CUT-02 C-DUR-01 C-DUR-02 C-DUR-03 C-DUR-04 C-GH-01 C-GH-07 C-GH-08 C-GH-09 C-GH-13 C-INS-01 C-INS-03 C-INS-05 C-INS-06 C-J1-01 C-J1-02 C-J1-03 C-J1-04 C-J1-05 C-J1-06 C-J10-01 C-J10-02 C-J10-03 C-J10-04 C-J10-05 C-J10-06 C-J10-07 C-J10-08 C-J10-09 C-J11-01 C-J11-02 C-J11-03 C-J11-04 C-J2-01 C-J2-02 C-J2-03 C-J2-04 C-J2-05 C-J3-01 C-J3-02 C-J3-03 C-J3-04 C-J3-05 C-J3-06 C-J3-08 C-J3-09 C-J3-10 C-J4-01 C-J4-02 C-J4-03 C-J5-01 C-J5-02 C-J5-03 C-J6-01 C-J6-02 C-J7-01 C-J7-02 C-J7-03 C-J8-01 C-J8-02 C-J8-03 C-J8-04 C-J8-05 C-J8-06 C-J9-01 C-MCH-01 C-MCH-02 C-MCH-03 C-MCH-04 C-MCH-05 C-MCH-06 C-MCH-07 C-MCH-08 C-MCH-09 C-MCH-10 C-MCH-11 C-MNT-01 C-MNT-02 C-MNT-03 C-MNT-04 C-MNT-05 C-MNT-06 C-PERF-01 C-PERF-02 C-PERF-03 C-PERF-04 C-PERF-05 C-PERF-06 C-PRC-01 C-PRC-02 C-PRC-03 C-REL-01 C-REL-02 C-REL-03 C-REL-04 C-REL-05 C-REL-06 C-SEC-01 C-SEC-02 C-SEC-03 C-SEC-04 C-SEC-05 C-SPK-02 C-SPK-03 C-SPK-05 C-SPK-06 C-SPK-07 C-SPK-08 C-STK-01 C-STK-02 C-STK-03 C-STK-04 C-STK-05 C-STK-06 C-STK-07 C-STK-08 C-STK-13 C-UI-01 C-UI-02 C-UI-03 C-UI-04 C-UI-05 C-UI-06 C-UI-07 C-UI-08 C-UI-09 C-UI-10 C-UI-11 C-UI-12 C-UI-13`.split(' ')
  assert.deepEqual(Object.keys(mappings.checks).sort(),files)

  for(const m of Object.values(mappings.checks)) assert.ok(validMapping(m))
  for(const m of [{command:['node'],host:'CI'},{approvedBy:'smithers-22',host:'CI'},{approvedBy:'smithers-22',command:['node']}]) assert.equal(validMapping(m),false)
})

test('replacement reasons accept a replacing issue URL or full commit SHA', () => {
  for (const reason of ['duplicate','superseded']) for (const note of ['https://github.com/o/r/issues/8','a'.repeat(40)]) {
    const f=fixture(); try { assert.equal(f.close([],['--reason',reason,'--note',note],null).code,0); assert.equal(f.writes.filter(a=>a.includes('PATCH')).length,1) } finally { f.cleanup() }
  }
})

// smithers-3f, 22:2x: local refs and branch-controlled argv cannot confer authority.
test('forged local origin main cannot authorize an unlanded commit', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    f.put('second', 'unlanded'); f.git('add', 'second'); f.git('commit', '-m', 'unlanded')
    const unlanded = f.git('rev-parse', 'HEAD')
    f.git('update-ref', 'refs/remotes/origin/main', unlanded)
    for (const path of paths) {
      const r = JSON.parse(readFileSync(join(f.root,path))); r.commit = unlanded; f.put(path,JSON.stringify(r))
    }
    const out = f.close(paths, [], unlanded)
    assert.equal(out.code,2); assert.deepEqual(out.out.checks,[{check:'C-FIX-01',reason:'commit'},{check:'C-FIX-02',reason:'commit'}]); assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})
test('unavailable remote main fails closed despite valid local ancestry', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    f.git('remote','set-url','origin',join(f.root,'absent.git'))
    const out = f.close(paths)
    assert.equal(out.code,2); assert.ok(out.out.checks.every(c=>c.reason==='commit')); assert.equal(f.writes.length,0)
  } finally { f.cleanup() }
})
test('receipt command must deep-equal the approved landed mapping', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence)
    const r = JSON.parse(readFileSync(join(f.root,paths[0])))
    for (const command of [[], null, ['smthrs-ci','//fixture:other'], ['smthrs-ci','//fixture:canary','extra'], ['//fixture:canary','smthrs-ci']]) {
      f.put(paths[0],JSON.stringify({...r,command}))
      const out = f.close(paths)
      assert.equal(out.code,2); assert.deepEqual(out.out.checks,[{check:'C-FIX-01',receipt:paths[0],reason:'coverage'}]); assert.equal(f.writes.length,0)
    }
  } finally { f.cleanup() }
})

test('an approved mapping cannot drop obligations its pending binding still lists open (4386fc25e review)', () => {
  const approved = { approvedBy: 'smithers-22', host: 'CI', target: '//fixture:canary' }
  assert.equal(validMapping(approved), true)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: ['a'] }], unboundSubcases: [{ name: 'T-UI-02-copy', reason: 'open' }] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: [] }] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{}] } }), false)
  assert.equal(validMapping({ ...approved, pendingBinding: { commands: [{ expectedCaseIds: ['a'] }], unboundSubcases: [] } }), true)
  // A pending entry may keep its open proposal; it is refused at closure as missing anyway.
  assert.equal(validMapping({ status: 'pending-owner', reason: 'r', ticket: 'T-UI-01', pendingBinding: { unboundSubcases: [{ name: 'x' }] } }), true)
})

test('a run that executed no tests is empty for every reporter, and a run with tests is not', () => {
  for (const log of ['ℹ tests 0\nℹ pass 0', '# tests 0', 'Ran 0 tests across 0 files. [3ms]', 'No test files found, exiting with code 1', 'Error: No tests found', 'ok  \tgithub.com/x/y\t0.01s [no tests to run]', '?   \tgithub.com/x/z\t[no test files]']) assert.equal(zeroTests(log), true, log)
  for (const log of ['ℹ tests 12', 'Ran 3 tests across 1 file.', 'ok  \tgithub.com/x/y\t0.51s', 'ok  \tgithub.com/x/y\t0.51s\nok  \tgithub.com/x/w\t0.01s [no tests to run]', '{"Action":"pass","Package":"p","Test":"TestA","Elapsed":0}\n[no tests to run]', '--- PASS: TestA (0.00s)', 'canary passed']) assert.equal(zeroTests(log), false, log)
})


// #3663 option B: CI's own record decides a target mapping. Each case forges one input.
const ciFixture = (overrides = {}) => {
  const L = 'a'.repeat(40); const label = '//apps/app:viewStories'
  const latest = Buffer.from('latest'); const earlier = Buffer.from('earlier')
  const files = new Map([
    [latest.toString(), [{ name: 'step.json', text: JSON.stringify({ version: 1, results: [{ label, status: overrides.status ?? 'ran', key: 'k' }, { label: '//other:x', status: 'failed' }] }) }]],
    [earlier.toString(), [{ name: 'step.json', text: JSON.stringify({ version: 1, results: [{ label, status: 'ran', key: 'k' }] }) }]]
  ])
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1', ...overrides.check }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2, html_url: 'https://github.com/o/r/actions/runs/7', ...overrides.run },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ name: 'test', conclusion: 'failure', run_attempt: overrides.testAttempt ?? 2 }, ...(overrides.jobs ?? [])] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [
      { id: 10, name: 'smthrs-results-test-0-2', workflow_run: { id: 7 }, expired: false, digest: digest(latest), ...overrides.artifact },
      { id: 11, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(earlier) }
    ] }
  }
  const zips = { 'repos/o/r/actions/artifacts/10/zip': overrides.zip ?? latest, 'repos/o/r/actions/artifacts/11/zip': earlier }
  return verifyCiRun({ github: { json: (path) => api[path] ?? (() => { throw new Error(`unexpected ${path}`) })(), bytes: (path) => zips[path] }, unpack: (bytes) => ({ files: files.get(bytes.toString()) ?? [] }), repo: 'o/r', landed: L, label })
}

test('CI receipt passes on the label\'s own status in the latest attempt, even when another target failed the job', () => {
  const ok = ciFixture()
  assert.equal(ok.pass, true); assert.equal(ok.reason, 'pass')
  assert.deepEqual(ok.evidence.rows.map(row => [row.artifact, row.status]), [['smthrs-results-test-0-2', 'ran']])
  assert.equal(ciFixture({ status: 'hit' }).pass, true)
})

test('CI receipt refuses forged sha, app, branch, event and workflow path', () => {
  for (const [overrides, reason] of [
    [{ check: { head_sha: 'b'.repeat(40) } }, 'commit'],
    [{ check: { app: { slug: 'evil-app' } } }, 'no_run'],
    [{ run: { head_sha: 'b'.repeat(40) } }, 'no_run'],
    [{ run: { event: 'pull_request' } }, 'no_run'],
    [{ run: { head_branch: 'feature' } }, 'no_run'],
    [{ run: { path: '.github/workflows/pr-edited.yml' } }, 'no_run'],
    [{ run: { repository: { full_name: 'fork/r' } } }, 'no_run'],
    [{ run: { status: 'in_progress' } }, 'incomplete']
  ]) assert.equal(ciFixture(overrides).reason, reason, JSON.stringify(overrides))
})

test('CI receipt refuses a rerun that still fails, ignoring the earlier passing attempt', () => {
  const r = ciFixture({ status: 'failed' })
  assert.equal(r.pass, false); assert.equal(r.reason, 'label_failed')
  assert.ok(r.evidence.rows.every(row => row.artifact.endsWith('-2')))
  assert.equal(ciFixture({ status: 'skipped' }).reason, 'label_failed')
})

test('CI receipt refuses foreign or tampered artifacts, stopped jobs and an absent label', () => {
  assert.equal(ciFixture({ artifact: { workflow_run: { id: 8 } } }).reason, 'artifact_foreign')
  assert.equal(ciFixture({ artifact: { expired: true } }).reason, 'artifact_foreign')
  assert.equal(ciFixture({ zip: Buffer.from('tampered') }).reason, 'artifact_digest')
  assert.equal(ciFixture({ jobs: [{ name: 'go', conclusion: 'cancelled' }] }).reason, 'job_stopped')
  assert.equal(ciFixture({ jobs: [{ name: 'go', conclusion: 'timed_out' }] }).reason, 'job_stopped')
  // A leg the latest attempt re-ran must have uploaded at that attempt (b8): its earlier pass never stands in.
  assert.equal(ciFixture({ artifact: { name: 'smthrs-results-test-0-1x' } }).reason, 'artifact_missing')
  // A leg the rerun did not execute keeps its earlier attempt's result.
  const fallback = ciFixture({ artifact: { name: 'smthrs-results-test-0-1x' }, testAttempt: 1 })
  assert.equal(fallback.pass, true); assert.deepEqual(fallback.evidence.rows.map(row => row.artifact), ['smthrs-results-test-0-1'])
})

test('target mappings carry a label and no argv, and closure expects the CI receipt command', () => {
  const target = { approvedBy: 'smithers-22', host: 'CI', target: '//apps/app:viewStories' }
  assert.equal(validMapping(target), true)
  for (const bad of [{ ...target, host: 'reference host' }, { ...target, command: ['node'] }, { ...target, paths: ['x'] }, { ...target, target: 'apps/app:viewStories' }, { ...target, target: '//apps/app' }]) assert.equal(validMapping(bad), false, JSON.stringify(bad))
  assert.deepEqual(expectedCommand(target), ['smthrs-ci', '//apps/app:viewStories'])
})

test('runner requires --landed and refuses argv mappings even with CI=true', () => {
  const f = fixture()
  try {
    const run = args => spawnSync(process.execPath, ['scripts/check-run.mjs', ...args], { cwd: f.root, encoding: 'utf8', env: { ...process.env, CI: 'true' } })
    for (const args of [['C-FIX-02'], ['C-FIX-01','--landed'], ['C-FIX-01','--landed','abc']]) {
      const out = run(args); assert.equal(out.status,2); assert.equal(JSON.parse(out.stdout).receipt,undefined)
    }
    const mappings = JSON.parse(readFileSync(join(f.root,'scripts/check-commands.json')))
    const { target, ...rest } = mappings.checks['C-FIX-01']
    mappings.checks['C-FIX-01'] = {...rest,command:['node','canary.mjs'],paths:['canary.mjs']}
    f.put('scripts/check-commands.json',JSON.stringify(mappings)); f.commit()
    const out = f.runner(); assert.equal(out.status,2)
    assert.equal(JSON.parse(out.stdout).reason,'argv mappings are not executable; map the check to a smthrs target')
    assert.equal(JSON.parse(out.stdout).receipt,undefined); assert.equal(f.writes.length,0)
    assert.equal(validMapping(mappings.checks['C-FIX-01']),false)
  } finally { f.cleanup() }
})
test('artifact unpacking is confined: symlinks, nested paths and oversize zips refuse with fixed reasons (3f, #3663)', () => {
  const dir = mkdtempSync(join(tmpdir(), 'unpack-'))
  try {
    const zip = (name, setup, flags = []) => {
      const work = join(dir, name); mkdirSync(work, { recursive: true }); setup(work)
      spawnSync('/usr/bin/zip', ['-q', '-r', ...flags, join(dir, `${name}.zip`), '.'], { cwd: work })
      return readFileSync(join(dir, `${name}.zip`))
    }
    const good = unpackResults(zip('good', (w) => writeFileSync(join(w, 'step.json'), '{"version":1,"results":[]}')))
    assert.deepEqual(good, { files: [{ name: 'step.json', text: '{"version":1,"results":[]}' }] })
    const secret = join(dir, 'secret.txt'); writeFileSync(secret, '-----BEGIN PRIVATE KEY-----')
    const link = unpackResults(zip('link', (w) => symlinkSync(secret, join(w, 'x.json')), ['-y']))
    assert.deepEqual(link, { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('nested', (w) => { mkdirSync(join(w, 'sub')); writeFileSync(join(w, 'sub', 'x.json'), '{}') })), { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('other', (w) => writeFileSync(join(w, 'x.txt'), '{}'))), { reason: 'artifact_entry' })
    assert.deepEqual(unpackResults(zip('big', (w) => writeFileSync(join(w, 'x.json'), 'x'.repeat(2048))), { maxFile: 1024 }), { reason: 'artifact_size' })
    assert.deepEqual(unpackResults(zip('total', (w) => { writeFileSync(join(w, 'a.json'), 'x'.repeat(600)); writeFileSync(join(w, 'b.json'), 'x'.repeat(600)) }), { maxTotal: 1000 }), { reason: 'artifact_size' })
    assert.deepEqual(unpackResults(Buffer.from('not a zip')), { reason: 'artifact_zip' })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('unreadable results JSON refuses with a fixed reason and no file contents', () => {
  const L = 'a'.repeat(40); const bytes = Buffer.from('z')
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 1 },
    'repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100': { jobs: [] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [{ id: 10, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(bytes) }] }
  }
  const r = verifyCiRun({ github: { json: (p) => api[p], bytes: () => bytes }, unpack: () => ({ files: [{ name: 'x.json', text: '-----BEGIN PRIVATE KEY----- abc' }] }), repo: 'o/r', landed: L, label: '//a:b' })
  assert.equal(r.reason, 'results_unreadable')
  assert.ok(!JSON.stringify(r).includes('PRIVATE KEY'))
})

test('a partial rerun keeps each job leg at its newest attempt, and truncated listings refuse (Fable, #3663)', () => {
  const L = 'a'.repeat(40); const label = '//x:y'
  const bytes = { a1: Buffer.from('a1'), b1: Buffer.from('b1'), a2: Buffer.from('a2') }
  const rows = { a1: 'failed', b1: 'ran', a2: 'ran' }
  const artifact = (id, name, key) => ({ id, name, workflow_run: { id: 7 }, expired: false, digest: digest(bytes[key]) })
  const api = (extra = {}) => ({
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }], ...extra.checks },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2 },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ name: 'a', conclusion: 'success', run_attempt: 2 }, { name: 'b', conclusion: 'success', run_attempt: 1 }], ...extra.jobs },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [artifact(1, 'smthrs-results-a-0-1', 'a1'), artifact(2, 'smthrs-results-b-0-1', 'b1'), artifact(3, 'smthrs-results-a-0-2', 'a2')], ...extra.artifacts }
  })
  const verify = (extra) => {
    const responses = api(extra); const zips = { 1: bytes.a1, 2: bytes.b1, 3: bytes.a2 }
    return verifyCiRun({ github: { json: (p) => responses[p], bytes: (p) => zips[/artifacts\/(\d+)\/zip/.exec(p)[1]] }, unpack: (b) => ({ files: [{ name: 's.json', text: JSON.stringify({ version: 1, results: [{ label, status: rows[b.toString()] }] }) }] }), repo: 'o/r', landed: L, label })
  }
  const r = verify()
  assert.equal(r.pass, true, JSON.stringify(r))
  assert.deepEqual(r.evidence.rows.map(row => [row.artifact, row.status]), [['smthrs-results-a-0-2', 'ran'], ['smthrs-results-b-0-1', 'ran']])
  for (const extra of [{ checks: { total_count: 101 } }, { jobs: { total_count: 150 } }, { artifacts: { total_count: 500 } }]) assert.equal(verify(extra).reason, 'truncated', JSON.stringify(extra))
})

test('closure re-reads CI for a target receipt: a hand-written receipt that passes the local gate is refused', () => {
  const f = fixture()
  try {
    const mappings = JSON.parse(readFileSync(join(f.root, 'scripts/check-commands.json')))
    const { command, paths, ...rest } = mappings.checks['C-FIX-02']
    mappings.checks['C-FIX-02'] = { ...rest, target: '//fixture:canary' }
    f.put('scripts/check-commands.json', JSON.stringify(mappings))
    f.commit()
    f.put('.artifacts/checks/C-FIX-02/forged/log.txt', 'ok')
    f.put('.artifacts/checks/C-FIX-02/forged/receipt.json', JSON.stringify({ version: 1, check: 'C-FIX-02', commit: f.sha, layer: 'integration', command: ['smthrs-ci', '//fixture:canary'], exit: 0, started: '2026-10-03T00:00:00.000Z', ended: '2026-10-03T00:00:01.000Z', log_digest: digest('ok') }))
    const L = f.sha; const calls = []
    const github = { json: (p) => { calls.push(p); return p.includes('check-runs') ? { check_runs: [] } : {} }, bytes: () => Buffer.alloc(0) }
    const failures = reverifyCi({ root: f.root, repo: 'o/r', landed: L, receipts: ['.artifacts/checks/C-FIX-02/forged/receipt.json'], github })
    assert.deepEqual(failures, [{ check: 'C-FIX-02', receipt: '.artifacts/checks/C-FIX-02/forged/receipt.json', reason: 'missing' }])
    assert.ok(calls[0].startsWith(`repos/o/r/commits/${L}/check-runs`))
  } finally { f.cleanup() }
})

test('a rate-limited CI read during closure defers the close instead of crashing it (Fable N2)', () => {
  const f = fixture()
  try {
    const mappings = JSON.parse(readFileSync(join(f.root, 'scripts/check-commands.json')))
    for (const id of ['C-FIX-01', 'C-FIX-02']) { const { command, paths, ...rest } = mappings.checks[id]; mappings.checks[id] = { ...rest, target: `//fixture:${id}` } }
    f.put('scripts/check-commands.json', JSON.stringify(mappings))
    f.commit()
    const receipts = ['C-FIX-01', 'C-FIX-02'].map(id => {
      f.put(`.artifacts/checks/${id}/r/log.txt`, 'ok')
      f.put(`.artifacts/checks/${id}/r/receipt.json`, JSON.stringify({ version: 1, check: id, commit: f.sha, layer: 'integration', command: ['smthrs-ci', `//fixture:${id}`], exit: 0, started: '2026-10-03T00:00:00.000Z', ended: '2026-10-03T00:00:01.000Z', log_digest: digest('ok') }))
      return `.artifacts/checks/${id}/r/receipt.json`
    })
    const writes = []
    const gh = (args) => {
      if (args.includes('-i')) { writes.push(args); return '{}' }
      const error = new Error('gh: API rate limit exceeded'); error.stderr = 'API rate limit exceeded (HTTP 429)'; throw error
    }
    const out = claimRun(['comment', 'o/r#7', '--by', 'fixture', '--body', 'Complete', '--close', '--landed', f.sha, ...receipts.flatMap(p => ['--receipt', p])], { cwd: f.root, env: { SMITHERS_GITHUB_PROXY: 'http://fixture.test' }, ensure: () => {}, gh, ghBytes: gh })
    assert.equal(out.out.action, 'deferred', JSON.stringify(out))
    assert.ok(out.out.retry_at)
    assert.equal(writes.length, 0)
  } finally { f.cleanup() }
})

test('an empty or non-JSON results file refuses the receipt (38L: a crashed run leaves 0 bytes)', () => {
  const L = 'a'.repeat(40); const bytes = Buffer.from('z')
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 1 },
    'repos/o/r/actions/runs/7/attempts/1/jobs?per_page=100': { jobs: [] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [{ id: 10, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(bytes) }] }
  }
  for (const text of ['', 'not json', '{"results":[]}']) {
    const files = [{ name: 'attempt.json', text: '{"version":1,"results":[]}' }, { name: '__run.json', text: JSON.stringify({ version: 1, results: [{ label: '//a:b', status: 'ran' }] }) }, { name: '__run_2.json', text }]
    const r = verifyCiRun({ github: { json: (p) => api[p], bytes: () => bytes }, unpack: () => ({ files }), repo: 'o/r', landed: L, label: '//a:b' })
    assert.equal(r.reason, 'results_unreadable', JSON.stringify(text))
  }
})

test('a crashed latest attempt (empty results) refuses the label; it never inherits the earlier attempt\'s pass (38L)', () => {
  const L = 'a'.repeat(40); const label = '//x:y'
  const earlier = Buffer.from('earlier'); const crashed = Buffer.from('crashed')
  const files = new Map([
    [earlier.toString(), [{ name: '__run.json', text: JSON.stringify({ version: 1, results: [{ label, status: 'ran' }] }) }]],
    [crashed.toString(), [{ name: 'attempt.json', text: '{"version":1,"results":[]}' }, { name: '__run.json', text: '{"results":[],"version":1}' }]]
  ])
  const api = {
    [`repos/o/r/commits/${L}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: L, details_url: 'https://github.com/o/r/actions/runs/7/job/1' }] },
    'repos/o/r/actions/runs/7': { id: 7, head_sha: L, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: 'o/r' }, status: 'completed', run_attempt: 2 },
    'repos/o/r/actions/runs/7/attempts/2/jobs?per_page=100': { jobs: [{ name: 'test', conclusion: 'failure', run_attempt: 2 }] },
    'repos/o/r/actions/runs/7/artifacts?per_page=100': { artifacts: [
      { id: 1, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: digest(earlier) },
      { id: 2, name: 'smthrs-results-test-0-2', workflow_run: { id: 7 }, expired: false, digest: digest(crashed) }
    ] }
  }
  const zips = { 'repos/o/r/actions/artifacts/1/zip': earlier, 'repos/o/r/actions/artifacts/2/zip': crashed }
  const r = verifyCiRun({ github: { json: (p) => api[p], bytes: (p) => zips[p] }, unpack: (b) => ({ files: files.get(b.toString()) }), repo: 'o/r', landed: L, label })
  assert.equal(r.pass, false); assert.equal(r.reason, 'label_absent')
  assert.deepEqual(r.evidence.artifacts.map(a => a.name), ['smthrs-results-test-0-2'])
})

test('executable CLI closes recorder-produced evidence through isolated transport', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01', 'C-FIX-02'].map(id => {
      const result = f.recorded(id); assert.equal(result.status, 0, result.stdout + result.stderr)
      return JSON.parse(result.stdout).receipt
    })
    const out = f.cliClose(paths)
    assert.equal(out.status, 0, out.stdout + out.stderr)
    const writes = JSON.parse(readFileSync(join(f.root, 'transport.json'))).writes
    assert.equal(writes.length, 2)
    assert.equal(writes.filter(args => args.includes('PATCH')).length, 1)
    assert.equal(writes.filter(args => args.includes('DELETE')).length, 0)
  } finally { f.cleanup() }
})

test('recorder retains failed CI labels as failed evidence', () => {
  const f = fixture()
  try {
    const out = f.recorded('C-FIX-01', 'failed')
    assert.equal(out.status, 1, out.stdout + out.stderr)
    const path = JSON.parse(out.stdout).receipt
    assert.equal(JSON.parse(readFileSync(join(f.root, path))).exit, 1)
    const log = JSON.parse(readFileSync(join(f.root, path, '..', 'log.txt')))
    assert.equal(log.label, '//fixture:canary')
    assert.equal(log.reason, 'label_failed')
    assert.equal(log.pass, false)
    assert.deepEqual(f.close([path, f.evidence('C-FIX-02')]).out.checks, [{ check: 'C-FIX-01', receipt: path, reason: 'failed' }])
    assert.equal(f.writes.length, 0)
  } finally { f.cleanup() }
})

test('root-check-mapping-validation: markers refuse recorder and close without dispatch', () => {
  for (const status of ['manual', 'pending-owner']) {
    const f = fixture()
    try {
      const paths = ['C-FIX-01', 'C-FIX-02'].map(f.evidence)
      f.put('scripts/check-commands.json', JSON.stringify({ version: 1, checks: {
        'C-FIX-01': { status, reason: 'root inputs lack owner-reviewed validation', ticket: 'T-SEC-01' },
        'C-FIX-02': { approvedBy: 'smithers-22', automation: 'smthrs test //fixture:canary', runsIn: 'CI', host: 'CI', target: '//fixture:canary' }
      } }))
      f.commit()
      const out = f.runner()
      assert.equal(out.status, 2)
      assert.deepEqual(JSON.parse(out.stdout), { action: 'check-refused', check: 'C-FIX-01', reason: 'no reviewed executable mapping' })
      assert.deepEqual(f.close(paths).out.checks, [{ check: 'C-FIX-01', reason: 'missing' }])
      assert.equal(f.writes.length, 0)
    } finally { f.cleanup() }
  }
})

test('CI check runs for a different SHA refuse closure with commit and no writes', () => {
  const f = fixture()
  try {
    const paths = ['C-FIX-01', 'C-FIX-02'].map(f.evidence)
    f.ci().responses[`repos/o/r/commits/${f.sha}/check-runs?per_page=100`].check_runs[0].head_sha = 'b'.repeat(40)
    const out = f.close(paths)
    assert.equal(out.code, 2)
    assert.equal(out.out.action, 'evidence-refused')
    assert.deepEqual(out.out.checks, [
      { check: 'C-FIX-01', receipt: paths[0], reason: 'commit' },
      { check: 'C-FIX-02', receipt: paths[1], reason: 'commit' }
    ])
    assert.equal(f.writes.length, 0)
  } finally { f.cleanup() }
})

test('scripts/checks retains only the host sampler and no duplicate runner', () => {
  const dir = new URL('./checks/', import.meta.url)
  assert.deepEqual(readdirSync(dir).sort(), ['host-process-sampler.mjs', 'host-process-sampler.test.mjs'])
  for (const name of readdirSync(dir)) assert.doesNotMatch(readFileSync(new URL(name, dir), 'utf8'), /check-run|check-evidence|check-commands|host-profile|ops-health-line/)
})
