/** Installed-product samples use one named clock; library counter gates cannot serve. */
export function summarize(samples, fields, minimum) {
  if (!Number.isInteger(minimum) || minimum < 100) throw new Error('minimum must be at least 100')
  if (!Array.isArray(samples) || samples.length < minimum) throw new Error(`requires ${minimum} samples`)
  if (!Array.isArray(fields) || !fields.length || new Set(fields).size !== fields.length) throw new Error('distinct measurement fields required')
  for (const sample of samples) {
    if (!sample || typeof sample.clock !== 'string' || !sample.clock.trim()) throw new Error('sample clock required')
    if (sample.failed !== false) throw new Error('sample must explicitly succeed')
    for (const field of fields) {
      if (!Number.isFinite(sample[field]) || sample[field] < 0) throw new Error(`invalid ${field}`)
    }
  }
  if (new Set(samples.map((sample) => sample.clock)).size !== 1) throw new Error('incomparable sample clocks')
  return Object.fromEntries(fields.map((field) => {
    const sorted = samples.map((sample) => sample[field]).sort((a, b) => a - b)
    return [field, { n: sorted.length, p50: sorted[Math.ceil(sorted.length * 0.5) - 1], p95: sorted[Math.ceil(sorted.length * 0.95) - 1] }]
  }))
}

/** Recompute a hold from retained guest evidence, never a provider's verdict. */
export function verifyRebase(sample, { requireDrain = true } = {}) {
  const { hold, receipt, pending, marker, main, acknowledgementsWithheld } = sample ?? {}
  if (!/^[a-f0-9]{40}$/.test(main ?? '') || !pending || pending.state !== 'pending' || pending.present !== true || pending.onto !== main || pending.rebased !== false || !pending.member) throw new Error('rebase pending evidence missing or mismatched')
  if (!receipt || typeof receipt.id !== 'string' || !receipt.id || receipt.onto !== main) throw new Error('rebase receipt identity missing or mismatched')
  if (!hold || hold.id !== receipt.id || typeof hold.clock !== 'string' || !hold.clock.startsWith('guest monotonic:') || hold.clock.length <= 'guest monotonic:'.length || hold.clock !== sample.clock ||
      !Number.isFinite(hold.start) || !Number.isFinite(hold.end) || hold.start < 0 || hold.end < hold.start || sample.holdMs !== hold.end - hold.start) throw new Error('rebase duration differs from guest hold observation')
  if (receipt.activity?.length !== 1 || receipt.activity[0].kind !== 'rebase' || receipt.activity[0].onto !== main) throw new Error('requires one attributed rebase activity')
  if (typeof receipt.headChanged !== 'boolean' || receipt.approvalsCleared !== receipt.headChanged) throw new Error('rebase approval clearing differs from head change')
  if (typeof marker !== 'string' || !marker || receipt.marker?.text !== marker || receipt.marker.member !== pending.member) throw new Error('held edit missing or attributed to another member')
  if (acknowledgementsWithheld && (hold.acknowledgedBeforeThaw !== false || hold.localSnapshotQueued !== true || !Number.isFinite(hold.withheldMs) || hold.withheldMs < 10000 || requireDrain && sample.outboxDrained !== true)) throw new Error('delayed rebase capture or outbox drain evidence missing')
  return hold.end - hold.start
}

/** Ordinary delivery and delayed acknowledgements must each meet C-PERF-06. */
export function summarizeRebases(samples) {
  if (!Array.isArray(samples) || samples.some(sample => typeof sample?.acknowledgementsWithheld !== 'boolean')) throw new Error('rebase acknowledgement cohort required')
  if (new Set(samples.map(sample => sample.marker)).size !== samples.length || samples.some(sample => typeof sample.marker !== 'string' || !sample.marker)) throw new Error('distinct retained rebase markers required')
  for (const sample of samples) verifyRebase(sample)
  if (new Set(samples.map(sample => sample.receipt.id)).size !== samples.length) throw new Error('distinct rebase receipts required')
  return Object.fromEntries([false, true].map(withheld => {
    const stats = summarize(samples.filter(sample => sample.acknowledgementsWithheld === withheld), ['holdMs'], 100)
    if (stats.holdMs.p95 >= 2000) throw new Error('rebase hold p95 must be below 2000 ms in each acknowledgement cohort')
    return [withheld ? 'withheld' : 'normal', stats]
  }))
}
