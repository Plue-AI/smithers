import { execFileSync, spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { createHash } from 'node:crypto'
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
  for (const id of ['C-FIX-01', 'C-FIX-02']) put(`.specs/engineering/checks/${id}.md`, `Proves: fixture · Layer: integration
Automation: \`smthrs test //fixture:canary\` · Runs in: CI
`)
  put('scripts/check-commands.json', JSON.stringify({ version: 1, checks: Object.fromEntries(['C-FIX-01','C-FIX-02'].map(id => [id, { approvedBy: 'smithers-22', automation: 'smthrs test //fixture:canary', runsIn: 'CI', host: 'CI', target: '//fixture:canary' }])) }))
  const commit = () => { git('add','scripts','.specs'); git('commit','--allow-empty','-m','fixture inputs'); sha = git('rev-parse','HEAD'); git('push', 'origin', 'HEAD:refs/heads/main'); return sha }
  commit()
  const runner = (id = 'C-FIX-01') => spawnSync(process.execPath, ['scripts/check-run.mjs', id, '--landed', sha], { cwd: root, encoding: 'utf8', env: { ...process.env, HOME: join(root, 'home'), CI: 'true' } })
  const hash = data => `sha256:${createHash('sha256').update(data).digest('hex')}`
  // Literal CI responses and real artifact zip: closure uses the production verifier.
  let cachedCi
  const ci = (repo = 'o/r') => {
    if (cachedCi?.sha === sha && cachedCi.repo === repo) return cachedCi
    const mappings = JSON.parse(git('show', `${sha}:scripts/check-commands.json`))
    put('ci/results.json', JSON.stringify({ version: 1, results: Object.values(mappings.checks).filter(m => m.target).map(m => ({ label: m.target, status: 'ran', key: 'fixture' })) }))
    rmSync(join(root, 'ci/artifact.zip'), { force: true })
    execFileSync('/usr/bin/zip', ['-q', 'artifact.zip', 'results.json'], { cwd: join(root, 'ci') })
    const bytes = readFileSync(join(root, 'ci/artifact.zip'))
    return cachedCi = { sha, repo, bytes, responses: {
      [`repos/${repo}/commits/${sha}/check-runs?per_page=100`]: { check_runs: [{ app: { slug: 'github-actions' }, head_sha: sha, details_url: `https://github.com/${repo}/actions/runs/7/job/1` }] },
      [`repos/${repo}/actions/runs/7`]: { id: 7, head_sha: sha, event: 'push', head_branch: 'main', path: '.github/workflows/ci.yml', repository: { full_name: repo }, status: 'completed', run_attempt: 1 },
      [`repos/${repo}/actions/runs/7/attempts/1/jobs?per_page=100`]: { jobs: [{ name: 'test', conclusion: 'success' }] },
      [`repos/${repo}/actions/runs/7/artifacts?per_page=100`]: { artifacts: [{ id: 10, name: 'smthrs-results-test-0-1', workflow_run: { id: 7 }, expired: false, digest: hash(bytes) }] }
    } }
  }
  const writes = []; let closed = false; let comments = [{ body: `Claimed by fixture on ${hostname()} at ${new Date().toISOString()}; expires ${new Date(Date.now()+6*3600_000).toISOString()}`, created_at: new Date().toISOString() }]; let labeled = true
  // Only remote transport is intercepted; production parser, gate and proxy write() run.
  const gh = (args) => {
    const path = args.find(a => a.startsWith('http://fixture.test/'))
    if (path.includes('/commits/') || path.includes('/actions/')) return JSON.stringify(ci().responses[path.split('http://fixture.test/')[1]])
    if (path.includes('/_smithers/admission')) return JSON.stringify({ principal: 'fixture', deferred: false })
    if (args.includes('-i')) { writes.push(args); if (args.includes('PATCH')) closed = true; if (args.includes('DELETE')) labeled = false; if (path.endsWith('/comments')) comments.push({ body: args.find(a => a.startsWith('body=')).slice(5) }); return '{}' }
    if (path.includes('/comments?')) return JSON.stringify([comments])
    if (path.includes('/events?')) return '[[]]'
    return JSON.stringify({ state: closed ? 'closed' : 'open', labels: labeled ? ['in-progress'] : [] })
  }
  const close = (receipts = [], extra = [], landed = sha) => run(['comment', 'o/r#7', '--by', 'fixture', '--body', 'Complete', '--close', ...(landed === null ? [] : ['--landed', landed]), ...receipts.flatMap(p => ['--receipt', p]), ...extra], { cwd: root, env: { SMITHERS_GITHUB_PROXY: 'http://fixture.test' }, ensure: () => {}, gh, ghBytes })
  const ghBytes = args => { const path = args.find(a => a.startsWith('http://fixture.test/')); if (!path.endsWith('/actions/artifacts/10/zip')) throw new Error('unexpected binary read'); return ci().bytes }
  const evidence = id => {
    const mappings = JSON.parse(git('show', `${sha}:scripts/check-commands.json`))
    const started = new Date().toISOString(); const dir = `.artifacts/checks/${id}/${started.replace(/[:.]/g, '-')}`
    const log = JSON.stringify({ label: mappings.checks[id].target, pass: true, reason: 'pass' }) + '\n'
    put(`${dir}/log.txt`, log)
    put(`${dir}/receipt.json`, JSON.stringify({ version: 1, check: id, commit: sha, layer: 'integration', command: ['smthrs-ci', mappings.checks[id].target], exit: 0, started, ended: new Date().toISOString(), log_digest: hash(log) }))
    return `${dir}/receipt.json`
  }
  const invoke = (argv) => run(argv,{cwd:root,env:{SMITHERS_GITHUB_PROXY:'http://fixture.test'},ensure:()=>{},gh,ghBytes})
  return { root, put, git, get sha() { return sha }, commit, ci, runner, close, writes, evidence, invoke, cleanup: () => { if (process.env.PRC03_EVIDENCE_DIR) cpSync(root, join(process.env.PRC03_EVIDENCE_DIR, 'fixtures', basename(root)), { recursive: true }); rmSync(root, { recursive: true, force: true }) } }
}

