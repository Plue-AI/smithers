import assert from 'node:assert/strict'
import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir, userInfo } from 'node:os'
import { basename, join } from 'node:path'
import { run } from '../issue-claim.mjs'

// Literal policy oracles from T-PRC-03 Tests / C-PRC-03 Pass when, not production data.
export const fixture = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'prc03-')))
  const put = (path, data) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), data) }
  const git = (...args) => execFileSync('/usr/bin/git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  git('init'); git('config', 'user.email', 'fixture@example.test'); git('config', 'user.name', 'Fixture')
  put('seed', 'fixture'); git('add', 'seed'); git('commit', '-m', 'fixture'); let sha = git('rev-parse', 'HEAD')
  git('init', '--bare', 'remote.git'); git('remote', 'add', 'origin', join(root, 'remote.git'))
  for (const name of ['check-run.mjs', 'check-evidence.mjs']) cpSync(new URL(`../${name}`, import.meta.url), join(root, 'scripts', name), { recursive: false })
  put('.specs/engineering/tickets/T-FIX-01.md', 'Issue: [#7](https://github.com/o/r/issues/7)\n## Acceptance\n- [C-FIX-01](../checks/C-FIX-01.md)\n- [C-FIX-02](../checks/C-FIX-02.md)\n## Risks\n')
  const config = join(root, 'home/.config/issue-claim')
  put('home/.config/issue-claim/canary', 'secret')
  put('canary.mjs', `import { readFileSync } from 'node:fs'; import { homedir, userInfo } from 'node:os'; for (const name of ['GH_TOKEN','GITHUB_TOKEN','SMITHERS_GITHUB_PROXY']) if (name in process.env) process.exit(31); try { readFileSync(homedir()+'/.config/issue-claim/canary'); process.exit(32) } catch {} try { readFileSync(${JSON.stringify(join(userInfo().homedir, '.config/issue-claim/app.json'))}); process.exit(33) } catch (error) { if (!['EPERM','EACCES','ENOENT'].includes(error.code)) throw error } console.log('canary passed')`)
  for (const id of ['C-FIX-01', 'C-FIX-02']) put(`.specs/engineering/checks/${id}.md`, `Proves: fixture · Layer: integration\nAutomation: \`node canary.mjs\` · Runs in: CI\n`)
  put('scripts/check-commands.json', JSON.stringify({ version: 1, activation: { mappingsApprovedBy: 'smithers-22', coverageAcceptedBy: 'smithers-8a' }, checks: Object.fromEntries(['C-FIX-01','C-FIX-02'].map(id => [id, { approvedBy: 'smithers-22', automation: 'node canary.mjs', runsIn: 'CI', host: 'CI', command: ['node', 'canary.mjs'], paths: ['canary.mjs'] }])) }))
  const commit = () => { git('add','scripts','.specs','canary.mjs'); git('commit','--allow-empty','-m','fixture inputs'); sha = git('rev-parse','HEAD'); git('push', 'origin', 'HEAD:refs/heads/main'); return sha }
  commit()
  const runner = (id = 'C-FIX-01', extra = {}) => spawnSync(process.execPath, ['scripts/check-run.mjs', id], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: join(root, 'home'), CI: 'true', GH_TOKEN: 'canary', GITHUB_TOKEN: 'canary', SMITHERS_GITHUB_PROXY: 'http://127.0.0.1:47821', ...extra } })
  const writes = []; let closed = false; let comments = [{ body: `Claimed by fixture on ${hostname()} at ${new Date().toISOString()}; expires ${new Date(Date.now()+6*3600_000).toISOString()}`, created_at: new Date().toISOString() }]; let labeled = true
  // Only remote transport is intercepted; production parser, gate and proxy write() run.
  const gh = (args) => {
    const path = args.find(a => a.startsWith('http://fixture.test/'))
    if (path.includes('/_smithers/admission')) return JSON.stringify({ principal: 'fixture', deferred: false })
    if (args.includes('-i')) { writes.push(args); if (args.includes('PATCH')) closed = true; if (args.includes('DELETE')) labeled = false; if (path.endsWith('/comments')) comments.push({ body: args.find(a => a.startsWith('body=')).slice(5) }); return '{}' }
    if (path.includes('/comments?')) return JSON.stringify([comments])
    if (path.includes('/events?')) return '[[]]'
    return JSON.stringify({ state: closed ? 'closed' : 'open', labels: labeled ? ['in-progress'] : [] })
  }
  const close = (receipts = [], extra = [], landed = sha) => run(['comment', 'o/r#7', '--by', 'fixture', '--body', 'Complete', '--close', ...(landed === null ? [] : ['--landed', landed]), ...receipts.flatMap(p => ['--receipt', p]), ...extra], { cwd: root, env: { SMITHERS_GITHUB_PROXY: 'http://fixture.test' }, ensure: () => {}, gh })
  const evidence = (id) => { const out = runner(id); assert.equal(out.status, 0, out.stderr + out.stdout); return JSON.parse(out.stdout).receipt }
  const invoke = (argv) => run(argv,{cwd:root,env:{SMITHERS_GITHUB_PROXY:'http://fixture.test'},ensure:()=>{},gh})
  return { root, put, git, get sha() { return sha }, commit, config, runner, close, writes, evidence, invoke, cleanup: () => { if (process.env.PRC03_EVIDENCE_DIR) cpSync(root, join(process.env.PRC03_EVIDENCE_DIR, 'fixtures', basename(root)), { recursive: true }); rmSync(root, { recursive: true, force: true }) } }
}

