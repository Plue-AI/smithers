import { identityProviderFor, ownerCredentials, signInByHandoff } from "./IdentityProvider"
import type { IdentityProvider } from "./IdentityProvider"
import type { ClientErrorReporter } from "./ClientErrors"
import type { FlowSubmission } from "../flows/Commands"
import { createRepositoryReadiness } from "./controller/repositoryReadiness"
import { lostActRefusal } from "./BrowserWriteFailure"
import { openRequestedRepo } from "../RepoLink"
import type { AppBootstrap } from "@smthrs/rpc/AppBootstrap"
import { hasCapability } from "@smthrs/rpc/AppBootstrap"
import type { ApplicationTarget } from "@smthrs/rpc/ApplicationTarget"
import { APPLICATION_SIGN_IN_PATH } from "@smthrs/rpc/ApplicationAuth"
import { AUTH_SIGN_IN_PATH } from "@smthrs/rpc/AgentApiRoutes"
import type { FetchLike } from "@smthrs/rpc/NativeAgent"
import type { MarkdownEditorHandle } from "@smthrs/ui/adapters/markdown-editor"
import type { CatalogItem,CommandRegistry } from "../flows/Commands"
import { createCommandRegistry } from "../flows/Commands"
import { bindFlowPreloading } from "../flows/FlowAction"
import type { CommandActions } from "../flows/Flows"
import type { RepositoryFlowCatalog } from "../flows/entries/flow"
import type { SlashItem,SlashRow } from "../flows/registry"
import { flowRequirements } from "../flows/registry"

import type { AgentPort } from "../runtime/AgentPort"
import type { ApplicationIdentityClient, LocalIdentityClient } from "../runtime/ApplicationClient"
import type { FrameHistoryPort } from "../runtime/FrameHistory"
import { localSocketProtocols } from "../runtime/LocalSession"
import { createActorBindings } from "./ActorBindings"
import type { AppTransition } from "./AppState"
import { DEFAULT_BRANCH_ID, DEFAULT_WORKSPACE_ID, MAIN_TAB_ID, rootFrameId } from "./AppState"
import type { AppStore } from "./AppStore"
import { createCloudLspClient,pageCloudLspSocketUrl } from "./CloudLspClient"
import type { CloudTerminalClient } from "./CloudTerminalClient"
import { createCloudTerminalClient,pageCloudSocketUrl } from "./CloudTerminalClient"
import { selectFirstRunRepository } from "./FirstRunRepository"
import type { InputMode } from "./InputMode"
import { knowledgeCardAvailable } from "./KnowledgeFeatures"
import { disposePreparedViews,invalidatePreparedViews } from "./PreparedView"
import type { KnownRepositories } from "./RepoContext"
import { activeCatalogRepositoryId,activeRepositoryId,knownRepositories,resolveTargetRepo } from "./RepoContext"
import type { StorageRecoveryAction,StorageRecoveryHost } from "./StorageRecoveryAction"
import { createLocalAuthController } from "./LocalAuth"
import type { LocalAuthController } from "./LocalAuth"
import type { AccountController } from "./controller/account"
import { createAccountController } from "./controller/account"
import { createSignupController, type SignupController } from "./controller/signup"
import type { AgentsController } from "./controller/agents"
import { createAgentsController } from "./controller/agents"
import type { AppShellController } from "./controller/app"
import { createAppShellController } from "./controller/app"
import { createAuthBillingController } from "./controller/auth-billing"
import { createCloudWikiController } from "./controller/cloud-wiki"
import type { CommandGesture } from "../flows/CommandGesture"
import type { WikiSpace } from "../wiki/CloudWiki"
import type { WikiIndexStore } from "./controller/cloud-wiki"
import { createCommandIntentLifecycle } from "./controller/commandIntents"
import { createPrivacyActions, PRIVACY_WRITE_PENDING, PRIVACY_WRITE_FAILED } from "./controller/privacyActions"
import { createConnectorController } from "./controller/connectors"
import type { NetEntry } from "./controller/context"
import { createControllerContext } from "./controller/context"
import type { ControlFocusController } from "./controller/controlFocus"
import { createControlFocus } from "./controller/controlFocus"
import { createDictation } from "./controller/dictation"
import type { ExplainConfig,ExplainController } from "./controller/explain"
import { createExplainController } from "./controller/explain"
import { createFailureController,humanCommandText } from "./controller/failures"
import type { FormFocusHandoff, FormsController } from "./controller/forms"
import { createFormsController } from "./controller/forms"
import { createFramesController } from "./controller/frames"
import { createHealthStatusController } from "./controller/health-status"
import { createInputModeController } from "./controller/inputMode"
import { createIssueFlowsController,type IssueFlowsController } from "./controller/issueFlows"
import { createRepositorySetupController, type RepositorySetupController } from "./controller/repositorySetup"
import { createModelCallController, type ModelCallController } from "./controller/modelCall"
import { createModelsController,type ModelsController } from "./controller/models"
import type { OnboardingController } from "./controller/onboarding"
import { createOnboardingController } from "./controller/onboarding"
import { createRegistrationController, type RegistrationController } from "./controller/registration"
import { createPluginsController } from "./controller/plugins"
import { createPresentationController } from "./controller/presentation"
import type { RecommenderConfig } from "./controller/recommend"
import { createRecommendController } from "./controller/recommend"
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
import { createPromptQueueController } from "./controller/promptQueue"
import { createTurnController, type TurnController } from "./controller/turns"
import { createTutorialChangeController,type TutorialChangeController } from "./controller/tutorialChange"
import { createTutorialRepositoryController,type TutorialRepositoryActions } from "./controller/tutorialRepository"
import { createFlowDurationsReader } from "./controller/flowDurations"
import { createWorkflowPumpController } from "./controller/workflow-pump"
import { createWorkflowController,type WorkflowController } from "./controller/workflows"
import type { WikiEditorHandle } from "./controller/world"
import { createWorldController } from "./controller/world"
import type { AgentSessionSeam } from "./seams/AgentSessionSeam"
import { createAgentSessionSeam } from "./seams/AgentSessionSeam"
import type { BillingSeam } from "./seams/BillingSeam"
import { createBillingSeam } from "./seams/BillingSeam"
import type { BookmarksSeam } from "./seams/BookmarksSeam"
import { createBookmarksSeam } from "./seams/BookmarksSeam"
import type { ChangeSeam } from "./seams/ChangeSeam"
import { createChangeSeam } from "./seams/ChangeSeam"
import type { CloudSeam } from "./seams/CloudSeam"
import { createCloudSeam } from "./seams/CloudSeam"
import type { CodeIntelSeam } from "./seams/CodeIntelSeam"
import { createCodeIntelSeam } from "./seams/CodeIntelSeam"
import type { CommitsSeam } from "./seams/CommitsSeam"
import { createCommitsSeam } from "./seams/CommitsSeam"
import { createDiffFilesSeam } from "./seams/DiffFilesSeam"
import type { EgressSeam } from "./seams/EgressSeam"
import { createEgressSeam } from "./seams/EgressSeam"
import type { EnvironmentSeam } from "./seams/EnvironmentSeam"
import { createEnvironmentSeam } from "./seams/EnvironmentSeam"
import type { FilesSeam } from "./seams/FilesSeam"
import { createFilesSeam, resolveFileTarget } from "./seams/FilesSeam"
import type { GitHubSeam } from "./seams/GitHubSeam"
import { createGitHubSeam } from "./seams/GitHubSeam"
import type { IssuesSeam } from "./seams/IssuesSeam"
import { createIssuesSeam } from "./seams/IssuesSeam"
import { createIntegrationsSeam, type IntegrationsSeam } from "./seams/IntegrationsSeam"
import type { LandingsSeam } from "./seams/LandingsSeam"
import { createLandingsSeam } from "./seams/LandingsSeam"
import type { NotificationsSeam } from "./seams/NotificationsSeam"
import { createNotificationsSeam } from "./seams/NotificationsSeam"
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
import type { StackSeam } from "./seams/StackSeam"
import { createStackSeam } from "./seams/StackSeam"
import type { TriggersSeam } from "./seams/TriggersSeam"
import { createTriggersSeam } from "./seams/TriggersSeam"
import type { WorkspaceSeam } from "./seams/WorkspaceSeam"
import { createWorkspaceSeam } from "./seams/WorkspaceSeam"

