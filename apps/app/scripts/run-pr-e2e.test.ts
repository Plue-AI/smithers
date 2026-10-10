import { expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from './test-child'

for (const shard of [undefined, '1', '2', '3']) test(`browser runner preserves tiers for shard ${shard ?? 'local'}`, () => {
  const root = mkdtempSync(join(tmpdir(), 'browser-shard-'))
  try {
    const log = join(root, 'commands')
    writeFileSync(join(root, 'pnpm'), '#!/usr/bin/env node\nrequire("fs").appendFileSync(process.env.COMMAND_LOG, JSON.stringify({args:process.argv.slice(2),skip:process.env.SMITHERS_SKIP_SPA_BUILD})+"\\n")\n')
    chmodSync(join(root, 'pnpm'), 0o755)
    const result = spawnSync('node', [join(import.meta.dir, 'run-pr-e2e.mjs'), ...(shard ? [shard] : [])], {
      encoding: 'utf8', env: { ...process.env, PATH: `${root}:${process.env.PATH}`, COMMAND_LOG: log }
    })
    expect(result.status).toBe(0)
    const commands = readFileSync(log, 'utf8').trim().split('\n').map(line => JSON.parse(line))
    expect(commands.slice(0, 4).map(command => command.args)).toEqual([
      ['exec', 'playwright', 'install', '--with-deps', 'chromium'], ['run', 'test:e2e:auth'],
      ['run', 'test:e2e:probes'], ['run', 'test:e2e:graph-lifecycle']
    ])
    expect(commands[4].args).toEqual(['exec', 'playwright', 'test', ...(shard ? [`--shard=${shard}/3`] : [])])
    if (!shard || shard === '3') {
      expect(commands.slice(5).map(command => command.args.at(-1))).toEqual([
        'playwright.showcase.config.ts', 'playwright.site.config.ts', 'playwright.graph.config.ts'
      ])
      expect(commands[5].skip).toBe(shard ? undefined : '1')
    } else expect(commands.length).toBe(5)
  } finally { rmSync(root, { recursive: true, force: true }) }
})
