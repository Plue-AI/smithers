import type { AppStore } from "./AppStore"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, rootFrameId } from "./AppState"
/** Old journals may restore branches even though the client no longer creates them. */
export const restoreRecordedBranch = async (store: AppStore): Promise<void> => {
  const session = store.session()
  const parentBranchId = session.activeBranchId ?? DEFAULT_BRANCH_ID
  const workspaceId = session.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID
  const createdAt = Date.now()
  const id = `recorded-${crypto.randomUUID()}`
  const snapshot = { revision: session.revision,
    messages: [...store.collections.messages.values()], cards: [...store.collections.cards.values()],
    worldDocuments: [...store.collections.worldDocuments.values()], draft: session.draft,
    selectedWorldDocumentId: session.selectedWorldDocumentId }
  const frameId = rootFrameId(id)
  const frame = { id: frameId, workspaceId, branchId: id, kind: "root" as const,
    parentFrameId: null, cardId: null, presentation: "embedded" as const,
    stateRevision: snapshot.revision, snapshot, createdAt, updatedAt: createdAt, revision: session.revision + 1 }
  await store.dispatch({ type: "frame.forked", actor: "user",
    branch: { id, workspaceId, title: "Recorded", parentBranchId,
      forkedFromFrameId: session.activeFrameId ?? rootFrameId(parentBranchId),
      forkedAtRevision: snapshot.revision, snapshot, createdAt, revision: session.revision + 1 },
    rootFrame: frame, selectedFrame: frame }).isPersisted.promise
}
