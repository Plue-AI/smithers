import test from 'node:test'
import assert from 'node:assert/strict'
import { identityPath, fingerprint } from './ssh-member.mjs'

test('SSH identity paths and public encodings refuse injected options and malformed keys', () => {
  assert.equal(identityPath({ SMITHERS_PERF_SSH_IDENTITY: '/tmp/credential' }), '/tmp/credential')
  for (const path of [undefined, '', '-oProxyCommand=x', 'relative', '/tmp/key\nother', '/tmp/key\0']) assert.throws(() => identityPath({ SMITHERS_PERF_SSH_IDENTITY: path }))
  for (const key of ['', 'ssh-ed25519 !!!', 'ssh-rsa YQ==', 'command="x" ssh-ed25519 YQ==', 'ssh-ed25519 AAAA']) assert.throws(() => fingerprint(key))
})