export interface AppController extends TutorialChangeController, IssueFlowsController, RepositorySetupController {
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
  readonly downloadUrl: string | null
  /** The resolved feature flags (every flag defaults off). */
  readonly features: Required<AppFeatures>
  readonly nativeAgentAvailable: boolean
  /** The command registry: every interactive affordance routes through it. */
  readonly dismissFirstRun: () => void
  readonly dismissHint: (id: string) => void
  /** The signup onboarding's doors (controller/signup.ts). */
  readonly signupChange: SignupController["signupChange"]
  readonly signupSet: SignupController["signupSet"]
  readonly signupAccount: SignupController["signupAccount"]
  readonly signupAnswer: SignupController["signupAnswer"]
  readonly signupNext: SignupController["signupNext"]
  readonly signupBack: SignupController["signupBack"]
  readonly signupRepo: SignupController["signupRepo"]
  readonly signupFinish: SignupController["signupFinish"]
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
  readonly resumePromptQueue: () => void
  readonly showChat: () => void
  readonly showWorld: () => void
  /** The Wiki pane beside the chat (#1922): toggles, and reads the shown space's index on opening. */
  readonly showWikiPane: () => void
  readonly showConnectors: () => void
  /** The Library: the plugin shelf this workspace browses and installs from. */
  readonly showPlugins: () => void
  readonly installPlugin: (id: string) => string | void
  readonly removePlugin: (id: string) => string | void
  readonly listPlugins: () => { readonly value: string }
  readonly askReset: () => void
  readonly cancelReset: () => void
  readonly submitCommand: (submission: FlowSubmission) => Promise<import("../flows/Commands").CommandOutcome>
  readonly runCommand: (name: string, args?: string, originCardId?: string) => boolean
  readonly makeConnectorReadOnly: (id: string) => string | void
  readonly askConnectorRemoval: (id: string) => string | void
  readonly cancelConnectorRemoval: () => void
  readonly removeConnector: (id: string) => string | void
  readonly selectWorldDocument: (id: string) => string | void
  readonly changeWorldDocument: (id: string, body: string) => Promise<string | void>
  readonly listCloudWiki: (repo: string, page?: number, space?: WikiSpace) => Promise<string | { value: string }>
  readonly openCloudWiki: (repo: string, slug: string, expectedPageId?: number, space?: WikiSpace) => Promise<string | { value: string }>
  readonly retryCloudWiki: (id: string) => Promise<string | void | { value: string }>
  /** The Wiki spaces (#1922): the switch, the space's navigation index, a page's history, and the writes the pane offers. */
  readonly setWikiSpace: (space: string, repo?: string) => Promise<string | void>
  readonly setWikiPageView: (view: string) => Promise<string | void>
  readonly loadWikiIndex: (repo?: string, space?: WikiSpace, quiet?: boolean) => Promise<string | { value: string }>
  readonly showWikiHistory: (slug: string, repo?: string, page?: number) => Promise<string | void | { value: string }>
  readonly createCloudWikiPage: (title: string, repo?: string) => Promise<string | void | { value: string }>
  readonly renameCloudWikiPage: (slug: string, path: string, repo?: string) => Promise<string | void>
  readonly deleteCloudWikiPage: (slug: string, repo?: string) => Promise<string | void>
  readonly attachCloudWiki: (slug: string, path: string, repo: string | undefined, gesture?: CommandGesture) => Promise<string | void | { value: string }>
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
  /** The guide shell reports mount ownership; this is a system observation, not a user command. */
  readonly toggleTheme: () => void
  /** Wear a color theme (/theme) — the axis orthogonal to light/dark. */
  readonly setPalette: (args: string) => string | void
  /** Archive locally and start fresh; model-generated notes are opt-in. */
  readonly clearConversation: (options?: { readonly summarize?: boolean }) => Promise<string | void>
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
  readonly runWorkflow: (name: string, repo?: string, input?: Record<string, unknown>, sourceCard?: string) => Promise<string | void | { readonly value: string }>
  /** What a flow WOULD run (flow.plan). */
  readonly planFlow: WorkflowController["planFlow"]
  /** change.request: a coding/request that lands through coding/vibe once validated. */
  readonly requestChange: WorkflowController["requestChange"]
  /* Wave 12 §2 — the answer to "which loaded repository?" (one act). */
  readonly chooseWorkflowRepo: (fullName: string) => Promise<string | void | { readonly value: string }>
  /* Wave 12 §3 — the two acts a run that has gone quiet offers. */
  readonly stopWatchingRun: (cardId: string, reason?: string) => string | void
  readonly retryRunWatch: (cardId: string) => string | void
  /** Boot reconciliation: resume the event pump for any run card still live. */
  readonly resumeWorkflowRuns: () => void
  /* Lane runs — the run lifecycle beyond launch (see controller/runs.ts). */
  readonly listRuns: RunsController["listRuns"]
  readonly prepareRunHandoff: RunsController["prepareRunHandoff"]
  readonly openRun: RunsController["openRun"]
  readonly resumeRun: RunsController["resumeRun"]
  readonly rerunRun: RunsController["rerunRun"]
  readonly signalRun: RunsController["signalRun"]
  readonly steerRun: RunsController["steerRun"]
  readonly steerRunSeat: RunsController["steerRunSeat"]
  readonly steerRunThinking: RunsController["steerRunThinking"]
  readonly steerRunTools: RunsController["steerRunTools"]
  readonly showRunLogs: RunsController["showRunLogs"]
  readonly showRunSteps: RunsController["showRunSteps"]
  readonly showRunEvents: RunsController["showRunEvents"]
  readonly traceFilter: RunsController["traceFilter"]
  readonly traceSelect: RunsController["traceSelect"]
  readonly selectCodingChange: RunsController["selectCodingChange"]
  readonly traceView: RunsController["traceView"]
  readonly graphFollow: RunsController["graphFollow"]
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
  readonly forkFrame: () => Promise<string | void>
  /* The card tabs (docs/LOCAL-APP.md "Cards"); see controller/tabs.ts. */
  readonly openCardTab: TabsController["openCardTab"]
  readonly selectTab: TabsController["selectTab"]
  readonly closeTab: TabsController["closeTab"]
  /* Tutorial stage 2: the ranked chooser and the local Skip. */
  readonly chooseTutorialRepository: TutorialRepositoryActions["chooseTutorialRepository"]
  readonly createTutorialRepository: TutorialRepositoryActions["createTutorialRepository"]
  readonly selectRepo: TabsController["selectRepo"]
  /* The sidebar's file tree and workspace heading (docs/workbench-lanes/sidebar-tree.md); see controller/sidebar.ts. */
  readonly toggleRepoTree: SidebarController["toggleRepoTree"]
  readonly renameWorkspace: SidebarController["renameWorkspace"]
  readonly toggleWorkspaceRename: SidebarController["toggleWorkspaceRename"]
  /* Agents as data (docs/workbench-lanes/custom-agents.md); see controller/agents.ts. */
  readonly listAgents: AgentsController["listAgents"]
  /* THE FORM LAW (apps/app/AGENTS.md): the flow-form card's render, field commits, submit, and dismiss; see controller/forms.ts. */
  readonly renderFlowForm: FormsController["renderFlowForm"]
  readonly setFormField: FormsController["setFormField"]
  readonly submitForm: FormsController["submitForm"]
  readonly dismissCard: FormsController["dismissCard"]
  /* Configured models and the seats they fill; see controller/models.ts. */
  readonly listModels: ModelsController["listModels"]
  readonly showModel: ModelsController["showModel"]
  readonly newModel: ModelsController["newModel"]
  readonly editModel: ModelsController["editModel"]
  readonly saveModel: ModelsController["saveModel"]
  readonly removeModel: ModelsController["removeModel"]
  readonly testModel: ModelsController["testModel"]
  readonly assignSeat: ModelsController["assignSeat"]
  readonly observeModels: ModelsController["observeModels"]
  /* The composer for one configured model; see controller/modelCall.ts. */
  readonly composeModel: ModelCallController["composeModel"]
  readonly askModel: ModelCallController["askModel"]
  readonly recallModel: ModelCallController["recallModel"]
  readonly setModelPrompt: ModelCallController["setModelPrompt"]
  readonly setModelField: ModelCallController["setModelField"]
  readonly setModelQuestion: ModelCallController["setModelQuestion"]
  readonly setModelOption: ModelCallController["setModelOption"]
  readonly fixtureModel: ModelCallController["fixtureModel"]
  /** Lane citc: the cloud-workspace terminal transport (one socket per workspace session). */
  readonly cloudTerminal: CloudTerminalClient
  /* The admin dev-tools panel + debug reads (§2b/§2d; admin registry only). */
  readonly toggleDevtools: () => void
  /** Report what drives a turn (admin /debug.backend; DESIGN.md §14). */
  readonly describeAgentBackend: (backend: string) => string | { readonly value: string }
  /* The composer surfaces menu — the /surfaces command's open state. */
  readonly toggleChatFilterMenu: () => { readonly value: string }
  readonly toggleChatFilter: (target: string) => string | { readonly value: string }
  readonly grepChatFilter: (query: string) => { readonly value: string }
  readonly resetChatFilter: () => { readonly value: string }
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
  /*
   * The composer connect menu's open state. Not a command — the chip is a
   * pointer affordance, not a registry entry — but the state is still the
   * store's, reached through the dispatcher with the actor recorded.
   */
  /** /files.add — attachments, or the honest answer that this host has none. */
  readonly addFiles: () => void
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
  readonly localAuth: LocalAuthController | undefined
  readonly signOut: () => Promise<string | void>
  readonly requestAccess: () => Promise<string | void>
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
  /** The `recommend` flow: regenerate the next-step pills for the current state (Recommend.ts). */
  readonly recommend: () => Promise<void>
  /** The `explain` flow: one side turn on the explainer role, answered as an embedded card (controller/explain.ts). */
  readonly explain: ExplainController["explain"]
  /** Render the full visible-flow catalog into the chat (the /chat.commands answer). */
  readonly showCommandCatalog: () => void
  /** Render the sign-in step into the chat (auth.prompt — the agent's door to login). */
  readonly promptSignIn: (required?: boolean, request?: { readonly name?: string; readonly args?: string | null; readonly summary?: string; readonly signInRequirement?: "cloud" }) => void
  /** Render the Smithers Cloud sign-in step into the chat (cloud.prompt — the agent's door to the cloud session). */
  readonly promptCloudSignIn: () => void
  /** Reload the app window — the /reload affordance (dev loop, stuck states). */
  readonly reloadApp: () => void
  /** Open the native app's download page (app.download — the web app's one door to the native app). */
  readonly openDownload: AppShellController["openDownload"]
  /** Render the native-only refusal card with the download action (app.download.prompt — the agent's door). */
  readonly promptDownload: AppShellController["promptDownload"]
  /** Render and return the identity line (smithers.who). */
  readonly introduce: AppShellController["introduce"]
  /** Render the account card, or the sign-in step signed out (account.show). */
  readonly showAccount: AccountController["showAccount"]
  readonly prototypeFeature: OnboardingController["prototypeFeature"]
  /** Register a repository (repository.register); a registered one replays its recorded run. */
  readonly registerRepository: RegistrationController["registerRepository"]
  /*
   * The multi-parity domain seams (MULTI-ACTIONS-GAP.md Tier 1/2): issues,
   * PRs/landings, billing checkout, notifications, the agent
   * environment, and repo import. One method per command; each seam owns its
   * backend domain in state/seams/*.
   */
  readonly listIssues: IssuesSeam["listIssues"]
  readonly viewIssue: IssuesSeam["viewIssue"]
  readonly createIssue: IssuesSeam["createIssue"]
  readonly setIssueState: IssuesSeam["setIssueState"]
  readonly draftIssueComment: IssuesSeam["draftIssueComment"]
  readonly retryIssueComment: IssuesSeam["retryIssueComment"]
  readonly reactToIssueComment: IssuesSeam["reactToIssueComment"]
  readonly resolveIssueSync: IssuesSeam["resolveIssueSync"]
  readonly mapIssueSync: IssuesSeam["mapIssueSync"]
  readonly editIssueComment: IssuesSeam["editIssueComment"]
  readonly deleteIssueComment: IssuesSeam["deleteIssueComment"]
  readonly commentOnIssue: IssuesSeam["commentOnIssue"]
  readonly listIntegrations: IntegrationsSeam["listIntegrations"]
  readonly listLandings: LandingsSeam["listLandings"]
  readonly viewLanding: LandingsSeam["viewLanding"]
  readonly setLandingTab: LandingsSeam["setTab"]
  readonly createLanding: LandingsSeam["createLanding"]
  readonly landLanding: LandingsSeam["landLanding"]
  readonly reviewLanding: LandingsSeam["reviewLanding"]
  readonly showBillingPlans: BillingSeam["showBillingPlans"]
  readonly startCheckout: BillingSeam["startCheckout"]
  readonly openBillingPortal: BillingSeam["openBillingPortal"]
  readonly listNotifications: NotificationsSeam["listNotifications"]
  readonly markNotificationsRead: NotificationsSeam["markNotificationsRead"]
  readonly viewEnvironment: EnvironmentSeam["viewEnvironment"]
  readonly setEnvironmentVar: EnvironmentSeam["setEnvironmentVar"]
  readonly removeSubscriptionToken: EnvironmentSeam["removeSubscriptionToken"]
  readonly connectCodingProvider: SecretsSeam["connectCodingProvider"]
  readonly listCodingProviders: SecretsSeam["listCodingProviders"]
  readonly revokeCodingProvider: SecretsSeam["revokeCodingProvider"]
  readonly connectCodex: SecretsSeam["connectCodex"]
  readonly moveCodingProvider: SecretsSeam["moveCodingProvider"]
  readonly listSecrets: SecretsSeam["listSecrets"]
  /* The mythical stack (#1745), the repository history (D-20): the History card, its admin writes, and the live snapshots its views read. */
  readonly showStack: StackSeam["showStack"]
  readonly bootstrapStack: StackSeam["bootstrapStack"]
  readonly backfillStack: StackSeam["backfillStack"]
  readonly setStackParallel: StackSeam["setStackParallel"]
  readonly retryStackItem: StackSeam["retryStackItem"]
  readonly refreshWiki: StackSeam["refreshWiki"]
  readonly stackSnapshots: StackSeam["snapshots"]
  readonly importRepository: RepoImportSeam["importRepository"]
  readonly retryImport: RepoImportSeam["retryImport"]
  readonly listBookmarks: BookmarksSeam["listBookmarks"]
  /** A branch's commits and one commit (seams/CommitsSeam.ts). */
  readonly listCommits: CommitsSeam["listCommits"]
  readonly readCommit: CommitsSeam["readCommit"]
  readonly listFiles: FilesSeam["listFiles"]
  readonly openDiffFile: ReturnType<typeof createDiffFilesSeam>["openDiffFile"]
  readonly readFile: FilesSeam["readFile"]
  /* Code intelligence (docs/code-intel/PLAN.md §4): the three code.* reads against the local language server (seams/CodeIntelSeam.ts). */
  readonly codeHover: CodeIntelSeam["hover"]
  readonly codeDefinition: CodeIntelSeam["definition"]
  readonly codeDiagnostics: CodeIntelSeam["diagnostics"]
  
