import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { readFileSync, readdirSync, rmSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { test } from 'node:test'
import { createServer, connect } from 'node:net'
import { validMapping } from './check-evidence.mjs'
import { fixture } from './fixtures/check-receipts.mjs'

const digest = (data) => `sha256:${createHash('sha256').update(data).digest('hex')}`

test('runner writes observed receipt and scrubs credentials; all close variants close exactly once', () => {
  const f = fixture()
  try {
    const before = Date.now(); const paths = ['C-FIX-01','C-FIX-02'].map(f.evidence); const after = Date.now()
    const r = JSON.parse(readFileSync(join(f.root, paths[0])))
    assert.deepEqual(Object.keys(r).sort(), ['version','check','commit','layer','command','exit','started','ended','log_digest'].sort())
    assert.equal(r.version, 1); assert.equal(r.commit, f.sha); assert.match(r.commit, /^[a-f0-9]{40}$/)
    assert.equal(r.check, 'C-FIX-01'); assert.equal(r.layer, 'integration'); assert.deepEqual(r.command, ['node','canary.mjs']); assert.equal(r.exit, 0); assert.ok(Number.isInteger(r.exit)); assert.match(r.log_digest, /^sha256:[a-f0-9]{64}$/)
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

test('runner refuses missing, unwritten, unparsable and unavailable mappings; failed command remains failed', () => {
  const f = fixture()
  try {
    for (const declaration of ['Automation: unavailable · Runs in: CI','Automation: `node missing.mjs` (to write) · Runs in: CI','Automation: prose PASS · Runs in: CI','Automation: `node canary.mjs` · Runs in: reference host']) {
      f.put('.specs/engineering/checks/C-FIX-01.md', `Layer: integration\n${declaration}\n`); f.commit(); const result = f.runner(); assert.equal(result.status,2); assert.equal(JSON.parse(result.stdout).action,'check-refused'); assert.equal(JSON.parse(result.stdout).receipt,undefined)
    }
    assert.equal(f.runner('C-ABS-01').status,2)
    f.put('.specs/engineering/checks/C-FIX-01.md','Layer: integration\nAutomation: `node canary.mjs` · Runs in: CI\n')
    assert.equal(f.runner('C-FIX-01',{CI:''}).status,2)
    rmSync(join(f.root,'canary.mjs')); f.commit(); assert.equal(f.runner().status,2)
    f.put('canary.mjs','process.exit(9)'); f.commit(); const failed = f.runner(); assert.equal(failed.status,9)
    const path = JSON.parse(failed.stdout).receipt; assert.equal(JSON.parse(readFileSync(join(f.root,path))).exit,9)
    assert.equal(f.close([path]).code,2); assert.equal(f.writes.length,0)
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

test('machine execution and escaping mapped command paths are refused without receipts', () => {
  const f = fixture()
  try {
    for (const mapping of [
      {approvedBy:'smithers-22',automation:'node canary.mjs',runsIn:'CI',host:'machine',command:['node','canary.mjs'],paths:['canary.mjs']},
      {approvedBy:'smithers-22',automation:'node canary.mjs',runsIn:'CI',host:'CI',command:['node','canary.mjs'],paths:['../canary.mjs']}
    ]) {
      f.put('scripts/check-commands.json',JSON.stringify({version:1,activation:{mappingsApprovedBy:'smithers-22',coverageAcceptedBy:'smithers-8a'},checks:{'C-FIX-01':mapping}}))
      f.commit(); const out = f.runner(); assert.equal(out.status,2); assert.equal(JSON.parse(out.stdout).receipt,undefined); assert.equal(f.writes.length,0)
    }
  } finally { f.cleanup() }
})

test('journey check IDs retain numeric stages in runner and ticket-derived coverage', () => {
  const f = fixture()
  try {
    f.put('.specs/engineering/tickets/T-FIX-01.md','Issue: https://github.com/o/r/issues/7\n## Acceptance\n- C-J1-01\n- C-FIX-02\n')
    f.put('.specs/engineering/checks/C-J1-01.md','Layer: integration\nAutomation: `node canary.mjs` · Runs in: CI\n')
    f.put('scripts/check-commands.json',JSON.stringify({version:1,activation:{mappingsApprovedBy:'smithers-22',coverageAcceptedBy:'smithers-8a'},checks:Object.fromEntries(['C-FIX-01','C-J1-01','C-FIX-02'].map(id=>[id,{approvedBy:'smithers-22',automation:'node canary.mjs',runsIn:'CI',host:'CI',command:['node','canary.mjs'],paths:['canary.mjs']}]))}))
    f.commit(); assert.equal(f.close(['C-J1-01','C-FIX-02'].map(f.evidence)).code,0)
  } finally { f.cleanup() }
})

test('landed ancestry and production receipts also work in a jj-colocated fixture checkout', () => {
  const f = fixture()
  try {
    const init = spawnSync('jj',['git','init','--colocate',f.root],{encoding:'utf8',env:{PATH:process.env.PATH,HOME:join(f.root,'home')}})
    assert.equal(init.status,0,init.stderr)
    assert.equal(f.close(['C-FIX-01','C-FIX-02'].map(f.evidence)).code,0)
  } finally { f.cleanup() }
})

// Expected committed input and coverage policy: T-PRC-03 Goal / spec §21.4a.
test('dirty command and ticket edits cannot forge committed execution or coverage', () => {
  const f = fixture()
  try {
    f.put('canary.mjs','process.exit(9)'); f.commit()
    f.put('canary.mjs',"console.log('locally passing')")
    const out = f.runner(); assert.equal(out.status,9)
    assert.equal(JSON.parse(readFileSync(join(f.root,JSON.parse(out.stdout).receipt))).commit,f.sha)
    f.put('canary.mjs',"console.log('committed pass')"); f.commit()
    const receipt = f.evidence('C-FIX-01')
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

test('concurrent working-source changes cannot alter the executed snapshot', () => {
  const f = fixture()
  try {
    f.put('canary.mjs', `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(join(f.root,'seed'))}, 'concurrent edit'); try { writeFileSync('seed','snapshot edit'); process.exit(34) } catch (e) { if (!['EPERM','EACCES','EROFS'].includes(e.code)) throw e } console.log(readFileSync('seed','utf8'))`)
    f.commit()
    const path = f.evidence('C-FIX-01')
    assert.equal(readFileSync(join(f.root,'seed'),'utf8'),'concurrent edit')
    assert.equal(readFileSync(join(f.root,path,'..','log.txt'),'utf8'),'fixture\n')
    assert.equal(JSON.parse(readFileSync(join(f.root,path))).commit,f.sha)
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
test('inventory covers every check exactly once and executable mappings require approval, command and host', () => {
  const root=new URL('../',import.meta.url)
  const mappings=JSON.parse(readFileSync(new URL('scripts/check-commands.json',root)))
  const files=readdirSync(new URL('.specs/engineering/checks/',root)).filter(n=>/^C-.*\.md$/.test(n)).map(n=>n.slice(0,-3)).sort()
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
    for (const command of [[], null, ['node','other.mjs'], ['node','canary.mjs','extra'], ['canary.mjs','node']]) {
      f.put(paths[0],JSON.stringify({...r,command}))
      const out = f.close(paths)
      assert.equal(out.code,2); assert.deepEqual(out.out.checks,[{check:'C-FIX-01',receipt:paths[0],reason:'coverage'}]); assert.equal(f.writes.length,0)
    }
  } finally { f.cleanup() }
})
test('check cannot connect to the operator proxy canary listener', async () => {
  const f = fixture(); let connections = 0
  const server = createServer(socket => { connections++; socket.end() })
  try {
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve))
    const port = server.address().port
    // Real unsandboxed control proves the listener is reachable on this host.
    await new Promise((resolve,reject)=>{ const s=connect(port,'127.0.0.1'); s.on('error',reject); s.on('end',resolve); s.resume() })
    assert.equal(connections,1); connections=0
    f.put('canary.mjs', `import { connect } from 'node:net'; const s=connect(${port},'127.0.0.1'); s.on('connect',()=>{s.destroy();process.exit(41)}); s.on('error',()=>{console.log('proxy denied')}); s.setTimeout(2000,()=>{s.destroy();process.exit(42)});`)
    f.commit()
    const child=spawn(process.execPath,['scripts/check-run.mjs','C-FIX-01'],{cwd:f.root,env:{...process.env,HOME:join(f.root,'home'),CI:'true',SMITHERS_GITHUB_PROXY:`http://localhost:${port}`}})
    let stdout='',stderr=''; child.stdout.on('data',d=>stdout+=d); child.stderr.on('data',d=>stderr+=d)
    const exit=await new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',resolve)})
    assert.equal(exit,0,stderr+stdout); assert.equal(connections,0)
    assert.equal(readFileSync(join(f.root,JSON.parse(stdout).receipt,'..','log.txt'),'utf8'),'proxy denied\n')
  } finally { await new Promise(resolve=>server.close(resolve)); f.cleanup() }
})
test('check cannot read gh authentication configuration', () => {
  const f=fixture()
  try {
    f.put('home/.config/gh/hosts.yml','operator-token')
    f.put('canary.mjs', `import {readFileSync} from 'node:fs'; try {readFileSync(${JSON.stringify(join(f.root,'home/.config/gh/hosts.yml'))});process.exit(43)} catch(e) {if(!['EACCES','EPERM'].includes(e.code))throw e;console.log('gh denied')}`)
    f.commit(); const path=f.evidence('C-FIX-01')
    assert.equal(readFileSync(join(f.root,path,'..','log.txt'),'utf8'),'gh denied\n')
  } finally { f.cleanup() }
})
