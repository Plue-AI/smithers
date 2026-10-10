import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { classify, command, connections, readiness, journey, pouredBottle } from './release-install.mjs'

async function directory(t) {
  const path = await mkdtemp(join(tmpdir(), 'release-install-'))
  t.after(() => rm(path, { recursive: true, force: true }))
  return path
}
test('the brew-info boundary requires the named release and a real bottle pour', async t => {
  const evidence = await directory(t)
  const data = { formulae: [{ full_name: 'smithersai/tap/smithers', installed: [{ version: '1.2.3', poured_from_bottle: true }] }] }
  const result = await command(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', JSON.stringify(data)], evidence, 'brew-info')
  assert.equal(pouredBottle(result.stdout, 'v1.2.3').poured_from_bottle, true)
  for (const installed of [[{ version: '1.2.3', poured_from_bottle: false }], [{ version: '1.2.4', poured_from_bottle: true }], [], [{ version: '1.2.3' }]]) {
    data.formulae[0].installed = installed
    assert.throws(() => pouredBottle(JSON.stringify(data), 'v1.2.3'), /keg|bottle/)
  }
  assert.throws(() => pouredBottle('{}', 'v1.2.3'), /keg/)
})
test('connection classification is exact and cannot approve Smithers hosts', () => {
  const roster = { distribution: ['github.com'], provider: ['api.example.org'], registry: ['registry.npmjs.org'], apple: ['apple.com', 'smithers.sh'] }
  for (const [host, result] of [['GITHUB.COM.', 'distribution'], ['api.example.org', 'provider'], ['registry.npmjs.org', 'registry'], ['apple.com', 'apple'], ['smithers.sh', 'forbidden'], ['a.smithers.sh', 'forbidden'], ['jjhub.tech', 'forbidden'], ['evil.github.com', 'unclassified'], ['github.com.evil.org', 'unclassified']]) assert.equal(classify(host, roster), result)
  assert.throws(() => classify('bad/host', roster), /Invalid hostname/)
})
test('production recorder executes argv without a shell and retains timed stdout/stderr', async t => {
  const evidence = await directory(t)
  const receipt = await command(process.execPath, ['-e', 'console.log(process.argv[1]); console.error("diagnostic")', '$(false); literal'], evidence, 'argv')
  assert.equal(receipt.status, 0)
  assert.match(receipt.stdout, /\$\(false\); literal/)
  assert.match(receipt.stderr, /diagnostic/)
  assert.ok(receipt.durationMs > 0)
  const events = (await readFile(join(evidence, 'argv.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse)
  assert.equal(events[0].uid, process.getuid())
  assert.equal(events.at(-1).event, 'end')
  assert.ok(events.every(event => Number.isFinite(Date.parse(event.at))))
})
test('failed commands, privilege prompts, missing executables and timeouts keep evidence', async t => {
  const evidence = await directory(t)
  for (const [name, program, args, timeout, expected] of [
    ['exit', process.execPath, ['-e', 'process.exit(7)'], 1000, /exited 7/],
    ['prompt', process.execPath, ['-e', 'console.log("Password:")'], 1000, /Privilege prompt/],
    ['missing', '/does-not-exist-smithers', [], 1000, /ENOENT/],
    ['timeout', process.execPath, ['-e', 'setInterval(()=>{},1000)'], 30, /abort/i]
  ]) {
    await assert.rejects(command(program, args, evidence, name, timeout), expected)
    const rows = (await readFile(join(evidence, `${name}.jsonl`), 'utf8')).trim().split('\n').map(JSON.parse)
    assert.ok(rows.at(-1).failure)
  }
})
test('readiness uses real HTTP, retries unhealthy responses, and records the transition', async t => {
  const evidence = await directory(t)
  let calls = 0
  const server = createServer((req, res) => { assert.equal(req.url, '/readyz'); res.writeHead(++calls === 1 ? 503 : 200); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  const result = await readiness(`http://127.0.0.1:${server.address().port}/readyz`, evidence, 10000)
  assert.equal(result.ready, true)
  assert.deepEqual(result.attempts.map(row => row.status), [503, 200])
  assert.deepEqual(JSON.parse(await readFile(join(evidence, 'readiness.json'), 'utf8')), result)
})
test('unhealthy HTTP retains failure and external or redirect URLs cannot qualify', async t => {
  const evidence = await directory(t)
  const server = createServer((req, res) => { res.writeHead(302, { location: 'https://smithers.sh' }); res.end() })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => { server.closeAllConnections(); return new Promise(resolve => server.close(resolve)) })
  await assert.rejects(readiness(`http://127.0.0.1:${server.address().port}/readyz`, evidence, 40), /timed out/)
  assert.equal(JSON.parse(await readFile(join(evidence, 'readiness.json'), 'utf8')).ready, false)
  for (const url of ['https://127.0.0.1/readyz', 'http://example.org/readyz', 'http://localhost/other', 'http://localhost/readyz?token=x', 'http://owner:secret@localhost/readyz']) await assert.rejects(readiness(url, evidence), /loopback|credentials/)
})
test('resolver export is retained, bounded by session, and unknown connections fail closed', async t => {
  const evidence = await directory(t), path = join(evidence, 'export')
  const raw = ['2026-10-08T00:00:00Z', '2026-10-08T00:01:00Z', '2026-10-08T00:02:00Z'].map(at => JSON.stringify({ at, hostname: 'github.com' })).join('\n')
  await writeFile(path, raw)
  const rows = await connections(path, { distribution: ['github.com'] }, evidence, '2026-10-08T00:01:00Z', '2026-10-08T00:01:00Z')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].category, 'distribution')
  assert.equal(await readFile(join(evidence, 'dns.jsonl'), 'utf8'), raw)
  for (const host of ['smithers.sh', 'unknown.org']) {
    const target = await directory(t)
    await writeFile(path, JSON.stringify({ at: '2026-10-08T00:01:00Z', hostname: host }))
    await assert.rejects(connections(path, {}, target, '2026-10-08T00:00:00Z', '2026-10-08T00:02:00Z'), /forbidden or unclassified/)
    assert.equal(JSON.parse(await readFile(join(target, 'connections.json'), 'utf8'))[0].hostname, host)
  }
})
test('empty and malformed DNS evidence fail; existing evidence cannot be overwritten', async t => {
  const evidence = await directory(t), path = join(evidence, 'export')
  await writeFile(path, '')
  await assert.rejects(connections(path, {}, evidence, '2026-10-08', '2026-10-09'), /Empty/)
  await assert.rejects(connections(path, {}, evidence, '2026-10-08', '2026-10-09'), /EEXIST/)
  const other = await directory(t)
  await writeFile(path, '{"at":"invalid","hostname":"github.com"}')
  await assert.rejects(connections(path, {}, other, '2026-10-08', '2026-10-09'), /timestamp/)
})
test('Linux execution refuses install qualification before reading config', { skip: process.platform === 'darwin' && process.arch === 'arm64' && process.getuid() !== 0 }, async () => {
  await assert.rejects(journey('/does-not-exist'), /unprivileged Apple Silicon/)
})
