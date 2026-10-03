#!/usr/bin/env node
/** Record reviewed engineering targets from CI at a landed commit. @since 0.1.0 */
import { execFileSync } from 'node:child_process'
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expectedCommand, fullSha, gitRead, hashLog, unpackResults, validMapping, verifyCiRun, zeroTests } from './check-evidence.mjs'

const root = realpathSync(process.cwd())
/** Writes one receipt and its log; never follows a pre-existing artifact symlink. */
const publish = ({ id, commit, layer, command, exit, started, ended, log }) => {
  const dir = join('.artifacts/checks', id, `${started.replace(/[:.]/g, '-')}-${process.pid}`)
  let current = root
  for (const part of dir.split('/')) {
    current = join(current, part)
    try { if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('unsafe artifact directory') } catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current) }
  }
  writeFileSync(join(root, dir, 'log.txt'), log, { flag: 'wx' })
  writeFileSync(join(root, dir, 'receipt.json'), JSON.stringify({ version: 1, check: id, commit, layer, command, exit, started, ended, log_digest: hashLog(log) }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ check: id, receipt: join(dir, 'receipt.json'), exit }))
  // The receipt records the observed exit; closure also refuses an empty run.
  process.exitCode = exit === 0 && zeroTests(log) ? 1 : exit
}
const id = process.argv[2]
const refuse = (reason) => { console.log(JSON.stringify({ action: 'check-refused', check: id, reason })); process.exitCode = 2 }
try {
  const landed = process.argv[3] === '--landed' && process.argv.length === 5 ? process.argv[4] : undefined
  if (!landed || !/^C-[A-Z][A-Z0-9]*-\d+$/.test(id ?? '')) throw new Error('expected one check ID with --landed <sha>')
  const commit = landed
  if (!fullSha(commit)) throw new Error('full commit SHA unavailable')
  const doc = gitRead(root, ['show', `${landed}:.specs/engineering/checks/${id}.md`])
  const declaration = /^Automation: `([^`\n]+)`(?:[^\n]*?) · Runs in: ([^\n]+)$/m.exec(doc)
  if (!declaration || /to write|unwritten|unavailable/i.test(declaration[0])) throw new Error('absent, unwritten or unparsable Automation')
  const layer = /\bLayer: ([a-z]+)\b/.exec(doc)?.[1]
  const mappings = JSON.parse(gitRead(root, ['show', `${landed}:scripts/check-commands.json`]))
  const mapping = mappings.version === 1 && mappings.checks[id]
  if (mapping && !mapping.status && !('target' in mapping)) throw new Error('argv mappings are not executable; map the check to a smthrs target')
  if (!layer || !validMapping(mapping) || mapping.status || mapping.automation !== declaration[1] || mapping.runsIn !== declaration[2]) throw new Error('no reviewed executable mapping')
  // CI already ran the label at `landed`: read its record, execute nothing (#3663).
  const repo = /github\.com[:/]([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(gitRead(root, ['remote', 'get-url', 'origin']))?.[1]
  const { proxied } = await import('./issue-claim.mjs')
  const { ensure, proxyUrl } = await import('./github-proxy.mjs')
  await ensure()
  const text = proxied({ gh: (args) => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 64 << 20 }), base: proxyUrl(process.env) })
  const binary = proxied({ gh: (args) => execFileSync('gh', args, { encoding: 'buffer', maxBuffer: 256 << 20 }), base: proxyUrl(process.env) })
  const started = new Date().toISOString()
  const verdict = verifyCiRun({ github: { json: (path) => JSON.parse(text.read(['api', path])), bytes: (path) => binary.read(['api', path]) }, unpack: unpackResults, repo, landed, label: mapping.target })
  publish({ id, commit, layer, command: expectedCommand(mapping), exit: verdict.pass ? 0 : 1, started, ended: new Date().toISOString(), log: Buffer.from(`${JSON.stringify({ label: mapping.target, ...verdict }, null, 2)}\n`) })
} catch (error) { refuse(error.message) }
