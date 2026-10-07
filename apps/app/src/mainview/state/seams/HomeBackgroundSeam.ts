import { z } from "zod"
import { randomUuid } from "../../runtime/RandomUuid"
import type { Session } from "../AppState"
import type { SeamFetch } from "./SeamContext"
import type { ControllerContext } from "../controller/context"

type Request = NonNullable<Session["homeBackgroundRequests"]>[number]
const Receipt = z.object({ state: z.string(), run_id: z.number().int().positive() })

/** Persist before acknowledgement; admission and remote settlement keep one toast. */
export function createHomeBackgroundSeam(options: {
  readonly http: SeamFetch
  readonly owner: () => string | undefined
  readonly epoch?: () => number
  readonly load: () => readonly Request[]
  readonly save: (requests: Request[]) => Promise<unknown>
  readonly withToast: ControllerContext["withToast"]
  readonly report: (error: unknown) => void
  readonly failed?: (request: Request, message: string) => void
  readonly pollMs?: number
}) {
  let disposed = false
  let saving = Promise.resolve<unknown>(undefined)
  const active = new Map<string, Promise<void>>()
  const starting = new Map<string, Promise<{ readonly value: string }>>()
  let abort = new AbortController()
  let observedOwner = options.owner()
  let observedEpoch = options.epoch?.()
  const current = (request: Request) => !disposed && options.owner() === request.owner
  const update = (request: Request) => {
    const work = saving.then(() => options.save([...options.load().filter(row => row.key !== request.key), request]))
    saving = work.catch(() => {})
    return work
  }
  const pause = () => new Promise<void>(resolve => {
    const signal = abort.signal
    const done = () => { clearTimeout(timer); signal.removeEventListener("abort", done); resolve() }
    const timer = setTimeout(done, options.pollMs ?? 1000)
    signal.addEventListener("abort", done, { once: true })
  })
  const pump = (request: Request) => {
    if (!current(request) || active.has(request.key)) return
    const epoch = options.epoch?.()
    const isCurrent = () => current(request) && epoch === options.epoch?.()
    const work = options.withToast(`background.${request.key}`, request.op === "retry" ? "Retrying run" : "Dismissing run", request.op === "retry" ? "Run completed" : "Dismissed", async () => {
      let row = request
      try {
        if (row.state === "requested") {
          const response = await options.http(`/api/runs/${encodeURIComponent(row.id)}`, { method: "POST", credentials: "same-origin",
            headers: { "Content-Type": "application/json", "Idempotency-Key": row.key }, body: JSON.stringify({ op: row.op }), signal: abort.signal })
          if (!isCurrent()) return
          if (!response.ok) throw new Error("Run action failed")
          const receipt = Receipt.parse(await response.json())
          if (row.op === "dismiss") {
            if (receipt.state !== "dismissed") throw new Error("Run action failed")
            await update({ ...row, state: "completed" }); return
          }
          if (receipt.state !== "accepted") throw new Error("Run action failed")
          row = { ...row, state: "running", run_id: receipt.run_id }
          await update(row)
        }
        while (isCurrent()) {
          const response = await options.http(`/api/runs/${row.run_id}/background-status`, { credentials: "same-origin", signal: abort.signal })
          if (!isCurrent()) return
          if (!response.ok) throw new Error("Run status unavailable")
          const receipt = Receipt.parse(await response.json())
          if (receipt.run_id !== row.run_id) throw new Error("Run status unavailable")
          if (receipt.state === "success") { await update({ ...row, state: "completed" }); return }
          if (receipt.state === "failure" || receipt.state === "cancelled") throw new Error(receipt.state === "failure" ? "Run failed" : "Run cancelled")
          if (receipt.state !== "queued" && receipt.state !== "running") throw new Error("Run status unavailable")
          await pause()
        }
      } catch (error) {
        if (!isCurrent()) return
        const message = error instanceof Error ? error.message : "Run action failed"
        await update({ ...row, state: "failed", error: message })
        return message
      }
    }, false, isCurrent).then(outcome => { if (typeof outcome === "string" && isCurrent()) options.failed?.(request, outcome) }).catch(options.report).finally(() => { if (active.get(request.key) === work) active.delete(request.key) })
    active.set(request.key, work)
  }
  const control = (id: string, op: Request["op"]): Promise<{ readonly value: string } | string> => {
    const owner = options.owner()
    if (!owner || disposed || !/^[1-9]\d*$/.test(id)) return Promise.resolve("Background runs unavailable")
    const identity = JSON.stringify([owner, id, op])
    const pending = starting.get(identity)
    if (pending) return pending
    const old = options.load().find(row => row.owner === owner && row.id === id && row.op === op && (row.state === "requested" || row.state === "running"))
    if (old) { pump(old); return Promise.resolve({ value: "Requested" }) }
    const work = (async () => {
      const failed = options.load().find(row => row.owner === owner && row.id === id && row.op === op && row.state === "failed" && row.error !== "Run failed" && row.error !== "Run cancelled")
      const request: Request = { key: failed?.key ?? randomUuid(), owner, id, op, state: failed?.run_id === undefined ? "requested" : "running", ...(failed?.run_id === undefined ? {} : { run_id: failed.run_id }) }
      await update(request)
      pump(request)
      return { value: "Requested" } as const
    })().finally(() => starting.delete(identity))
    starting.set(identity, work)
    return work
  }
  const resume = () => {
    if (observedOwner !== options.owner() || observedEpoch !== options.epoch?.()) {
      abort.abort(); abort = new AbortController(); active.clear()
      observedOwner = options.owner(); observedEpoch = options.epoch?.()
    }
    for (const request of options.load()) if (request.state === "requested" || request.state === "running") pump(request)
  }
  const dispose = () => { disposed = true; abort.abort() }
  return { control, resume, dispose }
}
export type HomeBackgroundSeam = ReturnType<typeof createHomeBackgroundSeam>
