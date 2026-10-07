import { createBranchMutations } from "./seams/BranchMutationsSeam"
import { draftIssueTodo } from "./seams/IssueTodoDraft"
import { createBranchControlsSeam } from "./seams/BranchControlsSeam"
import { branchFileMachineScope } from "./seams/BranchSeam"
import { projectHome } from "../runtime/HomeProjection"
import { projectTodoCard } from "../runtime/TodoProjection"
import { createSharedPrompts } from "./controller/sharedPrompts"
import { createSharedConversationSeam, type SharedConversationSeam } from "./seams/SharedConversationSeam"
import { createEarlierHistoryController } from "./controller/earlierHistory"
import { accountOwnerOf } from "./AccountOwner"
import { createHomeViewSeam, type HomeViewSeam } from "./seams/HomeViewSeam"
import { contextMonitor } from "./ContextMonitor"
import type { MonitorCard } from "@smthrs/rpc/MonitorCard"
import { designProposalCard } from "./seams/DesignWorld/proposal"
import { createProposalSeam, type ProposalSeam } from "./seams/ProposalSeam"
import { FileDocuments } from "../runtime/FileDocuments"
import type { DocumentPrerequisites } from "../runtime/LiveDocProvider"
import type { LiveChannel } from "../runtime/LiveChannel"
import { createTerminalSource, type TerminalCardSource } from "./seams/TerminalSeam"
import { debugApiOperation } from "@smthrs/ui/app-operations"
import { bundledOpenApi } from "../../debugApi/bundled"
import { createDebugApiSeam, debugApiFailureCopy, presentDebugApiFailure, type DebugApiSeam, type DebugApiInput, type DebugApiGates, type OpenApiDocument } from "./seams/DebugApiSeam"
import { confirmCancelRefusal } from "@smthrs/rpc/ConfirmCard"
import type { Refusal } from "@smthrs/rpc/Refusal"
import { openRequestedRepo } from "../RepoLink"
import { createRepositoryReadiness } from "./controller/repositoryAdmission"

