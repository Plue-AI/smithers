/** Record the existing authenticated Go host response; never detect or size locally. */
export function publicOrigin(value) {
  let url
  try { url = new URL(value) } catch { throw new Error('T-INS-04: configured public origin required') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('public origin required')
  if (['localhost', '[::1]', '0.0.0.0', '[::]', '::1'].includes(url.hostname) || /^127\./.test(url.hostname) || url.hostname.endsWith('.localhost')) throw new Error('T-INS-04: remote origin required')
  return url.origin
}

export function validateHost(host) {
  const profile = host?.profile
  for (const field of ['memory_bytes', 'perf_cores', 'physical_cores', 'disk_free_bytes']) {
    if (!Number.isSafeInteger(profile?.[field]) || profile[field] < 0) throw new Error(`host profile missing ${field}`)
  }
  if (typeof profile.macos_version !== 'string' || !profile.macos_version || typeof profile.hypervisor !== 'boolean') throw new Error('host platform missing')
  if (!host.limits || typeof host.limits !== 'object' || Array.isArray(host.limits) || !Object.keys(host.limits).length) throw new Error('derived host limits missing')
  return host
}

export async function readHost(origin, credential) {
  const headers = typeof credential === 'object' && credential?.cookie
    ? { Cookie: credential.cookie } : { Authorization: `Bearer ${credential}` }
  // /api/host was retired when Settings collapsed into the install contract.
  // Read the same Go capacity service through the owner-only metrics adapter.
  const response = await fetch(`${publicOrigin(origin)}/api/install/metrics`, {
    headers, redirect: 'error', signal: AbortSignal.timeout(10000)
  })
  if (response.status !== 200) throw new Error(`T-INS-06: GET /api/install/metrics returned ${response.status}`)
  return validateHost((await response.json()).host)
}
