import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import { isAbsolute } from 'node:path'

const execute = promisify(execFile)
export function identityPath(env) {
  const identity = env.SMITHERS_PERF_SSH_IDENTITY
  if (!identity || !isAbsolute(identity) || /[\r\n\0]/.test(identity)) throw new Error('absolute SSH identity required')
  return identity
}

export function fingerprint(publicKey) {
  const parts = publicKey.trim().split(/\s+/)
  if (parts.length < 2 || !/^(ssh-ed25519|ssh-rsa|ecdsa-sha2-nistp(?:256|384|521))$/.test(parts[0]) || !/^[A-Za-z0-9+/]+={0,2}$/.test(parts[1])) throw new Error('invalid SSH public key')
  const bytes = Buffer.from(parts[1], 'base64')
  if (bytes.toString('base64') !== parts[1] || bytes.length < 8 || bytes.readUInt32BE(0) !== parts[0].length || bytes.subarray(4, 4 + parts[0].length).toString() !== parts[0]) throw new Error('invalid SSH public key encoding')
  return `SHA256:${createHash('sha256').update(bytes).digest('base64').replace(/=+$/, '')}`
}

/** Match the actual private identity's public fingerprint to the signed-in
 * member's registered keys before opening any scratch repository channel.
 * ssh-keygen reads an operator credential; it never executes repository code.
 */
export async function authenticatedSSHKey(context, origin, identity) {
  const response = await context.request.get(`${origin}/api/user/keys`, { maxRedirects: 0, timeout: 10000 })
  if (response.status() !== 200) throw new Error(`SSH fixture: keys returned ${response.status()}`)
  const keys = await response.json()
  let publicKey
  try { publicKey = (await execute('/usr/bin/ssh-keygen', ['-y', '-P', '', '-f', identity], { timeout: 5000, maxBuffer: 16384 })).stdout }
  catch { throw new Error('SSH fixture: private identity cannot be read noninteractively') }
  const selected = fingerprint(publicKey)
  if (!Array.isArray(keys) || !keys.some(key => key.fingerprint === selected)) throw new Error('SSH fixture: identity is not registered to the authenticated member')
  return selected
}
