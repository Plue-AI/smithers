import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { runSelected } from './run.mjs'
import { summarizeRebases } from './lib/stats.mjs'

export const markers = Array.from({ length: 100 }, (_, i) => `REBASE${String(i).padStart(3, '0')}`)

/** C-PERF-06 contract driver. All actions are public person boundaries; scratch
 * pushes are unprivileged guest SSH actions. No daemon RPC or host execution is
 * a measurement adapter. Production binding waits on T-STK-08's action, guest
 * hold logs and acknowledgement-delay fixture, and T-APP-14's retained edits.
 */
export async function measure(boundary) {
  const samples = []
  let failure
  let attempt
  try {
    for (const acknowledgementsWithheld of [false, true]) {
      await boundary.acknowledgementWindow(acknowledgementsWithheld ? 10000 : 0)
      for (const [i, marker] of markers.entries()) {
        attempt = { i, marker: `${acknowledgementsWithheld ? 'DELAY' : 'NORMAL'}_${marker}`, acknowledgementsWithheld, failed: true }
        // pushScratchMain is implemented only by the qualified unprivileged
        // machine fixture; the Macs never run scratch repository commands.
        const main = await boundary.pushScratchMain(i, acknowledgementsWithheld)
        if (!/^[a-f0-9]{40}$/.test(main ?? '')) throw new Error('scratch main push requires a full commit SHA')
        attempt.main = main
        await boundary.retryGitHubSync()
        const pending = await boundary.waitRebasePending(main)
        if (pending.state !== 'pending' || pending.present !== true || pending.onto !== main || pending.rebased !== false || !pending.member) throw new Error('rebase ran before the present member acted')
        await boundary.pressRebaseNow()
        await boundary.waitWriteHold()
        const typed = `${acknowledgementsWithheld ? 'DELAY' : 'NORMAL'}_${marker}`
        await boundary.typeMarker(typed)
        const receipt = await boundary.waitRebased(main)
        if (typeof receipt.id !== 'string' || !receipt.id) throw new Error('rebase receipt identity missing')
        const hold = await boundary.guestHold(receipt.id)
        attempt.hold = hold
        attempt.clock = hold?.clock
        attempt.holdMs = hold?.end - hold?.start
        if (!hold || hold.id !== receipt.id || typeof hold.clock !== 'string' || !hold.clock.startsWith('guest monotonic:') ||
            !Number.isFinite(hold.start) || !Number.isFinite(hold.end) || hold.end < hold.start) throw new Error('guest hold clock receipt missing or mismatched')
        if (receipt.onto !== main || receipt.activity?.length !== 1 || receipt.activity[0].kind !== 'rebase' || receipt.activity[0].onto !== main) throw new Error('requires one attributed rebase activity')
        if (typeof receipt.headChanged !== 'boolean' || receipt.headChanged && receipt.approvalsCleared !== true || !receipt.headChanged && receipt.approvalsCleared !== false) throw new Error('rebase approval clearing differs from head change')
        if (receipt.marker?.text !== typed || receipt.marker.member !== pending.member) throw new Error('held edit missing or attributed to another member')
        if (acknowledgementsWithheld) {
          if (hold.acknowledgedBeforeThaw !== false || hold.localSnapshotQueued !== true || !Number.isFinite(hold.withheldMs) || hold.withheldMs < 10000) throw new Error('rebase waited for acknowledgement or failed to queue capture')
          await boundary.waitOutboxDrained(receipt.id)
        }
        samples.push({ i, marker: typed, main, acknowledgementsWithheld, hold, activity: receipt.activity, holdMs: hold.end - hold.start, clock: hold.clock, failed: false })
        attempt = undefined
      }
    }
  } catch (error) {
    failure = error
    if (attempt) samples.push({ ...attempt, error: error.message })
  } finally {
    try { await boundary.acknowledgementWindow(0) } catch (error) {
      if (failure) failure.cleanupError = error.message
      else failure = error
    }
  }
  if (failure) { failure.samples = samples; throw failure }
  let stats
  try { stats = summarizeRebases(samples) } catch (error) { error.samples = samples; throw error }
  return { samples, stats }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exitCode = await runSelected('C-PERF-06')
