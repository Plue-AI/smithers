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


/** Member identity comes from the owner-authenticated historical lookup;
 * ingress and retention come from the guest, using that same opaque reference.
 */
export function verifyHeldMarker(hold, marker, member) {
  const observed = hold?.markerObservation
  const raw = observed?.marker
  const attribution = marker?.attributionReceipt
  if (!observed || observed.phase !== 'marker' || observed.id !== hold.id || observed.branch !== hold.branch || observed.onto !== hold.onto ||
      observed.clock !== hold.clock || observed.start !== hold.start || raw?.text !== marker?.text || raw?.actor_reference !== marker?.actor_reference || raw?.typedDuringHold !== true ||
      !/^[a-f0-9]{32}$/.test(raw?.actor_reference ?? '') || !Number.isFinite(raw?.received) || !Number.isFinite(raw?.lastReceived) || !Number.isFinite(raw?.applied) ||
      raw.received < hold.start || raw.lastReceived < raw.received || raw.lastReceived > hold.end || raw.applied < hold.end ||
      !attribution || attribution.branch !== hold.branch || hold.clock !== `guest monotonic:${attribution.boot}` ||
      !Number.isSafeInteger(attribution.actor?.member_id) || attribution.actor.member_id < 1 || attribution.actor?.kind !== 'person' || attribution.actor?.via !== 'web' || String(attribution.actor?.member_id) !== member || marker?.member !== member) {
    throw new Error('guest held marker or authenticated member attribution mismatched')
  }
  return marker
}
