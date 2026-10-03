import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { test } from 'node:test'

// T-INS-05 Changes; spec §16.1.0: the image and its production launchers are cut.
const removed = ['distribution/Dockerfile', 'distribution/entrypoint.sh',
  'distribution/publish-image.sh', 'distribution/publish-image.test.mjs',
  'distribution/test-image.sh', 'apps/app/scripts/mode-matrix/docker-web-selfhost.ts',
  'apps/app/scripts/mode-matrix/docker-web-selfhost.test.ts',
  'apps/site/src/content/docs/docs/self-hosting.mdx',
  'scripts/repo-contract/distribution-image-tag.test.mjs']
test('Mac distribution deletes the Docker product and keeps lifecycle port sources', () => {
  for (const path of removed) assert.equal(existsSync(path), false, path)
  for (const path of ['backup.sh', 'restore.sh', 'upgrade.sh', 'lib.sh']) {
    assert.equal(existsSync(`distribution/${path}`), true, path)
  }
  for (const path of ['.github/workflows/release.yml', '.github/workflows/distribution.yml',
    'apps/app/scripts/run-packaged-mode-matrix.ts', 'scripts/set-release-version.mjs',
    'scripts/check-toolchain-pins.mjs', 'scripts/PACKAGE.ts', 'scripts/repo-contract/PACKAGE.ts',
    'distribution/README.md', 'packages/backend/docs/distribution-release.md',
    'packages/backend/docs/upgrade-recovery.md']) {
    const text = readFileSync(path, 'utf8')
    assert.doesNotMatch(text, /distribution\/Dockerfile|ghcr\.io\/smithersai\/smithers|docker-web-selfhost|SMITHERS_MODE_MATRIX_IMAGE|distribution-publish:/, path)
  }
})

import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

// Actual template fetch wrapper, isolated from Homebrew DSL and live signing.
// T-INS-05 Tests: archive faults refuse before extraction; production qualification
// still requires the real tap, signatures, bottle and host commands on macOS.
for (const fault of ['none', 'archive', 'checksum', 'signature']) {
  test(`tap download verification ${fault}: preserves extraction boundary`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'smithers-brew-fetch-'))
    try {
      const template = readFileSync('distribution/homebrew/Formula/smithers.rb.in', 'utf8')
        .replaceAll('@@VERSION@@', '1.2.3')
        .replaceAll('@@CLI_SHA256@@', 'a'.repeat(64))
        .replaceAll('@@BUNDLE_SHA256@@', 'b'.repeat(64))
        .replace('@@QUALIFIED_MANIFEST_AND_SIGNING@@', 'raise "unqualified signing"')
        .replace('@@QUALIFIED_BOTTLE_METADATA@@', '')
      const archive = join(dir, 'archive')
      const sums = join(dir, 'SHA256SUMS')
      const signature = join(dir, 'signature')
      const extracted = join(dir, 'extracted')
      const digest = createHash('sha256').update('original').digest('hex')
      writeFileSync(join(dir, 'smithers.rb'), template)
      writeFileSync(archive, fault === 'archive' ? 'changed' : 'original')
      writeFileSync(sums, `${fault === 'checksum' ? '0'.repeat(64) : digest}  smithers-v1.2.3-darwin-arm64.tar.gz\n`)
      writeFileSync(signature, fault === 'signature' ? 'invalid' : 'valid')
      const result = spawnSync('ruby', ['scripts/fixtures/homebrew-fetch.rb', join(dir, 'smithers.rb')], {
        encoding: 'utf8', timeout: 10_000,
        env: { PATH: process.env.PATH, ARCHIVE: archive, SUMS: sums, SIGNATURE: signature,
          FETCH_MARKER: join(dir, 'fetched'), EXTRACT_MARKER: extracted }
      })
      assert.equal(result.error, undefined)
      if (fault === 'none') assert.equal(result.status, 0, result.stderr)
      else {
        assert.notEqual(result.status, 0)
        assert.match(result.stderr, fault === 'signature' ? /invalid signature/ : /archive is not in the signed release/)
      }
      assert.equal(existsSync(extracted), fault === 'none')
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
}

test('Homebrew release remains disconnected until real bundle and pour qualification', () => {
  const workflow = readFileSync('.github/workflows/release.yml', 'utf8').split('  homebrew-bottle:')[1]
  assert.ok(workflow)
  assert.match(workflow, /if: \$\{\{ false \}\}/)
  assert.match(workflow, /runs-on: macos-15/)
  assert.match(workflow, /name: installer-darwin-arm64/)
  assert.match(workflow, /exit 1/)
  assert.doesNotMatch(workflow, /sudo|contents: write|id-token: write|s3|gh release upload/)
})

test('missing bottle cannot become a successful source installation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'smithers-brew-source-'))
  try {
    const template = readFileSync('distribution/homebrew/Formula/smithers.rb.in', 'utf8')
      .replaceAll('@@VERSION@@', '1.2.3')
      .replaceAll('@@CLI_SHA256@@', 'a'.repeat(64))
      .replaceAll('@@BUNDLE_SHA256@@', 'b'.repeat(64))
      .replace('@@QUALIFIED_MANIFEST_AND_SIGNING@@', 'raise "unqualified signing"')
      .replace('@@QUALIFIED_BOTTLE_METADATA@@', '')
    const path = join(dir, 'smithers.rb')
    writeFileSync(path, template)
    const result = spawnSync('ruby', ['scripts/fixtures/homebrew-fetch.rb', path, 'source-install'], {
      encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH }
    })
    assert.equal(result.error, undefined)
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /A prebuilt bottle is required/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
