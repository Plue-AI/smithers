/**
 * Print mode: the prompt runs as one top-level worker, the same worker an
 * interactive session delegates. It can split work with `agent.delegate`,
 * wait for its children, fail over and park on capacity, and a delegate
 * model this machine cannot reach is refused before any child starts.
 * Nobody is at the terminal, so an ask that reaches the person fails at once
 * with {@link unattended}. Once the root settles, unfinished children stop.
 */
import * as FailureCopy from "@smthrs/model/FailureCopy"
import * as Approvals from "./approvals.ts"
import * as Asks from "./asks.ts"
import type * as Host from "./host.ts"
import * as Lifecycle from "./lifecycle.ts"
import type { DelegateModel } from "./models.ts"
import { Workspace } from "./workspace.ts"

/** The root worker's id; its children are `print/<id>`. */
export const rootId = "print"
/** Why an ask that reached the person fails in print mode. */
export const unattended = "No person can answer in print mode; decide, and state the assumption in your answer"

export type Outcome =
  | { readonly _tag: "done"; readonly answer: string }
  | { readonly _tag: "failed"; readonly headline: string; readonly line: string }
  | { readonly _tag: "cancelled" }

export const run = (options: {
  readonly host: Host.Host
  readonly prompt: string
  /** The seat of a worker nobody chose one for; routed instead when the host routes. */
  readonly workerSeat: string
  /** The person's `--model`: every worker nobody chose a seat for runs on it, unrouted. */
  readonly model?: string | undefined
  /** Delegate models a request may name. */
  readonly delegable: ReadonlyArray<DelegateModel>
  /** One line per flow the approval mode denied, the first time only. */
  readonly onNotice?: (line: string) => void
}): Promise<Outcome> => {
  const notice = Approvals.notices()
  const host: Host.Host = {
    ...options.host,
    ...(options.model === undefined ? {} : { routes: false }),
    run: (input) =>
      options.host.run({
        ...input,
        onEvent: (event) => {
          if (event._tag === "cell-call-settled" && Approvals.denied(event.result)) {
            const line = notice(event.flowName)
            if (line !== undefined) options.onNotice?.(line)
          }
          return input.onEvent(event)
        }
      })
  }
  const workspace = new Workspace({
    host,
    workerSeat: options.model ?? options.workerSeat,
    history: () => [],
    persist: () => {},
    delegable: options.delegable
  })
  return new Promise((resolve) => {
    let finished = false
    const check = () => {
      if (finished) return
      for (const ask of workspace.asks.list()) {
        if (ask.holder === Asks.person) workspace.asks.refuse(ask.id, unattended)
      }
      const root = workspace.snapshot().tabs.find((tab) => tab.id === rootId)
      if (finished || root === undefined || !Lifecycle.settled(root.status)) return
      finished = true
      unsubscribe()
      workspace.dispose()
      if (root.status === "done") return resolve({ _tag: "done", answer: root.answer ?? "" })
      if (root.status === "cancelled") return resolve({ _tag: "cancelled" })
      const failure = root.failure ?? FailureCopy.describe(root.message)
      resolve({ _tag: "failed", headline: failure.headline, line: failure.line })
    }
    const unsubscribe = workspace.subscribe(check)
    workspace.request({ id: rootId, title: "Print", prompt: options.prompt, by: "user" })
    check()
  })
}