  readonly showMoreSyncOps: (cardId: string) => Promise<string | void>
  readonly githubApp: GitHubSeam["app"]
  readonly githubChooseInstallation: GitHubSeam["chooseInstallation"]
  readonly githubOpenInstall: GitHubSeam["openInstall"]
  readonly githubReconcile: GitHubSeam["reconcile"]
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
  /* Lane L3b: the NixOS desktop and the environment images a repository has built. */
  readonly openWorkspaceDesktop: WorkspaceSeam["openDesktop"]
  readonly rotateWorkspaceDesktop: WorkspaceSeam["rotateDesktop"]
  /** `/desktop`: create-or-reuse the desktop box, wait for it, and stream it, under one confirm. */
  readonly openDesktopBox: WorkspaceSeam["openDesktopBox"]
  readonly stopDesktopWait: WorkspaceSeam["stopDesktopWait"]
  /** The repository the active selection names, for a flow that must BIND its target before it asks. */
  readonly activeRepository: () => string | null
  readonly listEnvironmentImages: WorkspaceSeam["listEnvironmentImages"]
  readonly listSessionEgress: EgressSeam["listSessionEgress"]
  /*
   * The cloud agent sessions (UI-COVERAGE-GAPS.md "agents · Cloud agent
   * sessions"): a Codex/Claude/Smithers agent run by Smithers Cloud in a
   * sandbox, on a repository — the web app's answer to a local harness tab.
   */
  readonly newAgentSession: AgentSessionSeam["newSession"]
  readonly listAgentSessions: AgentSessionSeam["listSessions"]
  readonly viewAgentSession: AgentSessionSeam["viewSession"]
  readonly sayToAgentSession: AgentSessionSeam["sayToSession"]
  readonly stopAgentSession: AgentSessionSeam["stopSession"]
  /*
   * Lane change (ADR 0003): the change is the unit — the change and diff
   * cards behind the `/api/cloud/*` proxy (state/seams/ChangeSeam.ts).
   */
  readonly viewChange: ChangeSeam["viewChange"]
  readonly diffChange: ChangeSeam["diffChange"]
  readonly landChange: ChangeSeam["landChange"]
  readonly splitReadyChange: ChangeSeam["splitReady"]
  readonly splitChange: ChangeSeam["splitChange"]
  readonly resolveChangeConflict: ChangeSeam["resolveConflict"]
  readonly revertChange: ChangeSeam["revertChange"]
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
  /* The admin plugin's controller half — registered as commands only for admin sessions. */
  readonly adminAllowlist: (action: "add" | "remove", login: string) => Promise<string | void>
  readonly adminGrant: (amountUsd: number, login: string) => string | void
  readonly adminGrantConfirm: (cardId: string) => Promise<string | void>
  readonly adminGrantCancel: (cardId: string) => string | void
  readonly adminRequests: () => Promise<string | void>
  readonly adminQueueApprove: (login: string) => Promise<string | void>
  readonly adminHealth: () => Promise<string | void>
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
  readonly clientErrors?: ClientErrorReporter
  /** Fence late observations as soon as the embedding page starts leaving. */
  readonly pageLifetime?: AbortSignal
  /** Trusted local handoff, injectable by the embedding host; never projected as a tool. */
  readonly storageRecoveryHost?: StorageRecoveryHost
  readonly fetchImpl?: FetchLike
  readonly applicationTarget?: ApplicationTarget
  readonly localIdentity?: LocalIdentityClient
  readonly localBootstrapToken?: () => Promise<string | undefined>
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
  /**
   * Lane L6: the `/api/cloud-ws/…/lsp` tunnel URL for one workspace
   * language-server session; default the page's own origin. Tests bind
   * `() => undefined` or a real local origin.
   */
  readonly cloudLspSocketUrl?: (repo: string, sessionId: string, language: string) => string | undefined
  readonly bootstrap?: AppBootstrap
  readonly repositoryApp?: string
  readonly frameHistory?: FrameHistoryPort
  readonly baseUrl?: string
  /** The toast debounce (the 300ms law); injectable so tests pin both sides of it. */
  readonly toastDebounceMs?: number
  /**
   * Open a URL in the system browser (the native shell's door). Present =
   * the sign-in handoff runs OAuth outside the webview, where passkeys
   * work; absent = pure web keeps the same-page navigation.
   */
  readonly openExternal?: (url: string) => Promise<boolean>
  /**
   * The native app's download URL, when the composition root knows one;
   * default the shared constant (AppLinks.ts), null until a release carries
   * an asset. Tests inject a URL to exercise the door, and null to prove it
   * is absent.
   */
  readonly downloadUrl?: string | null
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
   * The next-step recommender (Recommend.ts): whether it asks the server's
   * POST /api/recommend at all (off by default) and its debounce.
   */
  readonly recommender?: RecommenderConfig
  /** The explainer side turn's timeout (controller/explain.ts). */
  readonly explainer?: ExplainConfig
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
}

