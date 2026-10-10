/*
 * The literal pin.
 *
 * A test suite asserts against the application with string literals, and a
 * string literal is invisible to the compiler. On 2026-08-15 a `command`→`flow`
 * rename orphaned nineteen literals in `scripts/worker-e2e.ts` and seventeen
 * `data-command` selectors across four browser scripts. Everything still
 * compiled, every suite still passed, and for three days the suite proved
 * nothing: nine `card.kind === "workflow-run"` comparisons could no longer be
 * true, and a stub emitting a tool call for `workflow.create` disarmed the very
 * substitution guard that section existed to prove.
 *
 * A one-off sweep fixes that Tuesday. This test fixes the class: it derives the
 * vocabularies from the application, extracts the literals from the suites, and
 * fails by name when one no longer resolves.
 *
 * It lives under `lint/conformance/` and runs in the conformance gate.
 */
import { describe, expect, test } from "bun:test"
import { relative } from "node:path"
import { RUN_LAUNCH_COMMANDS } from "../../src/mainview/state/RunClaims"
import { fixtureRepositoryName } from "../../e2e/real/support/values"
import {
  dataAttributesIn,
  DOTTED_IDENTIFIER,
  extractLiterals,
  FILE_NAME,
  literalsUnder,
  nearest,
  sourceFiles
} from "./Literals"
import { type Violation, violationsOf, type Vocabularies } from "./Rules"
import {
  assertsAgainstTheApp,
  cardIdPrefixes,
  cardKinds,
  renderedCardKinds,
  cardActionNames,
  cardObjectFields,
  composedDottedHeads,
  declaredFlowNames,
  E2E,
  emittedDataAttributes,
  idVocabularySegments,
  manifestFlowNames,
  productDottedIdentifiers,
  productSourceFiles,
  productStringLiterals,
  SCRIPTS,
  stampedDataAttributes,
  UI_APP,
  UI_SRC
} from "./Vocabulary"

/*
 * The trees under test: standalone runners and checklist probes in
 * `scripts/`, and browser, graph, real and packaged suites in `e2e/`.
 */
const TREES = [SCRIPTS, E2E] as const

const shortPath = (file: string): string => relative(UI_APP, file)

/** An allowlist entry: a literal, the file it sits in, and why it does not resolve. */
interface Excuse {
  readonly literal: string
  /** Path relative to `apps/app`. */
  readonly file: string
  readonly reason: string
}

/*
 * Literals that legitimately name nothing in the application.
 *
 * Every entry is a literal the app never owned: a CSS selector, a file or
 * bundle name, an id a test double invents for itself, a member of a different
 * union, or a value the assertion exists to prove is absent. An entry with no
 * reason fails, and an entry that stops matching a real literal fails, so the
 * list cannot outlive what it excuses.
 */
