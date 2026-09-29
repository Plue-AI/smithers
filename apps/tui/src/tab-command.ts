import * as Failures from "./failures.ts"

/** The shared /retry and /stop seam: resolve before acting, and surface misses. */
export interface Target {
  readonly has: (id: string) => boolean
  readonly retry: (id: string) => unknown
  readonly cancel: (id: string) => void
}

export const run = (verb: "retry" | "stop", id: string, options: {
  readonly flows: Target
  readonly workers: Target
  readonly pick: () => void
  readonly report: (message: string) => void
}): void => {
  if (id === "") return options.pick()
  const target = options.flows.has(id) ? options.flows : options.workers.has(id) ? options.workers : undefined
  if (target === undefined) return options.report(`Unknown tab: ${id}`)
  try {
    if (verb === "retry") target.retry(id)
    else target.cancel(id)
  } catch (error) {
    options.report(Failures.line(verb, error))
  }
}