import { createConversationHistoryController } from "./controller/conversationHistory"
import { createWikiAttachmentStore, type WikiAttachmentStore } from "../wiki/WikiAttachmentStore"
import { identityProviderFor, signInByHandoff } from "./IdentityProvider"
import type { IdentityProvider } from "./IdentityProvider"
import type { ClientErrorReporter } from "./ClientErrors"
import type { FlowSubmission } from "../flows/Commands"
import { lostActRefusal } from "./BrowserWriteFailure"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { ApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"
import { AUTH_SIGN_IN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { CatalogItem,CommandOutcome,CommandRegistry } from "../flows/Commands"
import { createCommandRegistry } from "../flows/Commands"
import { bindFlowPreloading } from "../flows/FlowAction"
import type { CommandActions } from "../flows/Flows"
import type { RepositoryFlowCatalog } from "../flows/entries/flow"
import type { SlashItem,SlashRow } from "../flows/registry"
import { parseSubmit, flowRequirements } from "../flows/registry"

import type { AgentPort } from "../runtime/AgentPort"
import type { ApplicationIdentityClient } from "../runtime/ApplicationClient"
import type { FrameHistoryPort } from "../runtime/FrameHistory"
import { localSocketProtocols } from "../runtime/LocalSession"
import { createActorBindings } from "./ActorBindings"
import type { AppTransition, Card, Message } from "./AppState"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, MAIN_TAB_ID, rootFrameId } from "./AppState"
import type { AppStore } from "./AppStore"
import { createCloudLspClient } from "./CloudLspClient"
import type { CloudTerminalClient } from "./CloudTerminalClient"
import { createCloudTerminalClient,pageCloudSocketUrl } from "./CloudTerminalClient"
import { selectFirstRunRepository } from "./BootRepositoryTarget"
import type { InputMode } from "./InputMode"
import { cardAvailable } from "./CardAvailability"
import { type ViewAction, disposePreparedViews,invalidatePreparedViews } from "./PreparedView"
import type { KnownRepositories } from "./RepoContext"
import { TodoCardSchema } from "@smthrs/rpc/TodoCard"
import { activeCatalogRepositoryId,activeRepositoryId,knownRepositories,resolveTargetRepo } from "./RepoContext"
import type { StorageRecoveryAction,StorageRecoveryHost } from "./StorageRecoveryAction"
import type { AgentsController } from "./controller/agents"
import { createModelsController } from "./controller/models"
import { createAgentsController } from "./controller/agents"
import { createAuthBillingController } from "./controller/auth-billing"
import { createCloudWikiController } from "./controller/cloud-wiki"
import type { CommandGesture } from "../flows/CommandGesture"
import type { WikiSpace } from "../wiki/CloudWiki"
import type { WikiIndexStore } from "./controller/cloud-wiki"
import { createCommandIntentLifecycle } from "./controller/commandIntents"
import { createPrivacyActions, PRIVACY_WRITE_PENDING, PRIVACY_WRITE_FAILED } from "./controller/privacyActions"
import { createConnectorController } from "./controller/connectors"
import type { NetEntry } from "./controller/context"
import { createControllerContext, UNRECORDED_NET, type UnrecordedInit } from "./controller/context"
import type { ControlFocusController } from "./controller/controlFocus"
import { createControlFocus } from "./controller/controlFocus"
import { createDictation } from "./controller/dictation"
import { TOAST_SUPERSEDED, createFailureController,humanCommandText } from "./controller/failures"
import type { FormFocusHandoff, FormsController } from "./controller/forms"
import { createFormsController } from "./controller/forms"
import { createFramesController } from "./controller/frames"
import { createHealthStatusController } from "./controller/health-status"
import { createInputModeController } from "./controller/inputMode"
import { createIssueFlowsController,type IssueFlowsController } from "./controller/issueFlows"
import { createPresentationController } from "./controller/presentation"
import type { CommandSelector } from "./CommandSelection"
import { createRepositoryUpdate } from "./controller/repositoryUpdate"
import { createGraphController,type GraphController } from "./controller/graph"
import { createRunsController,type RunsController } from "./controller/runs"
import type { SidebarController } from "./controller/sidebar"
import { createSidebarController } from "./controller/sidebar"
import { latestOrdinal } from "./controller/spokenLines"
import { createStorageRecoveryController } from "./controller/storage-recovery"
import type { TabsController } from "./controller/tabs"
import { createTabsController } from "./controller/tabs"
import { observeBackgroundWork } from "./controller/backgroundWork"
import { createGitHubSyncRetry } from "./controller/githubSync"
import { createPromptQueueController } from "./controller/promptQueue"
import { createTurnController, type TurnController } from "./controller/turns"
import { createFlowDurationsReader } from "./controller/flowDurations"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import { createWorkflowController,type WorkflowController } from "./controller/workflows"
import type { WikiEditorHandle } from "./controller/world"
import { createWorldController } from "./controller/world"
import type { BillingSeam } from "./seams/HostedBilling"
import { createBillingSeam, showHostedBalance } from "./seams/HostedBilling"
import { createDocsController } from "./controller/docs"
import type { Docs } from "../../docs/Docs"
import { bundledDocs } from "../../docs/bundled"
import { createBranchNavigationSeam } from "./seams/BranchNavigationSeam"
import type { ChangeSeam } from "./seams/ChangeSeam"
import { createChangeSeam } from "./seams/ChangeSeam"
import type { CloudSeam } from "./seams/CloudSeam"
import { createCloudSeam } from "./seams/CloudSeam"
import type { CodeIntelSeam } from "./seams/CodeIntelSeam"
import { createCodeIntelSeam } from "./seams/CodeIntelSeam"
import { createDiffFilesSeam, createBranchDiffReader } from "./seams/DiffFilesSeam"
import type { EgressSeam } from "./seams/EgressSeam"
import { createEgressSeam } from "./seams/EgressSeam"
import type { BranchFileOptions, FilesSeam } from "./seams/FilesSeam"
import { createFilesSeam, resolveFileTarget } from "./seams/FilesSeam"
import type { GitHubSeam } from "./seams/GitHubSeam"
import { createGitHubSeam } from "./seams/GitHubSeam"
import type { IssuesSeam } from "./seams/IssuesSeam"
import { createIssuesSeam } from "./seams/IssuesSeam"
import type { LandingsSeam } from "./seams/LandingsSeam"
import { createLandingsSeam } from "./seams/LandingsSeam"
import type { RepoImportSeam } from "./seams/RepoImportSeam"
import { createRepoImportSeam } from "./seams/RepoImportSeam"
import { createRepoTreeSeam } from "./seams/RepoTreeSeam"
import type { RepositoriesSeam } from "./seams/RepositoriesSeam"
import { createRepositoriesSeam } from "./seams/RepositoriesSeam"
import { createRepositoryFlowsSeam } from "./seams/RepositoryFlowsSeam"
import type { SeamContext } from "./seams/SeamContext"
import type { PaletteAnswer,SearchSeam } from "./seams/SearchSeam"
import { createSearchSeam } from "./seams/SearchSeam"
import type { SecretsSeam } from "./seams/SecretsSeam"
import { createSecretsSeam } from "./seams/SecretsSeam"
import { SecretsCardSchema } from "@smthrs/rpc/SecretsCard"
import { SecretsView } from "../cards/views/SecretsView"
import { secretsCardFamily } from "../cards/SecretsCard"
import type { SecretsProviders } from "./seams/SecretsProviders"
import type { StackSeam } from "./seams/StackSeam"
import { createInstallSeam, type InstallSeam, type InstallTopic } from "./seams/InstallSeam"
import { createGitHubSyncSeam, type GitHubSyncSeam } from "./seams/GitHubSyncSeam"
import { createExternalSessionSeam, type ExternalSessionSeam } from "./seams/ExternalSessionSeam"
import { createTimelineTitleSeam, modelStreamTitles, type TimelineTitleSeam } from "./seams/TimelineTitleSeam"
import { createAgentLaunch, type StartAgent } from "./controller/agentLaunch"
import { createMembersSeam, type MembersSnapshots } from "./seams/MembersSeam"
import { createRunMonitorSeam, type RunMonitorSnapshots } from "./seams/RunMonitorSeam"
import { traceNamed } from "./seams/DesignWorld/run"
import { createFlowsSeam, type FlowsSnapshots } from "./seams/FlowsSeam"
import { createTodoSeam, type TodoSeam, type TodoTopics } from "./seams/TodoSeam"
import { createConfirmationSeam } from "./seams/ConfirmationSeam"
import { createDesignWorld, type DesignWorld } from "./seams/DesignWorld"
import { actCard, confirmSubject, designPlainTurn, designTurn, mergeCard, type DesignTurn } from "./seams/DesignWorld/chat"
import { designMembers, designMembersRoster, designSecrets, designSettings, designViewerRole } from "./seams/DesignWorld/settings"
import { shellViewsOf } from "./seams/DesignWorld/shell"
import { DESIGN_CARD, newWikiPage, wikiCard } from "./seams/DesignWorld/subjects"
import { flowCardOf, flowNames } from "./seams/DesignWorld/run"
import { todoSourceProbe, withDesignTodos, type TodoRoute } from "./seams/DesignWorld/todo"
import { createStackSeam } from "./seams/StackSeam"
import type { TriggersSeam } from "./seams/TriggersSeam"
import { createTriggersSeam } from "./seams/TriggersSeam"
import type { LiveTopics } from "./useTopic"
import type { WorkspaceSeam } from "./seams/WorkspaceSeam"
import { createWorkspaceSeam } from "./seams/WorkspaceSeam"
import { randomUuid } from "../runtime/RandomUuid"

import type { ContextContainerProps } from "../ContextContainer"
import { createContextSeam, type ContextProvider } from "./seams/ContextSeam"

export interface AppController extends IssueFlowsController {
  readonly secretsProviders?: SecretsProviders
  readonly storageRecoveryState: StorageRecoveryAction["state"]
  readonly promptStorageRecovery: () => Promise<void>
  readonly exportStorageRecovery: () => Promise<string | void>
  /** The two-press erase: the first invocation arms it, the second runs it. */
  readonly resetStorageRecovery: () => Promise<string | void>
  readonly store: AppStore
  /** Control focus ("spotlight"): the one surface the human is driving right now (controller/controlFocus.ts). */
  readonly controlFocus: ControlFocusController
  /** The form the human's own invocation just rendered, until its card takes the keyboard (controller/forms.ts). */
  readonly formFocus: FormFocusHandoff
  readonly bootstrap: AppBootstrap | undefined
  /** The sign-in door this origin has (IdentityProvider.ts): the hosted GitHub session, or the owner's credentials. */
  readonly identityProvider: IdentityProvider
  /** Immutable repository pointer from this page's entry URL. */
  readonly repositoryApp: string | null
  /** The native app's download URL this page offers; null while no native release carries an asset (controller/app.ts). */
  /** The resolved feature flags (every flag defaults off). */
  readonly features: Required<AppFeatures>
  readonly nativeAgentAvailable: boolean
  readonly dismissHint: (id: string) => void
  readonly commands: CommandRegistry
  readonly privacyNotices: ReturnType<typeof createPrivacyActions>["notices"]
  /**
   * The active repository's declared flows (the `flows` rows of its
   * .smithers/factory.json, seams/RepositoryFlowsSeam.ts), from which the
   * registry derives one slash leaf each; undefined without a target
   * repository or before its projection has landed.
   */
  readonly repositoryFlows: () => RepositoryFlowCatalog | undefined
  /**
   * The repositories a trailing `owner/repo` token beside other text may
   * name (RepoContext.ts knownRepositories): the slash grammar's check that
   * `fix src/index.ts` keeps its path.
   */
  readonly knownRepositories: () => KnownRepositories
  readonly slashItems: (needle: string) => Array<SlashItem<CatalogItem>>
  readonly slashTree: (needle: string) => Array<SlashRow<CatalogItem>>
  readonly changeDraft: (draft: string) => void
  readonly reset: () => void
  readonly debugReset: () => Promise<string | void>
  readonly stop: () => void
  readonly send: TurnController["send"]
  readonly enqueuePrompt: (text: string, draftCurrent?: () => boolean) => void
  readonly removeQueuedPrompt: (id: string, edit?: boolean) => void
  readonly restoreQueuedPrompts: () => void
  readonly showChat: () => void
  readonly showWorld: () => void
  /** The Wiki pane beside the chat (#1922): toggles, and reads the shown space's index on opening. */
  readonly showWikiPane: () => void
  /** The Library: the plugin shelf this workspace browses and installs from. */
  readonly askReset: () => void
  readonly cancelReset: () => void
  readonly submitCommand: (submission: FlowSubmission) => Promise<import("../flows/Commands").CommandOutcome>
  readonly runCommand: (name: string, args?: string, originCardId?: string) => boolean
  readonly runCommandForResult: (name: string, args?: string, originCardId?: string) => Promise<CommandOutcome>
  readonly makeConnectorReadOnly: (id: string) => string | void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => Promise<string | void>
  readonly openWikiPage: (name: string, revision?: number) => Promise<string | void | { value: string }>
  readonly listCloudWiki: (repo?: string, page?: number, space?: WikiSpace) => Promise<string | { value: string }>
  readonly openCloudWiki: (repo: string, slug: string, expectedPageId?: number, space?: WikiSpace) => Promise<string | { value: string }>
  readonly retryCloudWiki: (id: string) => Promise<string | void | { value: string }>
  /** The Wiki spaces (#1922): the switch, the space's navigation index, a page's history, and the writes the pane offers. */
  readonly setWikiSpace: (space: string, repo?: string) => Promise<string | void>
  readonly setWikiPageView: (view: string) => Promise<string | void>
  readonly loadWikiIndex: (repo?: string, space?: WikiSpace, quiet?: boolean) => Promise<string | { value: string }>
  readonly showWikiHistory: (slug: string, repo?: string, page?: number, space?: WikiSpace) => Promise<string | void | { value: string }>
  readonly saveWikiAnswer: (name: string, text?: string) => Promise<string | void | { value: string }>
  readonly createCloudWikiPage: (title: string, repo?: string, body?: string) => Promise<string | void | { value: string }>
  readonly renameCloudWikiPage: (slug: string, path: string, repo?: string) => Promise<string | void>
  readonly deleteCloudWikiPage: (slug: string, repo?: string) => Promise<string | void>
  readonly attachCloudWiki: (path: string, repo: string | undefined, gesture?: CommandGesture) => Promise<string | void | { value: string }>
  /** Ephemeral authenticated attachment handles shared by Wiki views. */
  readonly wikiAttachments: WikiAttachmentStore
  /** The live wiki navigation indexes the Wiki views read (#1922), one per repository and space; never an act. */
  readonly wikiIndexes: WikiIndexStore
  readonly attachWorldEditor: (id: string, slot: string, editor: MarkdownEditorHandle | null) => void
  readonly selectWikiCardDocument: (cardId: string, documentId: string) => string | void
  readonly setWikiCardView: (cardId: string, view: "outline" | "read" | "document") => string | void
  readonly createWorldDocument: () => void
  /** Ask whether to delete a note; the answer is `world.delete.confirm|cancel`. */
  readonly removeWorldDocument: (id: string) => string | void
  readonly confirmWorldDelete: () => string | void
  readonly cancelWorldDelete: () => void
  /** `wiki.open <path>` embeds the note for either actor and returns its links to the agent. */
  readonly openWorldDocument: (path: string) => string | void | { readonly value: string }
  /** `wiki.backlinks <path>`: the note's link rail as an embedded card, for either actor; the agent reads the names back. */
  readonly showWorldLinks: (path: string) => string | void | { readonly value: string }
  /** `wiki.graph [path]` embeds the graph for either actor and returns its counts to the agent. */
  readonly showWorldGraph: (path?: string) => string | void | { readonly value: string }
  /** The Wiki pane's editor mount registers its handle here (null on unmount); `wiki.heading` scrolls through it. */
  readonly attachWikiEditor: (editor: WikiEditorHandle | null) => void
  /** `wiki.heading <line>`: bring the open note's heading at that source line into view. */
  readonly jumpToHeading: (line: string, cardId?: string) => Promise<string | void>
  /** `docs [page]` embeds an in-app docs page (M-35) as a read-only card for either actor. */
  readonly debugApi: DebugApiSeam
  readonly debugApiCommand: (input: DebugApiInput) => string | { readonly value: string }
  readonly docsTargetAvailable: (target: string) => boolean
  readonly contextLine: (answerId: string) => Omit<ContextContainerProps, "dispatch" | "available"> | undefined
  readonly contextAvailable: () => boolean
  readonly inspectContext: (branch: string, answer: string) => Promise<import("../flows/entries/Declare").CommandResult>
  readonly docsAvailable: () => boolean
  readonly openDocsPage: (page?: string) => string | { readonly value: string }
  /** `docs.read <page>`: the page's title, summary and Markdown as JSON, for the agent. */
  readonly readDocsPage: (page: string) => string | { readonly value: string }
  readonly decideApproval: (id: string, decision: "approved" | "denied") => void
  /**
   * Answer a gate that asked a question rather than for a grant.
   *
   * A HumanTask parks its run on something only a person knows, so approve and
   * deny answer nothing: the value the person wrote is what resumes the run.
   * It is its own method because a value cannot ride a flow's argument string.
   */
  readonly answerApproval: (id: string, answer: unknown, question?: string) => void
  readonly retryLastTurn: () => string | void
  /** Light or dark mode (/theme): the named one, or the other one when none is named. */
  readonly setTheme: (theme?: "light" | "dark") => void
  /* The browser tool + surface (§2d/§2d′). */
  readonly openBrowser: (url: string) => Promise<string | void | { readonly value: string }>
  /*
   * Wave 11 — workflows in the conversation. Create/list/run through the
   * box's flow seam; runs render as embedded run cards tracked live.
   */
  readonly createWorkflow: (
    description: string,
    repo?: string
  ) => Promise<string | void | { readonly value: string }>
  readonly listWorkspaceWorkflows: WorkflowController["listWorkspaceWorkflows"]
  /** The dispatchers waiting on the repository (triggers.list): declared rules for every visitor, live rows when a box answered. */
  readonly listTriggers: TriggersSeam["listTriggers"]
  /** The register door (triggers.register): signed-in by requirement. */
  readonly registerTrigger: TriggersSeam["registerTrigger"]
  /** Ask 5: the Flows pane — the surface switch and the listing that fills it. */
  readonly showFlows: () => Promise<string | void | { readonly value: string }>
  readonly runWorkflow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string, humanDoor?: boolean) => Promise<string | void | { readonly value: string }>
  /** What a flow WOULD run (flow.plan). */
  readonly planFlow: WorkflowController["planFlow"]
  /* Wave 12 §2 — the answer to "which loaded repository?" (one act). */
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §3 — the two acts a run that has gone quiet offers. */
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  /** Boot reconciliation: resume the event pump for any run card still live. */
  readonly resumeWorkflowRuns: () => void
  /* Lane runs — the run lifecycle beyond launch (see controller/runs.ts). */
  readonly listRuns: RunsController["listRuns"]
  readonly openRun: RunsController["openRun"]
  readonly resumeRun: RunsController["resumeRun"]
  readonly continueRun: RunsController["continueRun"]
  readonly rerunRun: RunsController["rerunRun"]
  readonly signalRun: RunsController["signalRun"]
  readonly showRunLogs: RunsController["showRunLogs"]
  readonly showRunSteps: RunsController["showRunSteps"]
  readonly showRunEvents: RunsController["showRunEvents"]
  readonly traceFilter: RunsController["traceFilter"]
  readonly traceSelect: RunsController["traceSelect"]
  readonly selectCodingChange: RunsController["selectCodingChange"]
  readonly traceView: RunsController["traceView"]
  readonly graphFollow: RunsController["graphFollow"]
  readonly graphExecution: RunsController["graphExecution"]
  /* The node drawer both graph cards open (see controller/graph.ts). */
  readonly selectGraphNode: GraphController["selectGraphNode"]
  readonly graphNodeTab: GraphController["graphNodeTab"]
  readonly selectPlanNode: GraphController["selectPlanNode"]
  readonly planNodeTab: GraphController["planNodeTab"]
  readonly traceLive: RunsController["traceLive"]
  readonly stopAllRuns: RunsController["stopAllRuns"]
  readonly listApprovals: RunsController["listApprovals"]
  readonly openApproval: RunsController["openApproval"]
  /* Card maximize/minimize — the user's presentation transition (§2d′). */
  readonly maximizeCard: (id: string) => string | void
  readonly minimizeCard: () => void
  readonly frameBack: () => void
  readonly frameForward: () => void
  /* Tutorial stage 2: the ranked chooser and the local Skip. */
  readonly selectRepo: TabsController["selectRepo"]
  /* The sidebar's file tree and workspace heading; see controller/sidebar.ts. */
  readonly toggleRepoTree: SidebarController["toggleRepoTree"]
  /* Agents as data; see controller/agents.ts. */
  readonly showModel: ReturnType<typeof createModelsController>["showModel"]
  readonly newModel: ReturnType<typeof createModelsController>["newModel"]
  readonly editModel: ReturnType<typeof createModelsController>["editModel"]
  readonly saveModel: ReturnType<typeof createModelsController>["saveModel"]
  readonly removeModel: ReturnType<typeof createModelsController>["removeModel"]
  readonly testModel: ReturnType<typeof createModelsController>["testModel"]
  readonly assignAgentModel: AgentsController["assignAgentModel"]
  readonly listAgents: AgentsController["listAgents"]
  /* THE FORM LAW (apps/app/AGENTS.md): the flow-form card's render, field commits, submit, and dismiss; see controller/forms.ts. */
  readonly renderFlowForm: FormsController["renderFlowForm"]
  readonly setFormField: FormsController["setFormField"]
  readonly submitForm: FormsController["submitForm"]
  readonly dismissCard: FormsController["dismissCard"]
  /** Lane citc: the cloud-workspace terminal transport (one socket per workspace session). */
  /** T-APP-12 stays dark until the owner-only machine provider supplies this scope. */
  readonly terminalCards?: TerminalCardSource
  readonly cloudTerminal: CloudTerminalClient
  /* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
  readonly toggleDevtools: () => void
  /** Report what drives a turn (admin /debug.backend; DESIGN.md §14). */
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  /* The composer surfaces menu — the /surfaces command's open state. */
  /*
   * The search palette (Search and Command Palette Spec 2026-09-07): the
   * overlay's rows read synchronously from the store (the button door), the
   * `search.*` flow handler (the slash and agent doors), and the session
   * acts the overlay dispatches (state/seams/SearchSeam.ts).
   */
  readonly searchPalette: (text: string) => PaletteAnswer
  readonly search: SearchSeam["search"]
  readonly showRepoOverview: (repo?: string) => Promise<string | { value: string }>
  readonly updateRepo: (repo?: string) => Promise<string | { value: string }>
  readonly markUpdateRead: (cardId: string) => Promise<string | void>
  readonly tagNotification: (id: string, tag: string) => Promise<string | void>
  readonly moveCardHistory: (id: string, delta: -1 | 1) => void
  readonly setInputMode: (mode: InputMode) => Promise<void>
  readonly openChat: () => Promise<string | void>
  readonly toggleDictation: () => Promise<string | void>
  readonly cancelDictation: () => void
  readonly openPalette: (prefix?: string) => void
  readonly closePalette: (lastQuery?: string) => void
  readonly togglePaletteActions: (ref: string) => void
  readonly notePaletteItemOpened: (item: { readonly kind: string; readonly ref: string }) => void
  readonly paletteRecent: () => { readonly value: string }
  readonly debugSnapshot: () => { readonly value: string }
  readonly debugEvents: () => { readonly value: string }
  readonly debugErrors: (query?: string) => string | { readonly value: string }
  readonly debugSeams: () => Promise<string | void | { readonly value: string }>
  /** The wire tap: the controller's fetch ring, newest first. */
  readonly debugNet: () => { readonly value: string }
  /**
   * The same ring, read WITHOUT surfacing it.
   *
   * `debugNet` is the flow: it renders the read for the human who typed it.
   * The dev-tools panel reads the ring while rendering, so it needs the pure
   * read — dispatching from a render is a re-render loop.
   */
  readonly netTap: () => string
  /**
   * The same ring as rows, for the panel that renders them. `netTap`
   * serializes for the debug read a human types; a renderer takes the rows
   * so nothing has to parse that string back into a shape it restates.
   */
  readonly netTapEntries: () => ReadonlyArray<NetEntry>
  /**
   * The tapped fetch, exposed so the chain runtime's model-relay traffic
   * records into the same ring as every controller seam.
   */
  readonly tappedFetch: FetchLike
  /** Adopt an identity answer already resolved by the server renderer. */
  readonly adoptSession: (session: import("./controller/auth-billing").ResolvedSession) => Promise<void>
  /** Load the identity session record from the identity seam (actor: system). */
  readonly loadSession: () => Promise<void>
  /** Redirect to the identity seam's GitHub OAuth start. */
  readonly signIn: (reservedOpen?: (url: string) => Promise<boolean>) => Promise<void> | void
  /** The login screen's email door: what this host can do with an address (auth.email). */
  readonly signInWithEmail: (email: string) => string | void
  readonly signOut: () => Promise<string | void>
  /**
   * Consume a `?auth=failed` return from a failed OAuth redirect: the failure
   * renders as a Smithers message in the chat (honest error + retry action),
   * never a bare page. Answers whether the search string carried one.
   */
  readonly handleAuthReturn: (search: string) => boolean
  /** Consume a GitHub App setup-URL return (GitHubSeam.handleInstallReturn): verified on the server, never trusted from the query. */
  readonly handleInstallReturn: (search: string) => boolean
  /*
   * The requirement axis (registry.ts commandRequirements): park a
   * user-invoked command on an unmet requirement, and resume it when the
   * requirement's predicate flips true. Deferral is durable (the session
   * row) because sign-in is a full OAuth redirect; every seam that can
   * SATISFY a requirement calls resumeDeferredCommand after it settles.
   */
  readonly deferCommand: (name: string, args: string | null, requirement: string) => void
  readonly deferRepositoryCommand: (name: string, payload: Record<string, unknown>, options?: { refresh?: boolean; scope?: "command" }) => Promise<void>
  readonly resumeDeferredCommand: () => void
  /**
   * First run has finished choosing its starting repository — selected one, or
   * decided there is none. Until this runs, a bare repository command waits
   * (`first-run-target`); after it, a park on that id resumes exactly once.
   */
  readonly settleFirstRunTarget: () => void
  /** Record a visible command run for the slash menu's recency ranking. */
  readonly noteCommandRun: (name: string) => void
  /** The /verbose switch: trace every flow and background transition in the transcript. */
  readonly toggleVerbose: () => void
  /** Record one settled flow invocation (every trigger) — the verbose trace's source. */
  readonly traceFlow: (record: Extract<AppTransition, { type: "flow.invoked" }>) => void
  /**
   * A `confirm` flow asked for: post the confirmation message whose action
   * button runs the flow as the user (Commands.ts runAs). `question` replaces
   * the model's sentence when the act's own door did the asking.
   */
  readonly requestFlowConfirmation: (name: string, args: string | null, label: string, question?: string) => void
  /** Cancel only the still-pending revision; retain a typed refusal for stale or answered confirmations. */
  readonly cancelConfirmation: (confirmation: string, revision: string) => Promise<void | { readonly refusal: Refusal }>
  /** Render the sign-in step into the chat (auth.prompt — the agent's door to login). */
  readonly promptSignIn: (required?: boolean, request?: { readonly name?: string; readonly args?: string | null; readonly summary?: string; readonly signInRequirement?: "cloud" }) => void
  /** Render the Smithers Cloud sign-in step into the chat (cloud.prompt — the agent's door to the cloud session). */
  readonly promptCloudSignIn: () => void
  /** Reload the app window — the /reload affordance (dev loop, stuck states). */
  readonly reloadApp: () => void
  /*
   * The multi-parity domain seams (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * PRs/landings, billing checkout, notifications, the agent
   * environment, and repo import. One method per command; each seam owns its
   * backend domain in state/seams/*.
   */
  readonly listIssues: IssuesSeam["listIssues"]
  readonly viewIssue: IssuesSeam["viewIssue"]
  readonly issueWriteTarget: IssuesSeam["issueWriteTarget"]
  readonly createIssue: IssuesSeam["createIssue"]
  readonly setIssueState: IssuesSeam["setIssueState"]
  readonly draftIssueComment: IssuesSeam["draftIssueComment"]
  readonly editIssueComment: IssuesSeam["editIssueComment"]
  readonly deleteIssueComment: IssuesSeam["deleteIssueComment"]
  readonly commentOnIssue: IssuesSeam["commentOnIssue"]
  readonly listLandings: LandingsSeam["listLandings"]
  readonly viewLanding: LandingsSeam["viewLanding"]
  readonly setLandingTab: LandingsSeam["setTab"]
  readonly reviewLanding: LandingsSeam["reviewLanding"]
  readonly showBillingPlans: BillingSeam["showBillingPlans"]
  readonly startCheckout: BillingSeam["startCheckout"]
  readonly openBillingPortal: BillingSeam["openBillingPortal"]
  readonly viewEnvironment: ViewAction<[repo?: string]>
  readonly setEnvironmentVar: (assignment: string, repo?: string) => ReturnType<ViewAction<[repo?: string]>>
  readonly removeSubscriptionToken: ViewAction<[repo?: string]>
  readonly listSecrets: SecretsSeam["listSecrets"]
  readonly scopeSecret: SecretsSeam["scopeSecret"]
  readonly bindSecret: SecretsSeam["bindSecret"]
  readonly setSecret: SecretsSeam["setSecret"]
  readonly deleteSecret: SecretsSeam["deleteSecret"]
  /* The mythical stack (#1745), the repository history (D-20): the History card, its admin writes, and the live snapshots its views read. */
  readonly showStack: StackSeam["showStack"]
  readonly bootstrapStack: StackSeam["bootstrapStack"]
  readonly setStackParallel: StackSeam["setStackParallel"]
  readonly retryStackItem: StackSeam["retryStackItem"]
  readonly newTodo: TodoSeam["newTodo"]
  readonly preapproveTodo: TodoSeam["preapproveTodo"]
  readonly newFlowSourceTodo: TodoSeam["newFlowSourceTodo"]
  readonly mergeTodo: TodoSeam["mergeTodo"]
  /** Review & merge for this host's TODO Tn: the person's private Confirm card bound to the PR head (T-APP-04). */
  readonly reviewTodoMerge: TodoSeam["reviewMerge"]
  /** MOCK SEAM: run a Tn flow on the seed or on this host's /api/todos, never waiting for the answer (DesignWorld/todo.ts). */
  readonly todoRoute: TodoRoute
  readonly showTodo: TodoSeam["showTodo"]
  readonly readFlowSource: (n: number, path: string) => ReturnType<FilesSeam["readFile"]>
  readonly dismissTodoDraft: TodoSeam["dismissTodoDraft"]
  readonly answerTodo: TodoSeam["answerTodo"]
  readonly steerTodo: TodoSeam["steerTodo"]
  readonly amendTodo: TodoSeam["amendTodo"]
  readonly draftImagePackage: TodoSeam["draftImagePackage"]
  readonly bringIn: TodoSeam["bringIn"]
  readonly discardForeign: TodoSeam["discardForeign"]
  readonly controlTodo: TodoSeam["controlTodo"]
  readonly openProposal: ProposalSeam["openProposal"]
  readonly resolveProposal: ProposalSeam["resolveProposal"]
  /** Move up or Move down on Tn: the seed's, or this host's POST /api/todos/{n} {op: move}. */
  readonly moveTodo: TodoSeam["moveTodo"]
  readonly refreshWiki: StackSeam["refreshWiki"]
  readonly installSnapshots: InstallSeam["snapshots"]
  /** The roster the Members card reads: GET /api/members on an install; elsewhere the seeded roster (MOCK SEAM, DesignWorld/settings.ts). */
  readonly membersRoster: MembersSnapshots
  /** The signed-in person's role on that roster; "member" until the roster names them. */
  readonly membersRole: () => "owner" | "maintainer" | "member"
  /** Reads the roster for the Members card (an install rereads GET /api/members). */
  readonly showMembers: () => void
  /** The flow catalog the Flow card reads on an install (GET /api/flows); undefined elsewhere, where the seeded flows answer. */
  readonly flowCatalog: FlowsSnapshots | undefined
  /** The flows /flow, /flows and /flow.edit read: GET /api/flows on an install (undefined when it is not served); elsewhere the seeded flows (MOCK SEAM, DesignWorld/run.ts). */
  readonly flowCards: (name?: string) => Promise<ReadonlyArray<import("@smthrs/rpc/FlowCard").FlowCard> | undefined>
  /** branch.fork on an install: POST /api/branches {from, name?} (spec §8.5); its value is the new scratch branch. A string is the refusal. Absent off an install, where the flow acts on the seeded world. */
  readonly selectConversationBranch: (name: string) => Promise<void>
  readonly setBranchNavigationView: (patch: { selected_branch?: string; selected_archive?: string; previous_branch?: string; open?: boolean }) => Promise<void>
  readonly setCardTab: (id: string, tab: string) => void
  readonly branchControls?: import("./seams/BranchControlsSeam").BranchControls
  readonly branchSshLine?: (name: string, signal?: AbortSignal) => Promise<string | { readonly value: string }>
  readonly openBranch?: (name: string) => Promise<string | { readonly value: string }>
  readonly addBranchToStack?: (input: { readonly branch: string; readonly text?: string; readonly title?: string; readonly acceptance?: ReadonlyArray<string>; readonly after?: number; readonly before?: number }) => Promise<string | { readonly value: string }>
  readonly forkBranch?: (input: { readonly from: string; readonly name?: string }) => Promise<string | { readonly value: string }>
  /** members.add, members.role and members.remove: the install's routes, or the seeded roster off an install. A string is the refusal. */
  readonly changeMembers: (tag: "members.add" | "members.role" | "members.remove", input: { readonly login: string; readonly role?: "maintainer" | "member" }) => Promise<string | { readonly value: string }>
  /** GET /api/todos, read while Home is open on a host with no `home` topic (T-APP-01). */
  readonly sharedConversation?: SharedConversationSeam
  readonly homeView?: HomeViewSeam
  readonly todoList: TodoSeam["list"]
  /** The install's GitHub sync health, which Home's `main` row shows (GET /api/github/sync); none on other hosts. */
  readonly githubSyncSnapshots: GitHubSyncSeam["snapshots"]
  /** A Codex or Claude Code session run on the host's machine, read-only for the conversation (M-38): GET /api/external/sessions, decoded here, read while shown. */
  readonly externalSession: ExternalSessionSeam["session"]
  /** The fast model's titles for the timeline's folded lines (#3732): POST /api/model/stream, asked while the rail shows them. */
  readonly timelineTitles: TimelineTitleSeam["ask"]
  /** Start an agent CLI on the host and show its session in this conversation (#3730). */
  readonly startAgent: StartAgent
  /** MOCK SEAM (state/seams/DesignWorld): the seeded design world and its stub mutations, deleted in one change. */
  readonly design: DesignWorld
  /** The `/api/live` channel the Home card subscribes through; absent when the composition supplied none. */
  readonly live?: LiveTopics
  /** Opens a subject-only card (card-kinds.md L5) once per conversation; its card file reads the data. */
  /** With a `subject` (Branch, Terminal: card-kinds.md L5) the card is `${kind}:${subject}` with payload `{ id: subject }`. */
  readonly presentCard: (kind: "setup" | "settings" | "members" | "commands" | "branch" | "terminal", title: string, subject?: string) => Promise<string>
  /** Opens (or reveals) the Run card for run `id`; `maximize` is Inspect. */
  readonly runMonitors: RunMonitorSnapshots | undefined
  readonly openRunMonitor: (id: string, maximize: boolean) => Promise<string | { readonly value: string } | void>
  readonly listRunMonitors: () => Promise<string | { readonly value: string } | void>
  readonly setRunView: (cardId: string, patch: { selected?: string; at?: number; tab?: "run" | "journal" | "custom" }) => Promise<string | void>
  readonly contextRun: (id: string) => MonitorCard | undefined
  readonly presentRun: (id: string, title: string, maximize: boolean) => Promise<string>
  /** Opens (or reveals) the Flow card for flow `name`, at `version` when given. */
  readonly presentFlow: (name: string, title: string, version?: string) => Promise<string>
  /** MOCK SEAM (DesignWorld/subjects.ts): opens or reveals a retained-kind subject card (issue, file, diff, world, change) by id. */
  readonly presentSubject: (card: Pick<Card, "id" | "kind" | "title" | "payload">) => Promise<string>
  /** Opens (or reveals) the Branch or Terminal card for subject `id` (card-kinds.md L5). */
  readonly presentBranchCard: (kind: "branch" | "terminal", id: string, title: string) => Promise<string>
  readonly showSetup: InstallSeam["showSetup"]
  readonly showSettings: InstallSeam["showSettings"]
  readonly setupStep: InstallSeam["setupStep"]
  readonly setInstallAddress: InstallSeam["setInstallAddress"]
  readonly setInstallCapacity: InstallSeam["setInstallCapacity"]
  readonly setInstallObsidian: InstallSeam["setInstallObsidian"]
  readonly setInstallPreapproveDefault: InstallSeam["setInstallPreapproveDefault"]
  readonly setInstallDailyAdmissions: InstallSeam["setInstallDailyAdmissions"]
  readonly setInstallParallel: InstallSeam["setInstallParallel"]
  readonly saveInstallModelKey: InstallSeam["saveInstallModelKey"]
  readonly stackSnapshots: StackSeam["snapshots"]
  readonly importRepository: RepoImportSeam["importRepository"]
  readonly retryImport: RepoImportSeam["retryImport"]
  readonly listBookmarks: ReturnType<typeof createBranchNavigationSeam>["listBookmarks"]
  readonly fileDocuments: FileDocuments | undefined
  readonly recoverFile: (tag: "file.compare" | "file.restore-deleted" | "file.follow-rename" | "file.reapply", path: string, branch?: string) => Promise<string | { value: string } | undefined>
  readonly branchFiles: FilesSeam["branchFiles"]
  readonly listFiles: FilesSeam["listFiles"]
  readonly branchDiff: ReturnType<typeof createDiffFilesSeam>["branchDiff"]
  readonly openDiffFile: ReturnType<typeof createDiffFilesSeam>["openDiffFile"]
  readonly readFile: FilesSeam["readFile"]
  /* Code intelligence (docs/code-intel/PLAN.md §4): the three code.* reads against the local language server (seams/CodeIntelSeam.ts). */
  readonly codeIntelligenceAvailable?: () => boolean
  readonly codeHover: CodeIntelSeam["hover"]
  readonly codeDefinition: CodeIntelSeam["definition"]
  readonly codeDiagnostics: CodeIntelSeam["diagnostics"]

  readonly showMoreSyncOps: (cardId: string) => Promise<string | void>
  readonly githubApp: GitHubSeam["app"]
  readonly githubChooseInstallation: GitHubSeam["chooseInstallation"]
  readonly githubOpenInstall: GitHubSeam["openInstall"]
  readonly githubReconcile: GitHubSeam["reconcile"]
  /** `github.retry` on the install (POST /api/github/sync); undefined where this host serves no sync. */
  readonly retryGitHubSync: GitHubSyncSeam["retry"]
  readonly retryMirrorRef: GitHubSeam["retryMirrorRef"]
  readonly githubMirrorSync: GitHubSeam["mirrorSync"]
  /*
   * Lane piper: the Smithers Cloud session (the CLI browser login; the token
   * never reaches the renderer) and the repository inventory behind the
   * `/api/cloud/*` proxy (state/seams/CloudSeam.ts, RepositoriesSeam.ts).
   */
  readonly loadCloudSession: CloudSeam["loadSession"]
  readonly signInCloud: CloudSeam["signIn"]
  readonly signOutCloud: CloudSeam["signOut"]
  readonly loadRepositories: RepositoriesSeam["loadRepositories"]
  /*
   * Lane citc (ADR 0002): the persistent cloud computers behind the
   * `/api/cloud/*` proxy (state/seams/WorkspaceSeam.ts).
   */
  readonly listWorkspaces: WorkspaceSeam["listWorkspaces"]
  readonly openWorkspace: WorkspaceSeam["openWorkspace"]
  readonly viewWorkspace: WorkspaceSeam["viewWorkspace"]
  readonly openWorkspaceTerminal: WorkspaceSeam["openTerminal"]
  readonly suspendWorkspace: WorkspaceSeam["suspendWorkspace"]
  readonly resumeWorkspace: WorkspaceSeam["resumeWorkspace"]
  readonly listWorkspaceSessions: WorkspaceSeam["listSessions"]
  readonly destroyWorkspaceSession: WorkspaceSeam["destroySession"]
  readonly deleteWorkspace: WorkspaceSeam["deleteWorkspace"]
  readonly setWorkspaceFacet: WorkspaceSeam["setFacet"]
  /* Lane L3: the workspace facets plue#449 and the sandbox egress audit answer. */
  readonly listWorkspaceFiles: WorkspaceSeam["listFiles"]
  readonly readWorkspaceFile: WorkspaceSeam["readFile"]
  readonly listWorkspaceServices: WorkspaceSeam["listServices"]
  readonly listWorkspaceEgress: WorkspaceSeam["listEgress"]
  /** The repository the active selection names, for a flow that must BIND its target before it asks. */
  readonly activeRepository: () => string | null
  readonly listEnvironmentImages: WorkspaceSeam["listEnvironmentImages"]
  readonly listSessionEgress: EgressSeam["listSessionEgress"]
  /** `egress.allow`: add a host to the repository's egress allowlist (#2653). */
  readonly allowEgressHost: EgressSeam["allowEgressHost"]
  /*
   * Lane change (ADR 0003): the change is the unit — the change and diff
   * cards behind the `/api/cloud/*` proxy (state/seams/ChangeSeam.ts).
   */
  readonly viewChange: ChangeSeam["viewChange"]
  readonly diffChange: ChangeSeam["diffChange"]
  readonly resolveChangeConflict: ChangeSeam["resolveConflict"]
  readonly setChangeFacet: ChangeSeam["setFacet"]
  /* Lane L1: the live plue routes — pins, checks per revision, threads, findings, the snapshot fork. */
  readonly setChangePins: ChangeSeam["setPins"]
  readonly checksOfChangeAt: ChangeSeam["checksAt"]
  readonly diffSinceMyReview: ChangeSeam["sinceMyReview"]
  readonly reviewThreadDone: ChangeSeam["threadDone"]
  readonly reviewThreadAck: ChangeSeam["threadAck"]
  readonly reviewThreadReopen: ChangeSeam["threadReopen"]
  readonly fixFinding: ChangeSeam["pleaseFix"]
  readonly findingNotUseful: ChangeSeam["notUseful"]
  readonly requestChangeReview: ChangeSeam["requestReview"]
  readonly unrequestChangeReview: ChangeSeam["unrequestReview"]
  /** Dismiss one toast on the shared corner stack (the toast.dismiss command). */
  readonly dismissToast: (id: string) => void
  /** Refresh the billing record from the billing seam (actor: system). */
  readonly refreshBalance: () => Promise<void>
  /** Refresh the balance and surface it as a card in the transcript. */
  readonly showBalance: () => Promise<string | { readonly value: string }>
  /**
   * Close the controller's scope: stop the workflow pumps and release
   * everything the controllers opened (the agent subscription, the
   * cross-tab identity listeners, the identity BroadcastChannel). Nothing a
   * controller opened outlives it.
   */
  readonly dispose: () => Promise<void>
}
/**
 * The product-Worker backend seams the controller talks to. Injectable so tests
 * bind honest doubles instead of a network; production uses same-origin fetch.
 */
