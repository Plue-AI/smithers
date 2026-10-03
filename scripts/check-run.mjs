#!/usr/bin/env node
/** Run only reviewed engineering commands behind an OS credential boundary. @since 0.1.0 */
import { execFileSync, spawnSync } from 'node:child_process'
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir, userInfo } from 'node:os'
import { join } from 'node:path'
import { confined, fullSha, gitRead, hashLog, validMapping } from './check-evidence.mjs'

const root = realpathSync(process.cwd())
const id = process.argv[2]
const refuse = (reason) => { console.log(JSON.stringify({ action: 'check-refused', check: id, reason })); process.exitCode = 2 }
let snapshot
try {
  if (process.argv.length !== 3 || !/^C-[A-Z][A-Z0-9]*-\d+$/.test(id ?? '')) throw new Error('expected one check ID')
  const commit = gitRead(root, ['rev-parse', 'HEAD'])
  if (!fullSha(commit)) throw new Error('full commit SHA unavailable')
  snapshot = realpathSync(mkdtempSync(join(tmpdir(), 'check-source-')))
  const archive = execFileSync('/usr/bin/git', ['archive', commit], { cwd: root, maxBuffer: 256 << 20 })
  execFileSync('/usr/bin/tar', ['-xf', '-', '-C', snapshot], { input: archive })
  const doc = readFileSync(join(snapshot, `.specs/engineering/checks/${id}.md`), 'utf8')
  const declaration = /^Automation: `([^`\n]+)`(?:[^\n]*?) · Runs in: ([^\n]+)$/m.exec(doc)
  if (!declaration || /to write|unwritten|unavailable/i.test(declaration[0])) throw new Error('absent, unwritten or unparsable Automation')
  const layer = /\bLayer: ([a-z]+)\b/.exec(doc)?.[1]
  const mappings = JSON.parse(readFileSync(join(snapshot, 'scripts/check-commands.json'), 'utf8'))
  const mapping = mappings.version === 1 && mappings.checks[id]
  if (!layer || !validMapping(mapping) || mapping.status || mapping.automation !== declaration[1] || mapping.runsIn !== declaration[2] || !Array.isArray(mapping.command) || !mapping.command.length || mapping.command.some(arg => typeof arg !== 'string' || !arg) || !Array.isArray(mapping.paths) || !mapping.paths.length) throw new Error('no reviewed executable mapping')
  // CI is an explicit execution location; reference/manual/machine execution stays refused
  // until its owner supplies a trusted host selector. No caller host override exists.
  if (mapping.host !== 'CI' || !['true', '1'].includes(process.env.CI)) throw new Error('declared host unavailable')
  for (const path of mapping.paths) confined(snapshot, path, '.')
  // Resolve publication endpoints before removing their discovery variable.
  const proxy = new URL(process.env.SMITHERS_GITHUB_PROXY || 'http://127.0.0.1:47821')
  if (!['http:', 'https:'].includes(proxy.protocol)) throw new Error('invalid publication proxy')
  const proxyPorts = [...new Set([47821, Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80))])]
  const env = Object.fromEntries(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CI', 'GOCACHE', 'GOMODCACHE', 'GOPATH'].filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]))
  const protectedPaths = [...new Set([homedir(), userInfo().homedir].flatMap(home => ['issue-claim', 'gh'].flatMap(name => { const path = join(home, '.config', name); try { return [path, realpathSync(path)] } catch { return [path] } })))]
  let binary; let args
  if (process.platform === 'darwin') {
    binary = '/usr/bin/sandbox-exec'
    const profile = `(version 1)(allow default)${proxyPorts.map(port => `(deny network-outbound (remote ip "*:${port}"))`).join('')}(deny file-write* (subpath ${JSON.stringify(snapshot)}))(deny file-read* ${protectedPaths.map(path => `(subpath ${JSON.stringify(path)})`).join(' ')})`
    args = ['-p', profile, ...mapping.command]
  } else if (process.platform === 'linux') {
    binary = '/usr/bin/bwrap'
    args = ['--die-with-parent', '--unshare-pid', '--unshare-net', '--ro-bind', '/', '/', '--dev-bind', '/dev', '/dev', '--proc', '/proc', '--tmpfs', '/tmp', '--ro-bind', snapshot, snapshot]
    for (const path of protectedPaths) { try { lstatSync(path); args.push('--tmpfs', path) } catch { /* absent configuration is unreadable */ } }
    args.push('--', ...mapping.command)
  } else throw new Error('credential sandbox unavailable')
  if (!lstatSync(binary).isFile()) throw new Error('credential sandbox unavailable')
  const started = new Date().toISOString()
  const child = spawnSync(binary, args, { cwd: snapshot, env, encoding: null, maxBuffer: 64 << 20 })
  const ended = new Date().toISOString()
  if (child.error) throw child.error
  const exit = child.status ?? 1
  const log = Buffer.concat([child.stdout ?? Buffer.alloc(0), child.stderr ?? Buffer.alloc(0)])
  const dir = join('.artifacts/checks', id, `${started.replace(/[:.]/g, '-')}-${process.pid}`)
  // Never follow a pre-existing artifact symlink on publication either.
  let current = root
  for (const part of dir.split('/')) {
    current = join(current, part)
    try { if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('unsafe artifact directory') } catch (error) { if (error.code !== 'ENOENT') throw error; mkdirSync(current) }
  }
  writeFileSync(join(root, dir, 'log.txt'), log, { flag: 'wx' })
  writeFileSync(join(root, dir, 'receipt.json'), JSON.stringify({ version: 1, check: id, commit, layer, command: mapping.command, exit, started, ended, log_digest: hashLog(log) }, null, 2) + '\n', { flag: 'wx' })
  console.log(JSON.stringify({ check: id, receipt: join(dir, 'receipt.json'), exit }))
  process.exitCode = exit
} catch (error) { refuse(error.message) } finally { if (snapshot) rmSync(snapshot, { recursive: true, force: true }) }
