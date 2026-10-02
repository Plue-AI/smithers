import {
  cardFrameId,
  DEFAULT_BRANCH_ID,
  DEFAULT_WORKSPACE_ID,
  rootFrameId
} from "../AppState"
import type { FrameHistoryPort, FrameLocation } from "../../runtime/FrameHistory"
import type { ControllerContext } from "./context"
import { knowledgeCardAvailable } from "../KnowledgeFeatures"

export interface FramesController {
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly frameBack: () => void
  readonly frameForward: () => void
}

const sessionLocation = (ctx: ControllerContext): FrameLocation => {
  const session = ctx.store.session()
  const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
  return {
    workspaceId: session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID,
    branchId,
    frameId: session.activeFrameId ?? rootFrameId(branchId)
  }
}

const validLocation = (ctx: ControllerContext, location: FrameLocation): boolean => {
  const workspace = ctx.store.collections.workspaces.get(location.workspaceId)
  const branch = ctx.store.collections.branches.get(location.branchId)
  const frame = ctx.store.collections.frames.get(location.frameId)
  // Only the active branch's frames are projected into `collections.frames`.
  // Browser history still carries frames from an inactive branch, so accept
  // their durable ids and let `frame.navigated` restore that branch snapshot.
  const historicalFrame = frame === undefined && branch !== undefined &&
    (location.frameId === rootFrameId(branch.id) ||
      branch.snapshot?.cards.some((card) => location.frameId === cardFrameId(branch.id, card.id)) === true)
  const card = frame?.cardId == null ? undefined : ctx.store.collections.cards.get(frame.cardId) ??
    branch?.snapshot?.cards.find(card => card.id === frame.cardId)
  return workspace !== undefined &&
    branch?.workspaceId === workspace.id &&
    (historicalFrame || (frame?.workspaceId === workspace.id && frame.branchId === branch.id)) &&
    (card === undefined || knowledgeCardAvailable(card.kind, ctx.services.features)) &&
    (frame === undefined || frame.cardId === null || ctx.store.collections.cards.get(frame.cardId) !== undefined ||
      branch.snapshot?.cards.some((card) => card.id === frame.cardId) === true)
}

const sameLocation = (left: FrameLocation, right: FrameLocation): boolean =>
  left.workspaceId === right.workspaceId && left.branchId === right.branchId && left.frameId === right.frameId

export const createFramesController = (
  ctx: ControllerContext,
  history: FrameHistoryPort | undefined
): FramesController => {
  const navigateFromHistory = (location: FrameLocation | undefined): void => {
    if (location !== undefined && location.branchId !== sessionLocation(ctx).branchId && ctx.store.session().phase === "responding") {
      history?.replace(sessionLocation(ctx))
      return
    }
    if (location === undefined || !validLocation(ctx, location)) {
      history?.replace(sessionLocation(ctx))
      return
    }
    if (sameLocation(location, sessionLocation(ctx))) return
    ctx.store.dispatch({ type: "frame.navigated", actor: "system", ...location })
  }

  if (history !== undefined) {
    const initial = history.current()
    if (initial !== undefined && validLocation(ctx, initial)) navigateFromHistory(initial)
    else history.replace(sessionLocation(ctx))
    ctx.onDispose(history.subscribe(navigateFromHistory))
  }

  const maximizeCard: FramesController["maximizeCard"] = (id) => {
    if (ctx.store.collections.cards.get(id) === undefined) return `There is no card with id ${id}.`
    if (!knowledgeCardAvailable(ctx.store.collections.cards.get(id)!.kind, ctx.services.features)) return "This feature is not enabled."
    const session = ctx.store.session()
    const workspaceId = session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
    const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
    ctx.store.dispatch({ type: "card.maximized", actor: "user", id })
    history?.push({ workspaceId, branchId, frameId: cardFrameId(branchId, id) })
  }

  const minimizeCard = (): void => {
    const session = ctx.store.session()
    const workspaceId = session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
    const branchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
    ctx.store.dispatch({ type: "card.minimized", actor: "user" })
    history?.push({ workspaceId, branchId, frameId: rootFrameId(branchId) })
  }

  return {
    maximizeCard,
    minimizeCard,
    frameBack: () => history?.back(),
    frameForward: () => history?.forward()
  }
}