export interface AppServices {
  /** The embedding host can omit an unavailable Secrets contract without replacing its runtime. */
  readonly secretsProviders?: (defaults: SecretsProviders) => SecretsProviders
  /** Host-owned branch authority and provider receipts; absent keeps S2 files dark. */
  readonly documentOptions?: { channel: LiveChannel; prerequisites: DocumentPrerequisites }
  readonly branchControlOptions?: import("./seams/BranchControlsSeam").BranchControlOptions
  readonly branchOptions?: BranchFileOptions
  /** The page's `/api/live` channel; production supplies the tab's one channel, and a controller without it subscribes to no topic. */
  readonly live?: LiveTopics
  readonly installTopic?: InstallTopic
  readonly presentInstallCard?: (kind: "setup" | "settings") => void
  readonly todoTopics?: TodoTopics
  readonly clientErrors?: ClientErrorReporter
  /**
   * The decision model's command selection (state/CommandSelection.ts). The
   * composition root binds the HTTP door when the backend advertises
   * `commands.select`; absent, turns run on the pinned commands alone and the
   * list action's query discloses none.
   */
  readonly commandSelector?: CommandSelector
  /** Fence late observations as soon as the embedding page starts leaving. */
  readonly pageLifetime?: AbortSignal
  /** Trusted local handoff, injectable by the embedding host; never projected as a tool. */
  readonly storageRecoveryHost?: StorageRecoveryHost
  readonly fetchImpl?: FetchLike
  readonly applicationTarget?: ApplicationTarget
  readonly applicationIdentity?: ApplicationIdentityClient
  readonly authorizeSocket?: (url: string, signal?: AbortSignal) => Promise<string>
  /**
   * The per-launch local capability every cloud tunnel socket carries as its
   * subprotocol; default the page's injected token (runtime/LocalSession.ts).
   * A test against a real local origin binds the server's protocol.
   */
  readonly socketProtocols?: () => ReadonlyArray<string>
  /**
   * Lane citc: the `/api/cloud-ws/` tunnel URL for one workspace session;
   * default the page's own origin. Tests bind `() => undefined`.
   */
  readonly cloudSocketUrl?: (repo: string, sessionId: string) => string | undefined
  /** The shared session host supplies admitted member-owned daemon exec sessions. */
  readonly daemonLsp?: Pick<import("./CloudLspClient").CloudLspClientOptions, "openSession" | "socketUrl"> & { readonly ready: () => boolean }
  readonly bootstrap?: AppBootstrap
  readonly repositoryApp?: string
  readonly frameHistory?: FrameHistoryPort
  readonly baseUrl?: string
  /** The toast debounce (the 300ms law); injectable so tests pin both sides of it. */
  readonly toastDebounceMs?: number
  /**
   * Open a URL in the browser. Present =
   * the sign-in handoff runs OAuth outside the webview, where passkeys
   * work; absent = pure web keeps the same-page navigation.
   */
  readonly openExternal?: (url: string) => Promise<boolean>
  /** The handoff claim poll cadence; tests shorten it. */
  readonly handoffPollMs?: number
  /** How long a settled-ok toast states its result before dismissing itself. */
  readonly toastAutoDismissMs?: number
  /**
   * How long a command parked on `first-run-target` waits for the identity
   * seam before the choice settles on its own; tests shorten it.
   */
  readonly firstRunSettleMs?: number
  /**
   * Wave 11 — the run card's event-pump cadence (the floor under the relay's
   * SSE pokes) and the provision poll gap. Injectable so tests drive a whole
   * run journey without waiting out real seconds.
   */
  readonly workflowPollMs?: number
  /** Maximum time a requested run may wait for its workspace gateway. */
  readonly workflowPreparationTimeoutMs?: number
  /**
   * Wave 12 §3 — how long a run may make no progress before the card states
   * that it has gone quiet and the pump stops (10 minutes in production).
   */
  readonly workflowQuietMs?: number
  /**
   * How long a request/response seam may take before it is an honest failure
   * (§22.6). Streaming paths carry no deadline; tests shorten this one.
   */
  readonly seamTimeoutMs?: number
  /**
   * Feature flags. `suggestionPills`: the next-action pills under the
   * composer and the recommender's POST /api/recommend requests behind them.
   * Default ON for the cloud host (the Worker serves the route) and OFF
   * elsewhere; an explicit value wins, so a test can turn the row off on the
   * cloud host or on elsewhere. Off, the pill row is absent from the DOM and
   * no request leaves; the `recommend` flow still writes its rule row so
   * turning the flag on later works without a schema change.
   */
  readonly features?: AppFeatures
  /**
   * The in-app docs pages (M-35); default the ones this build inlined
   * (src/docs/bundled.ts). Bun has no import.meta.glob, so tests bind the same
   * files read from disk (src/docs/DiskPages.ts).
   */
  readonly docs?: () => Docs
  /** T-APP-17 composition gate. No production provider exists yet. */
  readonly contextProvider?: ContextProvider
  /** Stored answer projection, supplied only with the authenticated conversation and action-capable View. */
  readonly contextLine?: (answerId: string) => Omit<ContextContainerProps, "dispatch" | "available"> | undefined
  /** Optional host override; bundled docs are available without a backend provider. */
  readonly docsCatalogAvailable?: () => boolean
  readonly debugApiGates?: () => DebugApiGates
  readonly openApi?: () => Promise<OpenApiDocument>
  readonly debugApiOrigin?: string
}

export interface AppFeatures {
  readonly suggestionPills?: boolean
}

/**
 * Environment-agnostic: the native bridge is injected by the composition root so this
 * module never pulls the Electrobun runtime into pure-web or test contexts.
 */