export interface AppFeatures {
  readonly pluginLibrary?: boolean
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
  const features: Required<AppFeatures> = {
    pluginLibrary: services.features?.pluginLibrary ?? false,
    suggestionPills: services.features?.suggestionPills ?? services.bootstrap?.host === "cloud"
  }
  if (!features.pluginLibrary && store.session().surface === "plugins") {
    store.dispatch({ type: "surface.changed", actor: "system", surface: "chat" })
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
      knowledgeCardAvailable(kind, features)
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
  const seamCtx: SeamContext = {
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
    checkout: services.bootstrap?.capabilities.includes("billing.checkout") ?? true
  }
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
  const issuesSeam = actors.pair(seamCtx, (context, select) => createIssuesSeam(context, request => select(renderFlowForm)(request)))
  /* The services that sync with conversations, issues and the wiki (smithers-ui-DESIGN.md §3.6). */
  const integrationsSeam = actors.pair(seamCtx, createIntegrationsSeam)
  const landingsSeam = actors.pair(seamCtx, (context, select) => createLandingsSeam(context, request => select(renderFlowForm)(request)))
  const repositoriesSeam = actors.pair(seamCtx, (context) => createRepositoriesSeam(context))
  const tutorialRepository = actors.pair(ctx, (context) => createTutorialRepositoryController(context, {
    createRepository: repositoriesSeam.createRepository,
    publish: async (payload) => {
      const id = "repository-choice"
      const existing = context.store.collections.cards.get(id)
      await context.store.dispatch({ type: "card.upsert", actor: context.commandActor, card: {
        id, kind: "repository-choice", title: "Repository", status: "active",
        createdAt: existing?.createdAt ?? Date.now(), ordinal: existing?.ordinal ?? store.nextOrdinal(),
        payload: { ...payload, repositories: [...payload.repositories] }
      } }).isPersisted.promise
    }
  }))
  const billingSeam = actors.pair(seamCtx, context => createBillingSeam(context, {
    overview: services.bootstrap?.capabilities.includes("billing.overview") ?? true,
    plans: services.bootstrap?.capabilities.includes("billing.plans") ?? true,
    checkout: services.bootstrap?.capabilities.includes("billing.checkout") ?? true,
    portal: services.bootstrap?.capabilities.includes("billing.portal") ?? true
  }, () => ctx.disposed))
  const repositoryUpdate = actors.pair(seamCtx, context => createRepositoryUpdate(context, () => ctx.disposed))
  const notificationsSeam = actors.pair(seamCtx, (context) => createNotificationsSeam(context))
  const environmentSeam = actors.pair(seamCtx, (context) => createEnvironmentSeam(context))
  const secretsSeam = actors.pair(seamCtx, (context) => createSecretsSeam(context, withToast))
  /* A registration is a launched flow run: it rides the app's own run watch and the shared toast stack. */
  const triggersSeam = actors.pair(seamCtx, (context, select) => createTriggersSeam(context, {
    requestRun: (repo, slug, operation) => select(workflowController).requestTriggerRun(repo, slug, operation),
    requestRegistration: (repo, request) => select(workflowController).requestTriggerRegistration(repo, request),
    withToast
  }))
  const repoImportSeam = actors.pair(seamCtx, (context) => createRepoImportSeam(context))
  const bookmarksSeam = actors.pair(seamCtx, (context) => createBookmarksSeam(context))
  const commitsSeam = actors.pair(seamCtx, (context) => createCommitsSeam(context))
  const diffFilesSeam = actors.pair(seamCtx, createDiffFilesSeam)
  const filesSeam = actors.pair(seamCtx, (context) => createFilesSeam(context))
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
  /* The cloud agent sessions; their transcript streams die with the controller. */
  const agentSessionSeam = actors.pair(seamCtx, (context) => createAgentSessionSeam(context))
  /*
   * The palette's seam reads the registry it is registered in: the thunk
   * resolves once `commands` exists below, and nothing calls it during
   * construction.
   */
  const searchSeam = actors.pair(seamCtx, (context, select) =>
    createSearchSeam(context, { registry: () => commands, refreshWorkspaces: select(workspaceSeam.refreshWorkspaces), readStack: select(stackSeam).readStack,
      heldStack: select(stackSeam).heldStack }))
  const egressSeam = actors.pair(seamCtx, (context) => createEgressSeam(context))
  ctx.onDispose(workspaceSeam.dispose)
  ctx.onDispose(agentSessionSeam.dispose)
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
  let localAuth: LocalAuthController | undefined
  const {
    handleAuthReturn,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    refreshBalance,
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
    settleTurnBilling,
    watchIdentityAcrossTabs
  } = actors.pair(ctx, (context) => createAuthBillingController(
    context,
    store.nextOrdinal,
    applicationIdentity === undefined && services.bootstrap !== undefined && hasCapability(services.bootstrap, "cloud")
      ? loadCloudSession
      : undefined,
    () => {
      if (localAuth === undefined) return false
      localAuth.open()
      return true
    },
    applicationIdentity === undefined
      ? undefined
      : {
        current: applicationIdentity.current,
        signInPath: signInByHandoff(services.bootstrap) ? AUTH_SIGN_IN_PATH : APPLICATION_SIGN_IN_PATH,
        settled: reloadRepositoriesWhenSignedIn
      }
  ))
  if (ownerCredentials(services) && services.localIdentity !== undefined) {
    localAuth = createLocalAuthController(services.localIdentity, loadSession, services.localBootstrapToken)
    ctx.onDispose(localAuth.dispose)
  }
  const { showPlugins, installPlugin, removePlugin, listPlugins } = actors.pair(ctx, createPluginsController)
  const { downloadUrl, openDownload, promptDownload, introduce } = actors.pair(ctx, (context) => createAppShellController(context))
  const { storageRecoveryState, promptStorageRecovery, exportStorageRecovery, resetStorageRecovery } = actors.pair(ctx, createStorageRecoveryController)

  const {
    showChat,
    showWorld,
    showWikiPane: togglePane,
    showConnectors,
    toggleDevtools,
    toggleChatFilterMenu,
    toggleChatFilter,
    grepChatFilter,
    resetChatFilter,
    addFiles,
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
    toggleTheme,
    setPalette
  } = actors.pair(ctx, (context, select) => createPresentationController(context, select(adminHealth)))

  const {
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame
  } = createFramesController(ctx, services.frameHistory)

  const {
    openCardTab: openCardTabOnly,
    selectTab,
    closeTab,
    selectRepo,
    installKeyboard
  } = actors.pair(ctx, (context) => createTabsController(context))
  const { renderFlowForm, setFormField, submitForm, dismissCard, focusHandoff: formFocus } = actors.pair(ctx, (context) => createFormsController(context, { nextOrdinal: store.nextOrdinal, minimizeCard }))
  const {
    listModels,
    showModel,
    newModel,
    editModel,
    saveModel,
    removeModel,
    testModel,
    assignSeat,
    credentialMissing,
    resumeModels,
    observeModels
  } = actors.pair(ctx, (context, select) => createModelsController(context, { nextOrdinal: store.nextOrdinal, renderFlowForm: select(renderFlowForm), minimizeCard }))
  const {
    composeModel,
    askModel,
    recallModel,
    setModelPrompt,
    setModelField,
    setModelQuestion,
    setModelOption,
    fixtureModel,
    resumeModelCalls
  } = actors.pair(ctx, (context) => createModelCallController(context, { nextOrdinal: store.nextOrdinal, minimizeCard }))
  const {
    listAgents,
  } = actors.pair(ctx, (context) => createAgentsController(context, { nextOrdinal: store.nextOrdinal }))
  const { toggleRepoTree, renameWorkspace, toggleWorkspaceRename } = actors.pair(ctx, (context, select) => createSidebarController(context, select(repoTreeSeam)))
  /*
   * "Open in tab" is offered on the maximized card, so opening the tab also
   * returns the transcript's copy to its embedded form — through the frames
   * controller, which moves the address bar back to the root frame. A bare
   * `card.minimized` dispatch left the URL at the maximized frame and a
   * reload restored the card maximized twice over.
   */
  const openCardTab: TabsController["openCardTab"] = (cardId) => {
    const wasMaximized = store.session().maximizedCardId === cardId
    const refusal = openCardTabOnly(cardId)
    if (refusal !== undefined) return refusal
    if (wasMaximized) minimizeCard()
  }
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
  /*
   * Lane L6: the workspace language-server transport (plue #505), one socket
   * per (workspace, language) through the same tunnel the cloud terminal
   * rides — so it exists exactly where that tunnel does (`cloud.terminal`);
   * elsewhere the seam tells a cloud file so instead of dialing nothing.
   */
  const createCloudLsp = services.bootstrap === undefined || services.bootstrap.capabilities.includes("cloud.terminal")
    ? () => createCloudLspClient({
      http: seamCtx.http,
      baseUrl,
      socketUrl: services.cloudLspSocketUrl ?? ((repo, sessionId, language) => pageCloudLspSocketUrl(repo, sessionId, language, baseUrl)),
      ...(services.authorizeSocket === undefined
        ? { socketProtocol: () => socketProtocols()[0] }
        : { authorizeSocket: services.authorizeSocket })
    })
    : undefined
  const codeIntelSeam = actors.pair(seamCtx, (context, select) => createCodeIntelSeam(context, { readFile: select(filesSeam.readFile), ...(createCloudLsp === undefined ? {} : { createCloudLsp }) }))
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
  const repositorySetup = actors.pair(ctx, (context, select) => createRepositorySetupController(context, {
    promptSignIn: () => promptSignIn(),
    chooseRepository: () => select(tutorialRepository).chooseTutorialRepository(),
    openRun: (runId, repo, sourceCard) => select(runs).openRun(runId, repo, sourceCard),
    send: (text, admission) => send(text, admission),
    guidanceFailed: (error, admitted) => {
      if (!admitted) { surfaceCommandFailure("setup.guide", { status: "failed", error }); return }
      const key = "command.failed.setup.guide"
      store.dispatch({ type: "toast.shown", actor: "system", key, title: "Configure in Chat" })
      resolveToast(key, { status: "failed", detail: error, autoDismissMs: ctx.toastAutoDismissMs })
    }
  }))
  const tutorialChange = actors.pair(ctx, (context, select) =>
    createTutorialChangeController(context, select(workflowController), store.nextOrdinal, select(renderFlowForm)))
  const issueFlows = actors.pair(seamCtx, (context, select) =>
    createIssueFlowsController(context, select(workflowController), select(landingsSeam)))
  ctx.finishTutorialChange = tutorialChange.finishTutorialChange
  /* A change run that settled while the app was closed still owes its receipt check. */
  for (const card of store.collections.cards.values()) {
    if (card.kind === "run-trace" && card.payload.kind === "change" && card.payload.phase === "completed") void tutorialChange.finishTutorialChange(card.id)
  }
  const {
    createWorkflow,
    listWorkspaceWorkflows,
    showFlows,
    runWorkflow,
    requestChange,
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
    decideApproval,
    retryLastTurn
  } = createTurnController(ctx, {
    settleTurnBilling,
    nextOrdinal: store.nextOrdinal,
    surfaceCommandFailure,
    forwardApprovalDecision,
    forwardInboxApprovalDecision,
    credentialMissing
  })
  const promptQueue = createPromptQueueController(ctx, send)
  const { enqueuePrompt, removeQueuedPrompt, restoreQueuedPrompts, resumePromptQueue } = promptQueue
  const cloudWiki = actors.pair(ctx, (context) => createCloudWikiController(context, store.nextOrdinal))
  const { listCloudWiki, openCloudWiki, retryCloudWiki, attachWorldEditor,
    setWikiSpace, setWikiPageView, loadWikiIndex, showWikiHistory, createCloudWikiPage, renameCloudWikiPage, deleteCloudWikiPage, attachCloudWiki, wikiIndexes } = cloudWiki
  const {
    clearConversation,
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

  /*
   * The requirement axis (registry.ts commandRequirements): the registry's
   * run path parks a user-invoked command here when a requirement is unmet,
   * and the seams that can satisfy one (identity load) resume it. Durable in
   * the session row because sign-in is a
   * full OAuth redirect. One parking spot, latest wins.
   */
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
   * Will read as a bug) and silent execution. An act whose own door asks
   * (setup.discard) names the question the human answers.
   */
  const requestFlowConfirmation = (name: string, args: string | null, label: string, question?: string): void => {
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: question ?? `Smithers wants to ${label}${args === null ? "" : ` (${args})`}. It runs when you confirm.`,
      action: {
        flow: name,
        ...(args === null ? {} : { args }),
        label: `Confirm: ${label}`
      }
    })
  }

  /*
   * The next-step recommender: the registry does not exist yet at this point,
   * so every dependency is a closure read at regeneration time.
   */
  const recommender = createRecommendController(ctx, {
    catalog: () => ctx.commands.all(),
    state: () => ctx.commands.state(),
    repo: () => activeRepositoryId(store),
    // Without the pills there is nowhere for the server's answer to show, so no request leaves.
    config: { ...services.recommender, enabled: (services.recommender?.enabled ?? false) && features.suggestionPills }
  })
  const recommend = recommender.recommend
  const { explain } = createExplainController(ctx, services.explainer ?? {})

  /*
   * auth.prompt: the agent cannot navigate the user to OAuth (auth.sign-in
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
        : flow ? `run ${flow}${repo ? ` on ${repo}` : ""}` : commands.find(asked.name)?.metadata.summary
    } else if (!summary && asked?.name) summary = commands.find(asked.name)?.metadata.summary
    const purpose = summary?.trim().replace(/[.!?]$/, "")
    const label = identityProviderFor(services) === "github" ? "Sign in with GitHub" : "Sign in"
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: purpose ? `${label} to ${purpose[0]!.toLowerCase()}${purpose.slice(1)}.` : `${label} to continue.`,
      action: { flow: "auth.sign-in", label,
        ...(request?.signInRequirement === undefined ? {} : { signInRequirement: request.signInRequirement }) }
    })
  }

  /*
   * cloud.prompt, mirroring auth.prompt (agent-parity.md): the agent cannot
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

  /*
   * The feature prototype rides flow.run's launch path as a run of kind prototype.
   */
  const onboarding = actors.pair(ctx, (context, select) =>
    createOnboardingController(context, {
      deferCommand,
      promptSignIn,
      workflows: select(workflowController)
    }))

  /*
   * Registration: the existing import, then register-repository on the
   * imported repository's workspace through flow.run's launch path.
   */
  const registration = actors.pair(ctx, (context, select) => {
    const workflows = select(workflowController)
    return createRegistrationController(context, {
      guard: () => workflows.workflowIdentityGuard(),
      importRepository: (repo) => select(repoImportSeam).importRepository(repo, { registration: true }),
      startRegistration: async (cloudRepo, link) => {
        const started = await workflows.runWorkflow("register-repository", cloudRepo, { link })
        return started === undefined ? { value: "run-requested" } : started
      }
    })
  })
  // A registration still importing or launching reconnects with the runs, after boot and sign-in.
  const resumeRuns = ctx.resumeWorkflowRuns
  ctx.resumeWorkflowRuns = () => {
    resumeRuns()
    registration.resumeRegistrations()
  }

  /*
   * The account card (mock 21): seam facts about the signed-in person, or the
   * sign-in step when no one is, through auth.prompt's renderer.
   */
  const account = actors.pair(ctx, (context) =>
    createAccountController(context, {
      nextOrdinal: store.nextOrdinal, promptSignIn,
      provider: identityProviderFor(services)
    }))
  const signup = actors.pair(ctx, (context) => createSignupController(context))

  /*
   * The /chat.commands answer: the LIVE visible catalog as one chat message —
   * the slash menu caps at 8 for calm, so this is where "all of it" lives.
   * Referenced before `commands` initializes; only ever called after.
   */
  const showCommandCatalog = (): void => {
    const lines = commands
      .all()
      .filter((command) => command.hidden !== true)
      .map((command) => `- \`/${command.name}\` — ${command.summary}`)
    store.dispatch({
      type: "message.appended",
      actor: "system",
      text: `Everything Smithers can do right now:\n\n${
        lines.join("\n")
      }\n\nType \`/\` in the composer to filter these as you type.`
    })
  }

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
    stop,
    send,
    enqueuePrompt, removeQueuedPrompt, restoreQueuedPrompts, resumePromptQueue,
    showChat,
    showWorld,
    showWikiPane: () => {
      togglePane()
      if (store.session().surface !== "world") return
      void loadWikiIndex()
      // The pane shows generated pages' freshness (D-09b) from the stack snapshot, so the pane keeps it live as a homepage stack block does.
      const repo = activeRepositoryId(store)
      if (repo !== null) stackSeam.watchHomeStack(repo)
    },
    showConnectors,
    showPlugins,
    installPlugin,
    removePlugin,
    listPlugins,
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
    listCloudWiki,
    openCloudWiki,
    retryCloudWiki,
    attachWorldEditor,
    setWikiSpace,
    setWikiPageView,
    loadWikiIndex,
    showWikiHistory,
    createCloudWikiPage,
    renameCloudWikiPage,
    deleteCloudWikiPage,
    attachCloudWiki,
    selectWikiCardDocument,
    setWikiCardView,
    decideApproval,
    answerApproval: (id: string, answer: unknown, question?: string) => decideApproval(id, "approved", answer, question),
    retryLastTurn,
    clearConversation,
    openBrowser,
    ...tutorialChange,
    ...issueFlows,
    ...repositorySetup,
    createWorkflow,
    listWorkspaceWorkflows,
    listTriggers,
    showFlows,
    runWorkflow,
    requestChange,
    planFlow,
    chooseWorkflowRepo,
    stopWatchingRun,
    retryRunWatch,
    resumeWorkflowRuns: () => ctx.resumeWorkflowRuns(),
    listRuns: runs.listRuns,
    prepareRunHandoff: runs.prepareRunHandoff,
    openRun: runs.openRun,
    resumeRun: runs.resumeRun,
    rerunRun: runs.rerunRun,
    signalRun: runs.signalRun,
    steerRun: runs.steerRun,
    steerRunSeat: runs.steerRunSeat,
    steerRunThinking: runs.steerRunThinking,
    steerRunTools: runs.steerRunTools,
    showRunLogs: runs.showRunLogs,
    showRunSteps: runs.showRunSteps,
    showRunEvents: runs.showRunEvents,
    traceFilter: runs.traceFilter,
    traceSelect: runs.traceSelect,
    selectCodingChange: runs.selectCodingChange,
    traceView: runs.traceView,
    graphFollow: runs.graphFollow,
    selectGraphNode: graph.selectGraphNode,
    graphNodeTab: graph.graphNodeTab,
    selectPlanNode: graph.selectPlanNode,
    planNodeTab: graph.planNodeTab,
    traceLive: runs.traceLive,
    stopAllRuns: runs.stopAllRuns,
    listApprovals: runs.listApprovals,
    openApproval: runs.openApproval,
    maximizeCard,
    minimizeCard,
    frameBack,
    frameForward,
    forkFrame,
    openCardTab,
    selectTab,
    closeTab,
    ...tutorialRepository,
    selectRepo,
    toggleRepoTree,
    renameWorkspace,
    toggleWorkspaceRename,
    listAgents,
    renderFlowForm,
    setFormField,
    submitForm,
    dismissCard,
    listModels,
    showModel,
    newModel,
    editModel,
    saveModel,
    removeModel,
    testModel,
    assignSeat,
    observeModels,
    composeModel,
    askModel,
    recallModel,
    setModelPrompt,
    setModelField,
    setModelQuestion,
    setModelOption,
    fixtureModel,
    cloudTerminal,
    toggleDevtools,
    toggleChatFilterMenu,
    toggleChatFilter,
    grepChatFilter,
    resetChatFilter,
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
    addFiles,
    describeAgentBackend,
    debugSnapshot,
    debugEvents,
    debugErrors,
    debugNet,
    netTap,
    netTapEntries,
    debugSeams,
    toggleTheme,
    setPalette,
    adoptSession,
    loadSession,
    signIn,
    signOut,
    requestAccess,
    handleAuthReturn,
    handleInstallReturn: gitHubSeam.handleInstallReturn,
    deferCommand,
    resumeDeferredCommand,
    settleFirstRunTarget,
    deferRepositoryCommand: repositoryReadiness.defer,
    noteCommandRun,
    toggleVerbose,
    traceFlow,
    requestFlowConfirmation,
    recommend,
    explain,
    showCommandCatalog,
    promptSignIn,
    promptCloudSignIn,
    reloadApp,
    openDownload,
    promptDownload,
    dismissFirstRun: () => { store.dispatch({ type: "first-run.dismissed", actor: ctx.commandActor }) },
    dismissHint: (id: string) => {
      if (ctx.disposed || privacyActions.refuse(ctx.commandActor) !== undefined) return
      store.dispatch({ type: "hint.dismissed", actor: ctx.commandActor, id })
    },
    ...signup,
    introduce,
    showAccount: account.showAccount,
    prototypeFeature: onboarding.prototypeFeature,
    registerRepository: registration.registerRepository,
    listIssues: issuesSeam.listIssues,
    viewIssue: issuesSeam.viewIssue,
    createIssue: issuesSeam.createIssue,
    setIssueState: issuesSeam.setIssueState,
    commentOnIssue: issuesSeam.commentOnIssue,
    draftIssueComment: issuesSeam.draftIssueComment,
    retryIssueComment: issuesSeam.retryIssueComment,
    reactToIssueComment: issuesSeam.reactToIssueComment,
    mapIssueSync: issuesSeam.mapIssueSync,
    resolveIssueSync: issuesSeam.resolveIssueSync,
    editIssueComment: issuesSeam.editIssueComment,
    deleteIssueComment: issuesSeam.deleteIssueComment,
    listIntegrations: integrationsSeam.listIntegrations,
    listLandings: landingsSeam.listLandings,
    viewLanding: landingsSeam.viewLanding,
    setLandingTab: landingsSeam.setTab,
    createLanding: landingsSeam.createLanding,
    landLanding: landingsSeam.landLanding,
    reviewLanding: landingsSeam.reviewLanding,
    showBillingPlans: billingSeam.showBillingPlans,
    startCheckout: billingSeam.startCheckout,
    openBillingPortal: billingSeam.openBillingPortal,
    ...repositoryUpdate,
    listNotifications: notificationsSeam.listNotifications,
    markNotificationsRead: notificationsSeam.markNotificationsRead,
    viewEnvironment: environmentSeam.viewEnvironment,
    setEnvironmentVar: environmentSeam.setEnvironmentVar,
    removeSubscriptionToken: environmentSeam.removeSubscriptionToken,
    connectCodingProvider: secretsSeam.connectCodingProvider,
    listCodingProviders: secretsSeam.listCodingProviders,
    revokeCodingProvider: secretsSeam.revokeCodingProvider,
    connectCodex: secretsSeam.connectCodex,
    moveCodingProvider: secretsSeam.moveCodingProvider,
    listSecrets: secretsSeam.listSecrets,
    showStack: stackSeam.showStack,
    bootstrapStack: stackSeam.bootstrapStack,
    backfillStack: stackSeam.backfillStack,
    setStackParallel: stackSeam.setStackParallel,
    retryStackItem: stackSeam.retryStackItem,
    refreshWiki: stackSeam.refreshWiki,
    registerTrigger,
    importRepository: repoImportSeam.importRepository,
    retryImport: repoImportSeam.retryImport,
    listBookmarks: bookmarksSeam.listBookmarks,
    listCommits: commitsSeam.listCommits,
    readCommit: commitsSeam.readCommit,
    listFiles: filesSeam.listFiles,
    ...diffFilesSeam,
    readFile: filesSeam.readFile,
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
    openWorkspaceDesktop: workspaceSeam.openDesktop,
    rotateWorkspaceDesktop: workspaceSeam.rotateDesktop,
    openDesktopBox: workspaceSeam.openDesktopBox,
    stopDesktopWait: workspaceSeam.stopDesktopWait,
    activeRepository: () => activeRepositoryId(store),
    listEnvironmentImages: workspaceSeam.listEnvironmentImages,
    listSessionEgress: egressSeam.listSessionEgress,
    /* The cloud agent sessions (the `agent.session.*` flows' seam). */
    newAgentSession: agentSessionSeam.newSession,
    listAgentSessions: agentSessionSeam.listSessions,
    viewAgentSession: agentSessionSeam.viewSession,
    sayToAgentSession: agentSessionSeam.sayToSession,
    stopAgentSession: agentSessionSeam.stopSession,
    viewChange: changeSeam.viewChange,
    diffChange: changeSeam.diffChange,
    landChange: changeSeam.landChange,
    splitReadyChange: changeSeam.splitReady,
    splitChange: changeSeam.splitChange,
    resolveChangeConflict: changeSeam.resolveConflict,
    revertChange: changeSeam.revertChange,
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
    showBalance,
    adminAllowlist,
    adminGrant,
    adminGrantConfirm,
    adminGrantCancel,
    adminRequests,
    adminQueueApprove,
    adminHealth,
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
      return {
        repositoryReadiness,
        pluginLibrary: features.pluginLibrary,
        surface: store.session().surface,
        plugins: store.session().plugins ?? [],
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
  const registry = createCommandRegistry(commandActions, actors.select(commandActions), createCommandIntentLifecycle(ctx, request => {
    if (request.actor === "user" && request.source === "command") recommender.noteDispatch(request.name)
  }, inputMode.setInputMode, prepareWorldDocument))
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

  triggersSeam.resumePauses()
  triggersSeam.resumePreparations()
  repoImportSeam.resume()
  secretsSeam.resumeCodingProviders()
  stackSeam.resumeStacks()
  workflowController.resumeWorkflowRequests()
  repositorySetup.resumeRepositorySetups()
  /*
   * Persisted model, repository and approval reads reconnect from the identity answer,
   * never from construction: every boot adopts or probes the session, and a read started
   * before that answer would only be superseded by it.
   */
  const setupIdentitySubscription = store.collections.identitySessions.subscribeChanges(() => {
    queueMicrotask(() => { if (!ctx.disposed) { triggersSeam.resumePauses(); triggersSeam.resumePreparations() } })
    queueMicrotask(() => { if (!ctx.disposed) secretsSeam.resumeCodingProviders() })
    workflowController.resumeWorkflowRequests()
    // Catalog recovery writes a card; leave the identity projection before dispatching it.
    queueMicrotask(() => { if (!ctx.disposed) { resumeModels(); resumeModelCalls(); account.resumeAccount() } })
    repositoryReadiness.resume()
    repositorySetup.resumeRepositorySetups()
    repoImportSeam.resume()
    runs.resumeApprovalRequests()
    runs.resumeRunFacetRequests()
    runs.resumeRunListRequests()
    runs.resumeRunOpenRequests()
  })
  ctx.onDispose(() => setupIdentitySubscription.unsubscribe())
  const importCloudSubscription = store.collections.cloudSessions.subscribeChanges(() => {
    repoImportSeam.resume()
    queueMicrotask(() => { if (!ctx.disposed) secretsSeam.resumeCodingProviders() })
  })
  ctx.onDispose(() => importCloudSubscription.unsubscribe())
  subscribeToAgent()
  promptQueue.subscribe()
  observeBackgroundWork(ctx)
  // Material transitions regenerate the next-step pills through the `recommend` flow.
  recommender.subscribe()
  // The active repository's flow catalog, read now and on every change of target, so its leaves are in the registry.
  issuesSeam.subscribe(ctx.onDispose)
  repositoryFlowsSeam.subscribe(ctx.onDispose)
  watchIdentityAcrossTabs()
  // Cmd+T / Cmd+W / Cmd+1..9 on the document, released with the controller.
  if (typeof document !== "undefined") ctx.onDispose(installKeyboard(document))
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

  const runCommand: AppController["runCommand"] = (name, args, originCardId) => {
    if (ctx.disposed) return false
    if (privacyActions.before({ name, actor: "user", source: "command" }, args) !== undefined) return true
    if (commands.find(name) === undefined) return false
    /* Everything the door says from here on belongs to this press (controller/spokenLines.ts). */
    const saidBefore = latestOrdinal(store.collections)
    void commands.run(name, args, undefined, originCardId).then((outcome) => { if (!ctx.disposed) surfaceCommandFailure(name, outcome, saidBefore) })
    return true
  }

  /*
   * The public controller IS the command surface: one map feeds the registry
   * and the UI, so a binding cannot drift between the two doors. Only the
   * composition root's own members join here; the registry's state read stays
   * internal to it.
   */
  const { snapshot: _snapshot, ...sharedActions } = commandActions
  return {
    ...sharedActions,
    store,
    privacyNotices: privacyActions.notices,
    controlFocus,
    formFocus,
    storageRecoveryState,
    downloadUrl,
    features,
    nativeAgentAvailable: agent.available,
    tappedFetch: http,
    localAuth,
    stackSnapshots: stackSeam.snapshots,
    wikiIndexes,
    commands,
    slashItems: (needle) => commands.slashItems(needle),
    slashTree: (needle) => commands.slashTree(needle),
    runCommand,
    submitCommand,
    dispose
  }
}
