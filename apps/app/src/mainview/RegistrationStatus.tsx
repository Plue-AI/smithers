import { useLiveQuery } from "@tanstack/react-db"
import { useController } from "./ControllerContext"
import { flowAction } from "./flows/FlowAction"
import { registrationRun, statusOf } from "./cards/Registration"
import { useCardRows } from "./state/useCardRows"

/**
 * The quiet sidebar row (docs/mvp/REGISTRATION.md "Quiet status"): the
 * account's newest registration and its one status word. Once it is Ready,
 * the row opens the repository.
 */
export function RegistrationStatus() {
  const controller = useController()
  const cards = useCardRows(controller.store.collections.cards)
  const { data: runs } = useLiveQuery(controller.store.collections.runtimeRuns)
  const { data: identities } = useLiveQuery(controller.store.collections.identitySessions)
  const login = identities[0]?.state === "signed-in" ? identities[0].login : null
  const newest = cards.flatMap((card) => card.kind === "registration" && card.payload.accountOwner === login ? [card] : [])
    .sort((a, b) => b.payload.startedAt - a.payload.startedAt)[0]
  if (newest === undefined) return null
  const run = registrationRun(cards, newest.payload.repo, runs)
  const status = statusOf(newest, run !== undefined && run.createdAt >= newest.payload.startedAt ? run : undefined)
  const row = (
    <>
      <span className="registration-status-dot" aria-hidden="true" />
      <span className="registration-status-name">{newest.payload.repo}</span>
      <span className="registration-status-chip">{status}</span>
    </>
  )
  return status === "Ready"
    ? (
      <button type="button" className="registration-status" data-status={status}
        {...flowAction(controller.runCommand, "repo.select", newest.payload.cloudRepo ?? newest.payload.repo)}>
        {row}
      </button>
    )
    : <div className="registration-status" data-status={status} role="status">{row}</div>
}
