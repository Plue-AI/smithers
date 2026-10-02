import { writeSync } from 'node:fs'

// Observe the production publication boundary and deliver a real kernel signal there.
// No backend, shutdown handler, process emitter, or cleanup implementation is replaced.
const originalLog = console.log
console.log = (...values: unknown[]) => {
  if (typeof values[0] !== 'string' || !values[0].startsWith('SMITHERS_LOCAL_ORIGIN=')) {
    originalLog(...values)
    return
  }
  const signal = process.env.SMITHERS_SERVE_READINESS_SIGNAL
  if (signal !== 'SIGINT' && signal !== 'SIGTERM') throw new Error('Missing readiness signal')
  writeSync(1, `SERVE_READINESS_RECEIPT=${JSON.stringify({
    signal,
    SIGINT: process.listenerCount('SIGINT'),
    SIGTERM: process.listenerCount('SIGTERM')
  })}\n`)
  originalLog(...values)
  process.kill(process.pid, signal)
}
