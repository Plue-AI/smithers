/*
 * Every interactive capability in the app, as a flow.
 *
 * A capability is a `Flow.make` declaration — name, description, and typed
 * payload/success schemas — paired with the controller call
 * that runs it through `FlowBinding.make`. The pair is the whole capability:
 * the projected `FlowDescriptor` is what the agent's catalog discloses, and the
 * binding's `run` is what answers the call, so the catalog shown to the model
 * and the code that executes cannot drift apart.
 *
 * The trigger axis lives on the declaration rather than on the UI wrapper, as
 * `modelInvocable`. A user-only flow is browser mechanics the human clicks
 * (sign-in, theme, stop, send, maximize); the descriptor says so, so it never
 * reaches the agent's catalog.
 *
 * Handlers take a DECODED payload. No handler parses argument text: the slash
 * boundary turns `/name <text>` into the flow's payload once, in SlashPayload.ts.
 *
 * One module per namespace under ./entries holds the declarations; this file
 * is the aggregator. It spreads each module's blocks in registration order,
 * which the slash menu, the agent catalog and the commands card all read, so
 * a new namespace is one import plus one spread line here and nothing else.
 * FlowOrder.test.ts pins that order.
 */
import type { FlowEntry } from "./registry"
import type { CommandActions } from "./entries/Declare"
import { accountFlows } from "./entries/account"
import {  adminResetFlows, adminToolFlows } from "./entries/admin"
import { agentFlows } from "./entries/agent"
import { appFlows } from "./entries/app"
import { themeFlows } from "./entries/theme"
import { approvalFlows } from "./entries/approval"
import { approvalsFlows } from "./entries/approvals"
import { authFlows } from "./entries/auth"
import { billingBalanceFlows, billingPlanFlows } from "./entries/billing"
import { branchesFlows } from "./entries/branches"
import { commitsFlows } from "./entries/commits"
import { browserFlows } from "./entries/browser"
import { cardFlows } from "./entries/card"
import { changeFlows } from "./entries/change"
import { chatCopyFlows, chatFlows, chatReloadFlows } from "./entries/chat"
import { cloudFlows } from "./entries/cloud"
import { debugFlows, debugVerboseFlows } from "./entries/debug"
import { egressFlows } from "./entries/egress"
export { guideFlows } from "./entries/guide"
import { envFlows } from "./entries/env"
import {  filesFlows } from "./entries/files"
import { findingsFlows } from "./entries/findings"
import { flowFlows, flowRunStopAllFlows, flowVersionFlows } from "./entries/flow"
import { todoFlows } from "./entries/todo"
import { homeFlows } from "./entries/home"
import { formFlows } from "./entries/form"
import { graphFlows } from "./entries/graph"
import { frameFlows } from "./entries/frame"
import { githubFlows } from "./entries/github"
import { issuesFlows } from "./entries/issues"
import { settingsFlows } from "./entries/settings"
import { membersFlows } from "./entries/members"
import { helpFlows } from "./entries/help"
import { paletteFlows } from "./entries/palette"
import { prsFlows } from "./entries/prs"
import { repoFlows, tutorialRepositoryFlows } from "./entries/repo"
import { reposImportFlows, reposImportRetryFlows } from "./entries/repos"
import { reviewFlows } from "./entries/review"
import { runsFlows } from "./entries/runs"
import { searchFlows } from "./entries/search"
import { secretsFlows } from "./entries/secrets"
import { HISTORY_LAND_USER_ONLY_REASON, historyFlows } from "./entries/history"
import { storageFlows } from "./entries/storage"
import { syncFlows } from "./entries/sync"
import { toastFlows } from "./entries/toast"
import { subjectFlows } from "./entries/subjects"
import { shellFlows } from "./entries/shell"
import { branchFlows } from "./entries/branch"
import { triggersFlows } from "./entries/triggers"
import { wikiFlows, wikiSurfaceFlows } from "./entries/wiki"
import { workspaceFlows } from "./entries/box"

export type { CommandActions, CommandResult } from "./entries/Declare"
export { Ack } from "./entries/Declare"

/**
 * The flows every session has.
 *
 * @category constructors
 */
/**
 * The ONLY flows that may be listed in the slash menu and still refuse the
 * model ("every workflow in the / menu is available as a tool call" — Will).
 * Each entry is here for a structural reason, not taste; adding to this list
 * is a conscious act pinned by flows/invocable.test.ts.
 */
