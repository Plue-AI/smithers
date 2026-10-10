import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'

// A declared host class is routing metadata, never proof of host identity.
export function requireReferenceFaultHost({ platform, uuid, hosts, bundleExists }) {
  if (platform !== 'darwin') throw new Error('reference faults require the approved macOS reference host')
  if (!uuid || !hosts.some(host => host.ioPlatformUUID?.toLowerCase() === uuid.toLowerCase())) {
    throw new Error('reference faults require an IOPlatformUUID in scripts/reference-host/hosts.json')
  }
  if (!bundleExists) throw new Error('reference faults require the installed bundle at .artifacts/fault-install-bundle')
}

if (process.argv[1]?.endsWith('/fault-reference-host.mjs')) {
  try {
    const platform = process.platform
    const hardware = platform === 'darwin' ? execFileSync('/usr/sbin/ioreg', ['-rd1', '-c', 'IOPlatformExpertDevice'], { encoding: 'utf8' }) : ''
    requireReferenceFaultHost({
      platform,
      uuid: hardware.match(/"IOPlatformUUID"\s*=\s*"([^"]+)"/)?.[1],
      hosts: JSON.parse(readFileSync('scripts/reference-host/hosts.json', 'utf8')).hosts,
      bundleExists: existsSync('.artifacts/fault-install-bundle')
    })
  } catch (error) {
    console.error(error.message)
    process.exitCode = 1
  }
}