const RESOLVES_ELSEWHERE: ReadonlyArray<Excuse> = [
  {
    literal: "control.engine.event", file: "e2e/real/agent-terminal.spec.ts",
    reason: "Native journal envelope from packages/smithers flows journal, inspected through Projection.Snapshot run-events; never a wire card."
  },
  {
    literal: "flows.harness.call-fact.v1", file: "e2e/real/agent-terminal.spec.ts",
    reason: "Native call-fact protocol declared in packages/smithers/flows/journal/src/CallFact.ts; the run-events oracle decodes this envelope, never an app flow."
  },
  {
    literal: "control.agent.cell-call-started", file: "e2e/real/agent-terminal.spec.ts",
    reason: "Native agent journal projection event declared in packages/smithers/src/internal/EngineJournalProjection.ts; the test normalizes call facts to this event, never a card."
  },
  {
    literal: "control.agent.cell-call-settled", file: "e2e/real/agent-terminal.spec.ts",
    reason: "Native agent journal projection event declared in packages/smithers/src/internal/EngineJournalProjection.ts; the test normalizes call facts to this event, never a card."
  },
  {
    literal: "check", file: "e2e/real/learning-journey.spec.ts",
    reason: "Backend TODO evidence item kind emitted by mythical_todo_read.go; inspected in stored attempts and evidence items, never a wire card."
  },
  {
    literal: "answer", file: "e2e/real/terminal-signin.spec.ts",
    reason: "BranchCard.ts activity and EntryRowCard.ts entry discriminator from the branch activity API; never a wire card."
  },
  {
    literal: "steer", file: "e2e/real/terminal-signin.spec.ts",
    reason: "BranchCard.ts activity discriminator from the branch activity API; never a wire card."
  },
  {
    literal: "review_merge", file: "e2e/real/terminal-signin.spec.ts",
    reason: "Backend confirmation kind emitted by approvals_confirmations_merge.go and approvals_confirmations.go; inspected through /api/confirmations, never a wire card."
  },
  {
    literal: "agent", file: "e2e/real/terminal-signin.spec.ts",
    reason: "CardPrimitives.ts ActorSchema agent discriminator; inspected in branch activity and presence actors, never a wire card."
  },
  {
    literal: "person", file: "e2e/real/todo-steer.spec.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator rendered by ActorChip.tsx on todo authors; the avatar selector names an actor, never a wire card."
  },
  {
    literal: "branch.activity", file: "e2e/real/todo-steer.spec.ts",
    reason: "Backend BranchActivityEvent declared in mythical_branch_activity.go; this test inspects SQL product_job_events, never an app flow."
  },
  {
    literal: "steer", file: "e2e/real/todo-steer.spec.ts",
    reason: "BranchCard.ts activity and backend run trace steer discriminator; the assertion inspects trace cells, never a wire card."
  },

  {
    literal: "p.world-card-path", file: "e2e/playwright/piper.spec.ts",
    reason: "Tag/class selector for FileCards.tsx FileCardHeader p.world-card-path, which renders address and readAt.changeId; never a dotted product identifier."
  },
  {
    literal: "renamed", file: "e2e/real/code-document-epoch.fixture.ts",
    reason: "FileCard.ts FileModel gone discriminator renamed with to and by; this fixture inspects provider.file.gone after a real file rename, never a wire card kind."
  },
  {
    literal: "foreign_push", file: "e2e/real/github-j10/foreign-push.spec.ts",
    reason: "Backend TodoWait.Kind foreign_push in mythical_todo_state.go and mythical publication; the suite inspects /api/todos waits, never a wire card kind."
  },
  {
    literal: "composed", file: "e2e/real/github-j10/foreign-push.spec.ts",
    reason: "github-j10/install.ts J10Install fixture kind distinguishes composed fixture from reference host; never a card."
  },
  {
    literal: "question", file: "e2e/real/github-j10/foreign-push.spec.ts",
    reason: "Backend TodoWait.Kind question for /api/todos planning waits; this suite inspects the TODO waits array alongside foreign_push, never a wire card kind."
  },
  {
    literal: "steer", file: "e2e/playwright/branch-live.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel activity declares steer and BranchView.tsx renders entry.kind; the run trace also names steer cells. Neither is a wire card kind."
  },
  {
    literal: "answer", file: "e2e/playwright/branch-live.spec.ts",
    reason: "EntryRowCard.ts EntryKindSchema answer and BranchView.tsx activity entry kinds; these assertions inspect answer rows or trace cells, never wire cards."
  },
  {
    literal: "todo.rebase-requested", file: "e2e/playwright/branch-live.spec.ts",
    reason: "Backend durable fact todo.rebase-requested recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },
  {
    literal: "registry.npmjs.org", file: "e2e/playwright/factory.spec.ts",
    reason: "Fixture secret host binding for the npm registry, supplied to the secrets API; an external hostname, never a flow."
  },
  {
    literal: "registry.npmjs.org", file: "e2e/playwright/spec/C-CAT-02.spec.ts",
    reason: "Fixture secret host binding for the npm registry, supplied to the secrets API; an external hostname, never a flow."
  },
  {
    literal: "member-review-", file: "e2e/playwright/spec/C-J10-09.spec.ts",
    reason: "C-J10-09 fixture operationId for accepted review requests and the polling HTTP route; never a card ID."
  },
  {
    literal: "question", file: "e2e/playwright/spec/C-J11-01.spec.ts",
    reason: "CardPrimitives.ts NeedsYouKindSchema question; the selector in the proof targets BranchView.tsx question activity, never a wire card."
  },
  {
    literal: "go.mod", file: "e2e/playwright/spec/C-PRC-02.spec.ts",
    reason: "Fixture repository file path read by C-PRC-02, the Go module manifest; never a flow identifier."
  },
  {
    literal: "migrate.go", file: "e2e/playwright/spec/C-PRC-02.spec.ts",
    reason: "Fixture repository file path read by C-PRC-02 for migration code; never a flow identifier."
  },
  {
    literal: "api.example.com", file: "e2e/playwright/view-stories.spec.ts",
    reason: "view-stories fixture external API host label; never an application flow identifier."
  },
  {
    literal: "setup-", file: "e2e/proof/agent.spec.ts",
    reason: "proof/agent.spec.ts screenshot filename prefix for prerequisite receipts in shot(); never an application card ID."
  },
  {
    literal: "button.mvp-tree-row", file: "e2e/proof/agent.spec.ts",
    reason: "Tag/class selector for the navigation tree buttons rendered by mainview branch navigation; never a dotted product identifier."
  },
  {
    literal: "person", file: "e2e/proof/agent.spec.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator, rendered by cards/views/ActorChip.tsx; this is an actor or avatar, never a card."
  },
  {
    literal: "agent", file: "e2e/proof/agent.spec.ts",
    reason: "CardPrimitives.ts ActorSchema agent discriminator, rendered by cards/views/ActorChip.tsx; this is an actor avatar, never a card."
  },
  {
    literal: "steer", file: "e2e/proof/agent.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel activity declares steer and BranchView.tsx renders entry.kind; the run trace also names steer cells. Neither is a wire card kind."
  },
  {
    literal: "read", file: "e2e/proof/agent.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel declares read activity; BranchView.tsx projects entry.kind; the proof scopes its activity helper to the branch activity list."
  },
  {
    literal: "edit", file: "e2e/proof/agent.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel declares edit activity; BranchView.tsx projects entry.kind; the proof scopes its activity helper to the branch activity list."
  },
  {
    literal: "button.branch-link", file: "e2e/proof/agent.spec.ts",
    reason: "Tag/class selector for BranchView.tsx BranchLink buttons; never a dotted product identifier."
  },
  {
    literal: "step", file: "e2e/proof/agent.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel declares step activity; BranchView.tsx projects entry.kind; the proof scopes its helper to branch activity."
  },
  {
    literal: "question", file: "e2e/proof/agent.spec.ts",
    reason: "CardPrimitives.ts NeedsYouKindSchema question; the selector in the proof targets BranchView.tsx question activity, never a wire card."
  },
  {
    literal: "answer", file: "e2e/proof/agent.spec.ts",
    reason: "EntryRowCard.ts EntryKindSchema answer and BranchView.tsx activity entry kinds; these assertions inspect answer rows or trace cells, never wire cards."
  },
  {
    literal: "ol.branch-activity", file: "e2e/proof/agent.spec.ts",
    reason: "Tag/class selector for BranchView.tsx ActivityList ordered list; never a dotted product identifier."
  },
  {
    literal: "answer", file: "e2e/real/agents.spec.ts",
    reason: "EntryRowCard.ts EntryKindSchema answer and BranchView.tsx activity entry kinds; these assertions inspect answer rows or trace cells, never wire cards."
  },
  {
    literal: "app-turn-", file: "e2e/real/agents.spec.ts",
    reason: "agents.spec.ts attachJson artifact name keyed by the admitted shared turn; never an application card ID."
  },
  {
    literal: "model.compose", file: "e2e/real/agents.spec.ts",
    reason: "Explicit absence assertions for retired model laboratory commands in owner help and palette; no live command is expected to resolve."
  },
  {
    literal: "model.ask", file: "e2e/real/agents.spec.ts",
    reason: "Explicit absence assertions for retired model laboratory commands in owner help and palette; no live command is expected to resolve."
  },
  {
    literal: "model.fixture", file: "e2e/real/agents.spec.ts",
    reason: "Explicit absence assertions for retired model laboratory commands in owner help and palette; no live command is expected to resolve."
  },
  {
    literal: "steer", file: "e2e/real/branch-card-install.fixture.tsx",
    reason: "rpc/BranchCard.ts BranchModel activity declares steer and BranchView.tsx renders entry.kind; the run trace also names steer cells. Neither is a wire card kind."
  },
  {
    literal: "answer", file: "e2e/real/branch-card-install.fixture.tsx",
    reason: "EntryRowCard.ts EntryKindSchema answer and BranchView.tsx activity entry kinds; these assertions inspect answer rows or trace cells, never wire cards."
  },
  {
    literal: "person", file: "e2e/real/branch-outside-change.spec.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator, rendered by cards/views/ActorChip.tsx; this is an actor or avatar, never a card."
  },
  {
    literal: "question", file: "e2e/real/branch-outside-change.spec.ts",
    reason: "CardPrimitives.ts NeedsYouKindSchema question; the selector in the proof targets BranchView.tsx question activity, never a wire card."
  },
  {
    literal: "control.agent.cell-call-started", file: "e2e/real/branch-outside-change.spec.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "control.agent.cell-call-settled", file: "e2e/real/branch-outside-change.spec.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "question", file: "e2e/real/duplicate-launch.spec.ts",
    reason: "CardPrimitives.ts NeedsYouKindSchema question; the selector in the proof targets BranchView.tsx question activity, never a wire card."
  },
  {
    literal: "keystrokes.csv", file: "e2e/real/file-coedit.spec.ts",
    reason: "Playwright CSV attachment filename for the file-coediting measured input samples; never a product identifier."
  },
  {
    literal: "flow-states.jsonl", file: "e2e/real/flow-activation.spec.ts",
    reason: "Flow activation evidence JSONL attachment filename; never an application identifier."
  },
  {
    literal: "flow-", file: "e2e/real/flow-source-run.browser.ts",
    reason: "flow-source-run.browser.ts scratch branch name and screenshot filename prefixes; neither is an application card ID."
  },
  {
    literal: "fork-add-", file: "e2e/real/fork-add-to-stack.spec.ts",
    reason: "fork-add-to-stack.spec.ts HTTP Idempotency-Key prefix for delegated add requests; never an application card ID."
  },
  {
    literal: "branch.forked", file: "e2e/real/fork-add-to-stack.spec.ts",
    reason: "Backend durable fact branch.forked recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },
  {
    literal: "branch.added-to-stack", file: "e2e/real/fork-add-to-stack.spec.ts",
    reason: "Backend durable fact branch.added-to-stack recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },
  {
    literal: "c-j10-05-issue-", file: "e2e/real/github-j10/merge-on-github.spec.ts",
    reason: "merge-on-github.spec.ts HTTP Idempotency-Key prefix supplied to f.api when filing a TODO from an issue; never a card ID."
  },
  {
    literal: "reference", file: "e2e/real/github-j10/merge-on-github.spec.ts",
    reason: "github-j10/install.ts J10Install fixture kind distinguishes reference host from composed fixture; never a card."
  },
  {
    literal: "c-j10-01-", file: "e2e/real/github-j10/pr-shape.spec.ts",
    reason: "pr-shape.spec.ts HTTP Idempotency-Key prefix supplied to f.api when appending fixture TODOs; never a card ID."
  },
  {
    literal: "composed", file: "e2e/real/github-j10/pr-shape.spec.ts",
    reason: "github-j10/install.ts J10Install fixture kind distinguishes composed fixture from reference host; never a card."
  },
  {
    literal: "person", file: "e2e/real/github-j10/review-steer.spec.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator, rendered by cards/views/ActorChip.tsx; this is an actor or avatar, never a card."
  },
  {
    literal: "crypto.subtle", file: "e2e/real/install-origins.spec.ts",
    reason: "Browser platform secure-context capability probed by install-origins; never an app flow or transition."
  },
  {
    literal: "console", file: "e2e/real/install-origins.spec.ts",
    reason: "install-origins.ts browser error observer records console events separately from page errors and rejections; never a card."
  },
  {
    literal: "install.address", file: "e2e/real/install-origins.spec.ts",
    reason: "Backend durable fact install.address recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },
  {
    literal: "https-hint-", file: "e2e/real/install-origins.spec.ts",
    reason: "install-origins.spec.ts screenshot evidence filename prefix for the HTTPS documentation hint; never a card ID."
  },
  {
    literal: "access-control-", file: "e2e/real/install-origins.spec.ts",
    reason: "HTTP CORS response header prefix checked for absence on refused network answers; never a card ID."
  },
  {
    literal: "evil.example", file: "e2e/real/install-origins.spec.ts",
    reason: "Deliberately hostile external Host/origin used to exercise origin refusal; never an application identifier."
  },
  {
    literal: "owner.har", file: "e2e/real/members.spec.ts",
    reason: "Playwright HAR artifact filename passed to recordHar in members.spec.ts; never an application identifier."
  },
  {
    literal: "dom.pointerdown", file: "e2e/real/support/keyboard-journey-input.test.ts",
    reason: "Test-owned keyboard audit method label in support/keyboardOnly and keyboard-journey-input fixtures; never an app flow."
  },
  {
    literal: "dom.keydown", file: "e2e/real/support/keyboard-journey-input.test.ts",
    reason: "Test-owned keyboard audit method label in support/keyboardOnly and keyboard-journey-input fixtures; never an app flow."
  },
  {
    literal: "dom.invalid", file: "e2e/real/support/keyboardOnly.test.ts",
    reason: "Test-owned keyboard audit method label in support/keyboardOnly and keyboard-journey-input fixtures; never an app flow."
  },
  {
    literal: "keydown", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "pointerdown", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "pointermove", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "wheel", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "touchstart", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "dblclick", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "click", file: "e2e/real/support/keyboardOnly.ts",
    reason: "DOM event type from the support/keyboardOnly.ts input audit listeners; never a wire card discriminator."
  },
  {
    literal: "evil.example", file: "e2e/real/support/listeners.test.ts",
    reason: "Deliberately hostile external Host/origin used to exercise origin refusal; never an application identifier."
  },
  {
    literal: "flows.harness.call-fact.v1", file: "e2e/real/support/outside-awareness.test.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "flows.harness.step-fact.v1", file: "e2e/real/support/outside-awareness.test.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "control.engine.event", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "flows.harness.step-fact.v1", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "flows.harness.call-fact.v1", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "person", file: "e2e/real/support/outside-awareness.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator, rendered by cards/views/ActorChip.tsx; this is an actor or avatar, never a card."
  },
  {
    literal: "control.agent.steering-drained", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "control.agent.model-requested", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "control.agent.cell-call-started", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "control.agent.cell-call-settled", file: "e2e/real/support/outside-awareness.ts",
    reason: "Native harness journal event envelope/type inspected by the independent outside-awareness oracle; declared in packages/smithers agent/src/AgentSession.ts, src/internal/EngineJournalProjection.ts and flows/journal/src/{CallFact,StepFact}.ts; never an app card or flow."
  },
  {
    literal: "attention-failure-", file: "e2e/real/timeline.spec.ts",
    reason: "timeline.spec.ts HTTP Idempotency-Key for fixture TODO movement requests; never an application card ID."
  },
  {
    literal: "question", file: "e2e/real/todo-needs-you.spec.ts",
    reason: "CardPrimitives.ts NeedsYouKindSchema question; the selector in the proof targets BranchView.tsx question activity, never a wire card."
  },
  {
    literal: "person", file: "e2e/real/todo-needs-you.spec.ts",
    reason: "CardPrimitives.ts ActorSchema person discriminator, rendered by cards/views/ActorChip.tsx; this is an actor or avatar, never a card."
  },
  {
    literal: "ask", file: "e2e/real/todo-needs-you.spec.ts",
    reason: "The public run trace phase cells use ask for the suspended question operation; todo-needs-you inspects cells, never cards."
  },
  {
    literal: "answer", file: "e2e/real/todo-needs-you.spec.ts",
    reason: "EntryRowCard.ts EntryKindSchema answer and BranchView.tsx activity entry kinds; these assertions inspect answer rows or trace cells, never wire cards."
  },
  {
    literal: "steer", file: "e2e/real/todo-needs-you.spec.ts",
    reason: "rpc/BranchCard.ts BranchModel activity declares steer and BranchView.tsx renders entry.kind; the run trace also names steer cells. Neither is a wire card kind."
  },
  {
    literal: "todo.amended", file: "e2e/real/todo-placement.spec.ts",
    reason: "Backend durable fact todo.amended recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },
  {
    literal: "todo.retried", file: "e2e/real/todo-stack-actions.spec.ts",
    reason: "Backend durable fact todo.retried recorded by packages/backend/internal/services; the suite inspects product_job_events or operation receipts, never an app flow."
  },

  {
    literal: "button.context-chip", file: "e2e/playwright/spec/C-UI-07-native.spec.ts",
    reason: "Tag/class selector for ContextLine.tsx buttons with className=context-chip; not a dotted product identifier."
  },
  {
    literal: "moved_off", file: "e2e/real/branch-moved-off.spec.ts",
    reason: "TODO wait discriminator declared by packages/rpc/src/CardPrimitives.ts NeedsYouKindSchema; both callbacks inspect waits, never cards."
  },
  {
    literal: "check", file: "e2e/real/fresh-repository.spec.ts",
    reason: "TODO evidence item discriminator emitted by packages/backend/internal/services/mythical_todo_read.go; the filter inspects attempt.items, never cards."
  },
  {
    literal: "live-drop-", file: "e2e/composed/live-todo.browser.ts",
    reason: "Test-owned HTTP Idempotency-Key for TODO drop requests, never an application card ID."
  },
  {
    literal: "keystrokes.csv", file: "e2e/real/wiki-coedit.spec.ts",
    reason: "Playwright CSV attachment filename for the 400 measured keystrokes; never a product identifier."
  },
  {
    literal: "demo.git", file: "scripts/mode-matrix/local-own.ts",
    reason: "The bare repository directory the local-own GitHub fake serves (<owner>/demo.git); a path, never a product identifier."
  },
  {
    literal: "local-draft-", file: "e2e/real/wiki-collaboration.spec.ts",
    reason: "The local note's human-authored title passed to createNote; the note API supplies its own card ID."
  },
  {
    literal: "owner-session",
    file: "scripts/run-mode-matrix.ts",
    reason: "Mode-matrix credential kind, declared by the matrix fixture contract, not a card kind."
  },
  {
    literal: "browser-profile",
    file: "scripts/run-mode-matrix.ts",
    reason: "Mode-matrix credential kind, declared by the matrix fixture contract, not a card kind."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/run-inspection/module-evidence.ts",
    reason: "The module checkpoint envelope is declared by packages/smithers/flows/journal/src/StepFact.ts, outside the app vocabulary."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/run-inspection/revisions.ts",
    reason: "The capability attachment counts the native checkpoint envelope declared by packages/smithers/flows/journal/src/StepFact.ts."
  },
  {
    literal: "flows.harness.step-fact.v1",
    file: "e2e/real/coverage/timeline-semantic.test.ts",
    reason: "The oracle tests the journal package's native module checkpoint wire format, outside the app vocabulary."
  },
  {
    literal: "flows.harness.call-fact.v1",
    file: "e2e/real/run-inspection/semantic.ts",
    reason: "The native call envelope is declared in the packages/smithers harness and gateway, outside the app vocabulary; the independent oracle reads that wire format."
  },
  {
    literal: "flows.harness.call-fact.v1",
    file: "e2e/real/coverage/timeline-semantic.test.ts",
    reason: "Native gateway call facts exercise the harness wire format outside the app vocabulary, including cursor positions before duplicate telemetry."
  },
  {
    literal: "smthrs-flow-graph-",
    file: "e2e/graph/lifecycle/gateway.test.ts",
    reason: "the scratch directory `BridgedEngineRun` mkdtemps its two SQLite files into, which this suite counts under its own TMPDIR and asserts removed when the host stops; a directory prefix, never a card id"
  },
  {
    literal: "main.home",
    file: "e2e/site/landing-start.spec.ts",
    reason: "CSS selector for the Astro landing's main.home in apps/site/src/pages/index.astro, outside the app vocabulary; the browser assertion requires the element to be visible"
  },
  {
    literal: "stub-call-",
    file: "e2e/support/ChatStub.ts",
    reason: "the call_id the chat stub invents for its own tool_call frame; the app keys the card by its record id (`toolcall-`), never by call_id"
  },
  {
    literal: "demo.v2",
    file: "e2e/playwright/cloudFixture.spec.ts",
    reason: "test repository basename containing a dot; the fixture preserves its full identity"
  },
  {
    literal: "section.smithers-card",
    file: "e2e/playwright/control-focus.spec.ts",
    reason: "tag and class composed by the geometry probe from the real card element, not a flow id"
  },
  {
    literal: "retained-review-",
    file: "e2e/real/todo-steer.spec.ts",
    reason: "composed-install.ts keep() writes retained JSON evidence to host.evidence; this prefix names the review receipt by PR head, never an application card ID"
  },
  {
    literal: "storage-test-",
    file: "e2e/playwright/databaseProbe.ts",
    reason: "queryDatabase send() generates correlation request IDs for worker.postMessage and matches message responses; test-owned SQLite protocol IDs, never application card IDs"
  },
  {
    literal: "smithers-mvp-quarantine.private-test",
    file: "e2e/playwright/storage-refusal.spec.ts",
    reason: "an intentionally invented historical quarantine key; recovery must enumerate unknown original keys, not only a current vocabulary"
  },
  {
    literal: "flow.ghost",
    file: "scripts/launch-checklist/Probes.test.ts",
    reason: "a flow name this unit test invents to exercise the unnamed-affordance rule, never sent to the app"
  },
  {
    literal: "promotional",
    file: "scripts/launch-checklist/Rows.ts",
    reason: "the billing grant kind the checklist reads back from its own /api/billing audit row; it is an upstream grant kind, never a card kind"
  },
  {
    literal: "navigation-storage-",
    file: "e2e/real/navigation-frames/storage.ts",
    reason: "test-owned request IDs on the shipped SQLite worker protocol; the worker echoes them for request correlation and they are never card IDs"
  },
  {
    literal: "keys.env", file: "scripts/proof-install.test.ts",
    reason: "Proof-install test-owned environment file written in a temporary directory; never a product identifier."
  },
  {
    literal: "com.apple.security.cs.disable-library-validation", file: "scripts/server-bundle-manifest.test.ts",
    reason: "Apple codesign entitlement key verified against the generated backend signing plist."
  },
  {
    literal: "backend.entitlements", file: "scripts/server-bundle-manifest.ts",
    reason: "Temporary codesign entitlement plist filename created by server-bundle-manifest.ts."
  },
  {
    literal: "entitlements.plist", file: "scripts/server-bundle.integration.test.ts",
    reason: "Temporary codesign entitlement plist the integration test writes to re-sign the backend."
  },
  {
    literal: "libkrunfw.5.dylib", file: "scripts/server-bundle.integration.test.ts",
    reason: "Third-party libkrunfw shared-library basename packaged by bundle-microsandbox.ts."
  },
  {
    literal: "deleted", file: "e2e/contracts/file-reload.spec.ts",
    reason: "FileCard.gone discriminator declared by @smthrs/rpc/FileCard; this compares file state, never a card kind."
  },
  {
    literal: "renamed", file: "e2e/contracts/file-reload.spec.ts",
    reason: "FileCard.gone discriminator declared by @smthrs/rpc/FileCard; this compares file state, never a card kind."
  },
  {
    literal: "review", file: "e2e/local/setup-no-github.spec.ts",
    reason: "TODO EvidenceItem discriminator declared in ui-components.md; the callback reads attempt.items, never cards."
  },
  {
    literal: "check", file: "e2e/local/team-no-github.spec.ts",
    reason: "TODO EvidenceItem discriminator declared in ui-components.md; the callback reads attempt.items, never cards."
  },
  {
    literal: "review", file: "e2e/local/team-no-github.spec.ts",
    reason: "TODO EvidenceItem discriminator declared in ui-components.md; the callback reads attempt.items, never cards."
  },
  {
    literal: "smithers-local-own-", file: "e2e/playwright/debug-api/local-own-read.ts",
    reason: "Child-owned temporary directory prefix emitted by scripts/mode-matrix/local-own.ts, outside product src."
  },
  {
    literal: "guard-", file: "e2e/playwright/debug-api/local-own-read.ts",
    reason: "Debug-API runner case-name prefix selecting missing-composition tests, never an application card ID."
  },
  {
    literal: "prompt", file: "e2e/playwright/entry-row.spec.ts",
    reason: "EntryRowCard conversation-entry discriminator rendered by EntryRow.tsx; not a wire Card kind."
  },
  {
    literal: "answer", file: "e2e/playwright/entry-row.spec.ts",
    reason: "EntryRowCard conversation-entry discriminator rendered by EntryRow.tsx; not a wire Card kind."
  },
  {
    literal: "action", file: "e2e/playwright/home.spec.ts",
    reason: "Story callback discriminator emitted by cards/views/view-stories.tsx; not a wire Card kind."
  },
  {
    literal: "smithers-lan.test", file: "e2e/playwright/notifications.spec.ts",
    reason: "Test-owned DNS hostname routed back to loopback to exercise an insecure LAN origin."
  },
  {
    literal: "op-", file: "e2e/playwright/spec/C-GH-01.spec.ts",
    reason: "Fake setup HTTP operation ID created by the route fixture; not a card ID emitted by the application."
  },
  {
    literal: "question", file: "e2e/playwright/spec/C-J4-02.spec.ts",
    reason: "TodoModel.waits discriminator from the J4 fixture; this finds the question wait, never a card."
  },
  {
    literal: "action", file: "e2e/playwright/spec/C-UI-12.spec.ts",
    reason: "Story callback discriminator emitted by cards/views/view-stories.tsx; not a wire Card kind."
  },
  {
    literal: "agent", file: "e2e/playwright/spec/C-UI-12.spec.ts",
    reason: "Actor kind rendered by the CodeMirror adapter on code-name-flag; not a wire Card kind."
  },
  {
    literal: "view", file: "e2e/playwright/spec/C-UI-12.spec.ts",
    reason: "Story callback discriminator emitted by cards/views/view-stories.tsx; not a wire Card kind."
  },
  {
    literal: "page", file: "e2e/playwright/view-stories.spec.ts",
    reason: "ContextLineCard item discriminator rendered by ContextLine.tsx; not a wire Card kind."
  },
  {
    literal: "svg.lucide-maximize2", file: "e2e/playwright/view-stories.spec.ts",
    reason: "Third-party lucide-react Maximize2 SVG class, supplied by Lucide rather than product source."
  },
  {
    literal: "app-address-", file: "e2e/real/github-j10/app-manifest.spec.ts",
    reason: "Test-owned HTTP Idempotency-Key for the setup address request, never an application card ID."
  },
  {
    literal: "control.approval.approved", file: "e2e/real/runs-continue.spec.ts",
    reason: "Native gateway journal event kind declared by packages/smithers/gateway, outside the app card vocabulary."
  },
  {
    literal: "control.approval.requested", file: "e2e/real/runs-continue.spec.ts",
    reason: "Native gateway journal event kind declared by packages/smithers/gateway, outside the app card vocabulary."
  },
  {
    literal: "api-", file: "e2e/real/todo/reference.ts",
    reason: "Playwright JSON attachment filename prefix supplied to attachJson; never an application card ID."
  }
]

/*
 * Literals that ARE orphans, deferred rather than excused.
 *
 * These are open defects of the same class this pin exists to catch, found by
 * running it. They are listed here so the pin can guard everything else in
 * those files instead of staying red, and each carries an inverted assertion
 * below: the moment the product emits the attribute (or the probe stops asking
 * for it), the entry stops matching and this suite fails until it is deleted.
 */
const KNOWN_ORPHANS: ReadonlyArray<Excuse> = [
  {
    literal: "files.read", file: "e2e/real/agents.spec.ts",
    reason: "AgentCards.tsx ProfileRowView no longer renders an instruction-file action; file is registered but replacing the name would still select no button. Instruction-link behavior needs the View owner."
  },
  {
    literal: "data-toast-status", file: "e2e/real/local-persistence.spec.ts",
    reason: "e2e/real/local-persistence.spec.ts: ToastStackView renders notice[data-tone], without the former toast-detail disclosure; updating only the status selector would leave recovery assertions dead."
  },
  {
    literal: "workflow-repo", file: "scripts/live-workflow-check.ts",
    reason: "scripts/live-workflow-check.ts: the former watched-repository chooser is absent; repo.choose now opens install Setup and cannot resume this old create scenario."
  },
  {
    literal: "flow.repo.choose", file: "scripts/live-workflow-check.ts",
    reason: "scripts/live-workflow-check.ts: the former workflow chooser action is absent; repo.choose opens Setup rather than choosing a watched repo for flow creation."
  },
  {
    literal: "data-content", file: "e2e/playwright/spec/C-UI-02.spec.ts",
    reason: "e2e/playwright/spec/C-UI-02.spec.ts: productWords.ts supports excluding this marker but no current View renders it; copy-scope behavior needs design/engineering ownership."
  },
  {
    literal: "p.branch-muted", file: "e2e/playwright/view-stories.spec.ts",
    reason: "e2e/playwright/view-stories.spec.ts: BranchView no longer renders the Nobody here paragraph; the empty-presence visual assertion needs design review."
  },
  {
    literal: "account", file: "e2e/real/auth-permissions.spec.ts",
    reason: "e2e/real/auth-permissions.spec.ts: account.show now opens Settings; the former account-login projection is absent, so changing the kind alone would leave the scenario dead."
  },
  {
    literal: "change.land", file: "e2e/real/coverage/deferrals.ts",
    reason: "e2e/real/coverage/deferrals.ts: the old change landing affordance is absent; TODO merging uses prs.land and different IDs/arguments, so this scenario needs a full rewrite."
  },
  {
    literal: "repo-import", file: "e2e/real/issues/cloud.ts",
    reason: "e2e/real/issues/cloud.ts: RepoImportSeam retains import records but no live wire repo-import card/renderer exists; the job scenario needs an owner decision."
  }
]

const ALLOWLIST: ReadonlyArray<Excuse> = [...RESOLVES_ELSEWHERE, ...KNOWN_ORPHANS]

const excuses = (violation: Violation, list: ReadonlyArray<Excuse>): ReadonlyArray<Excuse> =>
  list.filter((entry) => entry.literal === violation.value && entry.file === shortPath(violation.file))

const manifest = await manifestFlowNames()
const vocabularies: Vocabularies = {
  flowNames: declaredFlowNames(),
  cardKinds: cardKinds(),
  renderedCardKinds: renderedCardKinds(),
  cardActionNames: cardActionNames(),
  cardIdPrefixes: cardIdPrefixes(),
  dataAttributes: new Set([...emittedDataAttributes(), ...stampedDataAttributes(TREES)]),
  dottedIdentifiers: productDottedIdentifiers(),
  composedDottedHeads: composedDottedHeads(),
  productStringLiterals: productStringLiterals(),
  cardObjectFields: cardObjectFields(),
  idVocabularySegments: idVocabularySegments()
}
// These files parse test topology, select scenarios, or test those parsers.
// Their identifiers and credential/driver kinds belong to the harness schema.
// Scenario bodies and browser helpers remain scanned for app vocabulary.
const sourceParserFiles = new Set([
  "e2e/real/coverage/gate.ts", "e2e/real/coverage/gate.test.ts",
  "e2e/real/coverage/matrix.ts", "e2e/real/coverage/matrix.test.ts",
  "e2e/real/coverage/selection.test.ts"
])
/*
 * The fixture graph's own node addresses are not app vocabulary.
 *
 * `e2e/graph/workspace.ts` writes down the eleven ids the engine derives from
 * the fixture flow's structure, so the Chromium tier can read them back off
 * the drawn graph rather than recompute them from the builder the app reads
 * them through. They are dotted, they are data, and no product source spells
 * one — which is the rule's whole premise, so the rule cannot judge them. Only
 * `dotted-identifier` is lifted here: a flow id, a card kind or a `data-*`
 * selector in that file still rots the same way every other suite's does.
 */
const engineDerivedIds = new Set(["e2e/graph/workspace.ts"])
const literals = literalsUnder(TREES).filter(literal => !sourceParserFiles.has(shortPath(literal.file)))
const violations = literals
  .flatMap((literal) => [...violationsOf(literal, vocabularies)])
  .filter((violation) =>
    violation.rule !== "dotted-identifier" || !engineDerivedIds.has(shortPath(violation.file))
  )

describe("the vocabularies are derived from the app and are never empty", () => {
  /*
   * A conformance pin whose derivation returns nothing passes vacuously: with
   * no vocabulary, no literal can be orphaned. That is this lane's own version
   * of the defect it exists to close, so every derived set carries a floor.
   * The idiom and the numbers follow registry.test.ts's "every registered flow
   * leads its own name's listing", which walks the real catalog through the
   * controller behind `expect(listed.length).toBeGreaterThan(40)`.
   */
  test("the product source corpus is the whole app", () => {
    // 325 files today, the app's own source and the shared wire model, with
    // every test and fixture dropped. A corpus that collapses below half the
    // app is a broken path, not a smaller app.
    expect(productSourceFiles().length).toBeGreaterThan(60)
  })

  test("the discovery excludes the app's own test files", () => {
    /*
     * The authority answers "does the app still spell this name", so a file
     * that only asserts against the app cannot be part of it. Leaving the
     * unit tests in kept a retired name alive for as long as one stale test
     * mentioned it, which is the rename this pin exists to catch. The second
     * expectation is the floor under the first: the tests are really there
     * to exclude, so a corpus with none of them is an exclusion and not a
     * broken path.
     */
    expect(productSourceFiles().filter((file) => assertsAgainstTheApp(file))).toEqual([])
    expect(sourceFiles(UI_SRC).filter((file) => assertsAgainstTheApp(file)).length).toBeGreaterThan(100)
  })

  test("every card kind the wire model declares is derived", () => {
    // 28 today, one per shipped card; the union has never been below the
    // ten waves' worth of cards that shipped by Wave 10.
    expect(vocabularies.cardKinds.size).toBeGreaterThan(20)
    // Derived from the schema, so this is a spot check on the derivation
    // itself rather than a second hand-written list.
    expect(vocabularies.cardKinds.has("run-trace")).toBe(true)
    expect(vocabularies.cardKinds.has("flow-run")).toBe(false)
    expect(vocabularies.cardKinds.has("workflow-run")).toBe(false)
  })

  test("the flow declarations and the rendered manifest agree", () => {
    // 88 declared (base plus the admin plugin), 70 in a non-admin session's
    // manifest. registry.test.ts already refuses a catalog below 40.
    expect(vocabularies.flowNames.size).toBeGreaterThan(60)
    expect(manifest.size).toBeGreaterThan(40)
    // The manifest is what App.tsx renders into data-flows. A name that
    // reaches the shell but is declared nowhere would make the DOM and the
    // declarations disagree, and every selector pinned to the declarations
    // would then be checkable against the wrong set.
    expect([...manifest].filter((name) => !vocabularies.flowNames.has(name))).toEqual([])
  })

  test("the run-launch claim names registered flows", () => {
    // The 2026-08-15 rename's worst single casualty: a stub emitted a tool
    // call for `workflow.create` while RunClaims listed `flow.create`, so
    // nothing was ever claimed and the substitution guard never armed. A
    // launch name that is not a flow can claim nothing.
    expect(RUN_LAUNCH_COMMANDS.length).toBeGreaterThan(0)
    expect(RUN_LAUNCH_COMMANDS.filter((name) => !vocabularies.flowNames.has(name))).toEqual([])
  })

  test("the DOM attribute contract is derived from what the app renders", () => {
    // 77 today across the app's components and @smthrs/ui. The app's own
    // .tsx files alone carry 17.
    expect(vocabularies.dataAttributes.size).toBeGreaterThan(30)
    expect(vocabularies.dataAttributes.has("data-flow")).toBe(true)
    expect(vocabularies.dataAttributes.has("data-flows")).toBe(true)
    // PressActions writes this through toggleAttribute, including key release.
    expect(vocabularies.dataAttributes.has("data-pressed")).toBe(true)
    expect(vocabularies.dataAttributes.has("data-command")).toBe(false)
  })

  test("the card id prefixes and dotted identifiers are derived", () => {
    // 186 prefixes and 477 dotted identifiers today.
    expect(vocabularies.cardIdPrefixes.size).toBeGreaterThan(10)
    expect(vocabularies.cardIdPrefixes.has("flow-run-")).toBe(true)
    expect(vocabularies.dottedIdentifiers.size).toBeGreaterThan(100)
    expect(vocabularies.dottedIdentifiers.has("flow.create")).toBe(true)
    expect(vocabularies.dottedIdentifiers.has("workflow.create")).toBe(false)
  })
})

describe("the extraction reaches every tree and every rule fires", () => {
  /*
   * The second half of the vacuity guard. Derived vocabularies with nothing to
   * check against them pass just as emptily, so each rule's input population
   * carries its own floor: a rule that silently stops matching anything is a
   * rule that has stopped working.
   */
  test("every tree is scanned", () => {
    // 57 files today: the runners and doubles, the harness and its suites,
    // and the checklist. Other lanes add files, so the count drifts up; the
    // floors below are what a broken path or a lost tree trips.
    for (const tree of TREES) expect(sourceFiles(tree).length).toBeGreaterThan(5)
    expect(TREES.flatMap((tree) => [...sourceFiles(tree)]).length).toBeGreaterThan(30)
    // 2198 literals today (the web e2e suites and the wrangler doubles left
    // with the local-app cut; the Playwright specs and the checklist remain).
    expect(literals.length).toBeGreaterThan(1000)
  })

  const population = (predicate: (literal: (typeof literals)[number]) => number): number =>
    literals.reduce((total, literal) => total + predicate(literal), 0)

  test("each rule has literals to check", () => {
    // Today (local-app cut): 68 dotted identifiers. Each floor is roughly
    // half of what the trees carry, so ordinary churn does not trip it but a
    // rule that stops matching does.
    expect(
      population((literal) =>
        literal.form === "string" && DOTTED_IDENTIFIER.test(literal.value) && !FILE_NAME.test(literal.value) ? 1 : 0
      )
    ).toBeGreaterThan(30)
    expect(population((literal) => dataAttributesIn(literal.value).length)).toBeGreaterThan(30)
    /*
     * The card-kind comparisons, the [data-kind]/[data-flow] selector values
     * and the id prefixes were carried by the web e2e suites, which left with
     * the local-app cut (LOCAL-APP.md). The rules stay armed; their floors
     * return with the M1/M2 Playwright specs that assert cards and tabs.
     */
  })

})

describe("every literal the suites assert against still resolves", () => {
  test("no orphaned literal outside the allowlist", () => {
    const unexcused = violations.filter((violation) => excuses(violation, ALLOWLIST).length === 0)
    const report = unexcused.map((violation) =>
      `${shortPath(violation.file)}:${violation.line}  [${violation.rule}] ${violation.message}`
    )
    // Printing every orphan at once is the point: a rename orphans a family
    // of literals, and fixing them one failure per run is how the sweep gets
    // abandoned halfway.
    expect(report).toEqual([])
  })

  test("every allowlist entry carries a reason", () => {
    const reasonless = ALLOWLIST.filter((entry) => entry.reason.trim().length < 20)
    expect(reasonless.map((entry) => `${entry.file}: ${entry.literal}`)).toEqual([])
  })

  test("no literal is excused twice", () => {
    /*
     * One (literal, file) pair, one entry. A second entry for the same pair is
     * a spare licence: the staleness test above is satisfied by whichever of
     * the two still matches, so the extra one can never expire and the next
     * literal to land on that name inherits it in silence. A merge put a
     * second `smthrs-flow-graph-` entry on this list and nothing failed.
     */
    const seen = new Map<string, number>()
    for (const entry of ALLOWLIST) {
      const pair = `${entry.file}: ${entry.literal}`
      seen.set(pair, (seen.get(pair) ?? 0) + 1)
    }
    expect([...seen].filter(([, count]) => count > 1).map(([pair]) => pair)).toEqual([])
  })

  test("no allowlist entry outlives the literal it excuses", () => {
    const stale = ALLOWLIST.filter((entry) =>
      !violations.some((violation) => violation.value === entry.literal && shortPath(violation.file) === entry.file)
    )
    // A stale entry is a licence nobody is using — and the next literal to
    // land on that name inherits it silently.
    expect(stale.map((entry) => `${entry.file}: ${entry.literal}`)).toEqual([])
  })

  test("every deferred orphan is still an orphan", () => {
    // The inverted assertion, copied from packages/smithers/flows'
    // vitestCoverageIsolation deferral sets: the day the product emits the
    // attribute, this entry stops matching and the test above fails until
    // the entry is deleted. A deferral that cannot expire is a permanent
    // exception wearing a temporary label.
    for (const entry of KNOWN_ORPHANS) {
      const matched = violations.filter((violation) =>
        violation.value === entry.literal && shortPath(violation.file) === entry.file
      )
      expect(matched.length, `${entry.file}: ${entry.literal} is fixed — delete its KNOWN_ORPHANS entry`)
        .toBeGreaterThan(0)
    }
  })

  test("the allowlist stays small enough to read", () => {
    // The current-main sweep includes external protocol domains and deferred
    // retired surfaces. Keep a finite bound; stale and duplicate entries still fail.
    expect(ALLOWLIST.length).toBeLessThanOrEqual(160)
  })
})

test("composed form test ids require both live prefixes and a registered flow", () => {
  const literal = extractLiterals("/fixture/form.spec.ts", 'page.getByTestId("card-form-issue.add-flow")')[0]!
  expect(violationsOf(literal, vocabularies)).toEqual([])
  for (const prefix of ["card-", "form-"]) {
    const cardIdPrefixes = new Set([...vocabularies.cardIdPrefixes].filter(value => value !== prefix))
    expect(violationsOf(literal, { ...vocabularies, cardIdPrefixes }).map(violation => violation.rule))
      .toEqual(["dotted-identifier"])
  }
  const flowNames = new Set([...vocabularies.flowNames].filter(value => value !== "issue.add-flow"))
  expect(violationsOf(literal, { ...vocabularies, flowNames }).map(violation => violation.rule))
    .toEqual(["dotted-identifier"])
  for (const source of [
    'page.getByTestId("card-form-issue.retired-flow")',
    'page.getByTestId("invented-form-issue.add-flow")',
    'controller.runCommand("card-form-issue.add-flow")',
    'page.locator("main.retired-class")'
  ]) {
    expect(extractLiterals("/fixture/form.spec.ts", source).flatMap(value => [...violationsOf(value, vocabularies)]).length)
      .toBeGreaterThan(0)
  }
})

test("real scenario IDs do not excuse product assertions", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { scenario as evidence } from "./coverage/types";'
  expect(check(imports + 'evidence("workflow.create", { coverage: [] });')).toEqual([])
  for (const statement of [
    'runCommand("workflow.create")',
    'page.locator("[data-flow=\\\"workflow.create\\\"]")',
    'value.startsWith("flow-fixture-")',
    'other({name: `flow-fixture-${nonce}`})',
    'scenario("workflow.create", {})'
  ]) expect(check(imports + statement).length).toBeGreaterThan(0)
  expect(check('import { scenario } from "./unrelated"; scenario("workflow.create", {})').length).toBeGreaterThan(0)
  expect(check('import { scenario } from "./coverage/types"; scenario("case", { flow: "workflow.create" })').length).toBeGreaterThan(0)
  expect(check(imports + 'function nested(evidence) { evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
  expect(check(imports + 'function nested() { function evidence() {} evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
  expect(check(imports + 'try {} catch(evidence) { evidence("workflow.create", {}) }').length).toBeGreaterThan(0)
})

test("fixture value provenance is import-bound and cannot hide nested or aliased product claims", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureCommentBody as comment, fixtureRepositoryName as repository, fixtureAttachmentName as attachment } from "./support/values"; import { attachProductionJson as evidence } from "./repositories-github/production";'
  expect(check(imports + [
    'const body = comment(`practice-comment-${nonce}`); textbox.fill(body); expect(card).toContainText(body);',
    'const name = repository(`smithers-e2e-import-pr-${nonce}`);',
    'const uniqueRepositoryName = () => repository(`smithers-e2e-import-s12-${nonce}`);',
    'evidence(testInfo, attachment(`owned-workflow-run-cleanup-${runId}`), { runId });'
  ].join("\n"))).toEqual([])
  for (const source of [
    'const body = comment(`workflow-run-${nonce}`); const alias = body; page.getByTestId(alias);',
    'const body = comment("workflow.create"); runCommand(body);',
    'runCommand(comment("workflow.create"));',
    'page.getByTestId(repository(`workflow-run-${nonce}`));',
    'card.id.startsWith(comment("workflow-run-"));',
    'page.locator(attachment("[data-flow=\\\"workflow.create\\\"]"));',
    'const body = comment("[data-kind=\\\"workflow-run\\\"]");',
    'const body = comment("[data-command]");',
    'const frame = { id: "x", kind: comment("workflow-run"), title: "x", status: "active" };',
    'function nested(comment) { const value = comment(`workflow-run-${nonce}`) }',
    'function nested() { function comment() {} const value = comment(`workflow-run-${nonce}`) }',
    'try {} catch (comment) { const value = comment(`workflow-run-${nonce}`) }',
    'other(testInfo, attachment(`workflow-run-${nonce}`), {});',
    'evidence(testInfo, attachment(`workflow-run-${nonce}`), { kind: "workflow-run", id: "x", title: "x", status: "active" });'
  ]) expect(check(imports + source).length, source).toBeGreaterThan(0)
  expect(check('import { fixtureCommentBody as comment } from "./unrelated"; const body = comment(`workflow-run-${nonce}`);').length).toBeGreaterThan(0)
  expect(fixtureRepositoryName("smithers-e2e-import-s12-abc-123")).toBe("smithers-e2e-import-s12-abc-123")
  for (const name of ["canary-sandbox", "../smithers-e2e-import-x", "smithers-e2e-import-"]) {
    expect(() => fixtureRepositoryName(name)).toThrow("owned cleanup namespace")
  }
})

test("fixture workflow input and protocol IDs preserve explicit product checks", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureInputText as input, fixtureProtocolId as protocol } from "./support/values";'
  expect(check(imports + 'const text = input(`s15-input-${nonce}`); field.fill(text); const response = { sessionId: protocol(`session-${id}`) };')).toEqual([])
  for (const statement of [
    'const id = protocol(`missing-card-${nonce}`); const alias = id; page.getByTestId(alias);',
    'const name = input("workflow.create"); runCommand(name);',
    'runCommand(input("workflow.create"));',
    'page.locator(protocol("[data-kind=\\\"workflow-run\\\"]"));',
    'const card = { kind: input("workflow-run"), id: "x", title: "x", status: "active" };',
    'function nested(input) { const text = input(`missing-card-${nonce}`) }',
    'function nested() { function protocol() {} const id = protocol(`missing-card-${nonce}`) }',
    'try {} catch (protocol) { const id = protocol(`missing-card-${nonce}`) }'
  ]) expect(check(imports + statement).length, statement).toBeGreaterThan(0)
  const inputClaim = 'const text = input(`missing-card-${nonce}`);'
  expect(check('import { fixtureInputText as input } from "./support/values";' + inputClaim)).toEqual([])
  expect(check('import { fixtureInputText as input } from "./unrelated";' + inputClaim).map(violation => violation.rule))
    .toContain("card-id-prefix")
})

test("fixture input provenance follows a local factory's selected return field", () => {
  const check = (source: string) => extractLiterals("/app/e2e/real/probe.spec.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureInputText as input } from "./support/values";'
  expect(check(imports + [
    'const make = async (text, serverId) => { await submit(text); const id = await accepted(serverId); return { text, id }; };',
    'const text = input(`missing-card-${nonce}`); const row = await make(text, observedId);',
    'page.getByTestId(row.id);'
  ].join("\n"))).toEqual([])
  for (const factory of [
    'const make = (text) => ({ id: text });',
    'const make = async (text) => { const alias = text; return { id: alias }; };',
    'const make = (text) => { const id = decorate(text); return { id }; };',
    'const make = (text) => ({ text, id: text });',
    'const make = (text) => { runCommand(text); return { id: observedId }; };',
    'const make = (text) => { if (flag) return { id: text }; return { id: observedId }; };',
    'const make = (text) => ({ id: observedId, ...text });',
    'const make = (text) => external(text);',
    'import { make } from "./external";'
  ]) {
    const source = imports + factory + 'const text = input(`missing-card-${nonce}`); const row = await make(text); page.getByTestId(row.id);'
    expect(check(source).length, factory).toBeGreaterThan(0)
  }
  expect(check(imports + 'const make = (text) => ({ id: text }); const text = input(`missing-card-${nonce}`); const a = make(observedId); const b = make(text); page.getByTestId(a.id); page.getByTestId(b.id);').length).toBeGreaterThan(0)
  expect(check(imports + 'const text = input(`missing-card-${nonce}`); const row = { id: text }; page.getByTestId(row.id);').length).toBeGreaterThan(0)
  expect(check(imports + 'const text = input(`missing-card-${nonce}`); page.getByTestId(decorate(text));').length).toBeGreaterThan(0)
  expect(check(imports + 'const make = () => { const text = input(`missing-card-${nonce}`); return { id: text }; }; const row = make(); page.getByTestId(row.id);').length).toBeGreaterThan(0)
})

test("canonical card prefixes preserve opaque API repository suffix provenance", () => {
  const check = (source: string, file = "/app/e2e/real/probe.spec.ts") => extractLiterals(file, source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  const imports = 'import { fixtureProtocolId as protocol } from "./support/values";'
  const repository = 'const name = protocol(`smithers-e2e-secrets-${nonce}`);'
  expect(vocabularies.cardIdPrefixes.has("card-")).toBe(true)
  expect(vocabularies.cardIdPrefixes.has("secrets-")).toBe(true)
  for (const lookup of [
    'page.getByTestId(`card-secrets-${name}`);',
    'const repo = `${username}/${name}`; page.getByTestId(`card-secrets-${repo}`);',
    'const alias = name; const id = `card-secrets-${alias}`; page.getByTestId(id);',
    'function select(repo) { page.getByTestId(`card-secrets-${repo}`); } select(name);',
    'const make = (repo) => ({ id: `card-secrets-${repo}` }); const row = make(name); page.getByTestId(row.id);'
  ]) expect(check(imports + repository + lookup), lookup).toEqual([])
  expect(check('import { fixtureProtocolId as protocol } from "../support/values";' + repository +
    'page.getByTestId(`card-secrets-${name}`);', "/app/e2e/real/nested/probe.spec.ts")).toEqual([])
})

test("opaque suffix provenance requires every composed prefix to be emitted by product source", () => {
  const source = 'import { fixtureProtocolId as protocol } from "./support/values";' +
    'const name = protocol(`smithers-e2e-secrets-${nonce}`); page.getByTestId(`card-secrets-${name}`);'
  const check = (text: string, vocabulary = vocabularies) => extractLiterals("/app/e2e/real/probe.spec.ts", text)
    .flatMap(literal => [...violationsOf(literal, vocabulary)])
  for (const head of ["card-missing-", "canary-probe-", "card-secrets-extra-"]) {
    expect(check(source.replace("card-secrets-${name}", head + "${name}"))
      .some(violation => violation.value === "smithers-e2e-secrets-" && violation.rule === "card-id-prefix"), head).toBe(true)
  }
  for (const removed of ["card-", "secrets-"]) {
    const prefixes = new Set(vocabularies.cardIdPrefixes)
    prefixes.delete(removed)
    expect(check(source, { ...vocabularies, cardIdPrefixes: prefixes })
      .some(violation => violation.value === "smithers-e2e-secrets-")).toBe(true)
  }
  expect(check(source + 'page.getByTestId(`canary-probe-${name}`);')
    .some(violation => violation.value === "smithers-e2e-secrets-")).toBe(true)
})

test("direct and mixed product uses cannot inherit a composed suffix exemption", () => {
  const imports = 'import { fixtureProtocolId as protocol } from "./support/values";'
  const repository = 'const name = protocol(`smithers-e2e-secrets-${nonce}`);'
  const composed = 'page.getByTestId(`card-secrets-${name}`);'
  for (const direct of [
    'page.getByTestId(name);',
    'const alias = name; page.getByTestId(alias);',
    'runCommand(name);',
    'row.id.startsWith(name);',
    'row.id.endsWith(name);',
    'page.locator(name);'
  ]) for (const uses of [direct, composed + direct, direct + composed]) {
    const violations = extractLiterals("/app/e2e/real/probe.spec.ts", imports + repository + uses)
      .flatMap(literal => [...violationsOf(literal, vocabularies)])
    expect(violations.some(violation => violation.value === "smithers-e2e-secrets-"), uses).toBe(true)
  }
  const unbackedImport = imports.replace("./support/values", "./unrelated")
  expect(extractLiterals("/app/e2e/real/probe.spec.ts", unbackedImport + repository + composed)
    .flatMap(literal => [...violationsOf(literal, vocabularies)]).length).toBeGreaterThan(0)
})

test("extracts rendered selectors from JSX attributes and nested components", () => {
  const source = [
    'const controls = <section data-testid="agent-session-header">',
    '  <p>session {sessionId} · {repo}</p>{live ? (<div><Button data-testid={`agent-session-stop-${sessionId}`}>Stop</Button></div>) : null}{running ? (<Button data-testid={`flow-run-stop-${runId}`}>Stop</Button>) : null}',
    '</section>'
  ].join("\n")
  const selectors = new Set(["agent-session-header", "agent-session-stop-", "flow-run-stop-"])
  expect(extractLiterals("/fixture/controls.tsx", source)
    .filter(literal => selectors.has(literal.value))
    .map(({ value, form, line }) => ({ value, form, line }))).toEqual([
    { value: "agent-session-header", form: "string", line: 1 },
    { value: "agent-session-stop-", form: "template-head", line: 2 },
    { value: "flow-run-stop-", form: "template-head", line: 2 }
  ])
})

test("keeps TypeScript generic arrows parseable in .ts files", () => {
  const source = 'const identity = <T>(value: T): T => value; const id = identity(`flow-run-stop-${runId}`);'
  expect(extractLiterals("/fixture/identity.ts", source)
    .map(({ value, form }) => ({ value, form }))).toContainEqual({ value: "flow-run-stop-", form: "template-head" })
})

test("only a positive same-receiver delta guard removes a non-card kind claim", () => {
  const check = (source: string) => extractLiterals("/fixture/frames.ts", source)
    .flatMap(literal => [...violationsOf(literal, vocabularies)])
  expect(check('frames.filter(frame => frame.type === "delta" && frame.kind === "text")')).toEqual([])
  for (const source of [
    'frame.type !== "delta" && frame.kind === "text"',
    'frame.type === "delta" || frame.kind === "text"',
    'other.type === "delta" && frame.kind === "text"',
    'frame.kind === "text"'
  ]) expect(check(source).map(value => value.rule)).toContain("card-kind")
})

describe("the pin catches the 2026-08-15 rename it was built for", () => {
  /*
   * The regression fixture. A guard that cannot demonstrate catching the
   * defect it was built for is decoration, so the four literal classes that
   * survived that rename are fed back through the extractor verbatim.
   */
  const FIXTURE = [
    `import { fail } from "./harness";`,
    `const toolCall = { name: "workflow.create", arguments: "{}" };`,
    `controller.runCommand("workflow.create");`,
    `if (card.kind !== "workflow-run") fail("no run card");`,
    `const runCardId = \`workflow-run-\${runId}\`;`,
    `await page.evaluate(\`document.querySelector('[data-command="flow.run"]')\`);`,
    ""
  ].join("\n")

  const fixtureViolations = extractLiterals("/fixture/worker-e2e.ts", FIXTURE)
    .flatMap((literal) => [...violationsOf(literal, vocabularies)])

  test("all four dead literal classes are reported", () => {
    const reported = fixtureViolations.map((violation) => `${violation.rule}:${violation.value}`)
    expect(reported).toContain("dotted-identifier:workflow.create")
    expect(reported).toContain("flow:workflow.create")
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-id-prefix:workflow-run-")
    expect(reported).toContain("data-attribute:data-command")
  })

  test("each failure names the surviving member", () => {
    const messages = fixtureViolations.map((violation) => violation.message)
    expect(messages.some((message) => message.includes(`"workflow.create"`) && message.includes(`"flow.create"`)))
      .toBe(true)
    // The run card is `run-trace` now (factory spec 06), which shares no tail with `workflow-run`,
    // so the dead kind is reported with no lead rather than a stranger; `flow-run` is retired too.
    expect(messages.some((message) => message.includes(`"workflow-run"`) && !message.includes(`"flow-run"`))).toBe(true)
    expect(messages.some((message) => message.includes(`"run-trace"`))).toBe(false)
    // The flow-run form's prefix is now a closer lead (three edits versus four).
    expect(messages.some((message) => message.includes(`"workflow-run-"`) && message.includes(`"form-flow-run-"`))).toBe(
      true
    )
    // `data-command` → `data-flow` shares no tail, so the pin names the dead
    // attribute and says what is wrong with it rather than guessing.
    const attribute = messages.find((message) => message.includes(`"data-command"`))
    expect(attribute).toContain("is on no element this app renders")
    expect(attribute).not.toContain("Did you mean")
  })

  test("the surviving literals in the same shapes are clean", () => {
    const CLEAN = [
      `controller.runCommand("flow.new");`,
      `if (card.kind !== "run-trace") fail("no run card");`,
      `const runCardId = \`flow-run-\${runId}\`;`,
      `await page.evaluate(\`document.querySelector('[data-flow="flow.run"]')\`);`,
      ""
    ].join("\n")
    const clean = extractLiterals("/fixture/clean.ts", CLEAN)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
    expect(clean).toEqual([])
  })

  test("a literal that only appears in a comment is not an assertion", () => {
    // The extractor parses with the TypeScript parser rather than grepping,
    // so prose about the old name does not read as a claim that it exists.
    const COMMENTED = [
      `// The old name was "workflow.create" and the old kind was "workflow-run".`,
      `/* [data-command="flow.run"] was the selector before the rename. */`,
      `const ok = true;`,
      ""
    ].join("\n")
    const commented = extractLiterals("/fixture/commented.ts", COMMENTED)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
    expect(commented).toEqual([])
  })
})

describe("a card kind is checked wherever it appears, not only in the two easy positions", () => {
  /*
   * The hole the first cut of this pin left open, and the reason it is the
   * defect the pin exists to catch one level up: card kinds were checked only
   * inside `[data-kind="…"]` selectors and direct `.kind ===` comparisons.
   * Every other way a suite names a kind — and passing it as an argument is
   * the common one — sailed through. A suite calling `cardOfKind(client,
   * "workflow-run")` after the rename asks for a card that cannot exist,
   * finds nothing, and reports the absence as a pass.
   *
   * Each fixture below is one such position, in the shape the suites really
   * use, with a dead kind in it.
   */
  const reportOf = (name: string, source: string): ReadonlyArray<string> =>
    extractLiterals(`/fixture/${name}.ts`, source)
      .flatMap((literal) => [...violationsOf(literal, vocabularies)])
      .map((violation) => `${violation.rule}:${violation.value}`)

  test("a dead kind passed as a function argument is reported", () => {
    // connectors.e2e.ts's own helper, verbatim in shape: the parameter is
    // compared against `card.kind`, so every literal handed to that
    // parameter is a card-kind claim.
    const FIXTURE = [
      `const cardOfKind = <K extends string>(client: Client, kind: K) =>`,
      `\tclient.cards().find((card) => card.kind === kind);`,
      `const dead = cardOfKind(client, "workflow-run");`,
      ""
    ].join("\n")
    expect(reportOf("argument", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind interpolated into a selector helper is reported", () => {
    // cards-approvals.e2e.ts builds its CDP expression this way. The static
    // text carries `[data-kind=` and the kind arrives through the hole in it.
    const FIXTURE = [
      "const selectorFor = (kind: string): string =>",
      "\t`section[data-kind=${JSON.stringify(kind)}]`;",
      `await page.evaluate(selectorFor("workflow-run"));`,
      ""
    ].join("\n")
    expect(reportOf("selector-helper", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind in a card object literal is reported", () => {
    // The frames the suites script are card objects. `kind` alone means
    // nothing — half the wire model has a `kind` — so the object has to look
    // like a card before its kind is read as one.
    const FIXTURE = [
      `stack.chat.script({ frames: [card({`,
      `\tid: "copy-run-done",`,
      `\tkind: "workflow-run",`,
      `\ttitle: "Run finished",`,
      `\tstatus: "acted",`,
      `\tcreatedAt: 1700000000000,`,
      `\tordinal: 10,`,
      `\tpayload: {},`,
      `})] });`,
      ""
    ].join("\n")
    expect(reportOf("card-object", FIXTURE)).toContain("card-kind:workflow-run")
  })

  test("a dead kind reached through a name, a ternary, an array or a default is reported", () => {
    const FIXTURE = [
      `const wanted = "workflow-run";`,
      `if (card.kind === wanted) fail("still here");`,
      `const picked = admin ? "workflow-status" : "run-trace";`,
      `if (card.kind !== picked) fail("no card");`,
      `for (const kind of ["workflow-approval", "run-trace"]) {`,
      `\tif (card.kind === kind) fail("kind is back");`,
      `}`,
      `const { kind = "workflow-plan" } = frame;`,
      `if (card.kind === kind) fail("default is back");`,
      ""
    ].join("\n")
    const reported = reportOf("indirect", FIXTURE)
    // One dead kind per route, so no route can pass on another's finding.
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-kind:workflow-status")
    expect(reported).toContain("card-kind:workflow-approval")
    expect(reported).toContain("card-kind:workflow-plan")
    // The live kind in two of the same shapes is not reported.
    expect(reported).not.toContain("card-kind:run-trace")
  })

  test("a dead kind in a switch case or a membership set is reported", () => {
    // Two more spellings of "compared against a `.kind`". The parser sees a
    // `switch` case and a `KINDS.has(card.kind)` as neither a `===` nor a
    // selector, so the discovery rule had to name them or stay blind to a
    // suite that branches on kind instead of asserting on it.
    const FIXTURE = [
      `switch (card.kind) {`,
      `\tcase "workflow-run":`,
      `\t\treturn "run";`,
      `\tcase "run-trace":`,
      `\t\treturn "run";`,
      `\tdefault:`,
      `\t\treturn "other";`,
      `}`,
      `const ACCEPTED = new Set(["workflow-approval", "approval"]);`,
      `if (!ACCEPTED.has(card.kind)) fail("unexpected kind");`,
      ""
    ].join("\n")
    const reported = reportOf("switch-and-membership", FIXTURE)
    expect(reported).toContain("card-kind:workflow-run")
    expect(reported).toContain("card-kind:workflow-approval")
    // The live kinds sitting in the same two positions are left alone.
    expect(reported).not.toContain("card-kind:run-trace")
    expect(reported).not.toContain("card-kind:approval")
  })

  test("a kind a function returns is out of reach, and the header says so", () => {
    /*
     * The limit, pinned rather than described. Propagation follows values
     * into a call and never out of one, so a kind produced by a helper is
     * invisible. This test exists so the limit cannot quietly change: if a
     * later pass teaches the extractor to follow returns, this fails and
     * whoever did it updates the "WHAT IT CANNOT SEE" list in Literals.ts
     * in the same commit.
     */
    const FIXTURE = [
      `const kindFor = (row: Row): string => "workflow-run";`,
      `if (card.kind === kindFor(row)) fail("still here");`,
      ""
    ].join("\n")
    expect(reportOf("returned", FIXTURE)).not.toContain("card-kind:workflow-run")
  })

  test("the same positions holding a live kind stay clean", () => {
    // The other half of the widening. A rule that reports every kebab string
    // near the word `kind` would be noise, so the surviving vocabulary in the
    // same four shapes has to pass, and a `kind` belonging to another union
    // has to be left alone.
    const CLEAN = [
      `const cardOfKind = (client: Client, kind: string) =>`,
      `\tclient.cards().find((card) => card.kind === kind);`,
      `const live = cardOfKind(client, "setup");`,
      "const selectorFor = (kind: string): string =>",
      "\t`section[data-kind=${JSON.stringify(kind)}]`;",
      `await page.evaluate(selectorFor("approval"));`,
      `stack.chat.script({ frames: [`,
      `\t{ type: "delta", kind: "text", text: "Here is what finished." },`,
      `\tcard({`,
      `\t\tid: "copy-run-done",`,
      `\t\tkind: "run-trace",`,
      `\t\ttitle: "Run finished",`,
      `\t\tstatus: "acted",`,
      `\t\tcreatedAt: 1700000000000,`,
      `\t\tordinal: 10,`,
      `\t\tpayload: {},`,
      `\t}),`,
      `] });`,
      `const store = await createAppStore({ kind: "localStorage", storage });`,
      ""
    ].join("\n")
    expect(reportOf("clean-positions", CLEAN)).toEqual([])
  })
})

describe("the suggestion is a lead, not noise", () => {
  test("a near miss names its neighbour and a stranger names nobody", () => {
    expect(nearest("workflow.create", vocabularies.dottedIdentifiers)).toBe("flow.create")
    expect(nearest("workflow-run-", ["flow-run-"])).toBe("flow-run-")
    // The new form prefix is closer; the original run prefix still resolves above.
    expect(nearest("workflow-run-", vocabularies.cardIdPrefixes)).toBe("form-flow-run-")
    // No shared tail, no guess.
    expect(nearest("data-command", vocabularies.dataAttributes)).toBeUndefined()
    expect(nearest("zzzzzzzzzzzzzzzzzzzz", vocabularies.cardKinds)).toBeUndefined()
  })
})


test("explicit absence assertions distinguish removed affordances from positive checks", () => {
  for (const source of [
    `await expect(page.locator('[data-flow="flow.retired"]')).toHaveCount(0)`,
    `await expect(page.getByText("model.retired", { exact: true }).last()).toHaveCount(0)`
  ]) expect(extractLiterals("example.spec.ts", source).flatMap(literal => violationsOf(literal, vocabularies))).toEqual([])
  for (const source of [
    `await expect(page.locator('[data-flow="flow.retired"]')).toHaveCount(1)`,
    `await expect(page.locator('[data-flow="flow.retired"]')).not.toHaveCount(0)`,
    `await expect(page.locator('[data-flow="flow.retired"]')).toBeVisible()`,
    `runFlow("flow.retired")`
  ]) expect(extractLiterals("example.spec.ts", source).flatMap(literal => violationsOf(literal, vocabularies)).length).toBeGreaterThan(0)
})


test("rendered kinds and typed actions cannot widen wire cards or invocable flows", () => {
  const surfaceVocabulary = { ...vocabularies, renderedCardKinds: new Set(["design-surface"]), cardActionNames: new Set(["surface.confirm"]) }
  expect(extractLiterals("example.spec.ts", `page.locator('[data-kind="design-surface"][data-flow="surface.confirm"]')`).flatMap(literal => violationsOf(literal, surfaceVocabulary))).toEqual([])
  expect(extractLiterals("example.spec.ts", `card.kind === "design-surface"; runFlow("surface.confirm")`).flatMap(literal => violationsOf(literal, surfaceVocabulary)).map(row => row.rule)).toEqual(expect.arrayContaining(["card-kind", "flow"]))
})

describe("non-card discriminator provenance", () => {
  const reference = (source: string) => `import { withReference } from "./todo/reference"; withReference(browser, info, async fixture => { ${source} });`
  const claims = (source: string) => extractLiterals("/fixture/domains.ts", source)
    .filter(literal => literal.kindClaim).map(literal => literal.value)
  test("TODO evidence, run events and SQL activity trace through aliases and callback parameters", () => {
    expect(claims(reference(`
      let todo: any;
      todo = await fixture.read("Will", "/api/todos/1");
      const attempt = todo.evidence.find(e => e.attempt === 1);
      const evidence = attempt.items as any[];
      evidence.find(e => e.kind === "diff_stat");
      todo.evidence.find(e => e.items.some(i => i.kind === "review_summary"));
      const run = await fixture.read("Will", \`/api/runs/\${todo.run_id}\`);
      run.events.filter(event => event.kind === "answer");
      const events = fixture.sql("SELECT * FROM product_job_events WHERE todo_id = 1");
      events.find(event => event.kind === "wait_opened");
      const activity = fixture.sql("SELECT * FROM branch_activity");
      activity[0].kind === "steer";
    `))).toEqual([])
  })
  test("the imported ActorChip fixture establishes the actor domain without a value allowlist", () => {
    expect(claims(`import { fixtures as actors } from "@smthrs/rpc/fixtures/ActorChip";
      const actor = key ? actors[key]?.model.actor : undefined;
      actor?.kind === "agent";
    `)).toEqual([])
  })
  test("unproven receivers, card APIs, shadowed bindings and mixed assignments retain card claims", () => {
    for (const source of [
      'evidence.find(e => e.kind === "diff_stat")',
      'const fixture = { read: () => card }; const todo = await fixture.read("Will", "/api/todos/1"); todo.evidence.find(e => e.kind === "diff_stat")',
      'const todo = await fixture.read("Will", "/api/cards/1"); todo.evidence.find(e => e.kind === "diff_stat")',
      'const events = fixture.sql("SELECT * FROM cards"); events.find(e => e.kind === "wait_opened")',
      'const todo = await fixture.read("Will", "/api/todos/1"); { const todo = other; todo.evidence.find(e => e.kind === "diff_stat") }',
      'let todo = await fixture.read("Will", "/api/todos/1"); todo = other; todo.evidence.find(e => e.kind === "diff_stat")',
      'import { fixtures as actors } from "./lookalike"; actors[key].model.actor.kind === "agent"',
      'const card = { id: "one", title: "Bad", payload: {}, kind: "diff_stat" }; card.kind === "diff_stat"'
    ]) expect(claims(reference(source)).length).toBeGreaterThan(0)
  })
})


test("external input and artifacts retain checks when reused as product lookups", () => {
  expect(extractLiterals("example.spec.ts", `const text = "model.external"; input.fill(text)`).flatMap(literal => violationsOf(literal, vocabularies))).toEqual([])
  expect(extractLiterals("example.spec.ts", `const text = "model.external"; input.fill(text); runFlow(text)`).flatMap(literal => violationsOf(literal, vocabularies)).map(row => row.rule)).toContain("dotted-identifier")
  expect(extractLiterals("example.spec.ts", `const text = \`draft-private-\${Date.now()}\`; input.fill(text); page.getByTestId(text)`).flatMap(literal => violationsOf(literal, vocabularies)).map(row => row.rule)).toContain("card-id-prefix")
  expect(extractLiterals("example.spec.ts", `expect(basename(owner.home).startsWith("smithers-browser-test-")).toBe(true)`).flatMap(literal => violationsOf(literal, vocabularies))).toEqual([])
  expect(extractLiterals("example.spec.ts", `expect(card.id.startsWith("smithers-browser-test-")).toBe(true)`).flatMap(literal => violationsOf(literal, vocabularies)).map(row => row.rule)).toContain("card-id-prefix")
})


test("external spy evidence requires an executable recording call", () => {
  expect(extractLiterals("example.spec.ts", `const calls = []; const action = name => () => { calls.push(name) }; const keyboard = { press: action("key.press") }`).flatMap(literal => violationsOf(literal, vocabularies))).toEqual([])
  for (const source of [
    `const action = name => { /* calls.push(name) */ return () => {} }; action("key.press")`,
    `const calls = []; const action = name => () => { calls.push("unrelated") }; action("key.press")`,
    `const calls = []; const action = name => () => { calls.push(name) }; runFlow("key.press")`
  ]) expect(extractLiterals("example.spec.ts", source).flatMap(literal => violationsOf(literal, vocabularies)).length).toBeGreaterThan(0)
})

test("retirement records preserve old identities without excusing current product assertions", () => {
  const file = "/app/e2e/real/coverage/deferrals/history.ts"
  const check = (source: string) => extractLiterals(file, source).flatMap(literal => [...violationsOf(literal, vocabularies)])
  expect(check('export const RETIRED_SCENARIOS = [{ id: "retired.scenario", actions: ["retired.action"] }] as const')).toEqual([])
  expect(check('export const unrelated = ["retired.action"]')).not.toEqual([])
  expect(check('export const RETIRED_SCENARIOS = [page.getByTestId("card-form-issue.retired-flow")]')).not.toEqual([])
})
