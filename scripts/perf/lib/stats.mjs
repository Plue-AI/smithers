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