export const USER_ONLY_VISIBLE: ReadonlyArray<{ readonly name: string; readonly why: string }> = [
  { name: "chat.open", why: "opening Chat and starting the selected microphone mode is the human's gesture" },
  { name: "chat.dictate", why: "microphone capture is the human's explicit gesture" },
  { name: "chat.queue", why: "the prompt queue is the human's composer" },
  { name: "chat.send", why: "turn mechanics: the model is already the turn; sending would nest one" },
  { name: "stop", why: "turn mechanics: stopping the model's own turn from inside it" },
  { name: "admin.reset", why: "destroys the whole store with no undo; the confirm dialog is the only door" },
  { name: "billing.upgrade", why: "external checkout with real money; the human clicks" },
  { name: "billing.portal", why: "external billing portal; the human clicks" },
  { name: "admin.devtools", why: "admin panel presentation toggle" },
  { name: "debug.backend", why: "admin diagnostics presentation" },
  { name: "cloud.sign-in", why: "external browser OAuth on the human's account; the human clicks" },
  { name: "cloud.sign-out", why: "drops the human's cloud credential; the human clicks" },
  { name: "members", why: "people and roles are the person's call; the app agent has no path to members" },
  { name: "sign-in", why: "the GitHub OAuth redirect yanks the page; the human clicks (auth.prompt is the agent's door)" },
  { name: "sign-out", why: "drops the human's session; the human clicks" },
  { name: "wiki.pane", why: "surface switch: the model reads the wiki with wiki and wiki.cloud, which answer as embedded cards" },
  { name: "wiki.attach", why: "the file comes from the human's own file dialog; a model has no file to give" },
  { name: "history.land", why: HISTORY_LAND_USER_ONLY_REASON },
  { name: "palette.open", why: "focus and an overlay are the human's gesture; the model searches with the search.* flows, which answer the same rows as data" }
]

export const baseFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...wikiSurfaceFlows(actions),
  ...themeFlows(actions),
  ...debugVerboseFlows(actions),
  ...chatFlows(actions),
  ...browserFlows(actions),
  ...flowFlows(actions),
  ...flowVersionFlows(actions),
  ...triggersFlows(actions),
  ...runsFlows(actions),
  ...graphFlows(actions),
  ...flowRunStopAllFlows(actions),
  ...approvalsFlows(actions),
  ...cardFlows(actions),
  ...frameFlows(actions),
  ...chatCopyFlows(actions),
  ...approvalFlows(actions),
  ...wikiFlows(actions),
  ...authFlows(actions),
  ...accountFlows(actions),
  ...appFlows(actions),
  ...storageFlows(actions),
  ...cloudFlows(actions),
  ...toastFlows(actions),
  ...subjectFlows(actions),
  ...shellFlows(actions),
  ...branchFlows(actions),
  ...billingBalanceFlows(actions),
  ...billingPlanFlows(actions),
  ...reposImportFlows(actions),
  ...issuesFlows(actions),
  ...settingsFlows(actions),
  ...membersFlows(actions),
  ...helpFlows(actions),
  ...prsFlows(actions),
  ...envFlows(actions),
  ...secretsFlows(actions),
  ...historyFlows(actions),
  ...todoFlows(actions),
  ...homeFlows(actions),
  ...branchesFlows(actions),
  ...commitsFlows(actions),
  ...filesFlows(actions),
  ...githubFlows(actions),
  ...reposImportRetryFlows(actions),
  ...syncFlows(actions),
  ...workspaceFlows(actions),
  ...egressFlows(actions),
  ...changeFlows(actions),
  ...reviewFlows(actions),
  ...findingsFlows(actions),
  ...chatReloadFlows(actions),
  ...agentFlows(actions),
  ...formFlows(actions),
  ...repoFlows(actions),
  ...tutorialRepositoryFlows(actions),
  ...searchFlows(actions),
  ...paletteFlows(actions),
]

/*
 * The admin plugin (Launch Checklist §E — non-enumerable): these flows REGISTER
 * ONLY when the validated session carries admin:true. For every other session
 * they are absent from the registry — not hidden, not disabled — so the
 * enumeration surface (slash menu, agent catalog) of a non-admin session
 * contains no trace of them, and a direct /name invocation resolves exactly
 * like any typo.
 */
export const adminFlows = (actions: CommandActions): ReadonlyArray<FlowEntry> => [
  ...adminResetFlows(actions),
  ...adminToolFlows(actions),
  ...debugFlows(actions),
]