export const createAppController = (
  store: AppStore,
  agent: AgentPort,
  services: AppServices = {}
): AppController => {
  const ctx = createControllerContext(store, agent, services)
  const actors = createActorBindings(ctx.onDispose)
  const privacyActions = createPrivacyActions(ctx)
  if (store.dispose !== undefined) ctx.onDispose(store.dispose)
  ctx.onDispose(store.onStorageFailure(() => { void ctx.dispose().catch(() => {}) }))
  ctx.onDispose(store.onMaintenanceFailure((error, streak) => ctx.failures.report("journal.compaction", error, String(streak))))
  if (store.onWriterLost !== undefined) ctx.onDispose(store.onWriterLost(() => {
    // Mark the controller closed synchronously, before React unmount refs or
    // background pumps can dispatch into the revoked store.
    void ctx.dispose().catch(() => {})
  }))
  const { baseUrl, http } = ctx
  const wikiAttachments = createWikiAttachmentStore({ http, baseUrl })
  ctx.onDispose(ctx.onAccountChange(wikiAttachments.clear))
  ctx.onDispose(wikiAttachments.dispose)
  const features: Required<AppFeatures> = {
    suggestionPills: services.features?.suggestionPills ?? services.bootstrap?.host === "cloud"
  }
  /*
   * A Vite dev build unlocks the admin plugin (devtools, debug reads) without
   * a session: dev has no identity seam to grant admin, and the machinery
   * panel is exactly what dev needs. Vite serves DEV as the boolean true;
   * production builds and bun tests see undefined/"" (tsc types the field
   * string, hence the cast).
   */
  const adminSession = (): boolean => {
    const identity = store.collections.identitySessions.get("identity")
    return (identity?.state === "signed-in" && identity.admin) || (import.meta.env?.DEV as boolean | string | undefined) === true
  }
  const reconcileUnavailableCards = (): void => {
    const restored = store.session()
    const restoredCardAvailable = (kind: string): boolean =>
      cardAvailable(kind)
    const maximized = restored.maximizedCardId === null ? undefined : store.collections.cards.get(restored.maximizedCardId)
    if (maximized && !restoredCardAvailable(maximized.kind)) store.dispatch({ type: "frame.navigated", actor: "system",
      workspaceId: restored.activeWorkspaceId ?? DEFAULT_WORKSPACE_ID, branchId: restored.activeBranchId ?? DEFAULT_BRANCH_ID,
      frameId: rootFrameId(restored.activeBranchId ?? DEFAULT_BRANCH_ID) })
    const activeTab = restored.activeTabId === undefined ? undefined : store.collections.tabs.get(restored.activeTabId)
    const tabCard = activeTab?.kind === "card" && activeTab.cardId ? store.collections.cards.get(activeTab.cardId) : undefined
    if (tabCard && !restoredCardAvailable(tabCard.kind)) store.dispatch({ type: "tab.selected", actor: "system", id: MAIN_TAB_ID })
  }
  reconcileUnavailableCards()
  const { withToast, resolveToast, dismissToast, surfaceCommandFailure: surfaceFailure } = createFailureController(ctx)
  const surfaceCommandFailure: typeof surfaceFailure = (name, outcome, saidBefore) => {
    if (ctx.disposed) return
    // Infrastructure refusals already have a notice outside the blocked store.
    if (outcome.status === "failed" && (outcome.error === PRIVACY_WRITE_PENDING || outcome.error === PRIVACY_WRITE_FAILED)) return
    if ((outcome.status === "failed" || outcome.status === "form") && privacyActions.refuse("system") !== undefined) return
    /*
     * A superseded act says nothing: storage recovery owns a store that has
     * stopped taking writes, and a notice for work that was thrown away is
     * the silent-lie shape. A write this browser REFUSED is the opposite
     * case — the person acted, the control snapped back to the value it
     * already had, and nothing anywhere told them why. That one is surfaced,
     * and if the store is broken enough to lose the sentence too, it was
     * already lost under the old rule.
     */
    if (outcome.status === "failed" && outcome.persistenceFailed && !outcome.writeRefused) return
    surfaceFailure(name, outcome, saidBefore)
  }
  ctx.withToast = withToast
  ctx.resolveToast = resolveToast

  /*
   * The multi-parity domain seams: each owns one backend domain behind the
   * platform proxy, constructed on the shared seam context (the tapped
   * fetch, the store, the transcript-ordinal door).
   */
  /*
   * The domain seams ride boundedFetch (Ruling B): every request/response
   * seam call carries the seam deadline, and the tap plus 401 recovery still
   * apply because boundedFetch wraps the tapped http.
   */
  let issueAuthorizationRevision = 0
  const issueAuthorizationSession = randomUuid()
  if (services.live) ctx.onDispose(services.live.subscribe("members", () => { issueAuthorizationRevision++ }))
  const seamCtx: SeamContext = {
    issueAuthorizationScope: () => installHost ? `${issueAuthorizationSession}:${issueAuthorizationRevision}` : "",
    resolveToast,
    withToast,
    isDisposed: () => ctx.disposed,
    http: (input, init) => {
      const write = init?.method && !["GET", "HEAD"].includes(init.method.toUpperCase()) && !input.endsWith("/api/repo/files")
      if (write) invalidatePreparedViews(store)
      return ctx.boundedFetch(input, init).finally(() => { if (write) invalidatePreparedViews(store) })
    },
    /* The streaming door: the tapped fetch without the bounded body read, for the seams' SSE reads. */
    stream: (input, init) => ctx.http(input, init),
    baseUrl,
    store,
    dispatch: store.dispatch,
    actor: () => ctx.commandActor,
    nextOrdinal: store.nextOrdinal,
    promptSignIn: (summary) => promptSignIn(true, { summary }),
    promptCloudSignIn: () => promptCloudSignIn(true),
    report: (subject, error) => ctx.failures.report("seam.failure", error, subject),
    checkout: services.bootstrap?.capabilities.includes("billing.checkout") ?? false
  }
  const installSeam = actors.pair(seamCtx, context => createInstallSeam(context, withToast, { topic: services.installTopic ?? (services.live ? {
    subscribe: (topic, receive, refuse) => {
      const notify = () => {
        const snapshot = services.live!.getSnapshot(topic)
        if (snapshot?.error) refuse({ code: snapshot.error, class: snapshot.error === "permission" || snapshot.error === "forbidden" || snapshot.error === "unauthenticated" ? "permission" : "infra", message: "Install updates unavailable" })
        else if (snapshot?.data !== undefined) receive(snapshot.data)
      }
      const stop = services.live!.subscribe(topic, notify)
      notify()
      return stop
    }
  } : undefined), present: async kind => {
      if (kind === "settings") await presentCard("settings", "Settings")
      services.presentInstallCard?.(kind)
    },
    // MOCK SEAM: the design seed below stands in only where no install route exists (a 404 or a non-install page), so that
    // answer is quiet; an install that is unreachable or errors keeps its visible, retryable failure.
    quietWithoutInstall: true }))
  ctx.onDispose(installSeam.dispose)
  const installHost = services.bootstrap?.capabilities.includes("install") === true
  const setupEntry = typeof window !== "undefined" && window.location.pathname === "/setup"
  if (installHost) void installSeam.showSetup()
  const sharedConversation = installHost ? createSharedConversationSeam(ctx, services.live) : undefined
  const runMonitorSeam = createRunMonitorSeam({ owner: () => `${ctx.accountOwner()}:${ctx.accountEpoch}`, view: id => {
    const card = store.collections.cards.get(`run:${id}`)
    if (card?.kind !== "run") return undefined
    const member = design.enabled ? design.viewer() : store.collections.identitySessions.get("identity")?.login
    return member ? card.payload.memberViews?.[member] ?? (card.payload.memberViews === undefined ? card.payload.view : undefined) : card.payload.view
  }, http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init), live: services.live })
  ctx.onDispose(runMonitorSeam.dispose)
  const runMonitors = installHost || services.live ? runMonitorSeam.snapshots : undefined
  services.live?.registerProjection?.("home", projectHome)
  const design = createDesignWorld({ enabled: !installHost })
  ctx.onDispose(design.dispose)
  const gitHubSyncSeam = createGitHubSyncSeam({ http: installHost ? (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init) : undefined })
  const gitHubSyncRetry = createGitHubSyncRetry(ctx, gitHubSyncSeam)
  ctx.onDispose(gitHubSyncSeam.dispose)
  const homeView = installHost ? createHomeViewSeam({
    http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init),
    owner: () => {
      const identity = store.collections.identitySessions.get("identity")
      return identity?.state === "signed-in" ? `${identity.login}:${identity.ownerRevision ?? identity.revision}` : undefined
    },
    subscribeOwner: notify => {
      const subscription = store.collections.identitySessions.subscribeChanges(notify)
      return () => subscription.unsubscribe()
    },
    report: error => seamCtx.report?.("Home view", error)
  }) : undefined
  if (homeView) ctx.onDispose(homeView.dispose)
  const externalSessionSeam = createExternalSessionSeam({ http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init), live: services.live })
  ctx.onDispose(externalSessionSeam.dispose)
  /* The fast model titles the timeline's folded lines (#3732), only on a host that serves POST /api/model/stream. */
  const timelineTitleSeam = createTimelineTitleSeam({ ...(services.bootstrap !== undefined && hasCapability(services.bootstrap, "model.turn")
    ? { write: modelStreamTitles(ctx.boundedFetch, baseUrl.replace(/\/$/, "")) } : {}) })
  ctx.onDispose(timelineTitleSeam.dispose)
  const { startAgent } = createAgentLaunch(ctx, (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init))
  /* Members (T-ACC-02): an install reads and changes its roster through /api/members; the seeded roster stands in only off an install. */
  const membersSeam = createMembersSeam({ ready: installHost, http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init),
    live: services.live ?? { subscribe: () => () => {}, getSnapshot: () => undefined } })
  ctx.onDispose(membersSeam.dispose)
  if (installHost) {
    membersSeam.start()
    // Catalog authority must load without requiring a visit to Members or
    // Commands, and refresh when sign-in changes the authenticated viewer.
    const membershipIdentity = store.collections.identitySessions.subscribeChanges(() => { void membersSeam.read() })
    ctx.onDispose(() => membershipIdentity.unsubscribe())
  }
  const membersRoster = installHost ? membersSeam.snapshots : designMembersRoster(design)
  const membersRole = (): "owner" | "maintainer" | "member" => {
    if (!installHost) return designViewerRole(design)
    const login = store.collections.identitySessions.get("identity")?.login?.toLowerCase()
    return membersSeam.snapshots.get().model?.members.find(member => member.login.toLowerCase() === login)?.role ?? "member"
  }
  const showMembers = () => { if (installHost) { membersSeam.start(); void membersSeam.read() } }
  /* Flows (T-APP-05): an install reads its catalog from GET /api/flows; the seeded flows stand in only off an install. */
  const flowsSeam = createFlowsSeam({ http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init), live: services.live })
  ctx.onDispose(flowsSeam.dispose)
  const setBranchNavigationView: AppController["setBranchNavigationView"] = async patch => {
    const current = store.session().branchNavigation
    if (!current || current.owner !== (ctx.accountOwner() ?? null)) return
    await store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: { ...current, ...patch } }).isPersisted.promise
  }
  const setCardTab: AppController["setCardTab"] = (id, tab) => {
    const current = store.collections.cards.get(id)
    if (current?.kind === "branch" && ["activity", "files", "terminals"].includes(tab)) {
      store.dispatch({ type: "card.upsert", actor: "user", card: { ...current, payload: { ...current.payload, tab: tab as "activity" | "files" | "terminals" } } })
    } else if (current?.kind === "flow") {
      const member = design.enabled ? design.viewer() : store.collections.identitySessions.get("identity")?.login
      if (!member || current.payload.memberVersions?.[member] === tab) return
      store.dispatch({ type: "card.upsert", actor: "user", card: { ...current, payload: { ...current.payload, memberVersions: { ...current.payload.memberVersions, [member]: tab } } } })
    }
  }
  const selectConversationBranch = async (name: string) => {
    const owner = accountOwnerOf(store.collections.identitySessions.get("identity")) ?? null
    const previous = store.session().branchNavigation
    await store.dispatch({ type: "branch.navigation.changed", actor: "user", navigation: {
      owner, open: true, selected_branch: name, nodes: previous && previous.owner === owner ? previous.nodes : []
    } }).isPersisted.promise
  }
  const readBranchIdentity = async (target: string): Promise<{ name: string; id: string } | string> => {
    try {
      let name = target
      if (/^T[1-9][0-9]*$/.test(target)) {
        const todo = await seamCtx.http(`${baseUrl.replace(/\/$/, "")}/api/todos/${target.slice(1)}`, { credentials: "same-origin" })
        const body = await todo.json() as { branch?: { name?: unknown }; message?: unknown }
        if (!todo.ok || typeof body.branch?.name !== "string" || !body.branch.name) return typeof body.message === "string" ? body.message : "Branch unavailable"
        name = body.branch.name
      }
      const response = await seamCtx.http(`${baseUrl.replace(/\/$/, "")}/api/branches/${encodeURIComponent(name)}`, { credentials: "same-origin" })
      const body = await response.json() as { name?: unknown; machine?: { id?: unknown }; message?: unknown }
      if (!response.ok || typeof body.name !== "string" || typeof body.machine?.id !== "string") return typeof body.message === "string" ? body.message : "Branch unavailable"
      return { name: body.name, id: body.machine.id }
    } catch { return "Branch unavailable" }
  }
  const openBranch: AppController["openBranch"] = installHost ? async target => {
    if (target === "main") { await selectConversationBranch("main"); return { value: "Opened main" } }
    const branch = await readBranchIdentity(target)
    if (typeof branch === "string") return branch
    await selectConversationBranch(branch.name)
    await presentCard("branch", branch.name, branch.id)
    return { value: `Opened ${branch.name}` }
  } : undefined
  const branchControls = services.branchControlOptions ? createBranchControlsSeam(seamCtx, services.branchControlOptions) : undefined
  const pendingSshReads = new Set<() => void>()
  ctx.onDispose(() => { for (const cancel of pendingSshReads) cancel() })
  const branchSshLine: AppController["branchSshLine"] = installHost ? async (target, signal) => {
    const epoch = ctx.accountEpoch
    const branch = await readBranchIdentity(target)
    if (typeof branch === "string") return branch
    const live = services.live
    if (!live || signal?.aborted || ctx.accountEpoch !== epoch || seamCtx.isDisposed?.()) return "Branch unavailable"
    // A read owns a lease on the existing socket; it neither opens a card nor wakes the machine.
    const topic = `branch:${branch.id}`
    let stop: (() => void) | undefined
    let identity: { unsubscribe: () => void } | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    let cancel = () => {}
    try {
      return await new Promise<string | { readonly value: string }>(resolve => {
        let settled = false
        const finish = (value: string | { readonly value: string }) => {
          if (settled) return
          settled = true
          resolve(value)
        }
        cancel = () => finish("Branch unavailable")
        const read = () => {
          if (signal?.aborted || ctx.accountEpoch !== epoch || seamCtx.isDisposed?.()) return cancel()
          const snapshot = live.getSnapshot(topic)
          if (snapshot?.error) return cancel()
          if (snapshot?.data === undefined) return
          const data = snapshot.data as { id?: unknown; ssh_line?: unknown } | null
          finish(data?.id === branch.id && typeof data.ssh_line === "string" && data.ssh_line.length > 0
            ? { value: data.ssh_line } : "Branch unavailable")
        }
        pendingSshReads.add(cancel)
        signal?.addEventListener("abort", cancel, { once: true })
        identity = store.collections.identitySessions.subscribeChanges(read)
        timer = setTimeout(cancel, 10000)
        stop = live.subscribe(topic, read)
        read()
      })
    } catch { return "Branch unavailable" }
    finally {
      stop?.(); identity?.unsubscribe()
      if (timer !== undefined) clearTimeout(timer)
      signal?.removeEventListener("abort", cancel)
      pendingSshReads.delete(cancel)
    }
  } : undefined
  const branchMutations = createBranchMutations(seamCtx)
  ctx.onDispose(branchMutations.dispose)
  const forkBranch: AppController["forkBranch"] = installHost ? input => branchMutations.request("fork", { ...input }) : undefined
  const addBranchToStack: AppController["addBranchToStack"] = installHost ? input => branchMutations.request("add", { ...input }) : undefined
  const flowCards: AppController["flowCards"] = async (name) => installHost ? flowsSeam.read(name)
    : flowNames(design.world()).flatMap(name => flowCardOf(design.world(), name) ?? [])
  const changeMembers: AppController["changeMembers"] = async (tag, { login, role }) => {
    if (!installHost) {
      if (designViewerRole(design) === "member") return "A maintainer manages members"
      const seeded = designMembers(design)
      return tag === "members.add" ? seeded.add(login, role) : tag === "members.role" ? seeded.role(login, role ?? "member") : seeded.remove(login)
    }
    const refused = await membersSeam.mutate(tag, tag === "members.remove" ? { login } : { login, role: role ?? "member" })
    return refused ? refused.message : { value: tag === "members.add" ? `Added ${login}` : tag === "members.role" ? `${login}: ${role ?? "member"}` : `Removed ${login}` }
  }
  const presentCard = async (kind: "setup" | "settings" | "members" | "commands" | "branch" | "terminal", title: string, subject?: string): Promise<string> => {
    if (kind === "commands" && installHost) { membersSeam.start(); await membersSeam.read() }
    if (kind === "commands" && commands.viewerCatalog() === undefined) return "Commands unavailable"
    const id = subject === undefined ? kind : `${kind}:${subject}`
    const existing = store.collections.cards.get(id)
    const base = { id, title, status: "active" as const, createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? store.nextOrdinal() }
    const card: Card = kind === "branch" || kind === "terminal" ? { ...base, kind, payload: { id: subject ?? "" } } : { ...base, kind, payload: {} }
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card }).isPersisted.promise
    return `Opened ${title}`
  }
  const { setRunView } = actors.pair(ctx, context => ({ setRunView: async (cardId: string, patch: { selected?: string; at?: number; tab?: "run" | "journal" | "custom" }): Promise<string | void> => {
    const card = store.collections.cards.get(cardId)
    if (card?.kind !== "run") return "This run is no longer available."
    const member = design.enabled ? design.viewer() : store.collections.identitySessions.get("identity")?.login
    const previous = member ? card.payload.memberViews?.[member] ?? (card.payload.memberViews === undefined ? card.payload.view : undefined) : card.payload.view
    const view = { ...previous, ...patch }
    await store.dispatch({ type: "card.updated", actor: context.commandActor, id: cardId,
      patch: { kind: "run", payload: { ...card.payload, view: member ? undefined : view,
        ...(member ? { memberViews: { ...card.payload.memberViews, [member]: view } } : {}) } }
    }).isPersisted.promise
    if (installHost && (patch.tab === "journal" || patch.at !== undefined)) {
      const epoch = ctx.accountEpoch
      void withToast(`monitor.trace:${card.payload.id}`, "Loading journal", "", async () => {
        const error = await runMonitorSeam.trace(card.payload.id, patch.at ?? previous?.at)
        return epoch !== ctx.accountEpoch ? TOAST_SUPERSEDED : error ?? true
      }).catch(error => ctx.failures.report("toast.work", error, "monitor.trace"))
    }
  } }))
  const contextRun = (id: string): MonitorCard | undefined => {
    const owner = ctx.accountOwner()
    const turn = [...store.collections.httpTurns.values()].find(row => row.turnId === id && row.owner === owner)
    if (turn) return contextMonitor(turn)
    const shared = sharedConversation?.get().conversation?.entries.filter(entry => "runId" in entry).find(entry => entry.id === id || entry.runId === id)
    return shared?.preflight === undefined ? undefined : contextMonitor({
      turnId: shared.runId, preflight: shared.preflight, preflightPhase: "completed",
      status: shared.state === "completed" ? "complete" : shared.state === "failed" ? "failed"
        : shared.state === "cancelled" ? "cancelled" : shared.state === "uncertain" ? "ambiguous" : "active"
    })
  }
  /* THE EMBED LAW: only a person's press maximizes; the agent's binding (ActorBindings) opens the Run card embedded. */
  const { presentRun } = actors.pair(ctx, context => ({ presentRun: async (runId: string, title: string, maximize: boolean): Promise<string> => {
    const id = `run:${runId}`
    const existing = store.collections.cards.get(id)
    await store.dispatch({ type: "card.upsert", actor: context.commandActor, card: {
      id, kind: "run", title, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? store.nextOrdinal(), payload: { id: runId, ...(existing?.kind === "run" ? { view: existing.payload.view, memberViews: existing.payload.memberViews } : {}) }
    } }).isPersisted.promise
    const inspect = maximize && context.commandActor === "user"
    if (inspect) maximizeCard(id)
    return inspect ? `Inspecting ${title}` : `Opened ${title}`
  } }))
  const monitorLists = new Map<number, Promise<unknown>>()
  const { openRunMonitor, listRunMonitors } = actors.pair(ctx, (context, select) => ({
    openRunMonitor: async (id: string, maximize: boolean): Promise<string | { readonly value: string } | void> => {
      const stored = contextRun(id)
      if (stored) return { value: await select(presentRun)(stored.id, stored.title, maximize) }
      if (installHost) return { value: await select(presentRun)(id, id, maximize) }
      const trace = traceNamed(design.world(), id)
      if (trace) return { value: await select(presentRun)(trace.id, trace.title, maximize) }
      return runMonitors ? { value: await select(presentRun)(id, id, maximize) } : `No run ${id}`
    },
    listRunMonitors: async (): Promise<string | { readonly value: string } | void> => {
      if (!installHost && !services.live) {
        for (const trace of design.world().traces) await select(presentRun)(trace.id, trace.title, false)
        return
      }
      const epoch = ctx.accountEpoch
      const owner = ctx.accountOwner()
      if (monitorLists.has(epoch)) return { value: "Requested" }
      const work = withToast("monitor.list", "Loading runs", "", async () => {
        const runs = await runMonitorSeam.list()
        if (ctx.disposed || epoch !== ctx.accountEpoch || owner !== ctx.accountOwner()) return TOAST_SUPERSEDED
        if (!runs && !installHost) {
          for (const trace of design.world().traces) await select(presentRun)(trace.id, trace.title, false)
          return true
        }
        if (!runs) return "Runs unavailable"
        for (const run of runs) {
          const existing = store.collections.cards.get(`run:${run.id}`)
          if (ctx.disposed || epoch !== ctx.accountEpoch || owner !== ctx.accountOwner()) return TOAST_SUPERSEDED
          await store.dispatch({ type: "card.upsert", actor: context.commandActor, card: {
            id: `run:${run.id}`, kind: "run", title: run.title, status: "active", createdAt: existing?.createdAt ?? Date.now(),
            ordinal: existing?.ordinal ?? store.nextOrdinal(), payload: { id: run.id, view: existing?.kind === "run" ? existing.payload.view : undefined, memberViews: existing?.kind === "run" ? existing.payload.memberViews : undefined }
          } }).isPersisted.promise
        }
        return true
      })
      monitorLists.set(epoch, work)
      void work.finally(() => { if (monitorLists.get(epoch) === work) monitorLists.delete(epoch) })
        .catch(error => ctx.failures.report("toast.work", error, "monitor.list"))
      return { value: "Requested" }
    }
  }))
  const presentBranchCard = async (kind: "branch" | "terminal", subject: string, title: string): Promise<string> => {
    const id = `${kind}:${subject}`
    const existing = store.collections.cards.get(id)
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id, kind, title, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? store.nextOrdinal(), payload: { id: subject }
    } }).isPersisted.promise
    return `Opened ${title}`
  }
  const presentSubject = async (card: Pick<Card, "id" | "kind" | "title" | "payload">): Promise<string> => {
    const existing = store.collections.cards.get(card.id)
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      ...card, ...(card.kind === "flow" && existing?.kind === "flow" ? { payload: { ...card.payload, memberVersions: existing.payload.memberVersions } } : {}), status: "active", createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? store.nextOrdinal()
    } as Card }).isPersisted.promise
    return `Opened ${card.title}`
  }
  const presentFlow = async (name: string, title: string, version?: string): Promise<string> => {
    const id = `flow:${name}`
    const existing = store.collections.cards.get(id)
    await store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: {
      id, kind: "flow", title, status: "active", createdAt: existing?.createdAt ?? Date.now(),
      ordinal: existing?.ordinal ?? store.nextOrdinal(), payload: { name, ...(version === undefined ? {} : { version }), ...(existing?.kind === "flow" ? { memberVersions: existing.payload.memberVersions } : {}) }
    } }).isPersisted.promise
    return `Opened ${title}`
  }
  /* MOCK SEAM: the seed answers TODO and Draft flows until this host serves /api/todos (todoSourceProbe). */
  const todoSource = installHost ? { known: () => "real" as const, ask: () => Promise.resolve("real" as const) } : todoSourceProbe(seamCtx, services.bootstrap !== undefined)
  const flowSourceBranch = async (context: SeamContext, n: number) => {
    const response = await context.http(`${baseUrl.replace(/\/$/, "")}/api/todos/${n}`, { credentials: "include" })
    if (!response.ok) return { error: "Could not open the TODO." } as const
    const model = TodoCardSchema.safeParse(await response.json())
    return !model.success || model.data.n !== n || !model.data.branch
      ? { error: "Branch files are unavailable." } as const : { branch: model.data.branch.id } as const
  }
  const proposalSource = installHost ? todoSource : todoSourceProbe(seamCtx, services.bootstrap !== undefined, "/api/proposals")
  const proposalSeam = actors.pair(seamCtx, context => {
    const real = createProposalSeam(context)
    return { ...real, openProposal: async (id: string) => {
      const seed = design.enabled && proposalSource.known() !== "real" ? design.world().proposals.find(row => row.id === id) : undefined
      if (seed) return { value: await presentSubject({ id: `proposal:${id}`, kind: "proposal", title: seed.title,
        payload: { id, model: designProposalCard(design.world(), seed) } }) }
      return real.openProposal(id)
    }, resolveProposal: async (id: string, action: "accept" | "dismiss") => {
      if (design.enabled && await proposalSource.ask() === "seed") {
        const before = design.world(), seed = before.proposals.find(row => row.id === id)
        const result = action === "accept" ? design.proposalTodo(id, design.viewer()) : design.dismissProposal(id)
        const card = store.collections.cards.get(`proposal:${id}`)
        if (result.ok && seed && card?.kind === "proposal") {
          const after = design.world(), current = after.proposals.find(row => row.id === id)
          const model = action === "dismiss" ? { ...designProposalCard(before, seed), state: "dismissed" as const }
            : designProposalCard(after, current ?? seed)
          await context.dispatch({ type: "card.upsert", actor: context.actor(), card: { ...card, payload: { ...card.payload, model } } }).isPersisted.promise
        }
        return result.ok ? { value: result.ack } : result.refusal
      }
      return real.resolveProposal(id, action)
    } }
  })
  const todoSeam = actors.pair(seamCtx, context => withDesignTodos(createTodoSeam(context, { ...(installHost ? { draftIssue: (source, signal) => draftIssueTodo(context, source, signal), readIssue: async (number, repo) => {
    const issue = await issuesSeam.readTodoIssue(number, repo)
    if (typeof issue === "string") return issue
    if (issue.state === "closed") return `Issue #${number} is closed.`
    if (issue.makeTodoAllowed !== true) return "Only a maintainer can make a TODO from this issue."
    if (!issue.issueDigest) return "Could not read this issue."
    return { number, author: issue.author, digest: issue.issueDigest, title: issue.title, body: issue.issueBody, url: issue.htmlUrl ?? `https://github.com/${repo}/issues/${number}`, comments: issue.comments.map(comment => ({ author: comment.author, body: comment.commentBody })) }
  } } : {}), sourceAvailable: async path => {
    try {
      const response = await context.http(`${baseUrl.replace(/\/$/, "")}/api/branches/main/files/${path.split("/").map(encodeURIComponent).join("/")}`, { credentials: "include" })
      // A built-in has no override file yet; a missing file is a served read, not missing infrastructure.
      return response.ok || response.status === 404
    } catch { return false }
  }, openSource: async (n, path, live) => {
    const source = await flowSourceBranch(context, n)
    if (!live() || source.branch === undefined) return false
    // Wait for derivation on the machine. The host only reads the produced file.
    const file = await context.http(`${baseUrl.replace(/\/$/, "")}/api/branches/${encodeURIComponent(source.branch)}/files/${path.split("/").map(encodeURIComponent).join("/")}`, { credentials: "include" })
    if (!live() || !file.ok) return false
    const opened = await filesSeam.readFile(path, undefined, undefined, source.branch)
    return opened !== undefined && typeof opened !== "string"
  }, topics: services.todoTopics ?? (services.live ? { subscribe: (topic, receive) => {
    services.live!.registerProjection?.(topic, projectTodoCard)
    return services.live!.subscribe(topic, () => {
      const snapshot = services.live!.getSnapshot(topic)
      if (snapshot?.data !== undefined) receive(snapshot.data)
    })
  } } : undefined), debounceMs: ctx.toastDebounceMs, onDispose: ctx.onDispose }), context, design, todoSource))
  if (installHost) ctx.onDispose(todoSeam.list.subscribe(() => {}))
  const confirmations = createConfirmationSeam(seamCtx, { ready: installHost && services.applicationTarget?.auth.kind !== "bearer",
    live: services.live, observe: todoSeam.observeConfirmation, debounceMs: ctx.toastDebounceMs })
  ctx.onDispose(confirmations.dispose)
  const stackSeam = actors.pair(seamCtx, (context) => createStackSeam(context, withToast, {
    debounceMs: ctx.toastDebounceMs,
    onDispose: ctx.onDispose
  }))
  // A homepage that declares the stack keeps its snapshot live.
  const repositoryFlowsSeam = createRepositoryFlowsSeam(seamCtx, (repo, home) => {
    if (home.kind === "blocks" && home.blocks.some((block) => block.type === "stack")) stackSeam.watchHomeStack(repo)
  })
  const repositoryFlows = (): RepositoryFlowCatalog | undefined => {
    const target = resolveTargetRepo(store, undefined)
    if ("error" in target) return undefined
    const row = store.collections.repositoryFlows.get(target.repo)
    return row === undefined ? undefined : { repo: row.id, flows: row.flows, home: row.home, loadedAt: row.loadedAt }
  }
  /* An install reads its repository's GitHub issues at /api/issues (T-STK-09, J2 1 and 2). */
  const issuesSeam = actors.pair(seamCtx, (context, select) => createIssuesSeam(context, request => select(renderFlowForm)(request), undefined, { install: installHost,
    repository: () => { const repository = installSeam.snapshots.get().model?.repository; return repository && `${repository.owner}/${repository.name}` } }))
  /* The services that sync with conversations, issues and the wiki (smithers-ui-DESIGN.md §3.6). */
  const landingsSeam = actors.pair(seamCtx, (context, select) => createLandingsSeam(context, request => select(renderFlowForm)(request)))
  const repositoriesSeam = actors.pair(seamCtx, (context) => createRepositoriesSeam(context))
  const billingSeam = actors.pair(seamCtx, context => createBillingSeam(context, {
    overview: services.bootstrap?.capabilities.includes("billing.overview") ?? false,
    plans: services.bootstrap?.capabilities.includes("billing.plans") ?? false,
    checkout: services.bootstrap?.capabilities.includes("billing.checkout") ?? false,
    portal: services.bootstrap?.capabilities.includes("billing.portal") ?? false
  }, () => ctx.disposed))
  const repositoryUpdate = actors.pair(seamCtx, context => createRepositoryUpdate(context, () => ctx.disposed))
  const defaultSecretsProviders: SecretsProviders = {
    View: SecretsView, decoder: SecretsCardSchema, live: services.live,
    authority: () => ctx.commands.state().viewerRole,
    catalog: () => ctx.commands.all(),
    scopedWrite: (context, url, init) => context.http(url, init), family: secretsCardFamily
  }
  const secretsProviders = installHost ? services.secretsProviders?.(defaultSecretsProviders) ?? defaultSecretsProviders : undefined
  const secretsSeam = actors.pair(seamCtx, (context) => createSecretsSeam(context, withToast, { install: installHost, providers: secretsProviders, onDispose: ctx.onDispose,
    fallback: !installHost && services.bootstrap !== undefined ? {
      rows: () => designSecrets(design).rows().map(secret => ({ name: secret.name, mainOnly: secret.scope === "main only", hosts: [], matchHeaders: [], updatedAt: null, reconnect: false })),
      set: (name, scope) => designSecrets(design).set(name, scope === "main_only" ? "main only" : "all branches"), remove: name => designSecrets(design).remove(name)
    } : undefined }))
  /* A registration is a launched flow run: it rides the app's own run watch and the shared toast stack. */
  const triggersSeam = actors.pair(seamCtx, (context, select) => createTriggersSeam(context, {
    requestRun: (repo, slug, operation) => select(workflowController).requestTriggerRun(repo, slug, operation),
    requestRegistration: (repo, request) => select(workflowController).requestTriggerRegistration(repo, request),
    requireJobBox: (repo, act, title) => select(workflowController).requireJobBox(repo, act, title),
    withToast
  }))
  const repoImportSeam = actors.pair(seamCtx, (context) => createRepoImportSeam(context))
  const bookmarksSeam = actors.pair(seamCtx, (context) => createBranchNavigationSeam(context, design, { live: services.live, onDispose: ctx.onDispose }))
  const fileBranchSubscriptions = new Map<string, () => void>()
  ctx.onDispose(() => { for (const dispose of fileBranchSubscriptions.values()) dispose(); fileBranchSubscriptions.clear() })
  const branchFileOptions = services.branchOptions ?? (installHost ? {
    ready: () => true,
    scope: (requestedBranch?: string) => {
      const identity = store.collections.identitySessions.get("identity")
      if (identity?.state !== "signed-in" || !identity.login) return null
      // Selection is persisted by the branch flow. Ignore another account's navigation.
      const navigation = store.session().branchNavigation
      const branch = requestedBranch ?? (navigation?.owner === (ctx.accountOwner() ?? null) ? navigation.selected_branch : undefined) ?? "main"
      // The server authorizes each operation; this fences in-flight answers on sign-out.
      const topic = `branch:${branch}`
      if (services.live && !fileBranchSubscriptions.has(topic)) {
        // Bound subscriptions just like the bounded File card set.
        if (fileBranchSubscriptions.size >= 30) {
          const oldest = fileBranchSubscriptions.keys().next().value!
          fileBranchSubscriptions.get(oldest)!()
          fileBranchSubscriptions.delete(oldest)
        }
        fileBranchSubscriptions.set(topic, services.live.subscribe(topic, () => {}))
      }
      const snapshot = services.live?.getSnapshot(topic)
      if (snapshot?.error) return null
      const machine = branchFileMachineScope(snapshot?.data, branch)
      return { branch, member: identity.login, revision: ctx.accountEpoch, ...(machine ?? { sleeping: false }) }
    }
  } : undefined)
  const filesSeam = actors.pair(seamCtx, (context) => createFilesSeam(context, branchFileOptions ? { ...branchFileOptions, topics: services.live, onDispose: ctx.onDispose } : undefined, installHost))
  const readFlowSource: AppController["readFlowSource"] = actors.pair(seamCtx, (context, select) => ({
    read: async (n: number, path: string) => {
      const read = select(filesSeam.readFile)
      try {
        const source = await flowSourceBranch(context, n)
        return source.branch === undefined ? source.error : read(path, undefined, undefined, source.branch)
      } catch { return "Branch files are unavailable." }
    }
  })).read
  const installDiffReader = installHost ? createBranchDiffReader(ctx, branchFileOptions).readBranchDiff : undefined
  const diffFilesSeam = actors.pair(seamCtx, context => createDiffFilesSeam(context, branchFileOptions ? { ...branchFileOptions, topics: services.live, onDispose: ctx.onDispose } : undefined, filesSeam.branchFiles, installDiffReader))
  const fileDocuments = services.documentOptions && services.live === services.documentOptions.channel ? new FileDocuments(services.documentOptions.channel, services.documentOptions.prerequisites, filesSeam.branchFiles, { storage: store.documentRecoveryStorage, member: () => store.collections.identitySessions.get("identity")?.login?.toLowerCase() }) : undefined
  ctx.onDispose(() => fileDocuments?.dispose())
  const { recoverFile } = actors.pair(seamCtx, context => ({
    recoverFile: (tag: "file.compare" | "file.restore-deleted" | "file.follow-rename" | "file.reapply", path: string, branch?: string) => fileDocuments?.has(path, branch) ? fileDocuments.recover(tag, path, async (file, from) => {
      const old = [...store.collections.cards.values()].find(card => card.kind === "file" && (card.payload.file?.branch ?? card.payload.ref ?? card.payload.repo) === file.branch && card.payload.path === from)
      if (old?.kind !== "file") return
      await context.dispatch({ type: "card.navigated", actor: context.actor(), card: { ...old, title: `${file.path} · ${old.payload.repo}`, payload: {
        ...old.payload, file, path: file.path, ref: file.branch, digest: file.digest,
        content: file.content.kind === "binary" ? "" : file.content.text, binary: file.content.kind === "binary", truncated: false,
        readAt: undefined, line: undefined, column: undefined, hover: undefined, diagnostics: undefined, diagnosticsTotal: undefined, intel: undefined
      } } }).isPersisted.promise
    }, branch) : Promise.resolve(undefined)
  }))
  const repoTreeSeam = actors.pair(seamCtx, (context) => createRepoTreeSeam(context))

  const gitHubSeam = actors.pair(seamCtx, (context) => createGitHubSeam(context, {
    ...(services.openExternal === undefined ? {} : { openExternal: services.openExternal })
  }))
  /*
   * Lane piper: the cloud session and inventory seams. A definitive
   * signed-in answer pulls the repository inventory; sign-in does the same
   * when its wait settles.
   */
  const cloudSeam = actors.pair(seamCtx, (context) => createCloudSeam(context, {
    sessionEpoch: () => ctx.accountEpoch,
    ...(services.openExternal === undefined ? {} : { openExternal: services.openExternal })
  }))
  /* Lane citc: the cloud workspaces; its settle watches die with the controller. */
  const workspaceSeam = actors.pair(seamCtx, (context) => createWorkspaceSeam(context))
  /*
   * The palette's seam reads the registry it is registered in: the thunk
   * resolves once `commands` exists below, and nothing calls it during
   * construction.
   */
  const searchSeam = actors.pair(seamCtx, (context, select) =>
    createSearchSeam(context, { registry: () => commands, readStack: select(stackSeam).readStack,
      heldStack: select(stackSeam).heldStack }))
  const egressSeam = actors.pair(seamCtx, (context) => createEgressSeam(context, withToast))
  ctx.onDispose(workspaceSeam.dispose)
  /* Lane change: the change/diff cards and their acts. */
  /* Lane L1: a revision's snapshot forks into a computer whose card the workspace seam renders. */
  const changeSeam = actors.pair(seamCtx, (context, select) => createChangeSeam(context, { viewWorkspace: select(workspaceSeam.viewWorkspace) }))
  const reloadRepositoriesWhenSignedIn = (): void => {
    if (store.collections.cloudSessions.get("cloud")?.state === "signed-in") {
      void repositoriesSeam.loadRepositories()
      void workspaceSeam.refreshWorkspaces()

    }
  }
  const loadCloudSession = async (): Promise<void> => {
    await cloudSeam.loadSession()
    reloadRepositoriesWhenSignedIn()
  }
  const signInCloud = async (): Promise<string | void> => {
    const refusal = await cloudSeam.signIn()
    reloadRepositoriesWhenSignedIn()
    return refusal
  }

  // Every selected backend reads its canonical user API, including hosted
  // cookie sessions. The bootstrap still identifies the GitHub sign-in door.
  const applicationIdentity = services.applicationIdentity
  const {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signInWithEmail,
    signOut,
    refreshBalance,
    settleTurnBilling,
    watchIdentityAcrossTabs
  } = actors.pair(ctx, (context) => createAuthBillingController(
    context,
    applicationIdentity === undefined
      ? undefined
      : {
        current: applicationIdentity.current,
        signInPath: signInByHandoff(services.bootstrap) ? AUTH_SIGN_IN_PATH : APPLICATION_SIGN_IN_PATH,
        settled: reloadRepositoriesWhenSignedIn
      }
  ))
    const { storageRecoveryState, promptStorageRecovery, exportStorageRecovery, resetStorageRecovery } = actors.pair(ctx, createStorageRecoveryController)
  /*
   * An install's owner is admitted part-way through Setup (GitHub sign-in, then the repository claim), after the
   * page read its identity at boot. Each Setup step that finishes reads it again until it answers signed in, so the
   * TODO, Draft and Members doors open for the owner without a reload. Source ready creates the repository's row
   * after that read listed the owner's repositories, so its finishing reads them again: the agent's first answer
   * names the repository instead of "no repository is selected".
   */
  let installStepsDone: readonly string[] | undefined
  ctx.onDispose(installSeam.snapshots.subscribe(() => {
    const model = installSeam.snapshots.get().model
    if (model && (model.steps.some(step => step.state !== "done") || setupEntry) && !store.collections.cards.has("setup")) {
      void presentCard("setup", "Setup").catch(cause => ctx.failures.report("seam.failure", cause, "setup"))
    }
    if (!installHost || model === undefined || !model.github.signed_in) return
    const done = model.steps.flatMap(step => step.state === "done" ? [step.id] : [])
    if (done.join() === installStepsDone?.join()) return
    const mirrored = installStepsDone !== undefined && !installStepsDone.includes("source") && done.includes("source")
    installStepsDone = done
    if (store.collections.identitySessions.get("identity")?.state !== "signed-in") void loadSession()
    else if (mirrored) reloadRepositoriesWhenSignedIn()
  }))

  const {
    showChat,
    showWorld,
    showWikiPane: togglePane,
    toggleDevtools,
    askReset,
    cancelReset,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugErrors,
    netTap,
    netTapEntries,
    debugNet,
    debugSeams,
    openBrowser,
    setTheme,
  } = actors.pair(ctx, createPresentationController)

  const conversationHistory = createConversationHistoryController(ctx)
  const earlierHistory = createEarlierHistoryController(ctx)
  const {
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
  } = createFramesController(ctx, services.frameHistory)

  const {
    selectRepo: selectRepoOnly,
  } = actors.pair(ctx, (context) => createTabsController(context))
  const { renderFlowForm, setFormField, submitForm, dismissCard, focusHandoff: formFocus } = actors.pair(ctx, (context) => createFormsController(context, { nextOrdinal: store.nextOrdinal }))
  const todoForms = actors.pair(ctx, (context, select) => ({
    setFormField: (cardId: string, field: string, value: string) => context.store.collections.cards.get(cardId)?.kind === "draft"
      ? select(todoSeam).setTodoFormField(cardId, field, value) : select(setFormField)(cardId, field, value)
  }))
  const {
    listAgents,
    assignAgentModel,
  } = actors.pair(ctx, (context, select) => createAgentsController(context, { nextOrdinal: store.nextOrdinal, install: installHost, live: services.live, refreshSettings: select(installSeam).readInstall }))
  const { newModel, editModel, saveModel, removeModel, testModel, showModel } = actors.pair(ctx, (context, select) => createModelsController(context, { renderFlowForm: select(renderFlowForm), listAgents: select(listAgents) }))
  const { toggleRepoTree,} = actors.pair(ctx, (context, select) => createSidebarController(context, select(repoTreeSeam)))
  const socketProtocols = services.socketProtocols ?? localSocketProtocols
  createHealthStatusController(ctx)
  /* Lane citc: the cloud-workspace terminal transport, one socket per session. */
  const cloudTerminal = createCloudTerminalClient({
    auth: services.authorizeSocket === undefined
      ? services.bootstrap?.host === "cloud" ? "cookie" : "subprotocol"
      : "ticket",
    socketUrl: services.cloudSocketUrl ?? ((repo, sessionId) => pageCloudSocketUrl(repo, sessionId, baseUrl)),
    ...(services.authorizeSocket === undefined
      ? { socketProtocol: () => socketProtocols()[0] }
      : { authorizeSocket: services.authorizeSocket })
  })
  ctx.onDispose(cloudTerminal.dispose)
  const terminalProvider = installHost && services.live ? createTerminalSource({
    live: services.live,
    knownBranches: () => [...store.collections.cards.values()].flatMap(card => card.kind === "branch" ? [card.payload.id] : []),
    subscribeViewer: listener => {
      const subscription = store.collections.identitySessions.subscribeChanges(listener)
      return () => subscription.unsubscribe()
    },
    repo: () => store.session().repositoryEntry?.repo ?? "",
    viewer: () => {
      const identity = store.collections.identitySessions.get("identity")
      return identity?.state === "signed-in" ? identity.login ?? undefined : undefined
    },
    http: (path, init) => seamCtx.http(`${baseUrl.replace(/\/$/, "")}${path}`, init)
  }) : undefined
  if (terminalProvider) ctx.onDispose(terminalProvider.dispose)

  const createCloudLsp = services.daemonLsp === undefined ? undefined
    : () => createCloudLspClient({
      openSession: services.daemonLsp!.openSession,
      socketUrl: services.daemonLsp!.socketUrl,
      ...(services.authorizeSocket === undefined
        ? { socketProtocol: () => socketProtocols()[0] }
        : { authorizeSocket: services.authorizeSocket })
    })
  const codeIntelSeam = actors.pair(seamCtx, (context, select) => createCodeIntelSeam(context, {
    readFile: installHost
      ? (path, repo, anchor, branch) => select(filesSeam).branchFiles.open(path, branch ?? repo, anchor?.line)
      : select(filesSeam.readFile),
    validatedGuestExecution: () => services.daemonLsp?.ready() === true,
    ...(installHost ? { branchScope: branchFileOptions!.scope, subscribeBranch: (branch: string, changed: () => void) => services.live?.subscribe(`branch:${branch}`, changed) ?? (() => {}) } : {}),
    ...(createCloudLsp === undefined ? {} : { createCloudLsp })
  }))
  ctx.onDispose(codeIntelSeam.dispose)
  const { codeHover, codeDefinition, codeDiagnostics } = actors.pair(seamCtx, (_context, select) => {
    const seam = select(codeIntelSeam)
    return {
      codeHover: (path: string, line: number, column: number, repo?: string) =>
        withToast("code.hover", `Asking the language server about ${path}:${line}:${column}…`, "Language server answered", () => seam.hover(path, line, column, repo)),
      codeDefinition: (path: string, line: number, column: number, repo?: string) =>
        withToast("code.definition", `Asking the language server where ${path}:${line}:${column} is defined…`, "Language server answered", () => seam.definition(path, line, column, repo)),
      codeDiagnostics: (path: string, repo?: string) =>
        withToast("code.diagnostics", `Asking the language server about ${path}…`, "Language server answered", () => seam.diagnostics(path, repo))
    }
  })
  /* One reader for the whole controller, so a plan card opening and a run of
   * the same flow settling cannot apply their two answers out of order. */
  const readFlowDurations = createFlowDurationsReader(ctx)
  const {
    pumpWorkflowRun,
    stopWatchingRun,
    retryRunWatch: retryObservedRun
  } = createWorkflowPumpController(ctx, store.nextOrdinal, readFlowDurations)

  const workflowController: WorkflowController = actors.pair(ctx, (context, select) => createWorkflowController(context, store.nextOrdinal, pumpWorkflowRun, select(renderFlowForm), readFlowDurations))
  const retryRunWatch = (cardId: string): string | void => {
    if (!workflowController.retryWorkflowRequest(cardId)) return retryObservedRun(cardId)
  }
  const issueFlows = actors.pair(seamCtx, (context, select) =>
    createIssueFlowsController(context, select(workflowController), select(todoSeam), installHost))
  const {
    createWorkflow,
    listWorkspaceWorkflows,
    showFlows,
    runWorkflow,
    planFlow,
    chooseWorkflowRepo,
    forwardApprovalDecision,
    forwardInboxApprovalDecision
  } = workflowController
  const { listTriggers, registerTrigger } = triggersSeam
  const runs = actors.pair(ctx, (context, select) => createRunsController(context, store.nextOrdinal, select(workflowController), select(renderFlowForm)))
  const graph = actors.pair(ctx, (context, select) => createGraphController(context, select(filesSeam.readFile)))
  const {
    subscribeToAgent,
    send,
    reset,
    stop,
    decideApproval: decideRunApproval,
    retryLastTurn
  } = createTurnController(ctx, {
    settleTurnBilling,
    nextOrdinal: store.nextOrdinal,
    surfaceCommandFailure,
    forwardApprovalDecision,
    forwardInboxApprovalDecision
  })
  const sharedPrompts = sharedConversation ? createSharedPrompts(ctx, sharedConversation) : undefined
  const promptQueue = createPromptQueueController(ctx, send)
  const decideApproval: typeof decideRunApproval = (id, decision, answer, question) => {
    if (id.startsWith("confirmation:")) {
      if (answer === undefined) confirmations.decide(id.slice("confirmation:".length), decision)
      return
    }
    decideRunApproval(id, decision, answer, question)
  }
  const { enqueuePrompt, removeQueuedPrompt, restoreQueuedPrompts } = promptQueue
  const cloudWiki = actors.pair(ctx, (context) => createCloudWikiController(context, store.nextOrdinal))
  const { listCloudWiki, openCloudWiki, retryCloudWiki, attachWorldEditor,
    setWikiSpace, setWikiPageView, loadWikiIndex, readWikiForPane, openWikiPage, showWikiHistory, createCloudWikiPage, saveWikiAnswer, renameCloudWikiPage, deleteCloudWikiPage, attachCloudWiki, wikiIndexes } = cloudWiki
  const selectRepo: TabsController["selectRepo"] = async (key) => {
    const result = await selectRepoOnly(key)
    if (result === undefined && store.session().surface === "world") void readWikiForPane()
    return result
  }
  const {
    selectWorldDocument,
    changeWorldDocument,
    prepareWorldDocument,
    createWorldDocument,
    removeWorldDocument,
    confirmWorldDelete,
    cancelWorldDelete,
    openWorldDocument,
    showWorldLinks,
    showWorldGraph,
    attachWikiEditor,
    jumpToHeading,
    selectWikiCardDocument,
    setWikiCardView
  } = actors.pair(ctx, (context, select) => createWorldController(context, { nextOrdinal: store.nextOrdinal, cloudWiki: select(cloudWiki) }))
  const debugApi = createDebugApiSeam({
    document: services.openApi ?? bundledOpenApi, fetch: (url, init) => ctx.boundedFetch(url, { ...init, [UNRECORDED_NET]: true } as UnrecordedInit),
    origin: services.debugApiOrigin ?? (typeof window === "undefined" ? "http://localhost" : window.location.origin),
    gates: services.debugApiGates ?? (() => ({ view: true, catalog: debugApiOperation.name === "debug.api", authorizer: services.bootstrap?.capabilities.includes("debug.api") === true }))
  })
  ctx.onDispose(debugApi.dispose)
  ctx.onDispose(ctx.onAccountChange(debugApi.endAccount))
  const debugApiCommand = (input: DebugApiInput): string | { readonly value: string } => {
    if (!debugApi.available()) return "Debug API is unavailable"
    if (input.intent === "send" || input.intent === "confirm") {
      if (debugApi.get().busy) return { value: "Requested" }
      const epoch = ctx.accountEpoch
      // The toast is journaled: it states status and class only. The response's
      // own words stay in the seam's session-local exchange.
      void withToast("debug.api.send", "Sending", "Response", async () => {
        try {
          await debugApi.send(input)
          const failure = debugApi.get().model.exchange?.failure
          return failure === undefined ? undefined : debugApiFailureCopy(failure)
        } catch (cause) { return presentDebugApiFailure(cause) }
      }, false, () => ctx.accountEpoch === epoch)
      return { value: "Requested" }
    }
    void withToast("debug.api.open", "Opening API", "API", async () => {
      await debugApi.open(input.operationId)
      if (ctx.disposed) return
      const existing = store.collections.cards.get("debug-api")
      store.dispatch({ type: "card.upsert", actor: "user", card: { id: "debug-api", kind: "debug-api", title: "Debug API", status: "active",
        createdAt: existing?.createdAt ?? Date.now(), ordinal: store.nextOrdinal(), payload: {} } })
    })
    return { value: "Requested" }
  }
  const { contextAvailable, inspectContext } = actors.pair(ctx, context =>
    createContextSeam(context.http, context.baseUrl, services.contextProvider, () => {
      const epoch = context.accountEpoch
      return () => !context.disposed && context.accountEpoch === epoch
    }, () => context.commandActor))
  const { docsTargetAvailable, docsAvailable, openDocsPage, readDocsPage } = actors.pair(ctx, (context) =>
    createDocsController(context, { nextOrdinal: store.nextOrdinal, docs: services.docs ?? bundledDocs, available: services.docsCatalogAvailable ?? (() => true) }))

  const { askWorldDelete } = actors.pair(ctx, (_context, select) => ({
    askWorldDelete: (id: string): string | void => {
      const refusal = select(removeWorldDocument)(id)
      return refusal
    }
  }))

  const changeDraft = (draft: string): void => {
    if (ctx.disposed || privacyActions.refuse("user") !== undefined) return
    store.dispatch({ type: "composer.changed", actor: "user", draft })
  }
  const repositoryReadiness = createRepositoryReadiness(ctx, surfaceCommandFailure, (repo, requestId, isCurrent, scope) =>
    openRequestedRepo({ store, selectRepo, loadRepositories: repositoriesSeam.loadRepositories, runCommand: (name, args) => runCommand(name, args) },
      ctx.http, repo, requestId, 0, { activate: false, isCurrent, scope }))
  const deferCommand = (name: string, args: string | null, requirement: string): void => {
    store.dispatch({ type: "command.deferred", actor: "user", name, args, requirement })
    // The fulfilling prompt owns the answer. Parking survives OAuth silently.
    if (requirement === "first-run-target") armFirstRunDeadline()
  }

  const noteCommandRun = (name: string): void => {
    if (ctx.disposed) return
    store.dispatch({ type: "command.ran", actor: "user", name })
  }

  const dictation = createDictation(store)
  ctx.onDispose(dictation.cancel)
  const cancelDictation = dictation.cancel
  const toggleDictation = async (): Promise<string | void> => {
    if (!store.session().dictating) {
      openPalette()
    }
    return dictation.toggle()
  }

  /* The palette's session acts (palette spec §3): open, close, the actions panel, the recents ledger. */
  const openPalette = (prefix?: string): void => {
    if (ctx.disposed || privacyActions.refuse("user") !== undefined) return
    if (prefix !== undefined && prefix !== "") store.dispatch({ type: "composer.changed", actor: "user", draft: prefix })
    if (store.session().paletteOpen !== true) store.dispatch({ type: "palette.toggled", actor: "user", open: true })
    store.dispatch({ type: "hint.dismissed", actor: "user", id: "chat" })
  }
  const inputMode = createInputModeController(store, {
    actor: () => ctx.commandActor,
    cancelDictation,
    startDictation: dictation.toggle,
    openChat: async () => { openPalette() },
  })
  const closePalette = (lastQuery?: string): void => {
    cancelDictation()
    if (ctx.disposed || privacyActions.refuse("user") !== undefined) return
    if (store.session().paletteOpen !== true) return
    store.dispatch({ type: "palette.toggled", actor: "user", open: false, ...(lastQuery === undefined ? {} : { lastQuery }) })
  }
  const togglePaletteActions = (ref: string): void => {
    if (ctx.disposed || privacyActions.refuse("user") !== undefined) return
    if (store.session().paletteOpen !== true) store.dispatch({ type: "palette.toggled", actor: "user", open: true })
    const current = store.session().paletteActionsRef ?? null
    store.dispatch({ type: "palette.actions.toggled", actor: "user", ref: current === ref ? null : ref })
  }
  const notePaletteItemOpened = (item: { readonly kind: string; readonly ref: string }): void => {
    if (ctx.disposed || privacyActions.refuse("user") !== undefined) return
    store.dispatch({ type: "palette.item.opened", actor: "user", ref: item.ref, kind: item.kind, at: Date.now() })
  }
  const paletteRecent = (): { readonly value: string } => ({ value: JSON.stringify({ items: store.session().paletteRecents ?? [] }) })

  const toggleVerbose = (): void => {
    store.dispatch({ type: "verbose.toggled", actor: "user", on: store.session().verbose !== true })
  }

  const traceFlow = (record: Extract<AppTransition, { type: "flow.invoked" }>): void => {
    // Command settlement can outlive its subscription scope. A diagnostic
    // receipt must not write into a controller whose shutdown has begun.
    if (ctx.disposed) return
    store.dispatch(record)
  }

  /*
   * A `confirm` flow asked for: the act is consequential (land a PR, remove a
   * credential, discard a draft), so the invocation never runs the handler —
   * it posts this message, and the button runs the flow as the user. The
   * honest middle between "user-only" (the agent cannot even ask, the refusal
   * Will read as a bug) and silent execution.
   */
  const requestFlowConfirmation = (name: string, args: string | null, label: string, question?: string): void => {
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: question ?? `Smithers wants to ${label}${args === null ? "" : ` (${args})`}. It runs when you confirm.`,
      action: {
        flow: name,
        ...(args === null ? {} : { args }),
        revision: randomUuid(),
        label: `Confirm: ${label}`
      }
    })
  }

  /*
   * MOCK SEAM (state/seams/DesignWorld/chat.ts): a plain prompt the seeded app
   * agent can read never reaches the model. The agent runs the flows the
   * person asked for through the agent's own door (the tool loop's): it acts
   * with the person's authority, a `confirm` flow asks before it runs, and
   * what it writes reads "<member> via Smithers". It settles the turn with
   * its reply and Context line; a prompt it has no reading for takes the
   * real turn path.
   */
  const runDesignTurn = async (turnId: string, turn: DesignTurn): Promise<void> => {
    const viewer = design.viewer()
    const said: string[] = []
    for (const step of turn.run) {
      const outcome = await ctx.commands.submit({ name: step.name, payload: step.payload, actor: "agent" })
      if (outcome.status === "failed") said.push(outcome.error)
      else if (outcome.status === "unavailable") said.push(outcome.reason)
      else if (outcome.status === "unknown-command") said.push(`/${step.name} is not a flow here.`)
    }
    const shown: Array<Pick<Card, "id" | "kind" | "title" | "payload">> = []
    if (turn.wiki !== undefined) {
      const { title, lines } = turn.wiki
      const id = newWikiPage(design, title, `${viewer}~smithers`)
      design.patch("wiki", id, current => ({ ...current, lines: lines.map((text, index) => ({ n: index + 1, text })) }))
      shown.push(wikiCard(id, title))
    }
    if (turn.ask !== undefined) {
      const asked = design.ask({ ...turn.ask, by: viewer })
      const act = asked.ok && asked.id !== undefined ? design.row("acts", asked.id) : undefined
      if (act !== undefined) shown.push(actCard(act))
    }
    if (turn.merge !== undefined) {
      const todo = design.row("todos", turn.merge)
      if (todo !== undefined) shown.push(mergeCard(todo, viewer))
    }
    // One loop presents them in order (scripts/durable-write-doors.ts reads a write inside an `if` block as every `if`'s).
    for (const card of shown) await presentSubject(card)
    const reply = said.length > 0 ? said.join(" ") : turn.reply
    if (reply !== undefined && reply !== "") {
      await store.dispatch({ type: "message.response.delta", actor: "smithers", turnId, channel: "text", delta: reply }).isPersisted.promise
    }
    const context = said.length > 0 || turn.context === undefined ? {} : { context: [...turn.context] }
    await store.dispatch({ type: "message.response.completed", actor: "smithers", turnId, ...context }).isPersisted.promise
  }
  const designSend: TurnController["send"] = (text, admission, capturedDraft) => {
    if (sharedPrompts && parseSubmit(text, ctx.commands.all()).kind === "prompt") return sharedPrompts.submit(text, capturedDraft)
    const viewer = design.viewer()
    const turn = admission === undefined && !text.trimStart().startsWith("/") && store.session().phase === "idle"
      ? (() => {
        const at = shellViewsOf(design).get(viewer)?.at ?? "main"
        // MOCK SEAM: a booted host with no agent provider (the mounted design) answers an unscripted prompt from the seed
        // instead of failing; a harness with no bootstrap keeps the failure, and a signed-out visitor still meets the sign-in gate.
        const seedAnswers = !agent.available && services.bootstrap !== undefined
          && store.collections.identitySessions.get("identity")?.state !== "signed-out"
        return designTurn(design.world(), viewer, text, at) ?? (seedAnswers ? designPlainTurn(design.world(), text, at) : undefined)
      })()
      : undefined
    if (turn === undefined) return send(text, admission, capturedDraft)
    const draftCurrent = capturedDraft ?? store.captureComposerDraft(text)
    const turnId = randomUuid()
    const admitted = store.dispatch({ type: "message.submitted", actor: "user", turnId, text: text.trim(), preserveDraft: !draftCurrent() }).isPersisted.promise
    void admitted.then(() => runDesignTurn(turnId, turn)).catch((error: unknown) => {
      if (ctx.disposed) return
      // A thrown step still settles the turn with a visible line, so Chat stays usable (controller/failures.ts reports the cause).
      ctx.failures.report("command.boundary", error, "design.turn")
      store.dispatch({ type: "message.response.failed", actor: "system", turnId, message: "Try again." })
    })
    return admitted.then(() => true)
  }

  const cancelConfirmation: AppController["cancelConfirmation"] = async (confirmation, revision) => {
    /* MOCK SEAM: an act cancels in the seeded world (its id is its revision); a Review & merge card closes. */
    const act = design.row("acts", confirmation)
    if (act !== undefined) {
      const stale = confirmCancelRefusal(revision, { revision: act.id, answered: act.state !== "asked" })
      if (stale !== undefined) return { refusal: stale }
      design.cancelAct(act.id, design.viewer())
      return
    }
    if (confirmSubject(confirmation)?.kind === "merge") {
      /* The seed's Review & merge, or this host's (`merge:todo:<n>`, TodoSeam.reviewMerge). */
      const id = store.collections.cards.has(`confirm:${confirmation}`) ? `confirm:${confirmation}` : `${DESIGN_CARD}confirm:${confirmation}`
      await store.dispatch({ type: "card.removed", actor: "user", id }).isPersisted.promise
      return
    }
    const message = store.collections.messages.get(confirmation)
    const refusal = confirmCancelRefusal(revision, message?.action === undefined ? undefined : { revision: message.action.revision, answered: message.answeredAction !== undefined })
    if (refusal !== undefined) return { refusal }
    await store.dispatch({ type: "confirmation.cancelled", actor: "user", id: confirmation, revision }).isPersisted.promise
  }


  /*
   * auth.prompt: the agent cannot navigate the user to OAuth (sign-in
   * is user-only — a model must not yank the page mid-turn), but it CAN
   * hand the step over: one message whose action IS the sign-in button.
   * Every identity state answers honestly, including a build with no seam.
   * A 401 read requires the door even while identity is being rechecked.
   */
  const promptSignIn: AppController["promptSignIn"] = (required = false, request) => {
    const identity = store.collections.identitySessions.get("identity")
    if (!required && identity?.state === "signed-in") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `GitHub is already connected as ${identity.login ?? "you"}.`
      })
      return
    }
    if (!required && (identity === undefined || identity.state === "unavailable")) {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text:
          "Sign-in isn't available on this build — no identity service is configured here. Use the deployed app to sign in."
      })
      return
    }
    const pending = store.session().pendingCommand
    const asked = request ?? (pending?.requirement === "signed-in" || pending?.requirement === "repo-read" ? pending : undefined)
    let summary = asked && "summary" in asked ? asked.summary : undefined
    if (asked?.name === "flow.run") {
      const [flow, explicit] = asked.args?.trim().split(/\s+/) ?? []
      const repo = explicit ?? activeRepositoryId(store)
      const declared = repo ? store.collections.repositoryFlows.get(repo)?.flows.find(row => row.id === flow)?.summary : undefined
      summary = declared ? `${declared.replace(/[.!?]$/, "")} on ${repo}`
        : flow ? `run ${flow}${repo ? ` on ${repo}` : ""}` : undefined
    }
    // A registry summary is the flow's internal description, not product copy (#2285): without a named purpose the step says "continue".
    const purpose = summary?.trim().replace(/[.!?]$/, "")
    const label = identityProviderFor(services) === "github" ? "Sign in with GitHub" : "Sign in"
    const text = purpose ? `${label} to ${purpose[0]!.toLowerCase()}${purpose.slice(1)}.` : `${label} to continue.`
    const signInRequirement = request?.signInRequirement
    // Repeated doors do not pile up: the same unanswered step already closing the transcript stands.
    let tail: { readonly ordinal: number; readonly message?: Message } = { ordinal: -1 }
    for (const message of store.collections.messages.values()) if (message.ordinal > tail.ordinal) tail = { ordinal: message.ordinal, message }
    for (const card of store.collections.cards.values()) if (card.ordinal > tail.ordinal) tail = { ordinal: card.ordinal }
    const last = tail.message
    if (last?.action?.flow === "sign-in" && last.answeredAction === undefined && last.text === text &&
        last.action.signInRequirement === signInRequirement) return
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text,
      action: { flow: "sign-in", label, ...(signInRequirement === undefined ? {} : { signInRequirement }) }
    })
  }

  /*
   * cloud.prompt, mirroring auth.prompt (.specs/engineering/spec.md §6.1): the agent cannot
   * run cloud.sign-in (the browser login is the human's gesture), but it CAN
   * hand the step over — one message whose action IS the Smithers Cloud
   * sign-in button. A host without the PAT door (the web) has no
   * cloud.sign-in to offer: there the GitHub sign-in IS the Cloud sign-in
   * (Instructions.ts WEB_HOST_LINE), so that step is the one rendered.
   * Referenced before `commands` initializes; only ever called after.
   */
  const promptCloudSignIn = (required = false): void => {
    const cloud = store.collections.cloudSessions.get("cloud")
    if (!required && cloud?.state === "signed-in" && cloud.scopes !== "degraded") {
      store.dispatch({
        type: "message.appended",
        actor: "system",
        text: `Smithers Cloud is already signed in as ${cloud.username ?? "you"}.`
      })
      return
    }
    if (commands.find("cloud.sign-in") === undefined) {
      // Identity alone does not answer this prompt: the Cloud exchange may
      // still be signed out, unavailable, or missing workspace scopes.
      promptSignIn(true, { signInRequirement: "cloud" })
      return
    }
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: "One step signs in to Smithers Cloud: workspaces, changes and sync need it.",
      action: { flow: "cloud.sign-in", label: "Sign in to Smithers Cloud" }
    })
  }
  // A registration still importing or launching reconnects with the runs, after boot and sign-in.

  const reloadApp = (): void => {
    if (typeof window !== "undefined") window.location.reload()
  }

  /** A deferral older than this resumes nothing: firing it would surprise, not continue. */
  const deferralMaxAgeMs = 15 * 60 * 1000

  const resumeDeferredCommand = (): void => {
    const pending = store.session().pendingCommand
    if (pending === undefined || pending === null || pending.requirement === "repository-ready") return
    const requirement = flowRequirements.find((candidate) => candidate.id === pending.requirement)
    // Still waiting (or the requirement id no longer exists): leave it parked.
    if (requirement !== undefined && !requirement.satisfied(commands.state())) return
    store.dispatch({ type: "command.deferral.cleared", actor: "system" })
    store.dispatch({ type: "toast.dismissed", actor: "system", id: "toast-command.requirement" })
    if (requirement === undefined || Date.now() - pending.requestedAt > deferralMaxAgeMs) return
    // The app acting on its own is announced (300ms law does not apply: this
    // IS the act, not its latency) — then the command re-enters the one run
    // path, where the NEXT unmet requirement, if any, parks it again.
    const key = `command.resume.${pending.name}`
    const summary = commands.find(pending.name)?.metadata.summary ?? "This action"
    store.dispatch({ type: "toast.shown", actor: "system", key, title: `Continuing: ${summary}` })
    void commands.run(pending.name, pending.args ?? undefined).then((outcome) => {
      resolveToast(key, {
        status: outcome.status === "failed" ? "failed" : "ok",
        detail: outcome.status === "failed"
          ? humanCommandText(commands, outcome.error)
          : outcome.status === "unknown-command"
          ? `${summary} is no longer available`
          : `${summary} continued`,
        autoDismissMs: ctx.toastAutoDismissMs
      })
    })
  }
  ctx.resumeDeferredCommand = resumeDeferredCommand

  /*
   * Whether boot has made its first-run choice yet. A per-boot fact, never a
   * persisted row: a reload must make the choice again, and a stored "settled"
   * would suppress the very park the reload has to recreate.
   */
  let firstRunTargetSettled = false
  const settleFirstRunTarget = (): void => {
    firstRunTargetSettled = true
    // Only the park that waits on this choice; a sign-in or repo-read park
    // keeps waiting for the seam that satisfies it.
    if (store.session().pendingCommand?.requirement === "first-run-target") resumeDeferredCommand()
  }
  /*
   * What the identity seam announces (controller/auth-billing.ts, the
   * registry.ts convention: the seam that can SATISFY a requirement settles
   * it). The read that writes the row makes the choice, so a boot read raced
   * by a focus re-read cannot lose it. A page entered at /owner/name has its
   * target from the URL and makes no first-run choice.
   */
  ctx.settleFirstRunTarget = (): void => {
    if (firstRunTargetSettled) return
    /*
     * The seam announces; boot chooses. The park is the exception: it is
     * already waiting on the target boot would have chosen, and without one
     * it resumes into a repository form.
     */
    if (services.repositoryApp !== undefined || store.session().pendingCommand?.requirement !== "first-run-target") {
      settleFirstRunTarget()
      return
    }
    selectFirstRunRepository(store, settleFirstRunTarget)
  }
  /*
   * An identity seam that never answers must not hold a command forever: the
   * choice settles on its own once a park has waited this long, so the
   * command asks for a repository instead of waiting with nothing on screen.
   */
  let firstRunDeadline: ReturnType<typeof setTimeout> | undefined
  const armFirstRunDeadline = (): void => {
    if (firstRunTargetSettled || firstRunDeadline !== undefined) return
    firstRunDeadline = setTimeout(settleFirstRunTarget, services.firstRunSettleMs ?? 8_000)
    ctx.unref(firstRunDeadline)
  }
  ctx.onDispose(() => { clearTimeout(firstRunDeadline) })

  const {
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector
  } = actors.pair(ctx, (context) => createConnectorController(context))

  // A fresh-user reset closes producers only after the durable clear succeeds.
  const debugReset = async (): Promise<string | void> => {
    if (store.collections.identitySessions.get("identity")?.state === "signed-in") {
      const error = await signOut()
      if (typeof error === "string") return error
    }
    if (store.collections.cloudSessions.get("cloud")?.state === "signed-in") {
      const error = await cloudSeam.signOut()
      if (typeof error === "string") return error
    }
    if (ctx.activeTurn !== undefined) await agent.cancelTurn(ctx.activeTurn.id)
    ctx.activeTurn = undefined
    ctx.stopWorkflowPumps()
    await store.dispatch({ type: "app.reset", actor: "user" }).isPersisted.promise
    await ctx.dispose()
    if (typeof window !== "undefined") {
      const path = window.location.pathname.startsWith("/w/") ? "/" : window.location.pathname
      window.history.replaceState(null, "", path)
      window.location.reload()
    }
  }

  /*
   * The agent's entry point uses fixed smithers bindings — whether it
   * arrives through the streaming tool
   * loop or a direct executeForAgent call — so agent invocations render
   * embedded cards and record via:"agent", never user chrome.
   */
  const commandActions: CommandActions = {
    recoverFile,
    live: services.live,
    startAgent,
    design,
    presentCard,
    runMonitors,
    openRunMonitor,
    listRunMonitors,
    setRunView,
    contextRun,
    presentRun,
    presentFlow,
    presentSubject,
    presentBranchCard,
    showSetup: installSeam.showSetup, showSettings: installSeam.showSettings, setupStep: installSeam.setupStep,
    /* MOCK SEAM (DesignWorld/settings.ts designInstall): the Settings card shows the live install once it has a model, so the write goes there; the seed takes it only until then. */
    setInstallAddress: address => !installHost && installSeam.snapshots.get().model === undefined ? designSettings(design).address(address) : installSeam.setInstallAddress(address),
    /* MOCK SEAM (DesignWorld/settings.ts designInstall): the Settings card shows the live install once it has a model, so the write goes there; the seed takes it only until then. */
    setInstallCapacity: capacity => !installHost && installSeam.snapshots.get().model === undefined ? designSettings(design).capacity(capacity) : installSeam.setInstallCapacity(capacity),
    setInstallObsidian: installSeam.setInstallObsidian,
    setInstallPreapproveDefault: value => installSeam.setInstallPreapproveDefault(value),
    setInstallDailyAdmissions: value => installSeam.setInstallDailyAdmissions(value),
    setInstallParallel: parallel => !installHost && installSeam.snapshots.get().model === undefined ? designSettings(design).parallel(parallel) : installSeam.setInstallParallel(parallel),
    saveInstallModelKey: installSeam.saveInstallModelKey,
    showMembers,
    changeMembers,
    flowCards,
    selectConversationBranch,
    setBranchNavigationView,
    setCardTab,
    ...(openBranch ? { openBranch } : {}),
    ...(forkBranch ? { forkBranch } : {}),
    ...(branchControls ? { branchControls } : {}),
    ...(addBranchToStack ? { addBranchToStack } : {}),
    ...(branchSshLine ? { branchSshLine } : {}),
    promptStorageRecovery,
    exportStorageRecovery,
    resetStorageRecovery,
    bootstrap: services.bootstrap,
    identityProvider: identityProviderFor(services),
    repositoryApp: services.repositoryApp ?? null,
    repositoryFlows,
    knownRepositories: () => knownRepositories(store),
    changeDraft,
    reset,
    debugReset,
    askReset,
    cancelReset,
    stop: sharedPrompts?.stop ?? stop,
    send: designSend,
    enqueuePrompt: sharedPrompts ? (text, draftCurrent) => { void designSend(text, undefined, draftCurrent) } : enqueuePrompt,
    removeQueuedPrompt: sharedPrompts ? (id, edit) => { void sharedPrompts.remove(id, edit) } : removeQueuedPrompt,
    restoreQueuedPrompts: sharedPrompts?.restore ?? restoreQueuedPrompts,
    showChat,
    showWorld,
    showWikiPane: () => {
      togglePane()
      if (store.session().surface !== "world") return
      void readWikiForPane()
      // The pane shows generated pages' freshness (D-09b) from the stack snapshot, so the pane keeps it live as a homepage stack block does.
      const repo = activeRepositoryId(store)
      if (repo !== null) stackSeam.watchHomeStack(repo)
    },
    makeConnectorReadOnly,
    askConnectorRemoval,
    cancelConnectorRemoval,
    removeConnector,
    selectWorldDocument,
    changeWorldDocument,
    createWorldDocument,
    removeWorldDocument: askWorldDelete,
    confirmWorldDelete,
    cancelWorldDelete,
    openWorldDocument,
    showWorldLinks,
    showWorldGraph,
    attachWikiEditor,
    jumpToHeading,
    debugApi,
    debugApiCommand,
    docsTargetAvailable,
    contextAvailable, inspectContext,
    docsAvailable,
    openDocsPage,
    readDocsPage,
    listCloudWiki,
    openCloudWiki,
    retryCloudWiki,
    attachWorldEditor,
    setWikiSpace,
    setWikiPageView,
    loadWikiIndex,
    showWikiHistory,
    openWikiPage,
    createCloudWikiPage,
    saveWikiAnswer,
    renameCloudWikiPage,
    deleteCloudWikiPage,
    attachCloudWiki,
    selectWikiCardDocument,
    setWikiCardView,
    decideApproval,
    answerApproval: (id: string, answer: unknown, question?: string) => decideApproval(id, "approved", answer, question),
    retryLastTurn: sharedPrompts?.retry ?? retryLastTurn,
    openBrowser,
    ...issueFlows,
    createWorkflow,
    listWorkspaceWorkflows,
    listTriggers,
    showFlows,
    runWorkflow,
    planFlow,
    chooseWorkflowRepo,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns: () => ctx.resumeWorkflowRuns(),
    listRuns: runs.listRuns,
    openRun: runs.openRun,
    resumeRun: runs.resumeRun,
    continueRun: runs.continueRun,
    rerunRun: runs.rerunRun,
    signalRun: runs.signalRun,
    showRunLogs: runs.showRunLogs,
    showRunSteps: runs.showRunSteps,
    showRunEvents: runs.showRunEvents,
    traceFilter: runs.traceFilter,
    traceSelect: runs.traceSelect,
    selectCodingChange: runs.selectCodingChange,
    traceView: runs.traceView,
    graphFollow: runs.graphFollow,
    graphExecution: runs.graphExecution,
    selectGraphNode: graph.selectGraphNode,
    graphNodeTab: graph.graphNodeTab,
    selectPlanNode: graph.selectPlanNode,
    planNodeTab: graph.planNodeTab,
    traceLive: runs.traceLive,
    stopAllRuns: runs.stopAllRuns,
    listApprovals: runs.listApprovals,
    openApproval: runs.openApproval,
    maximizeCard: id => {
      const shared = sharedConversation?.get()
      if (shared?.conversation?.entries.some(turn => "frames" in turn && turn.frames.some(frame => frame.type === "card" && frame.card.id === id))) {
        void sharedConversation!.saveView({ card_view: { [id]: "maximized" } })
        return
      }
      return maximizeCard(id)
    },
    minimizeCard: () => {
      if (sharedConversation?.get().view?.card_view) void sharedConversation.saveView({ card_view: {} })
      minimizeCard()
    },
    frameBack,
    frameForward,
    selectRepo,
    toggleRepoTree,
    newModel, editModel, saveModel, removeModel, testModel, showModel,
    listAgents,
    assignAgentModel,
    renderFlowForm,
    setFormField: todoForms.setFormField,
    submitForm,
    dismissCard,
    cloudTerminal,
    terminalCards: terminalProvider?.source,
    toggleDevtools,
    moveCardHistory: (id, delta) => { store.dispatch({ type: "card.history.moved", actor: ctx.commandActor, id, delta }) },
    toggleDictation,
    cancelDictation,
    setInputMode: inputMode.setInputMode,
    openChat: inputMode.openChat,
    searchPalette: searchSeam.palette,
    search: searchSeam.search,
    openPalette,
    closePalette,
    togglePaletteActions,
    notePaletteItemOpened,
    paletteRecent,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugErrors,
    debugNet,
    netTap,
    netTapEntries,
    debugSeams,
    setTheme,
    adoptSession,
    loadSession,
    signIn,
    signInWithEmail,
    signOut,
    handleAuthReturn,
    handleInstallReturn: gitHubSeam.handleInstallReturn,
    deferCommand,
    deferRepositoryCommand: repositoryReadiness.defer,
    resumeDeferredCommand,
    settleFirstRunTarget,
    noteCommandRun,
    toggleVerbose,
    traceFlow,
    requestFlowConfirmation,
    cancelConfirmation,
    promptSignIn,
    promptCloudSignIn,
    reloadApp,
    dismissHint: (id: string) => {
      if (ctx.disposed || privacyActions.refuse(ctx.commandActor) !== undefined) return
      store.dispatch({ type: "hint.dismissed", actor: ctx.commandActor, id })
    },
    listIssues: issuesSeam.listIssues,
    viewIssue: issuesSeam.viewIssue,
    issueWriteTarget: issuesSeam.issueWriteTarget,
    createIssue: issuesSeam.createIssue,
    setIssueState: issuesSeam.setIssueState,
    commentOnIssue: issuesSeam.commentOnIssue,
    draftIssueComment: issuesSeam.draftIssueComment,
    editIssueComment: issuesSeam.editIssueComment,
    deleteIssueComment: issuesSeam.deleteIssueComment,
    listLandings: landingsSeam.listLandings,
    viewLanding: landingsSeam.viewLanding,
    setLandingTab: landingsSeam.setTab,
    reviewLanding: landingsSeam.reviewLanding,
    showBillingPlans: billingSeam.showBillingPlans,
    startCheckout: billingSeam.startCheckout,
    openBillingPortal: billingSeam.openBillingPortal,
    ...repositoryUpdate,
    viewEnvironment: async () => installSeam.showSettings(),
    setEnvironmentVar: async () => installSeam.showSettings(),
    removeSubscriptionToken: async () => installSeam.showSettings(),
    listSecrets: secretsSeam.listSecrets,
    scopeSecret: secretsSeam.scopeSecret,
    bindSecret: secretsSeam.bindSecret,
    setSecret: secretsSeam.setSecret,
    deleteSecret: secretsSeam.deleteSecret,
    showStack: stackSeam.showStack,
    bootstrapStack: stackSeam.bootstrapStack,
    setStackParallel: stackSeam.setStackParallel,
    retryStackItem: stackSeam.retryStackItem,
    newTodo: todoSeam.newTodo,
    newFlowSourceTodo: todoSeam.newFlowSourceTodo,
    showTodo: todoSeam.showTodo,
    readFlowSource,
    preapproveTodo: todoSeam.preapproveTodo,
    mergeTodo: todoSeam.mergeTodo,
    reviewTodoMerge: todoSeam.reviewMerge,
    todoRoute: todoSeam.todoRoute,
    dismissTodoDraft: todoSeam.dismissTodoDraft,
    answerTodo: todoSeam.answerTodo,
    steerTodo: todoSeam.steerTodo,
    amendTodo: todoSeam.amendTodo,
    draftImagePackage: todoSeam.draftImagePackage,
    bringIn: todoSeam.bringIn,
    discardForeign: todoSeam.discardForeign,
    controlTodo: todoSeam.controlTodo,
    openProposal: proposalSeam.openProposal,
    resolveProposal: proposalSeam.resolveProposal,
    moveTodo: todoSeam.moveTodo,
    refreshWiki: stackSeam.refreshWiki,
    registerTrigger,
    importRepository: repoImportSeam.importRepository,
    retryImport: repoImportSeam.retryImport,
    listBookmarks: async () => { earlierHistory.load(); return bookmarksSeam.listBookmarks() },
    branchFiles: filesSeam.branchFiles,
    listFiles: filesSeam.listFiles,
    ...diffFilesSeam,
    // Before branch providers are composed, read from the authenticated mirror.
    // An absent live-branch scope must not disable Source-ready file cards.
    readFile: installHost && branchFileOptions !== undefined ? (path, branch, anchor, ref) => ref === undefined && filesSeam.branchFiles.available() ? filesSeam.branchFiles.open(path, branch, anchor?.line) : filesSeam.readFile(path, branch, anchor, ref) : filesSeam.readFile,
    codeIntelligenceAvailable: () => services.daemonLsp?.ready() === true,
    codeHover,
    codeDefinition,
    codeDiagnostics,
    showMoreSyncOps: async (cardId) => {
      const card = store.collections.cards.get(cardId)
      if (card?.kind !== "sync-ops") return
      store.dispatch({ type: "card.upsert", actor: ctx.commandActor, card: { ...card, payload: { ...card.payload, expanded: true } } })
    },
    githubApp: gitHubSeam.app,
    githubChooseInstallation: gitHubSeam.chooseInstallation,
    githubOpenInstall: gitHubSeam.openInstall,
    githubReconcile: gitHubSeam.reconcile,
    retryGitHubSync: gitHubSyncRetry.retry,
    retryMirrorRef: gitHubSeam.retryMirrorRef,
    githubMirrorSync: gitHubSeam.mirrorSync,
    loadCloudSession,
    signInCloud,
    signOutCloud: cloudSeam.signOut,
    loadRepositories: repositoriesSeam.loadRepositories,
    listWorkspaces: workspaceSeam.listWorkspaces,
    openWorkspace: workspaceSeam.openWorkspace,
    viewWorkspace: workspaceSeam.viewWorkspace,
    openWorkspaceTerminal: workspaceSeam.openTerminal,
    suspendWorkspace: workspaceSeam.suspendWorkspace,
    resumeWorkspace: workspaceSeam.resumeWorkspace,
    listWorkspaceSessions: workspaceSeam.listSessions,
    destroyWorkspaceSession: workspaceSeam.destroySession,
    deleteWorkspace: workspaceSeam.deleteWorkspace,
    setWorkspaceFacet: workspaceSeam.setFacet,
    listWorkspaceFiles: workspaceSeam.listFiles,
    readWorkspaceFile: workspaceSeam.readFile,
    listWorkspaceServices: workspaceSeam.listServices,
    listWorkspaceEgress: workspaceSeam.listEgress,
    activeRepository: () => activeRepositoryId(store),
    listEnvironmentImages: workspaceSeam.listEnvironmentImages,
    listSessionEgress: egressSeam.listSessionEgress,
    allowEgressHost: egressSeam.allowEgressHost,
    viewChange: changeSeam.viewChange,
    diffChange: installHost ? branch => diffFilesSeam.branchDiff(branch) : changeSeam.diffChange,
    resolveChangeConflict: changeSeam.resolveConflict,
    setChangeFacet: changeSeam.setFacet,
    setChangePins: changeSeam.setPins,
    checksOfChangeAt: changeSeam.checksAt,
    diffSinceMyReview: changeSeam.sinceMyReview,
    reviewThreadDone: changeSeam.threadDone,
    reviewThreadAck: changeSeam.threadAck,
    reviewThreadReopen: changeSeam.threadReopen,
    fixFinding: changeSeam.pleaseFix,
    findingNotUseful: changeSeam.notUseful,
    requestChangeReview: changeSeam.requestReview,
    unrequestChangeReview: changeSeam.unrequestReview,
    dismissToast,
    refreshBalance,
    showBalance: () => showHostedBalance(store, refreshBalance, services.bootstrap?.capabilities.includes("billing.balance") === true),
    snapshot: (repo, path) => {
      const identity = store.collections.identitySessions.get("identity")
      const signedIn = identity?.state === "signed-in"
      const fileTarget = path === undefined ? undefined : resolveFileTarget(store, path, repo)
      const requestedRepo = fileTarget !== undefined && "kind" in fileTarget && fileTarget.kind === "cloud" ? fileTarget.repo : repo
      const routeEntry = store.session().repositoryEntry
      const globalRepo = repo === undefined && requestedRepo !== undefined && path !== undefined && (
        path.toLowerCase() === `/${requestedRepo.toLowerCase()}` || path.toLowerCase().startsWith(`/${requestedRepo.toLowerCase()}/`)
      ) ? requestedRepo : undefined
      const explicitRepo = repo ?? globalRepo
      const commandEntry = store.session().repositoryCommandEntry
      const routeMatches = routeEntry != null && (explicitRepo === undefined || explicitRepo.toLowerCase() === routeEntry.repo.toLowerCase())
      const commandMatches = commandEntry !== undefined && explicitRepo?.toLowerCase() === commandEntry.repo.toLowerCase() &&
        commandEntry.owner === ctx.accountOwner()
      const entry = routeMatches ? routeEntry : commandMatches ? commandEntry : undefined
      const scope = routeMatches ? undefined : "command" as const
      const knownPublic = requestedRepo !== undefined && [...store.collections.repositories.values()].some(row => row.catalog === true && row.id.toLowerCase() === requestedRepo.toLowerCase())
      const coldExplicitTarget = identity?.state === "signed-out" && explicitRepo !== undefined && /^[\w.-]+\/[\w.-]+$/.test(explicitRepo) &&
        !knownPublic && entry === undefined
      const needsCatalog = entry?.phase === "pending" || (entry?.phase === "failed" && entry.failureKind !== "not-public")
      const repositoryReadiness = entry !== undefined && needsCatalog
        ? { repo: entry.repo, phase: entry.phase === "pending" ? "pending" as const : "unavailable" as const, error: entry.error, scope }
        : coldExplicitTarget ? { repo: explicitRepo, phase: "unrequested" as const, scope: "command" as const } : undefined
      const catalogRefused = entry?.phase === "failed" && entry.failureKind === "not-public" && (
        requestedRepo === undefined || requestedRepo.toLowerCase() === entry.repo.toLowerCase()
      )
      const roster = membersSeam.snapshots.get()
      const viewer = roster.model?.members.find(member => member.login.toLowerCase() === identity?.login?.toLowerCase())
      return {
        repositoryReadiness,
        viewerRole: installHost ? identity?.state === "signed-in" && roster.error === undefined && viewer?.suspended === false && viewer.needs_access === false ? viewer.role : undefined : membersRole(),
        surface: store.session().surface,
        typing: store.session().phase === "responding",
        // Sign-in IS the GitHub connector (§2a′): a valid session means
        // work IS connected, so "connect" stops leading the next actions.
        hasConnectors: signedIn || [...store.collections.connectors.values()].length > 0,
        admin: adminSession(),
        signedOut: identity?.state === "signed-out",
        // The Worker's spending routes sit behind its own identity seam; the
        // local host spends the operator's key and asks nobody.
        hostSpendsOwnKey: services.bootstrap?.host === "cloud" && hasCapability(services.bootstrap, "identity"),
        /*
         * First run has not finished choosing its target: a bare command waits
         * for it. The whole decision counts, not just the identity read — the
         * signed-out row persists first and the selection lands after it, and a
         * command typed in that gap would otherwise be asked to name a
         * repository. "unavailable" and "signed-in" are answers that lead to no
         * first-run selection, so they never wait.
         */
        firstRunTargetPending: !firstRunTargetSettled && repo === undefined &&
          store.session().activeRepoKey == null && routeEntry == null &&
          (identity === undefined || identity.state === "unknown" || identity.state === "signed-out"),
        publicRepo: !catalogRefused && (requestedRepo === undefined
          ? activeCatalogRepositoryId(store) !== null
          : [...store.collections.repositories.values()].some(row => row.catalog === true && row.id.toLowerCase() === requestedRepo.toLowerCase())),
        recent: store.session().recentCommands ?? [],
        maximizedCardId: store.session().maximizedCardId ?? null,
        identity: identity === undefined
          ? "unknown"
          : identity.state === "signed-in"
          ? `signed-in as ${identity.login ?? "?"}`
          : identity.state
      }
    }
  }
  const registry = createCommandRegistry(commandActions, actors.select(commandActions), createCommandIntentLifecycle(ctx, () => {
  }, inputMode.setInputMode, prepareWorldDocument), (id, revision) => {
    const message = store.collections.messages.get(id)
    if (!message?.action || message.answeredAction || message.action.revision !== revision) return undefined
    return { name: message.action.flow, ...(message.action.args === undefined ? {} : { args: message.action.args }) }
  })
  /*
   * The user's one door (slash, button, pill, form submit) also answers the
   * standing recommendation: the recommender reports the dispatched flow as
   * its outcome before the flow runs. The agent's doors never pass here.
   */
  const commands: CommandRegistry = {
    ...registry,
    run: async (name, args, source, originCardId) => {
      if (ctx.disposed) return { status: "failed", error: "The controller is closed." }
      try {
        return await registry.run(name, args, source, originCardId)
      } catch (error) {
        /*
         * The floor under the person's door. A handler's throw is classified
         * at the flow boundary, but the steps AROUND it — the durable command
         * record, the private staging of their edit, the trace — are outside
         * every flow, and a throw from there used to leave this promise
         * rejected: `void run(…).then(…)` with no catch, so the control
         * snapped back, nothing was said, and the reason went to an
         * `unhandledrejection` handler that reports to maintainers. No gesture
         * leaves here without an outcome, and a bug says it is a bug.
         */
        ctx.failures.report("command.boundary", error, name)
        return { status: "failed", error: lostActRefusal(error), writeRefused: true }
      }
    }
  }
  ctx.commands = commands
  if (typeof document !== "undefined") ctx.onDispose(bindFlowPreloading(document, commands.preload!))
  ctx.onDispose(() => disposePreparedViews(store))
  for (const collection of [store.collections.identitySessions, store.collections.cloudWorkspaces, store.collections.changes, store.collections.repositories]) {
    const subscription = collection.subscribeChanges(() => invalidatePreparedViews(store))
    ctx.onDispose(() => subscription.unsubscribe())
  }
  for (const card of store.collections.cards.values()) {
    if (card.loading) store.dispatch({ type: "card.upsert", actor: "system", card: { ...card, loading: false, status: "error", body: "Loading was interrupted. Open this view again to retry." } })
  }

  gitHubSyncRetry.resume()
  triggersSeam.resumePauses()
  triggersSeam.resumePreparations()
  repoImportSeam.resume()
  secretsSeam.resumeSecretRequests()
  egressSeam.resumeEgressRequests()
  proposalSeam.resumeProposals()
  if (installHost) branchMutations.resume()
  todoSeam.resumeTodos()
  stackSeam.resumeStacks()
  workflowController.resumeWorkflowRequests()
  /*
   * Persisted model, repository and approval reads reconnect from the identity answer,
   * never from construction: every boot adopts or probes the session, and a read started
   * before that answer would only be superseded by it.
   */
  const setupIdentitySubscription = store.collections.identitySessions.subscribeChanges(() => {
    queueMicrotask(() => { if (!ctx.disposed) { conversationHistory.resume(); triggersSeam.resumePauses(); triggersSeam.resumePreparations() } })
    queueMicrotask(() => { if (!ctx.disposed) { secretsSeam.resumeSecretRequests(); egressSeam.resumeEgressRequests(); proposalSeam.resumeProposals() } })
    if (installHost) branchMutations.resume()
    workflowController.resumeWorkflowRequests()
    gitHubSyncRetry.resume()
    // Catalog recovery writes a card; leave the identity projection before dispatching it.
    repositoryReadiness.resume()
    repoImportSeam.resume()
    runs.resumeApprovalRequests()
    runs.resumeRunFacetRequests()
    runs.settleRunSignalRequests()
    runs.resumeRunListRequests()
    runs.resumeRunOpenRequests()
  })
  ctx.onDispose(() => setupIdentitySubscription.unsubscribe())
  const importCloudSubscription = store.collections.cloudSessions.subscribeChanges(() => {
    repoImportSeam.resume()
    queueMicrotask(() => { if (!ctx.disposed) { secretsSeam.resumeSecretRequests(); egressSeam.resumeEgressRequests(); proposalSeam.resumeProposals() } })
  })
  ctx.onDispose(() => importCloudSubscription.unsubscribe())
  if (!sharedPrompts) subscribeToAgent()
  conversationHistory.resume()
  if (!sharedPrompts) promptQueue.subscribe()
  observeBackgroundWork(ctx)
  // Material transitions regenerate the next-step pills through the `recommend` flow.
  // The active repository's flow catalog, read now and on every change of target, so its leaves are in the registry.
  issuesSeam.subscribe(ctx.onDispose)
  repositoryFlowsSeam.subscribe(ctx.onDispose)
  watchIdentityAcrossTabs()
  // Cmd+T / Cmd+W / Cmd+1..9 on the document, released with the controller.
  /* Control focus: surface detection and the dismissal swallow ride window capture. */
  const controlFocus = createControlFocus(typeof document === "undefined" ? undefined : document)
  ctx.onDispose(controlFocus.dispose)
  // One completion identity, including for a reentrant close from a resource.
  // The scope stops pumps, then releases consumers before their hosts.
  const dispose = ctx.dispose

  const submitCommand: AppController["submitCommand"] = async submission => {
    const early = privacyActions.before({ name: submission.name, actor: submission.actor === "agent" ? "smithers" : submission.actor, source: "form" }, undefined, submission.payload)
    if (early !== undefined) return early
    const saidBefore = latestOrdinal(store.collections)
    const outcome = await commands.submit(submission).catch(() => ({ status: "failed" as const, error: "Submission failed" }))
    if (!ctx.disposed) surfaceCommandFailure(submission.name, outcome, saidBefore)
    return outcome
  }

  const beginCommand = (name: string, args?: string, originCardId?: string): { readonly accepted: boolean; readonly result: Promise<CommandOutcome> } => {
    if (ctx.disposed) return { accepted: false, result: Promise.resolve({ status: "failed", error: "The controller is closed." }) }
    const early = privacyActions.before({ name, actor: "user", source: "command" }, args)
    if (early !== undefined) return { accepted: true, result: Promise.resolve(early) }
    if (commands.find(name) === undefined) {
      const key = `command.unavailable.${name}`
      store.dispatch({ type: "toast.shown", actor: "system", key, title: "This action is no longer available" })
      resolveToast(key, { status: "failed", detail: "This action is no longer available" })
      return { accepted: false, result: Promise.resolve({ status: "unknown-command" }) }
    }
    /* Everything the door says from here on belongs to this press (controller/spokenLines.ts). */
    const saidBefore = latestOrdinal(store.collections)
    const result = commands.run(name, args, undefined, originCardId).then((outcome) => {
      if (!ctx.disposed) surfaceCommandFailure(name, outcome, saidBefore)
      return outcome
    })
    return { accepted: true, result }
  }
  const runCommand: AppController["runCommand"] = (name, args, originCardId) => beginCommand(name, args, originCardId).accepted
  const runCommandForResult: AppController["runCommandForResult"] = (name, args, originCardId) => beginCommand(name, args, originCardId).result

  /*
   * The public controller IS the command surface: one map feeds the registry
   * and the UI, so a binding cannot drift between the two doors. Only the
   * composition root's own members join here; the registry's state read stays
   * internal to it.
   */
  const { snapshot: _snapshot, ...sharedActions } = commandActions
  return {
    ...sharedActions,
    fileDocuments,
    store,
    privacyNotices: privacyActions.notices,
    controlFocus,
    formFocus,
    storageRecoveryState,
    features,
    nativeAgentAvailable: agent.available,
    tappedFetch: http,
    installSnapshots: installSeam.snapshots,
    membersRoster,
    membersRole,
    secretsProviders,
    flowCatalog: installHost ? flowsSeam.snapshots : undefined,
    homeView,
    sharedConversation,
    todoList: todoSeam.list,
    githubSyncSnapshots: gitHubSyncSeam.snapshots,
    externalSession: externalSessionSeam.session,
    timelineTitles: timelineTitleSeam.ask,
    contextLine: answerId => contextAvailable() ? services.contextLine?.(answerId) : undefined,
    design,
    live: services.live,
    presentCard,
    runMonitors,
    openRunMonitor,
    listRunMonitors,
    setRunView,
    contextRun,
    presentRun,
    presentFlow,
    presentBranchCard,
    stackSnapshots: stackSeam.snapshots,
    wikiIndexes,
    wikiAttachments,
    commands,
    slashItems: (needle) => commands.slashItems(needle),
    slashTree: (needle) => commands.slashTree(needle),
    runCommand,
    runCommandForResult,
    submitCommand,
    dispose
  }
}
