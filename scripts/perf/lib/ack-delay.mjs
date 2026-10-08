/** Owner-authenticated one-shot capture delay. Host ACK evidence cannot stand
 * in for the guest's retained snapshot, thaw or drained outbox observation. */
export function acknowledgementDelay({ origin, branch, cookie }) {
  if (!cookie) throw new Error('owner session required')
  const csrf = cookie.match(/(?:^|;\s*)__csrf=([^;]+)/)?.[1]
  if (!csrf) throw new Error('owner cookie must include __csrf')
  let armed
  const request = async (method, delay) => {
    const response = await fetch(`${origin}/api/install/ack-delay${method === 'GET' ? `?branch=${encodeURIComponent(branch)}` : ''}`, {
      method, redirect: 'error', signal: AbortSignal.timeout(10000),
      headers: { Cookie: cookie, Origin: origin, 'X-CSRF-Token': csrf, 'Content-Type': 'application/json' },
      ...(method === 'POST' ? { body: JSON.stringify({ branch, delay_ms: delay }) } : {})
    })
    if (response.status !== 200) throw new Error(`${method} /api/install/ack-delay: ${response.status}`)
    const receipt = await response.json()
    if (receipt.branch !== branch) throw new Error('acknowledgement receipt branch mismatch')
    return receipt
  }
  return {
    async arm(delay) {
      if (delay !== 0 && delay !== 10000) throw new Error('delay must be 0 or 10000 ms')
      const receipt = await request('POST', delay)
      if (delay) {
        if (receipt.state !== 'armed' || !/^[a-f0-9-]{36}$/.test(receipt.id ?? '') || !/^[a-f0-9]{32}$/.test(receipt.boot ?? '')) throw new Error('invalid armed acknowledgement receipt')
        armed = receipt
      }
      return receipt
    },
    async read() {
      const receipt = await request('GET')
      if (armed && (receipt.id !== armed.id || receipt.boot !== armed.boot)) throw new Error('acknowledgement window replaced or machine reconnected')
      return receipt
    }
  }
}
