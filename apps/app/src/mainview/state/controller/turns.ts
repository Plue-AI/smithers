import { identityProviderFor, hasGitHubIdentity } from "../IdentityProvider"
import { releaseInterruptedApproval } from "../ApprovalRecovery"
import { lostActRefusal } from "../BrowserWriteFailure"
import type { AgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import type { ModelBinding } from "@smthrs/rpc/ConfiguredModel"
import { AGENT_RUNTIME_CONTEXT_VERSION,composeAgentInstructions,renderAgentRuntimeContext } from "@smthrs/rpc/AgentContext"
import { hasCapability, nativeShell } from "@smthrs/rpc/AppBootstrap"
import { setupCandidate, storedSetupCandidate } from "@smthrs/rpc/RepositorySetup"
import { AGENT_TURN_FRONT_DOOR_CALL_PREFIX } from "@smthrs/rpc/NativeAgent"
import type { AgentChatMessage,AgentTurnCommand,AgentTurnFrame,TurnRefusal } from "@smthrs/rpc/NativeAgent"
import { clientRefusal } from "@smthrs/rpc/Refusal"
import { agentRefusalText } from "@smthrs/rpc/RefusalCopy"
import type { CommandOutcome } from "../../flows/Commands"
import { agentFailureText,agentVisibleCatalog } from "../../flows/agentTools"
import { itemOf, parseSubmit, unmetRequirements, visible } from "../../flows/registry"
import { boundToolResult,boundTurnRequest } from "../AgentTurnPolicy"
import type { Card } from "../AppState"
import { CardPatchSchema,CardSchema,conversationTabIdOf,inConversation,MAIN_TAB_ID } from "../AppState"
import { isCurrentApprovalAnswer,prepareApprovalAnswer } from "../ApprovalAnswerState"
import { parseApprovalActionId } from "../ApprovalReference"
import type { ImpossibleAskClass,InstructionStage } from "../Instructions"
import { bytesOf,CHAT_INSTRUCTIONS_CAP_BYTES,INSTRUCTIONS_HEADROOM_BYTES,smithersInstructions } from "../Instructions"
import { COMMANDS_MAX } from "../Recommend"
import { activeCatalogRepositoryId,activeRepositoryId } from "../RepoContext"
import { currentRepositoryUpdate } from "../RepositoryContext"
import { setupContextSummary } from "./repositorySetup"
import {
impossibleAskOf,
renderedAskTurnText,
renderedRunTurnText,
RUN_LAUNCH_COMMANDS,
runLaunchCommandOf,
toolResultLaunchedRun
} from "../RunClaims"
import { toolActLine } from "../ToolActLine"
import { WORLD_BODY_BUDGET,worldContextDocuments } from "../WorldContext"
import { knowledgeCardAvailable } from "../KnowledgeFeatures"
import { isRuntimeOwnedCard } from "../isRuntimeOwnedCard"
import { readDesktopStream } from "../seams/DesktopStream"
import { downloadUrlOf } from "./app"
import type { ActiveTurn,ControllerContext } from "./context"
import type { FailureController } from "./failures"
import { createHttpTurnDriver } from "./httpTurns"
import { ZERO_BALANCE_EXHAUSTED_TEXT } from "./failures"
import { outOfCreditRefusal, renderCreditExhausted } from "../seams/BillingSeam"
import { assignedBinding } from "./modelSeats"
import { latestOrdinal } from "./spokenLines"

/**
 * The client-side tool-loop leg cap, mirroring the chat worker's
 * CHAT_MAX_TOOL_LEGS default (8): over it the turn ends honestly instead of
 * looping forever on a model that keeps calling tools.
 */
const MAX_TOOL_LEGS = 8
/** How many of this conversation's cards a turn describes, the boundary's own maximum (AgentContext recentCards). */
const RECENT_CARD_WINDOW = 12
/**
 * The chain's own doors (DESIGN.md §14): calls that ARE the surface — the
 * author seat and the transcript doors — rather than acts on the app, so
 * they never render an act row of their own.
 */
const CHAIN_SURFACE_CALLS = new Set(["author", "say", "card.show", "card.update"])

export interface TurnControllerDependencies {
  readonly settleTurnBilling: () => void
  /** The next transcript ordinal, so a refusal card lands at the end of the conversation. */
  readonly nextOrdinal: () => number
  readonly surfaceCommandFailure: FailureController["surfaceCommandFailure"]
  readonly credentialMissing?: () => void
  readonly forwardApprovalDecision: (
    card: Extract<Card, { kind: "approval" }>,
    decision: "approved" | "denied",
    answer?: unknown
  ) => Promise<void>
  /** A decision clicked on the workspace approvals inbox, bound to its run and request. */
  readonly forwardInboxApprovalDecision: (
    cardId: string,
    requestId: string,
    decision: "approved" | "denied",
    runId?: string,
    answer?: unknown
  ) => Promise<void>
}

export interface TurnController {
  readonly subscribeToAgent: () => void
  readonly send: (text: string, admission?: { readonly turnId: string; readonly owner: string | null | undefined }, draftCurrent?: () => boolean) => Promise<boolean> | void
  readonly reset: () => void
  readonly stop: () => void
  readonly decideApproval: (id: string, decision: "approved" | "denied", answer?: unknown, question?: string) => void
  readonly retryLastTurn: () => string | void
}

export const createTurnController = (
  ctx: ControllerContext,
  dependencies: TurnControllerDependencies
): TurnController => {
  const { store, agent } = ctx
  const { settleTurnBilling, nextOrdinal, surfaceCommandFailure, forwardApprovalDecision, forwardInboxApprovalDecision, credentialMissing } =
    dependencies

  // The cloud host authenticates ordinary turns; its public catalog is the
  // explicit anonymous exception. Local hosts can still run local chat.
  const chatNeedsSignIn = (): boolean => ctx.services.bootstrap?.host === "cloud"
    && hasCapability(ctx.services.bootstrap, "identity")
    && store.collections.identitySessions.get("identity")?.state === "signed-out"
    && activeCatalogRepositoryId(store) === null

  const offerChatSignIn = async (draft: string, turnId?: string, attemptId?: string): Promise<void> => {
    await store.dispatch({ type: "chat.sign-in.required", actor: "system", draft,
      provider: identityProviderFor(ctx.services), ...(turnId === undefined ? {} : { turnId }),
      ...(attemptId === undefined ? {} : { attemptId }) }).isPersisted.promise
  }

  /*
   * The anonymous turn ceiling (apps/server turnLimit.ts; factory mock 22):
   * a signed-out visitor's refused turn is its own card, never the generic
   * failure line, because the way on is a door (sign in) and not a retry. The
   * branch is the refusal's CODE plus the session: a signed-out caller can
   * only be refused by the anonymous buckets, while a signed-in login that
   * trips its own ceiling has hit a bug and keeps the failure line the server
   * wrote for it. Only a session the app KNOWS is signed out takes the card:
   * "unknown" (the seam has not answered yet) and "unavailable" (the seam
   * failed) may belong to a signed-in login, and a Sign in door beside a
   * sentence about a login ceiling would contradict itself, so those keep the
   * failure line, whose server sentence carries its own sign-in instruction
   * for the anonymous wordings. The card carries the server's sentence and
   * reset time as sent; the reducer's completion settles the phase without a
   * bubble.
   */
  /** Out of model credit: the plans card with its Upgrade-to-Pro door, beside the failed turn. */
  const offerCreditUpgrade = (): void => {
    void renderCreditExhausted(store, outOfCreditRefusal(ZERO_BALANCE_EXHAUSTED_TEXT),
      ctx.services.bootstrap?.capabilities.includes("billing.checkout") ?? true, "system")
  }

  const refuseAnonymousTurn = (turnId: string, refusal: TurnRefusal): boolean => {
    if (refusal.code !== "turn_rate_limited") return false
    if (store.collections.identitySessions.get("identity")?.state !== "signed-out") return false
    const card: Card = {
      id: `anonymous-ceiling-${turnId}`,
      kind: "anonymous-ceiling",
      title: "Exploring is paused",
      status: "active",
      createdAt: Date.now(),
      ordinal: nextOrdinal(),
      payload: { message: refusal.message, retryAt: refusal.retryAt }
    }
    store.dispatch({ type: "card.upsert", actor: "system", card, turnId })
    store.dispatch({ type: "message.response.completed", actor: "smithers", turnId })
    return true
  }

  const handleCardFrame = (frame: Extract<AgentTurnFrame, { type: "card" | "card.update" }>): void => {
    if (frame.type === "card") {
      if (isRuntimeOwnedCard(frame.card) || isRuntimeOwnedCard(store.collections.cards.get(frame.card.id)) ||
        store.approvalRequest(frame.card.id) !== undefined) return
      store.dispatch({ type: "card.upsert", actor: "smithers", card: frame.card })
      return
    }
    const patch = CardPatchSchema.safeParse(frame.patch)
    const existing = store.collections.cards.get(frame.id)
    if (isRuntimeOwnedCard(existing) || store.approvalRequest(frame.id) !== undefined) return
    if (!patch.success || existing === undefined || patch.data.kind !== existing.kind) {
      console.warn("Smithers dropped a card.update frame for an unknown or invalid card", frame.id)
      return
    }
    /* The card is spread as a plain record: TypeScript's arithmetic over the spread of every kind's payload exceeds its union limit. */
    const held = existing as unknown as Record<string, unknown> & { readonly id: string; readonly payload: Record<string, unknown> }
    const merged = CardSchema.safeParse({ ...held, ...patch.data, id: held.id,
      payload: patch.data.payload === undefined ? held.payload :
        { ...held.payload, ...patch.data.payload }
    })
    if (!merged.success) {
      console.warn("Smithers dropped a card.update frame that fails schema", merged.error)
      return
    }
    store.dispatch({ type: "card.updated", actor: "smithers", id: frame.id, patch: CardPatchSchema.parse(merged.data) })
  }

  /**
   * The transcript as the chat contract reads it: no tool-act lines, no empty
   * bubbles.
   *
   * With one exception, and it is not an exception to the rule. An ordinary
   * act line is a step inside a turn the model then answers in its own words,
   * so repeating it would say the same thing twice. A front-door route
   * (apps/server frontDoor.ts) has no such words: the act IS the answer, and
   * that row is marked `answersTurn`. Dropping it left a routed turn with no
   * trace at all, so the next turn's model read the user's question as
   * unanswered and re-routed it — seven legs of the same command against one
   * question, live, 2026-09-18.
   */
  const contextMessages = (): ReadonlyArray<AgentChatMessage> => {
    return [...store
      .agentContextSnapshot()
      .messages.filter((message) => (message.act === undefined || message.answersTurn === true) && message.text.trim() !== "")
      .map((message) => ({
        role: message.role === "user" ? ("user" as const) : ("assistant" as const),
        content: message.text
      }))]
  }
  ctx.contextMessages = contextMessages

  /*
   * The hidden runtime context, freshly derived from live collections on EVERY
   * turn leg (never cached): the server boundary renders it into the upstream
   * instructions, so the model truthfully knows it runs inside the Smithers
   * product. It is never dispatched, so it never enters the persisted visible
   * transcript; it carries no secrets (only state the client already holds).
   */
  /*
   * The Smithers Cloud session as the model must know it (agent-parity.md):
   * the native app holds a PAT session of its own (cloudSessions, mirrored
   * from the Bun side); on the web the GitHub sign-in IS the Cloud sign-in
   * (WEB_HOST_LINE), so the identity answers. A host with neither door is
   * unavailable, and a session the host has not answered yet is too.
   */
  const cloudContext = (): NonNullable<AgentRuntimeContext["cloud"]> => {
    const bootstrap = ctx.services.bootstrap
    if (bootstrap?.host === "cloud") {
      const identity = store.collections.identitySessions.get("identity")
      if (identity?.state === "signed-in") return { state: "signed-in", username: identity.login }
      return { state: identity?.state === "signed-out" ? "signed-out" : "unavailable", username: null }
    }
    if (bootstrap !== undefined && !hasCapability(bootstrap, "cloud.pat")) return { state: "unavailable", username: null }
    const session = store.collections.cloudSessions.get("cloud")
    switch (session?.state) {
      case "signed-in":
        return { state: session.scopes === "degraded" ? "degraded" : "signed-in", username: session.username }
      case "signed-out":
      case "signing-in":
        return { state: "signed-out", username: null }
      default:
        return { state: "unavailable", username: null }
    }
  }

  const agentRuntimeContext = (
    worldBodyBudget: number = WORLD_BODY_BUDGET,
    setupDrafts: number = Number.POSITIVE_INFINITY,
    cardLines: number = RECENT_CARD_WINDOW
  ): AgentRuntimeContext => {
    const snapshot = store.agentContextSnapshot()
    const current = store.session()
    const identity = store.collections.identitySessions.get("identity")
    const githubConnected = hasGitHubIdentity(identity, identityProviderFor(ctx.services))
    const loadedRepoIds = [...store.collections.repositories.keys()]
    const billingAccount = store.collections.billingAccounts.get("billing")
    /*
     * Anonymous exploring (apps/server/PUBLIC-REPOSITORIES.md): signed out
     * with a public catalog repository selected, the visitor reads and asks
     * about it; anything that writes is one sign-in away.
     */
    const exploring = identity?.state === "signed-out" ? activeCatalogRepositoryId(store) : null
    const selected = current.selectedWorldDocumentId === null
      ? undefined
      : store.collections.worldDocuments.get(current.selectedWorldDocumentId)
    const windowed = [...store.collections.cards.values()]
      .filter(card => inConversation(card, conversationTabIdOf(current)) && knowledgeCardAvailable(card.kind, ctx.services.features))
      .sort((a, b) => a.ordinal - b.ordinal).slice(-RECENT_CARD_WINDOW)
    /*
     * The card lines that give way when the turn does not fit are the ones that
     * are ONLY a line, oldest first; a setup card keeps its place because its
     * draft is what a question asked beside it is answered from. Twelve lines at
     * production's card ids spend the whole budget on their own (canary walk run
     * 3, B3 step 3: every draft shed and the turn still refused, HTTP 400).
     */
    let surplus = windowed.length - cardLines
    const recent = surplus <= 0 ? windowed : windowed.filter(card => {
      if (surplus <= 0 || card.kind === "repository-setup") return true
      surplus -= 1
      return false
    })
    /*
     * The open setup's own draft. Asked "what will run automatically?" beside an
     * issues card whose research, duplicates and reproduce steps were all
     * automatic, the model answered "Nothing runs automatically": the draft
     * reached it only through the setup.guide tool it had no reason to call for
     * an ordinary question. `setupDrafts` is how many of them, newest card
     * first, composeTurn can afford under the chat seam's cap.
     */
    const drafted = new Set([...recent].reverse()
      .filter(card => card.kind === "repository-setup").slice(0, setupDrafts).map(card => card.id))
    return {
      repositoryUpdate: currentRepositoryUpdate(store),
      recentCards: recent
        .map(card => ({
          id: card.id, kind: card.kind, title: card.title.replace(/[\r\n]/g, " ").slice(0, 250),
          status: card.status, maximized: current.maximizedCardId === card.id,
          ...(card.kind === "workspace" ? { workspace: {
            id: card.payload.workspaceId, repo: card.payload.repo,
            kind: card.payload.workspaceKind ?? "unknown", status: card.payload.status,
            facet: card.payload.facet ?? "terminal",
            streaming: readDesktopStream(card.payload.workspaceId) !== null,
          } } : {}),
          ...(card.kind === "repository-setup" && drafted.has(card.id) ? { setup: setupContextSummary(card.payload) } : {}),
        })),
      version: AGENT_RUNTIME_CONTEXT_VERSION,
      product: "smithers",
      capturedAt: snapshot.capturedAt,
      revision: snapshot.revision,
      surface: current.surface,
      theme: current.theme,
      selectedWorldDocument: selected?.path ?? null,
      connectors: snapshot.connectors.map((connector) => ({
        kind: connector.kind,
        name: connector.name,
        status: connector.status,
        access: connector.access,
        root: connector.root,
        branch: connector.branch
      })),
      repositories: [...store.collections.repos.values()].map((repo) => ({
        id: repo.id,
        name: repo.name,
        path: repo.path,
        branch: repo.git?.branch ?? null,
        smithers: repo.smithers.detected
      })),
      /*
       * The selection `repo.select` (or the landing page's `?repo=` link)
       * made. Without it the model learned the choice only through
       * repo-scoped tool calls, never from a plain first message.
       */
      activeRepository: activeRepositoryId(store),
      activeRepositorySummary: store.collections.repositories.get(activeRepositoryId(store) ?? "")?.summary,
      /*
       * Only the GitHub authentication door establishes this connection.
       * A backend owner can load repositories without connecting GitHub.
       */
      github: {
        connected: githubConnected,
        login: githubConnected ? identity?.login ?? null : null,
        repositories: githubConnected ? loadedRepoIds.length : null,
        /*
         * §22.7: a COUNT left the model declining to answer "what repos do
         * I have?" while the names were served plainly by the seam it
         * was already reading.
         */
        ...(githubConnected && loadedRepoIds.length > 0
          ? { repositoryNames: loadedRepoIds }
          : {})
      },
      cloud: cloudContext(),
      /*
       * §22.7: the client holds the balance; the model did not, so asked
       * for it, it answered "$0.00" one line above a card its own tool call
       * had just rendered reading "$519 left".
       */
      billing: billingAccount === undefined
        ? null
        : {
          state: billingAccount.state,
          totalUsd: billingAccount.totalUsd,
          lifetimeChargedUsd: billingAccount.lifetimeChargedUsd,
          chargeCount: billingAccount.chargeCount
        },
      /*
       * §10.8: metadata alone made the World decorative — a note holding a
       * fact recorded nowhere else was invisible to the model, which said
       * it could not retrieve it. The notes' own words ride the turn under
       * a budget, open note first.
       */
      worldState: {
        documentCount: snapshot.worldState.documents.length,
        documents: worldContextDocuments(
          snapshot.worldState.documents,
          current.selectedWorldDocumentId,
          worldBodyBudget
        )
      },
      /*
       * Smithers is the first tab and knows every other one (docs/LOCAL-APP.md
       * "Cards"): the model sees the card tabs as the human does.
       */
      tabs: snapshot.tabs.map((tab) => ({
        id: tab.id,
        kind: tab.kind,
        title: tab.title,
        active: tab.id === (current.activeTabId ?? MAIN_TAB_ID)
      })),
      capabilities: [
        "Hold a streaming conversation in this chat and read its visible transcript.",
        "Run app commands through the \"commands\" tool — the same code path as the UI buttons and slash commands.",
        "Render structured cards (plans, approvals, statuses, recommendations) in the transcript.",
        ...(ctx.commands.find("box.desktop.open") === undefined ? [] : [
          "Open a live cloud desktop inside this browser chat with box.desktop.open [bookmark] [owner/repo] (alias desktop). It creates or reuses a desktop box and embeds its live screen; the user can interact with it and explicitly maximize or restore the card. This feature does not require the native app. Use the existing box state in recent cards; an attached stream is already open, not a reason to offer sign-in. You cannot infer screen contents from the stream's presence.",
        ]),
        "Create, list, and run Smithers flows on the user's loaded repositories (flow.create, flow.list, flow.run). Runs report live as embedded cards in this chat.",
        ...(store.collections.repos.size > 0
          ? [
            "Read the open repositories listed above: files.list <path> [repo] lists a directory and files.read <path> [repo] renders a file as a card in this chat (a bare call means the active repository)."
          ]
          : []),
        ...(exploring === null
          ? []
          : [
            `Read the public repository ${exploring} the visitor is exploring signed out: files.list <path> lists a directory and files.read <path> renders a file as a card in this chat, no sign-in needed.`
          ])
      ],
      limitations: [
        "Cannot see or control the host environment beyond what this context block states.",
        ...(exploring === null
          ? []
          : [
            `The visitor is signed out, exploring ${exploring}: anything that writes (pull requests, issues, workspaces, flow runs, secrets) needs GitHub sign-in, so when they ask for one execute auth.prompt instead.`
          ]),
        "Flow runs execute on the user's workspace gateway; any outbound act a run wants (pushes, PRs) pauses for the human's explicit approval. Never promise one landed without it.",
        "This host cannot connect local repositories."
      ]
    }
  }

  /*
   * Wave 13 §F: the system prompt's capability section is GENERATED per turn
   * from the live command catalog and connector state — the one source of
   * truth — so the model's offers are bounded by what actually exists, and a
   * workflow is never presented as laundering an effect the catalog lacks.
   */
  const turnInstructions = (context?: AgentRuntimeContext, lastStage: InstructionStage = 3): string => {
    const identity = store.collections.identitySessions.get("identity")
    const signedIn = identity?.state === "signed-in"
    const githubConnected = hasGitHubIdentity(identity, identityProviderFor(ctx.services))
    const recent = new Set(context?.recentCards?.map(card => card.id))
    const prompt = contextMessages().filter(message => "role" in message && message.role === "user").at(-1)
    const mentioned = (id: string) => prompt !== undefined && "content" in prompt && prompt.content.includes(id)
    /*
     * The Bun side composes prompt + rendered context into ONE string the chat
     * seam caps at CHAT_INSTRUCTIONS_CAP_BYTES, so the prompt's budget is what
     * the cap leaves after this turn's context (world notes ride under their
     * own 8 000-char budget, tabs and repositories grow with the session).
     * The catalog degrades in stages to fit, down to `lastStage`; composeTurn
     * below owns the floor under that.
     */
    const contextBytes = context === undefined ? 0 : bytesOf(renderAgentRuntimeContext(context)) + 2
    const budgetBytes = CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES - contextBytes
    return smithersInstructions(agentVisibleCatalog(ctx.commands.callable()), {
      // The bootstrap is the one authority for the mode: the desktop shell's row says native; every web origin, hosted or self-hosted, is the web app.
      host: nativeShell(ctx.services.bootstrap) ? "native" : "web",
      nativeDownloadable: downloadUrlOf(ctx.services) !== null,
      github: {
        connected: githubConnected,
        login: githubConnected ? identity?.login ?? null : null,
        repositories: githubConnected ? store.collections.repositories.size : null
      },
      localRepositories: [
        ...new Set([
          ...[...store.collections.connectors.values()].map((connector) => connector.name),
          ...[...store.collections.repos.values()].map((repo) => repo.name)
        ])
      ],
      localRepositoriesAvailable: false,
      repositorySetups: !signedIn ? [] : [...store.collections.cards.values()]
        .filter(card => inConversation(card, conversationTabIdOf(store.session())) && (recent.has(card.id) || mentioned(card.id)))
        .sort((left, right) => Number(mentioned(left.id)) - Number(mentioned(right.id)) || left.ordinal - right.ordinal)
        .flatMap(card => {
          if (card.kind !== "repository-setup" || card.payload.owner !== identity.login) return []
          const { repo, job, revision, inspectedAt, active } = card.payload
          const digest = setupCandidate(card.payload)
          return [{ cardId: card.id, repo, job, revision, digest, inspectedAt,
            state: active?.enabled && active.revision === revision && storedSetupCandidate(card.payload, active.digest) ? "enabled" as const
              : active?.enabled === false ? "paused" as const : "draft" as const }]
        })
    }, { budgetBytes, lastStage })
  }

  /*
   * The floor under the budget. The catalog degrades first (stages 0→2 keep
   * every command's name); when the namespace list plus this turn's context
   * still exceeds the cap, the World bodies give way (each cut note says so
   * in the context, and the pane still holds it); only when even bodiless
   * notes do not fit does the catalog fall to stage 3 (namespaces and
   * counts, every name behind the list action). Under that floor the oldest
   * card lines that carry no draft give way, then the open setups' drafts,
   * oldest card first. A turn fails on size only past that: a context whose
   * tabs and repositories alone pass the cap, which no session has produced.
   */
  /** The note text (characters) command names never crowd out. */
  const NOTE_BODY_FLOOR = 1_000
  const composeInstructions = (): { readonly context: AgentRuntimeContext; readonly instructions: string } => {
    const limit = CHAT_INSTRUCTIONS_CAP_BYTES - INSTRUCTIONS_HEADROOM_BYTES
    const render = (worldBodyBudget: number, lastStage: InstructionStage = 2, setupDrafts?: number, cardLines?: number) => {
      const context = agentRuntimeContext(worldBodyBudget, setupDrafts, cardLines)
      const instructions = turnInstructions(context, lastStage)
      return { context, instructions, over: bytesOf(composeAgentInstructions(instructions, context)) - limit }
    }
    const whole = render(WORLD_BODY_BUDGET)
    if (whole.over <= 0) return { context: whole.context, instructions: whole.instructions }
    /*
     * The bodies give way to the largest budget that still fits, found by
     * bisection in a bounded number of renders. Cutting the budget by the
     * overshoot in one step landed on zero whenever the overshoot exceeded
     * the budget (a full catalog beside three notes at budget), which left
     * hundreds of bytes of room unused and every note bodiless.
     */
    let fit = render(0)
    /*
     * Command names by namespace stay only while the notes keep a floor of
     * text beside them; a catalog that fits with a sliver left would cut
     * every note body to nothing, so the names give way first.
     */
    const lastStage = fit.over > 0 || render(NOTE_BODY_FLOOR).over > 0 ? 3 : 2
    let setupDrafts: number | undefined
    let cardLines: number | undefined
    if (lastStage === 3) {
      // The namespace-count floor frees room. Refill the note bodies under
      // that same cap instead of carrying the zero-budget probe into the turn.
      const floorWhole = render(WORLD_BODY_BUDGET, lastStage)
      if (floorWhole.over <= 0) return { context: floorWhole.context, instructions: floorWhole.instructions }
      fit = render(0, lastStage)
      if (fit.over > 0) {
        /*
         * Twelve card lines at production's card ids spend the whole budget on
         * their own, so the oldest of them give way next, oldest first, keeping
         * the setup cards whose drafts answer questions asked beside them: a
         * repeated `flow-run@<repo>@<workspace>@run-N` line is worth less than
         * the draft the person is looking at.
         */
        for (let keep = (fit.context.recentCards ?? []).length - 1; keep > 0; keep -= 1) {
          cardLines = keep
          fit = render(0, lastStage, undefined, keep)
          if (fit.over <= 0) break
        }
      }
      if (fit.over > 0) {
        /*
         * The drafts are the last thing to give, and the newest card keeps its
         * own longest: a native session at the namespace-count floor leaves
         * about 1 300 bytes, which an issues draft (six steps and their cut
         * prompts) does not fit, so that draft is left to setup.guide instead
         * of failing the turn on size. Past even the bare turn the fewest
         * bytes go, because the seam refuses it either way.
         */
        for (let keep = (fit.context.recentCards ?? []).filter(card => card.setup !== undefined).length - 1; keep >= 0; keep -= 1) {
          setupDrafts = keep
          fit = render(0, lastStage, keep, cardLines)
          if (fit.over <= 0) break
        }
        if (fit.over > 0) return { context: fit.context, instructions: fit.instructions }
      }
    }
    let low = 0
    let high = WORLD_BODY_BUDGET
    for (let round = 0; round < 8 && high - low > 16; round += 1) {
      const middle = Math.floor((low + high) / 2)
      const candidate = render(middle, lastStage, setupDrafts, cardLines)
      if (candidate.over <= 0) {
        low = middle
        fit = candidate
      } else {
        high = middle
      }
    }
    return { context: fit.context, instructions: fit.instructions }
  }

  /*
   * The catalog as DATA, beside the prompt that renders it as prose.
   *
   * The serving side's front door (apps/server frontDoor.ts) asks a decision
   * model whether this message simply IS one of the commands the app can run,
   * and answers the turn itself when it is. It needs the options, and the
   * prompt's catalog is not them: it degrades in stages to fit the
   * instructions cap, and parsing it back would be a second contract that
   * breaks the first time a stage drops. So every turn carries the same
   * `{ name, summary }` list the recommender posts (state/Recommend.ts
   * recommendRequest) — `visible(catalog)`, capped — and the front door reads
   * data.
   *
   * With one narrowing the recommender does not make. Choosing a command here
   * RUNS it, so an option this client would refuse is not an option: the
   * catalog is the model-invocable set (`callable()` — the human's own
   * browser mechanics, chat.stop and sign-in among them, are refused with
   * userOnlyError) and, of those, the ones whose requirements are met right
   * now (`unmetRequirements`, which at the agent boundary is an honest
   * failure and never a deferral: Commands.ts runAs). The live front door
   * offered all 208 visible commands and routed "show me my runs" to one that
   * answered with a refusal. The pills keep the wider list on purpose: a
   * recommendation is a suggestion the human clicks, and that click is what
   * renders the sign-in step or the first-run choice.
   */
  const turnCommands = (): ReadonlyArray<AgentTurnCommand> => {
    const state = ctx.commands.state()
    return visible(ctx.commands.callable().map(itemOf))
      .filter((command) => unmetRequirements(command, state).length === 0)
      .slice(0, COMMANDS_MAX)
      .map((command) => ({ name: command.name, summary: command.summary }))
  }

  // The `front-door` seat rides every conversation leg. `model` never does:
  // these turns carry tools, and a bound turn is sealed.
  const composeTurn = (): {
    readonly context: AgentRuntimeContext
    readonly instructions: string
    readonly commands: ReadonlyArray<AgentTurnCommand>
    readonly decisionModel?: ModelBinding
  } => {
    const decisionModel = assignedBinding(ctx, "front-door")
    return { ...composeInstructions(), commands: turnCommands(), ...(decisionModel === undefined ? {} : { decisionModel }) }
  }

  // Retries keep their transcript id, so its previous backend run must finish
  // cancelling before that id can launch again. The map also fences final
  // frames from the cancelled run while a retry holds the turn seat.
  const pendingCancellations = new Map<string, Promise<void>>()
  const cancelTurn = (turnId: string): void => {
    if (pendingCancellations.has(turnId)) return
    const pending = agent.cancelTurn(turnId)
    pendingCancellations.set(turnId, pending)
    const settled = () => { pendingCancellations.delete(turnId) }
    // Handle rejection even when no retry is waiting; a queued launch still
    // observes the original rejection through its ordinary failure handler.
    void pending.then(settled, error => { ctx.failures.report("turn.cancel", error, turnId); settled() })
  }

  // A turn belongs to the account generation it started in (ctx.accountEpoch).
  let owner = ctx.accountOwner()
  const turnGenerations = new WeakMap<ActiveTurn, number>()
  const ownTurn = (turn: ActiveTurn): ActiveTurn => {
    turnGenerations.set(turn, ctx.accountEpoch)
    return turn
  }
  const revokedTurn = (turn: ActiveTurn): boolean => ctx.disposed || turnGenerations.get(turn) !== ctx.accountEpoch
  const isCurrentTurn = (turn: ActiveTurn): boolean => !revokedTurn(turn) && ctx.activeTurn === turn &&
    store.session().turnId === turn.id && store.session().phase === "responding"
  const ownershipCurrent = (generation: number): boolean => !ctx.disposed && generation === ctx.accountEpoch
  const identitySubscription = store.collections.identitySessions.subscribeChanges(() => {
    const nextOwner = ctx.accountOwner()
    if (nextOwner === owner) return
    owner = nextOwner
    const turn = ctx.activeTurn
    ctx.activeTurn = undefined
    // Cancel without rendering a terminal row into the replacement account.
    if (turn !== undefined) cancelTurn(turn.id)
  })
  ctx.onDispose(() => { identitySubscription.unsubscribe() })

  const launchLeg = (
    turnId: string,
    messages: ReadonlyArray<AgentChatMessage>,
    /*
     * §4.13: the trailing messages a bound must not cut — the user's own
     * prompt, and the function_call/function_call_output pair of every tool
     * leg, which mean nothing split apart.
     */
    keepTail = 1
  ): void => {
    const turn = ctx.activeTurn
    if (turn === undefined || turn.id !== turnId || !isCurrentTurn(turn)) return
    /*
     * §4.13: the client re-sent the whole transcript every turn, so a long
     * conversation crossed the boundary's body limit and then stayed dead —
     * every later turn failed the same way, and /clear could not recover it
     * because /clear runs a model turn of its own into the same wall.
     */
    const { commands, context, instructions, decisionModel } = composeTurn()
    const { request } = boundTurnRequest(
      {
        runId: turnId,
        messages,
        instructions,
        tools: ctx.commands.toolSpecs(),
        commands,
        context,
        ...(decisionModel === undefined ? {} : { decisionModel })
      },
      keepTail
    )
    const cancellation = pendingCancellations.get(turnId)
    const started = cancellation === undefined
      ? agent.startTurn(request)
      : cancellation.then(() => isCurrentTurn(turn) ? agent.startTurn(request) : undefined)
    void started
      .then(async (result) => {
        if (!isCurrentTurn(turn)) {
          // Cancellation can beat a delayed start acknowledgement at the host.
          // Do not let that acknowledgement leave the revoked turn running.
          if (result?.status === "started" && revokedTurn(turn) && ctx.activeTurn?.id !== turn.id) cancelTurn(turn.id)
          return
        }
        if (result?.status !== "error") return
        // §1: a leg that never started still ends a turn that launched a
        // run, and a claim streamed before the launch is already on screen.
        settleRunClaims(turn)
        if (result.refusal?.code === "sign_in_required") {
          const draft = store.collections.messages.get(`message-${turnId}-user`)?.text ?? ""
          try { await offerChatSignIn(draft, turnId) }
          catch (error) {
            if (!isCurrentTurn(turn)) return
            ctx.failures.report("turn.sign-in", error)
            store.dispatch({ type: "message.response.failed", actor: "system", turnId, message: "Sign-in recovery could not be saved." })
          }
        } else if (result.refusal === undefined || !refuseAnonymousTurn(turnId, result.refusal)) {
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId,
            message: result.message
          })
          if (result.refusal?.code === "out_of_credit") offerCreditUpgrade()
        }
        if (revokedTurn(turn)) return
        if (ctx.activeTurn === turn) ctx.activeTurn = undefined
        settleTurnBilling()
      })
      .catch(() => {
        if (!isCurrentTurn(turn)) return
        ctx.activeTurn = undefined
        settleRunClaims(turn)
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId,
          message: "The native Smithers Cloud connection stopped responding."
        })
        settleTurnBilling()
      })
  }

  /*
   * The visible one-line record of a tool act (§2b transcript hygiene): at
   * most a compact Smithers-side line, actor smithers — the raw arguments or
   * result payload (the commands list's JSON, the browser read's text) NEVER
   * enters the conversation. The full-fidelity record lives in the toolCalls
   * collection for the admin dev-tools panel.
   */

  /*
   * One tool-loop leg: execute the model's call through the registry (the
   * same path as buttons and slash, actor smithers), render the act line,
   * then POST the continuation turn with the tool-role result appended.
   */
  const continueToolLeg = async (turn: ActiveTurn): Promise<void> => {
    if (!isCurrentTurn(turn)) return
    const call = turn.pendingCall
    if (call === undefined) return
    turn.pendingCall = undefined
    turn.toolLegs += 1
    // The registry selects fixed smithers bindings for the same flow
    // definitions used by buttons and slash commands.
    /*
     * A throw here is a request that never got an answer — a fetch that died
     * before any server judged it. It used to reach the model as
     * `failed: <message>`, a sentence with no verdict in it, which the model
     * read as the user's mistake and apologised for. It is infra by
     * construction, and now says so.
     */
    const result = await ctx.commands.executeForAgent({ name: call.name, arguments: call.args, httpCall: { turnId: turn.id, callId: call.callId } }).catch((error: unknown) =>
      agentFailureText(agentRefusalText(clientRefusal(error)))
    )
    if (!isCurrentTurn(turn)) return
    /*
     * Wave 12 §1: a real launch arms the deterministic claim surface for the
     * rest of this turn. A refusal or a chooser route launched nothing, so
     * there is no run for the model to misdescribe and its prose stands.
     */
    /*
     * A call the front door minted (apps/server frontDoor.ts) is the whole
     * turn: its act line is the answer — the registry's own honest result,
     * success or refusal — and the continuation leg carries no prose, so the
     * claim surface has nothing to police and this row is what every later
     * turn reads (contextMessages above).
     */
    const answersTurn = call.callId.startsWith(AGENT_TURN_FRONT_DOOR_CALL_PREFIX)
    const launched = runLaunchCommandOf(call.name, call.args)
    if (!answersTurn && launched !== undefined && toolResultLaunchedRun(result)) turn.runLaunch = launched
    store.dispatch({
      type: "toolcall.recorded",
      actor: "smithers",
      turnId: turn.id,
      name: call.name,
      arguments: call.args,
      result
    })
    store.dispatch({
      type: "message.tool.executed",
      actor: "smithers",
      turnId: turn.id,
      text: toolActLine(call, result),
      ...(answersTurn ? { answersTurn: true as const } : {})
    })
    /*
     * The record above keeps the whole result; the model gets it bounded, so
     * one wide tool output cannot fill the next request by itself and force
     * the turn bound to drop the conversation around it.
     */
    turn.toolItems.push(
      { type: "function_call", call_id: call.callId, name: call.name, arguments: call.args },
      { type: "function_call_output", call_id: call.callId, output: boundToolResult(result).modelOutput }
    )
    launchLeg(turn.id, [...contextMessages(), ...turn.toolItems], turn.toolItems.length + 1)
  }

  /*
   * Wave 12 §1 — the claim surface settles deterministically.
   *
   * A turn that launched a run renders the model's whole answer only when it
   * claims nothing about run state; otherwise the client's own line stands in
   * its place. The check reads the WHOLE answer (anything streamed before the
   * tool call plus everything withheld after it) because a preamble and a
   * continuation land in one bubble — half-suppressing a claim still ships it.
   */
  const settleRunClaims = (turn: ActiveTurn): void => {
    const command = turn.runLaunch
    const askClass = turn.askClass
    if (command === undefined && askClass === undefined) return
    const buffered = turn.claimBuffer
    turn.claimBuffer = ""
    turn.runLaunch = undefined
    turn.askClass = undefined
    const streamed = store.collections.messages.get(`message-${turn.id}-smithers`)?.text ?? ""
    const whole = `${streamed}${buffered}`
    if (whole.trim() === "") {
      /*
       * Nothing renderable was withheld, so nothing is substituted — but the
       * turn must still settle. `message.response.completed` no-ops when no
       * answer message exists, and the session's phase would have stayed
       * `responding` forever with the composer refusing every submit: held-
       * back whitespace bricked the chat. Report it as what it was, through
       * the empty-response path that already exists for exactly this.
       */
      turn.receivedText = false
      return
    }
    /*
     * Wave 13c: an ask-classed turn that launched nothing still answers
     * honestly — the class's deterministic line when the model offered the
     * impossible act, its own words otherwise (an unoffered answer flushes
     * verbatim through the same substitution that would have replaced it).
     */
    const text = command !== undefined
      ? renderedRunTurnText(command, whole)
      : renderedAskTurnText(askClass as ImpossibleAskClass, whole)
    store.dispatch({
      type: "message.claim.substituted",
      actor: "system",
      turnId: turn.id,
      text
    })
  }

  const subscribeToAgent = (): void => {
    httpTurns.subscribe()
    const unsubscribe = agent.subscribe((frame: AgentTurnFrame) => {
      if (ctx.activeTurn === undefined || !isCurrentTurn(ctx.activeTurn) ||
        ctx.activeTurn.httpAttemptId !== undefined ||
        frame.runId !== ctx.activeTurn.id || pendingCancellations.has(frame.runId)) return
      if (frame.type === "card" || frame.type === "card.update") {
        handleCardFrame(frame)
        return
      }
      if (frame.type === "tool_call") {
        // The model asked for a command; the done frame right after it ends
        // this leg, and the continuation is driven from there.
        ctx.activeTurn.pendingCall = { callId: frame.call_id, name: frame.name, args: frame.arguments }
        // A call the front door minted (apps/server frontDoor.ts) IS the
        // turn's answer: the act line this call renders says what happened,
        // so its continuation leg carries no text, and a silent leg there is
        // the ordinary end of a worked turn, not an empty response.
        if (frame.call_id.startsWith(AGENT_TURN_FRONT_DOOR_CALL_PREFIX)) ctx.activeTurn.receivedText = true
        return
      }
      if (frame.type === "delta") {
        if (frame.text === "") return
        if (frame.kind === "text") {
          ctx.activeTurn.receivedText = true
          /*
           * Wave 12 §1: after a run launch the model's words are held until
           * the turn settles, so a claim is never rendered even for the beat
           * it would take to stream. Reasoning is unaffected — it is not the
           * answer, and the substitution replaces the answer.
           * Wave 13c: the same hold applies when the user's ask named an
           * impossible class — the offer is reviewed before it renders.
           */
          if (ctx.activeTurn.runLaunch !== undefined || ctx.activeTurn.askClass !== undefined) {
            ctx.activeTurn.claimBuffer += frame.text
            return
          }
        }
        store.dispatch({
          type: "message.response.delta",
          actor: "smithers",
          turnId: frame.runId,
          channel: frame.kind,
          delta: frame.text
        })
        return
      }
      /*
       * Chain frames (DESIGN.md §14). A settled command call renders the same
       * one-line act row the tool loop rendered — the harness's own doors
       * (author, say, cards, sys/*) are not user-facing acts. A gate
       * rejection is visible, payload-free, and in-character (§9: no
       * flow/run jargon) — never an error bubble, because the next link
       * corrects it. The remaining chain frames (link.*, steering.drained,
       * park, call.started) are journal evidence: debug mode renders them;
       * the transcript does not.
       */
      if (frame.type === "link.authored") {
        // A chain turn that ends without prose is still a worked turn: the
        // authored link is the proof, so the empty-response failure branch
        // below never applies to a chain turn.
        ctx.activeTurn.receivedText = true
        return
      }
      if (frame.type === "call.settled") {
        // Wave 12 parity: a settled launch call arms the deterministic claim
        // surface exactly as the tool loop did, so the model's prose about
        // the run substitutes at settle instead of rendering as a claim.
        if (RUN_LAUNCH_COMMANDS.includes(frame.name)) {
          ctx.activeTurn.runLaunch = frame.name
        }
        if (!CHAIN_SURFACE_CALLS.has(frame.name) && !frame.name.startsWith("sys/")) {
          store.dispatch({
            type: "message.tool.executed",
            actor: "smithers",
            turnId: frame.runId,
            text: `Smithers ran /${frame.name}`
          })
        }
        return
      }
      if (frame.type === "park") {
        // Approval parks explain themselves through the approval card; every
        // other park states the pause honestly instead of settling silently.
        if (frame.code !== "approval") {
          store.dispatch({
            type: "message.appended",
            actor: "system",
            text: frame.code === "quota"
              ? "Smithers paused — this turn ran out of budget."
              : "Smithers paused — it is waiting on something outside this chat."
          })
        }
        return
      }
      if (frame.type === "gate.rejected") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers adjusted its approach"
        })
        return
      }
      if (frame.type === "steering.drained") {
        store.dispatch({
          type: "message.tool.executed",
          actor: "smithers",
          turnId: frame.runId,
          text: "Smithers picked up your note"
        })
        return
      }
      if (frame.type !== "done") return
      const turn = ctx.activeTurn
      // A kill outranks a pending tool call: the terminal frame the Worker
      // injects for a server-side kill can land between the model's
      // `tool_call` frame and the upstream's own `done`. Continuing there
      // would run the tool and re-POST a continuation leg — the killed turn
      // would quietly carry on, which is exactly what B-3 forbids.
      if (
        frame.error === undefined &&
        frame.reason !== "cancelled" &&
        turn.pendingCall !== undefined
      ) {
        if (turn.toolLegs >= MAX_TOOL_LEGS) {
          ctx.activeTurn = undefined
          settleRunClaims(turn)
          store.dispatch({
            type: "message.response.failed",
            actor: "system",
            turnId: turn.id,
            message: `I hit the tool-call limit for this turn (${MAX_TOOL_LEGS}) — stopping here instead of looping.`
          })
          settleTurnBilling()
          return
        }
        void continueToolLeg(turn)
        return
      }
      ctx.activeTurn = undefined
      settleRunClaims(turn)
      if (frame.error !== undefined) {
        if (frame.code === "credential_missing") credentialMissing?.()
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: frame.error
        })
      } else if (frame.reason === "cancelled") {
        // A server-side kill ended the stream with the honest terminal frame —
        // render it interrupted (partial text kept), never a silent stop.
        store.dispatch({
          type: "message.response.cancelled",
          actor: "system",
          turnId: turn.id,
          detail: "That turn was stopped by the server."
        })
      } else if (frame.reason === "tool_limit") {
        // The server-side cap answered honestly; surface it the same way.
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud stopped this turn at its tool-call limit."
        })
      } else if (!turn.receivedText) {
        store.dispatch({
          type: "message.response.failed",
          actor: "system",
          turnId: turn.id,
          message: "Smithers Cloud returned an empty response."
        })
      } else {
        store.dispatch({
          type: "message.response.completed",
          actor: "smithers",
          turnId: turn.id
        })
      }
      settleTurnBilling()
    })
    // The subscription is scoped to the controller: disposing the controller
    // unsubscribes instead of leaking the listener for the page lifetime.
    if (typeof unsubscribe === "function") ctx.onDispose(unsubscribe)
  }

  /** A miss the registry did not render itself, stated as the refusal the toast channel carries. */
  const missAsFailure = (name: string, outcome: CommandOutcome): CommandOutcome =>
    outcome.status === "unknown-command"
      ? { status: "failed", error: `There is no /${name} flow. Type / to see everything Smithers can do.` }
      : outcome.status === "unavailable" && outcome.action === null
      ? { status: "failed", error: outcome.reason }
      : outcome

  const send: TurnController["send"] = (text, admission, capturedDraft) => {
    if (ctx.disposed) return
    const generation = ctx.accountEpoch
    if (admission && ctx.accountOwner() !== admission.owner) return
    // This lookup excludes optimistic rows, including a prior failed attempt.
    if (admission && typeof admission.owner === "string" && store.committedHttpTurn(admission.turnId, admission.owner)) return Promise.resolve(true)
    const draftCurrent = capturedDraft ?? store.captureComposerDraft(text)
    const parsed = parseSubmit(text, ctx.commands.all())
    if (parsed.kind === "empty") return
    if (parsed.kind === "unknown-command") {
      /*
       * §23.5: a name the app does not have used to go to the model as
       * prose, and the model reached for whatever flow it COULD see — so
       * `/reset` on a non-admin session ran `retry`. The app answers for
       * its own registry, through the one run path: a declared flow this
       * host lacks the door for is refused by its door (Commands.ts settle —
       * the download card when the native app is the answer, the sentence
       * otherwise), and only a name no host has is "no such flow".
       */
      if (draftCurrent()) store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      /* Everything the door says from here on belongs to this line (controller/spokenLines.ts). */
      const saidBefore = latestOrdinal(store.collections)
      void ctx.commands.run(parsed.name).then((outcome) => {
        if (ownershipCurrent(generation)) surfaceCommandFailure(parsed.name, missAsFailure(parsed.name, outcome), saidBefore)
      })
      return
    }
    if (parsed.kind === "command") {
      /*
       * A bare /name is a command invocation, never a prompt for the agent.
       * The outcome is surfaced exactly as the pointer path surfaces it:
       * a flow the human typed and that refused must SAY so — dropping the
       * outcome here is what made `/name <args>` silent while bare `/name`
       * (which the slash menu routes through the pointer path) was honest.
       */
      if (draftCurrent()) store.dispatch({ type: "composer.changed", actor: "user", draft: "" })
      /* Everything the door says from here on belongs to this line (controller/spokenLines.ts). */
      const saidBefore = latestOrdinal(store.collections)
      void ctx.commands
        .run(parsed.name, parsed.args)
        .then((outcome) => { if (ownershipCurrent(generation)) surfaceCommandFailure(parsed.name, outcome, saidBefore) })
      return
    }
    const prompt = parsed.text
    if (store.session().phase !== "idle") {
      if (admission) return
      /*
       * Mid-turn input steers a steerable turn (DESIGN.md §14): the words
       * render as the user's own bubble now, and the running chain drains
       * them at its next link boundary. A backend without steering (the
       * proxy) keeps today's behavior — the input is not eaten, it stays
       * in the composer.
       */
      const turn = ctx.activeTurn
      if (turn !== undefined && agent.steer !== undefined) {
        // Wave 13c holds apply to steered asks too: an impossible ask
        // admitted mid-turn arms the same review the opening prompt gets.
        const steeredAsk = impossibleAskOf(prompt)
        if (steeredAsk !== undefined && turn.askClass === undefined) {
          turn.askClass = steeredAsk
        }
        void agent
          .steer(turn.id, prompt)
          .then((admitted) => {
            if (admitted && isCurrentTurn(turn)) {
              store.dispatch({ type: "message.steered", actor: "user", turnId: turn.id, text: prompt, preserveDraft: !draftCurrent() })
            }
          })
          .catch(() => {
            // The draft remains untouched, so a rejected steer is retryable.
          })
      } else {
        void ctx.withToast("chat.busy", "Chat", "Chat", async () => "A response is still in progress — stop it first, then retry.")
      }
      return
    }
    if (chatNeedsSignIn()) {
      return offerChatSignIn(text).then(() => false)
    }
    const turnId = admission?.turnId ?? crypto.randomUUID()
    if (agent.journal !== undefined) {
      return httpTurns.start(turnId, prompt, false, ctx.commandActor, !draftCurrent())
    }
    ctx.activeTurn = ownTurn({
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      // Wave 13c: the ASK arms the hold, detected from the user's words
      // before the model speaks — ordinary conversation arms nothing.
      askClass: impossibleAskOf(prompt),
      claimBuffer: ""
    })
    const pendingTurn = ctx.activeTurn
    const receipt = store.dispatch({ type: "message.submitted", actor: ctx.commandActor, turnId, text: prompt, preserveDraft: !draftCurrent() })
    if (!admission) launchLeg(turnId, contextMessages())
    const admitted = receipt.isPersisted.promise.then(() => {
      if (admission && isCurrentTurn(pendingTurn)) launchLeg(turnId, contextMessages())
      return true
    }, error => {
      if (ctx.activeTurn === pendingTurn) ctx.activeTurn = undefined
      if (!admission) cancelTurn(turnId)
      throw error
    })
    void admitted.catch(() => {})
    return admitted
  }

  const reset = (): void => {
    if (ctx.disposed) return
    const turn = ctx.activeTurn
    ctx.activeTurn = undefined
    if (turn !== undefined) cancelTurn(turn.id)
    ctx.stopWorkflowPumps()
    store.dispatch({ type: "conversation.reset", actor: "user" })
  }

  const stop = (): void => {
    if (ctx.disposed || ctx.activeTurn === undefined) return
    if (httpTurns.stop()) return
    const turn = ctx.activeTurn
    const turnId = turn.id
    ctx.activeTurn = undefined
    cancelTurn(turnId)
    /*
     * §1: stopping does not un-launch the run, so the claim surface still
     * belongs to the client. Anything the model streamed before the tool call
     * is already rendered — settling here replaces it with the deterministic
     * line instead of leaving a half-turn's claim standing.
     */
    settleRunClaims(turn)
    store.dispatch({
      type: "message.response.cancelled",
      actor: "user",
      turnId,
      detail: "Stopped the current response."
    })
  }

  const approvalFailed = (cardId: string, error: unknown, generation: number, target?: { requestId: string; runId?: string }): void => {
    ctx.failures.report("approval.forward", error, cardId)
    if (!ownershipCurrent(generation)) return
    void releaseInterruptedApproval(store, store.collections.cards.get(cardId), lostActRefusal(error), target)
      .catch(failure => ctx.failures.report("approval.forward", failure, cardId))
  }

  const commitApprovalDecision = (id: string, decision: "approved" | "denied", answer?: unknown): void => {
    if (ctx.disposed) return
    const generation = ctx.accountEpoch
    const rowTarget = parseApprovalActionId(id)
    if (rowTarget !== undefined) {
      void forwardInboxApprovalDecision(rowTarget.cardId, rowTarget.requestId, decision, rowTarget.runId, answer).catch(error => approvalFailed(rowTarget.cardId, error, generation, rowTarget))
      return
    }
    /*
     * Legacy inbox actions used `inboxCardId:requestId`; they resolve only
     * when that request ID belongs to exactly one row: the gate's own approval card may never have landed in
     * this transcript, so the row forwards through the inbox card, which
     * carries the submit-ready envelope the gateway published.
     */
    const separator = id.indexOf(":")
    if (separator > 0) {
      const inboxCardId = id.slice(0, separator)
      const requestId = id.slice(separator + 1)
      const inbox = store.collections.cards.get(inboxCardId)
      if (inbox?.kind === "approvals-inbox") {
        void forwardInboxApprovalDecision(inboxCardId, requestId, decision, undefined, answer).catch(error => approvalFailed(inboxCardId, error, generation, { requestId }))
        return
      }
    }
    const displayed = store.collections.cards.get(id)
    const card = store.approvalRequest(id)
    if (card?.kind !== "approval" || displayed?.kind !== "approval" || displayed.status === "acted") return
    if (displayed.payload.pending === true || displayed.payload.decision !== undefined) return
    const { runId, requestId, approval } = card.payload
    if (runId === undefined || requestId === undefined || approval === undefined) {
      // A card without a run identity has no backend to decide against —
      // say so honestly instead of fake-freezing it.
      store.dispatch({
        type: "card.approval.decision.failed",
        actor: "system",
        id,
        message: "This approval is not linked to a run, so there is nothing to send the decision to."
      })
      return
    }
    const pending = store.dispatch({ type: "card.approval.decision.pending", actor: "user", id })
    void pending.isPersisted.promise.then(() => ownershipCurrent(generation) ? forwardApprovalDecision(card, decision, answer) : undefined).catch(error => approvalFailed(id, error, generation))
  }

  const decideApproval = (id: string, decision: "approved" | "denied", answer?: unknown, question?: string): void => {
    if (ctx.disposed) return
    if (answer === undefined) { commitApprovalDecision(id, decision); return }
    const input = prepareApprovalAnswer(store, id, answer, question)
    if (input === undefined || decision !== "approved") return
    const generation = ctx.accountEpoch
    // An answer is never sent before its human input has a durable receipt.
    const receipt = store.dispatch({ type: "approval.answer.changed", actor: "user", ...input })
    void receipt.isPersisted.promise.then(() => {
      if (!ownershipCurrent(generation) || !isCurrentApprovalAnswer(store.collections.runtimeApprovals.get(input.id), input)) return
      commitApprovalDecision(id, decision, answer)
    }).catch(error => approvalFailed(id, error, generation))
  }

  /*
   * /retry re-RUNS the last turn — it does not re-SEND the prompt.
   *
   * `send` appends a user message, so retrying through it grew the transcript
   * a duplicate user/assistant pair per attempt and made every retry ship a
   * longer history than the one before it. The turn keeps its id: the answer
   * it produced is dropped and the same leg launches again over the context
   * that produced it.
   */
  /*
   * A refusal is returned as its reason so the run path can state it as a
   * toast: typed with nothing settled to re-run, `/retry` used to "execute"
   * and change nothing on screen, which reads as a dead command.
   */
  const retryLastTurn = (): string | void => {
    if (ctx.disposed) return
    if (store.session().phase !== "idle" || ctx.activeTurn !== undefined) {
      return "A response is still in progress — stop it first, then retry."
    }
    const last = [...store.collections.messages.values()]
      .filter((message) => message.role === "user")
      .sort((left, right) => right.ordinal - left.ordinal)[0]
    const turnId = last?.id.match(/^message-(.+)-user$/)?.[1]
    if (turnId === undefined) return "Nothing to retry yet — send a message first."
    if (chatNeedsSignIn()) {
      void offerChatSignIn(last?.text ?? "").catch(error => ctx.failures.report("turn.sign-in", error))
      return
    }
    if (agent.journal !== undefined) {
      httpTurns.start(turnId, last?.text ?? "", true, "user")
      return
    }
    store.dispatch({ type: "message.retried", actor: "user", turnId })
    if (store.session().phase !== "responding") return
    ctx.activeTurn = ownTurn({
      id: turnId,
      receivedText: false,
      toolLegs: 0,
      toolItems: [],
      pendingCall: undefined,
      runLaunch: undefined,
      askClass: impossibleAskOf(last?.text ?? ""),
      claimBuffer: ""
    })
    launchLeg(turnId, contextMessages())
  }

  const httpTurns = createHttpTurnDriver(ctx, {
    ownTurn, isCurrentTurn, contextMessages, composeTurn, settled: settleTurnBilling,
    refused: (turnId, result, attemptId) => {
      if (result.refusal?.code === "sign_in_required") return offerChatSignIn(store.collections.messages.get(`message-${turnId}-user`)?.text ?? "", turnId, attemptId)
      else if (result.refusal?.code === "out_of_credit") offerCreditUpgrade()
      else if (result.refusal !== undefined) refuseAnonymousTurn(turnId, result.refusal)
    }
  })
  return { subscribeToAgent, send, reset, stop, decideApproval, retryLastTurn }
}
