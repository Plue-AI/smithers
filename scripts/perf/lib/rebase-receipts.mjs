/** The observed barrier and completion must describe the same guest rewrite. */
export function verifyHeldObservation(held, { branch, onto }, thawed) {
  if (!branch || !/^[a-f0-9]{40}$/.test(onto ?? '') || held?.phase !== 'held' || !held.id || held.branch !== branch || held.onto !== onto ||
      !/^guest monotonic:[a-f0-9]{32}$/.test(held.clock ?? '') || !Number.isFinite(held.start) || held.start < 0) throw new Error('guest held observation missing or mismatched')
  if (thawed && (thawed.phase !== 'thawed' || thawed.id !== held.id || thawed.branch !== held.branch || thawed.onto !== held.onto || thawed.clock !== held.clock || thawed.start !== held.start || !Number.isFinite(thawed.end) || thawed.end < held.start)) throw new Error('guest thaw does not bind the observed hold')
  return held
}

export function verifyCaptureDelay(receipt, hold, armed) {
  if (!armed || armed.state !== 'armed' || !armed.id || !armed.branch || !armed.boot || receipt.id !== armed.id || receipt.branch !== armed.branch || receipt.boot !== armed.boot || hold.branch !== armed.branch || hold.clock !== `guest monotonic:${armed.boot}`) throw new Error('host delay does not bind the armed branch window')
  if (!/^[a-f0-9]{32}$/.test(hold.capture?.event ?? '') || !/^[a-f0-9]{32}$/.test(hold.capture?.boot ?? '') || !Number.isSafeInteger(hold.capture?.sequence) || hold.capture.sequence < 1) throw new Error('guest capture identity missing or invalid')
  if (receipt.state !== 'acknowledged' || receipt.event !== hold.capture?.event || receipt.boot !== hold.capture?.boot || receipt.sequence !== hold.capture?.sequence || !Number.isFinite(receipt.withheld_ms) || receipt.withheld_ms < 10000) throw new Error('host delay does not bind the guest capture')
  if (hold.acknowledgedBeforeThaw !== false || hold.localSnapshotQueued !== true) throw new Error('guest did not queue and thaw before host acknowledgement')
  return receipt
}

/** Drain must identify the complete queued capture, not only its event UUID. */
export function verifyDrain(drained, hold) {
  if (!hold?.capture || !hold.id || !hold.branch || !hold.onto || !hold.clock || !drained?.capture || drained.phase !== 'drained' || drained.id !== hold.id || drained.branch !== hold.branch || drained.onto !== hold.onto || drained.clock !== hold.clock || drained.capture?.event !== hold.capture?.event || drained.capture?.boot !== hold.capture?.boot || drained.capture?.sequence !== hold.capture?.sequence || drained.outboxDepth !== 0) throw new Error('guest outbox drain does not bind the held capture')
  return drained
}

