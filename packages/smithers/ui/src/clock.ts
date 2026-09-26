/** React clocks shared by DOM and terminal projections; subscribers own timers.
 * @since 0.1.0
 */
import { useMemo, useSyncExternalStore } from "react"

/** A stable external-store snapshot, sampled only while a reader subscribes.
 * @category constructors
 * @since 0.1.0
 */
export const createClock = <T>(sample: () => T, intervalMs: number, enabled = true) => {
  let value = sample()
  const listeners = new Set<() => void>()
  let timer: ReturnType<typeof setInterval> | undefined
  const tick = () => {
    const next = sample()
    if (Object.is(value, next)) return
    value = next
    for (const listener of listeners) listener()
  }
  return {
    snapshot: () => value,
    subscribe: (listener: () => void): (() => void) => {
      listeners.add(listener)
      if (enabled && timer === undefined) {
        timer = setInterval(tick, intervalMs)
        tick()
      }
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          clearInterval(timer)
          timer = undefined
        }
      }
    }
  }
}

/** Wall time at the renderer's cadence, paused when no work needs a clock.
 * @category hooks
 * @since 0.1.0
 */
export const useClock = (running: boolean, intervalMs = 1000): number => {
  const clock = useMemo(() => createClock(() => Date.now(), intervalMs, running), [running, intervalMs])
  return useSyncExternalStore(clock.subscribe, clock.snapshot, clock.snapshot)
}

/** Extend a recorded engine timestamp by local monotonic time while running.
 * @category hooks
 * @since 0.1.0
 */
export const useObservedClock = (recordedAt: number | undefined, running: boolean): number | undefined => {
  const clock = useMemo(() => {
    const receivedAt = performance.now()
    return createClock(() => recordedAt === undefined ? undefined : recordedAt + (running
      ? Math.floor(Math.max(0, performance.now() - receivedAt) / 1000) * 1000 : 0), 1000, running && recordedAt !== undefined)
  }, [recordedAt, running])
  return useSyncExternalStore(clock.subscribe, clock.snapshot, () => recordedAt)
}
