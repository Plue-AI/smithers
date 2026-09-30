import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../../', import.meta.url))

for (const name of ['review', 'bug-worker']) {
  test(`${name} deploy requires a qualified Cloud rollout`, () => {
    const packageDirectory = join(root, 'apps', name)
    const manifest = JSON.parse(readFileSync(join(packageDirectory, 'package.json'), 'utf8'))
    assert.equal(typeof manifest.scripts?.deploy, 'string')

    const fixture = mkdtempSync(join(tmpdir(), 'smithers-deploy-qualification-'))
    try {
      const bin = join(fixture, 'bin')
      const marker = join(fixture, 'alchemy-invoked')
      mkdirSync(bin)
      const fake = join(bin, 'alchemy')
      writeFileSync(fake, '#!/usr/bin/env node\n' +
        'const { writeFileSync } = require("node:fs");\n' +
        'writeFileSync(process.env.SMITHERS_FAKE_ALCHEMY_MARKER, process.argv.slice(2).join(" "));\n',
      { mode: 0o755 })
      if (process.platform === 'win32') {
        writeFileSync(`${fake}.cmd`, `@"${process.execPath}" "${fake}" %*\r\n`)
      }

      // Exclude the repository's node_modules/.bin and every installed publisher.
      const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => key.toLowerCase() !== 'path'))
      env.PATH = [bin, dirname(process.execPath)].join(delimiter)
      env.SMITHERS_FAKE_ALCHEMY_MARKER = marker
      const result = spawnSync(manifest.scripts.deploy, {
        cwd: packageDirectory,
        env,
        shell: true,
        encoding: 'utf8',
        timeout: 10_000,
      })

      assert.deepEqual({
        nonzeroExit: result.status !== 0 && result.status !== null,
        alchemyInvoked: existsSync(marker),
        qualifiedCloudRolloutExplained: /qualified Cloud rollout/i.test(result.stderr ?? ''),
      }, {
        nonzeroExit: true,
        alchemyInvoked: false,
        qualifiedCloudRolloutExplained: true,
      }, `deploy command: ${manifest.scripts.deploy}\nstdout: ${result.stdout}\nstderr: ${result.stderr}\nerror: ${result.error ?? 'none'}`)
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
}
